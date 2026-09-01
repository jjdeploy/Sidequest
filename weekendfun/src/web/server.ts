/**
 * The dashboard server.
 *
 *   npm run dashboard          then open http://localhost:5173
 *
 * Deliberately a plain `node:http` server with no framework, no bundler and
 * no new runtime dependency. The whole appeal of this repo is `npm install`
 * and go with one secret; adding a build step to draw six progress bars would
 * have been a bad trade, and server-sent events are a dozen lines.
 *
 * It is a localhost control panel, not a deployable web app, and that is a
 * deliberate boundary: it holds a Solari API key, writes to a local SQLite
 * file, and launches cloud browsers on your account. It binds to 127.0.0.1
 * for exactly that reason.
 *
 * Everything it can do, the CLI can already do. The dashboard exists because
 * some things are much easier to *see* than to read: six browsers overlapping
 * on one time axis, an itinerary as points on a map, and the rrweb replay of
 * the session that actually found a venue.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { Solari } from "@solarisdk/browser"
import { describeTaste, relearn } from "./../engine/learn.js"
import { claudeAvailable } from "./../llm/claude.js"
import { NoCandidatesError, resolvePlanRequest, runPlan, type PlanEvent } from "./../pipeline.js"
import { ALL_SOURCES } from "./../sources/index.js"
import { redditConfigured } from "./../sources/reddit.js"
import { Store } from "./../store/db.js"
import type { Mobility } from "./../types.js"

const PUBLIC_DIR = resolve(fileURLToPath(new URL("./public", import.meta.url)))
const DB_PATH = process.env.WEEKENDFUN_DB ?? resolve(process.cwd(), "data", "weekendfun.db")
const PORT = Number(process.env.PORT ?? 5173)

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
}

// One store for the life of the process. The CLI opens its own connection to
// the same file; the schema turns on WAL precisely so both can be live at once.
const store = new Store(DB_PATH)

/**
 * Only one plan at a time.
 *
 * Not a UI nicety — a fan-out holds up to twelve browser slots, and the
 * Starter plan allows twenty *account-wide*. Two overlapping runs would spend
 * the second one's life retrying `ConcurrencyLimitExceeded`, which looks
 * exactly like a broken source.
 */
let running: { city: string; startedAt: number } | null = null

// ────────────────────────────────────────────────────────────────── helpers

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    // Nothing this API accepts is large; a body this big is a mistake or an
    // attack, and either way there's no reason to buffer it.
    if (size > 64 * 1024) throw new Error("request body too large")
    chunks.push(chunk as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const full = resolve(PUBLIC_DIR, rel)
  // Contain the resolved path inside the public directory. `..` in a URL is
  // normally collapsed by the client, but nothing guarantees the client is a
  // browser, and serving arbitrary files from a process holding an API key is
  // not a mistake worth risking on politeness.
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) {
    json(res, 403, { error: "forbidden" })
    return
  }
  try {
    const body = await readFile(full)
    res.writeHead(200, {
      "content-type": MIME[extname(full)] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    res.end(body)
  } catch {
    json(res, 404, { error: `not found: ${rel}` })
  }
}

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d)
const listOf = (v: unknown) => str(v).split(",").map((s) => s.trim()).filter(Boolean)
const int = (v: unknown, d: number) => {
  const n = Number(str(v))
  return Number.isFinite(n) ? n : d
}

// ─────────────────────────────────────────────────────────────────── routes

/** Everything the page needs on a cold load. */
async function handleState(res: ServerResponse): Promise<void> {
  const weights = store.getWeights()
  json(res, 200, {
    counts: store.counts(),
    runs: store.recentRuns(8),
    weights,
    taste: describeTaste(weights),
    signals: store.recentSignals(10),
    // Just the label — the page uses it for one line of text, and the full
    // item payload is several kilobytes of plan nobody is going to render.
    lastPlan: (() => { const p = store.latestPlan(); return p ? { id: p.id, title: p.title, createdAt: p.createdAt } : null })(),
    sources: ALL_SOURCES.map((s) => s.id),
    redditConfigured: redditConfigured(),
    // Drives the hint under the free-text box: --ask and the write-up both
    // shell out to the claude CLI, and the form should say so up front
    // rather than after you have typed a sentence into a dead field.
    claude: await claudeAvailable(),
    running,
  })
}

/**
 * Run a plan, streaming progress as server-sent events.
 *
 * SSE rather than a WebSocket because the traffic is entirely one-way and the
 * browser's `EventSource` handles framing and reconnection for free. It has
 * to be a GET for the same reason, so the request lives in the query string.
 */
async function handlePlan(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    json(res, 400, { error: "SOLARI_API_KEY is not set. Copy .env.example to .env and add your key." })
    return
  }
  const where = url.searchParams.get("city")?.trim()
  if (!where) {
    json(res, 400, { error: "which city?" })
    return
  }
  if (running) {
    json(res, 409, { error: `already planning ${running.city} — one fan-out at a time` })
    return
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // The dashboard is one page doing one thing; buffering it would defeat
    // the entire point of streaming the fan-out.
    "x-accel-buffering": "no",
  })

  const send = (e: PlanEvent | { type: "done" }) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(e)}\n\n`)
  }

  // If the tab closes mid-run we stop writing, but we do NOT abandon the run:
  // the browsers are already launched and the results are worth persisting.
  let clientGone = false
  req.on("close", () => {
    clientGone = true
  })

  running = { city: where, startedAt: Date.now() }
  try {
    const q = url.searchParams
    const { req: planReq, alternates, askNote } = await resolvePlanRequest(where, {
      days: listOf(q.get("days")),
      adults: int(q.get("adults"), 2),
      kids: int(q.get("kids"), 0),
      budgetUsd: int(q.get("budget"), 200),
      vibes: listOf(q.get("vibes")),
      mobility: (str(q.get("mobility"), "car") as Mobility) || "car",
      avoid: listOf(q.get("avoid")),
      ask: q.get("ask")?.trim() || undefined,
    })
    send({ type: "place", place: planReq.place, alternates, askNote })

    await runPlan(
      planReq,
      store,
      {
        apiKey,
        sources: listOf(q.get("sources")),
        concurrency: int(q.get("concurrency"), 12),
        retries: int(q.get("retries"), 1),
        record: q.get("record") === "1",
        writeup: q.get("writeup") !== "0" && (await claudeAvailable()),
      },
      (e) => {
        if (!clientGone) send(e)
      },
    )
    send({ type: "done" })
  } catch (err) {
    const message =
      err instanceof NoCandidatesError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
    send({ type: "error", message })
  } finally {
    running = null
    if (!res.writableEnded) res.end()
  }
}

/** Record a thumb, relearn, and hand back the new taste vector so the page can
 *  show the weight actually moving. */
async function handleFeedback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { candidateId?: string; kind?: string; value?: number; undo?: boolean }
  const id = str(body.candidateId)
  const kind = str(body.kind)
  if (!id || !["kept", "skipped", "did", "rated"].includes(kind)) {
    json(res, 400, { error: "candidateId and kind (kept|skipped|did|rated) are required" })
    return
  }

  const found = store.resolveCandidate(id)
  if (!found) {
    json(res, 404, { error: `no single candidate matches "${id}"` })
    return
  }

  let removed = 0
  if (body.undo) {
    removed = store.deleteSignal(found.id, kind)
  } else {
    const value = kind === "rated" ? Number(body.value) : 1
    if (kind === "rated" && !(value >= 1 && value <= 5)) {
      json(res, 400, { error: "rated needs a value from 1 to 5" })
      return
    }
    store.addSignal(found.id, kind, value)
  }

  // A full recompute, not a nudge — which is what makes undo actually undo.
  const { updated, signalsUsed } = relearn(store)
  json(res, 200, {
    candidate: found,
    kind,
    undone: body.undo === true,
    removed,
    signalsUsed,
    weights: updated,
    taste: describeTaste(updated),
    signals: store.recentSignals(10),
  })
}

/** Which sources saw this venue and what each one said — the raw material
 *  behind the corroboration score. */
function handleCandidate(res: ServerResponse, id: string): void {
  const found = store.resolveCandidate(id)
  if (!found) {
    json(res, 404, { error: "unknown candidate" })
    return
  }
  json(res, 200, { candidate: found, sightings: store.sightingsFor(found.id) })
}

/**
 * The rrweb replay for one Solari session, proxied through this server.
 *
 * Proxied rather than redirecting the browser to the presigned URL, for two
 * reasons: the URL is short-lived, and fetching it cross-origin from the page
 * would need CORS that isn't ours to grant. The replay is only recorded when
 * the run was launched with "record sessions" on.
 */
async function handleReplay(res: ServerResponse, sessionId: string): Promise<void> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) {
    json(res, 400, { error: "SOLARI_API_KEY is not set" })
    return
  }
  const solari = new Solari({ apiKey })
  try {
    const bytes = await solari.sessions.downloadReplay(sessionId)
    // Some objects come back still gzipped, depending on how the store serves
    // them; fetch only decompresses when the header says to. Sniffing the
    // magic number handles both without caring which.
    const buf = Buffer.from(bytes)
    const body = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" })
    res.end(body)
  } catch (err) {
    json(res, 404, {
      error: err instanceof Error ? err.message : String(err),
      hint: "replays only exist for runs launched with recording on",
    })
  } finally {
    await solari.close()
  }
}

// ────────────────────────────────────────────────────────────────────── main

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const path = url.pathname

  const route = async (): Promise<void> => {
    if (req.method === "GET" && path === "/api/state") return handleState(res)
    if (req.method === "GET" && path === "/api/plan") return handlePlan(req, res, url)
    if (req.method === "POST" && path === "/api/feedback") return handleFeedback(req, res)
    if (req.method === "GET" && path.startsWith("/api/candidate/")) {
      return handleCandidate(res, decodeURIComponent(path.slice("/api/candidate/".length)))
    }
    if (req.method === "GET" && path.startsWith("/api/replay/")) {
      return handleReplay(res, decodeURIComponent(path.slice("/api/replay/".length)))
    }
    if (req.method === "GET") return serveStatic(res, path)
    json(res, 405, { error: "method not allowed" })
  }

  route().catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    if (!res.headersSent) json(res, 500, { error: message })
    else if (!res.writableEnded) res.end()
  })
})

// A second dashboard on the same port is a normal mistake (a stale one left
// running in another terminal), and the default behaviour is an unhandled
// error event and a stack trace. Say what happened instead.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`
Port ${PORT} is already in use — another dashboard is probably running.`)
    console.error(`Stop it, or start this one somewhere else:  PORT=5174 npm run dashboard
`)
  } else {
    console.error(`
dashboard failed: ${err.message}
`)
  }
  store.close()
  process.exit(1)
})

// Loopback only. This process holds an API key and can spend money on your
// Solari account; it has no auth and is not meant to.
server.listen(PORT, "127.0.0.1", () => {
  const key = process.env.SOLARI_API_KEY ? "found" : "MISSING — copy .env.example to .env"
  console.log(`\nWeekendFun dashboard  →  http://localhost:${PORT}`)
  console.log(`  store        ${DB_PATH}`)
  console.log(`  SOLARI_API_KEY ${key}`)
  console.log(`  reddit       ${redditConfigured() ? "configured" : "not configured (source will skip)"}`)
  console.log(`\nCtrl-C to stop.\n`)
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close()
    store.close()
    process.exit(0)
  })
}
