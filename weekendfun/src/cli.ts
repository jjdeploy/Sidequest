/**
 * WeekendFun CLI.
 *
 *   npm run plan -- "Tampa, FL" --vibes "chill, live music" --budget 200
 *   npm run plan -- "Seattle, WA" --ask "cheap date night, no driving"
 *   npm run feedback -- <candidate-id> did
 *   npm run history
 */
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { geocode } from "./place.js"
import { buildKeywords } from "./engine/keywords.js"
import { BrowserPool, type PoolEvent } from "./solari/pool.js"
import { ALL_SOURCES, sourcesByName } from "./sources/index.js"
import { fetchWeather } from "./sources/weather.js"
import { fetchReddit, redditConfigured } from "./sources/reddit.js"
import { rank, type ScoreContext } from "./engine/score.js"
import { buildItinerary, type Itinerary } from "./engine/itinerary.js"
import { describeTaste, relearn } from "./engine/learn.js"
import { Store } from "./store/db.js"
import { claudeAvailable, parseIntake, writeUp } from "./llm/claude.js"
import type { Candidate, PlanRequest, SourceResult, Weather } from "./types.js"

const DB_PATH = process.env.WEEKENDFUN_DB ?? resolve(process.cwd(), "data", "weekendfun.db")

// ─────────────────────────────────────────────────────────── arg parsing

interface Args {
  _: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) {
        out.flags[key] = next
        i++
      } else {
        out.flags[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

const str = (a: Args, k: string, d?: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : d)
const num = (a: Args, k: string, d: number) => {
  const v = a.flags[k]
  const n = typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : d
}
const bool = (a: Args, k: string) => a.flags[k] === true || a.flags[k] === "true"

/**
 * The upcoming Saturday and Sunday, as local dates in the target city.
 *
 * Deliberately does all arithmetic on Y/M/D integers via `Date.UTC`, never on
 * a local `Date`. The obvious version — build a local Date, add days, call
 * `toISOString().slice(0,10)` — silently shifts the answer by a day, because
 * `toISOString` converts to UTC first. It planned Sunday and Monday for a
 * request made on a Monday in Florida.
 */
function nextWeekend(timezone: string): string[] {
  const now = new Date()
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(now)

  const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday)
  // Already the weekend? Plan THIS one — someone asking on Saturday morning
  // means today, not eight days out.
  const daysToSat = idx === 6 ? 0 : idx === 0 ? -1 : 6 - idx

  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number]
  const base = Date.UTC(y, m - 1, d)
  const DAY = 86_400_000
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  return [iso(base + daysToSat * DAY), iso(base + (daysToSat + 1) * DAY)]
}

// ─────────────────────────────────────────────────────────── rendering

const BAR = "─".repeat(72)

function renderProgress(e: PoolEvent): void {
  const t = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  switch (e.type) {
    case "launch":
      console.log(`  ↗ ${e.source.padEnd(13)} launching (${e.proxy})`)
      break
    case "gated":
      console.log(`  ✓ ${e.source.padEnd(13)} in position, verified (${t(e.ms)})`)
      break
    case "done":
      console.log(`  ● ${e.source.padEnd(13)} ${String(e.found).padStart(3)} found (${t(e.ms)})`)
      break
    case "retry":
      console.log(`  ↺ ${e.source.padEnd(13)} retry ${e.attempt}: ${e.reason.slice(0, 60)}`)
      break
    case "fail":
      console.log(`  ✕ ${e.source.padEnd(13)} ${e.reason.slice(0, 60)}`)
      break
    case "note":
      if (process.env.WEEKENDFUN_VERBOSE) console.log(`      ${e.source}: ${e.msg.slice(0, 80)}`)
      break
  }
}

function renderItinerary(it: Itinerary, req: PlanRequest, verbose: boolean): void {
  for (const day of it.days) {
    const d = new Date(`${day.date}T12:00:00`)
    const name = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
    const w = day.weather
    const wx = w ? `  ${w.highF}°/${w.lowF}°F, ${w.summary}, ${w.precipChance}% rain` : ""
    console.log(`\n${name}${wx}`)
    console.log(BAR)

    if (day.items.length === 0) {
      console.log("  (nothing fit — try a bigger budget or a wider radius)")
      continue
    }

    for (const item of day.items) {
      const c = item.scored.candidate
      const price = c.priceUsd === null ? "—" : c.priceUsd === 0 ? "free" : `$${c.priceUsd}`
      const hop = item.hopMiles !== null ? `  (${item.hopMiles.toFixed(1)} mi hop)` : ""
      console.log(`\n  ${item.slot.padEnd(10)} ${c.title}`)
      console.log(`  ${" ".repeat(10)} ${price.padEnd(8)} ${c.category}${hop}`)
      console.log(`  ${" ".repeat(10)} ${item.why}`)
      console.log(`  ${" ".repeat(10)} \x1b[2m${c.id}  ${c.url.slice(0, 58)}\x1b[0m`)
      if (verbose) {
        for (const comp of item.scored.components) {
          console.log(`  ${" ".repeat(12)} \x1b[2m${comp.points > 0 ? "+" : ""}${comp.points.toFixed(1)} ${comp.name}: ${comp.why}\x1b[0m`)
        }
      }
    }
    console.log(`\n  day total: $${day.costUsd.toFixed(0)}`)
  }

  console.log(`\n${BAR}`)
  const heads = req.party.adults + req.party.kids
  console.log(`Total: $${it.totalUsd.toFixed(0)} of $${req.budgetUsd} for ${heads} ${heads === 1 ? "person" : "people"}`)
  for (const note of it.notes) console.log(`Note: ${note}`)
}

/** Compact text handed to Claude for the write-up. */
function summarize(it: Itinerary, req: PlanRequest): string {
  const lines = [`Trip: ${req.place.label}. Party: ${req.party.adults} adults, ${req.party.kids} kids. Budget: $${req.budgetUsd}. Getting around by ${req.mobility}. Vibes: ${req.vibes.join(", ") || "unspecified"}.`]
  for (const day of it.days) {
    const w = day.weather
    lines.push(`\n${day.date}${w ? ` (${w.highF}F, ${w.summary}, ${w.precipChance}% rain)` : ""}:`)
    for (const item of day.items) {
      const c = item.scored.candidate
      lines.push(`- ${item.slot}: ${c.title} (${c.category}, ${c.priceUsd === null ? "price unknown" : c.priceUsd === 0 ? "free" : "$" + c.priceUsd}). Evidence: ${c.evidence.slice(0, 160)}`)
    }
  }
  lines.push(`\nTotal cost: $${it.totalUsd.toFixed(0)}.`)
  return lines.join("\n")
}

// ─────────────────────────────────────────────────────────── commands

async function cmdPlan(args: Args): Promise<void> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set. Copy .env.example to .env and add your key.")

  const where = args._[0]
  if (!where) throw new Error('Where to? e.g. npm run plan -- "Tampa, FL"')

  // 1. Resolve the place. Ambiguity is surfaced, never silently resolved.
  const { best: place, alternates } = await geocode(where)
  console.log(`\n${BAR}`)
  console.log(`WeekendFun — ${place.label}`)
  console.log(BAR)
  if (alternates.length > 0) {
    console.log(`(also matched ${alternates.map((a) => a.label).join(", ")} — qualify the name to pick another)`)
  }

  // 2. Build the request.
  const req: PlanRequest = {
    place,
    days: str(args, "days")?.split(",").map((d) => d.trim()) ?? nextWeekend(place.timezone),
    party: { adults: num(args, "adults", 2), kids: num(args, "kids", 0) },
    budgetUsd: num(args, "budget", 200),
    vibes: (str(args, "vibes", "") ?? "").split(",").map((v) => v.trim()).filter(Boolean),
    mobility: (str(args, "mobility", "car") as PlanRequest["mobility"]) ?? "car",
    avoid: (str(args, "avoid", "") ?? "").split(",").map((v) => v.trim()).filter(Boolean),
  }

  // Free-text intake, when asked for and when Claude is available.
  const askText = str(args, "ask")
  if (askText) {
    const parsed = await parseIntake(askText)
    if (parsed) {
      if (parsed.vibes?.length) req.vibes = [...req.vibes, ...parsed.vibes]
      if (parsed.budgetUsd) req.budgetUsd = parsed.budgetUsd
      if (parsed.adults) req.party.adults = parsed.adults
      if (parsed.kids !== undefined) req.party.kids = parsed.kids
      if (parsed.kidAges?.length) req.party.kidAges = parsed.kidAges
      if (parsed.mobility) req.mobility = parsed.mobility
      if (parsed.avoid?.length) req.avoid = [...req.avoid, ...parsed.avoid]
      console.log(`Read your request as: ${req.vibes.join(", ")} · $${req.budgetUsd} · ${req.mobility}`)
    } else {
      console.log("(couldn't parse --ask; using flag defaults)")
    }
  }

  console.log(`${req.days.join(" and ")} · ${req.party.adults} adults${req.party.kids ? ` + ${req.party.kids} kids` : ""} · $${req.budgetUsd} · ${req.mobility}`)

  // 3. Decide what to search for BEFORE spending a single browser session.
  const keywords = buildKeywords(req, num(args, "keywords", 8))
  console.log(`\nSearching for ${keywords.length} things:`)
  for (const k of keywords.slice(0, 6)) console.log(`  · ${k.term}  \x1b[2m(${k.because})\x1b[0m`)
  if (keywords.length > 6) console.log(`  · …and ${keywords.length - 6} more`)

  // 4. Fan out.
  const sources = sourcesByName((str(args, "sources", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean))
  console.log(`\nLaunching ${sources.length} cloud browsers in parallel:`)

  const store = new Store(DB_PATH)
  const runId = randomUUID()
  const pool = new BrowserPool({
    apiKey,
    maxConcurrent: num(args, "concurrency", 12),
    recording: bool(args, "record"),
    retries: num(args, "retries", 1),
    sourceTimeoutMs: num(args, "source-timeout", 90) * 1000,
    onEvent: renderProgress,
  })

  const started = Date.now()
  let results: SourceResult[] = []
  let weather: Weather[] = []
  try {
    const [browserResults, wx, redditCandidates] = await Promise.all([
      pool.fanOut(sources, place, keywords, req),
      fetchWeather(place, req.days).catch(() => [] as Weather[]),
      // Not a browser source — Reddit blocks all scraping, so this is the
      // official API and runs alongside the fan-out for free.
      fetchReddit(place, (msg) => {
        if (process.env.WEEKENDFUN_VERBOSE) console.log(`      reddit: ${msg}`)
      }),
    ])
    results = browserResults
    weather = wx

    if (redditCandidates.length > 0) {
      console.log(`  ● ${"reddit".padEnd(13)} ${String(redditCandidates.length).padStart(3)} found (official API)`)
      results.push({ source: "reddit", candidates: redditCandidates, elapsedMs: 0 })
    } else if (!redditConfigured()) {
      console.log(`  ○ ${"reddit".padEnd(13)} skipped (no REDDIT_CLIENT_ID — see sources/reddit.ts)`)
    }
  } finally {
    // REQUIRED: the client holds a loopback proxy open, and that handle keeps
    // the event loop alive. Without this the CLI prints the plan and hangs.
    await pool.close()
  }

  const elapsed = Date.now() - started
  const all: Candidate[] = results.flatMap((r) => r.candidates)
  const failed = results.filter((r) => r.error)
  console.log(`\n${all.length} candidates from ${results.length - failed.length}/${results.length} sources in ${(elapsed / 1000).toFixed(1)}s`)

  if (all.length === 0) {
    console.log("\nNothing found. Every source failed — check your connection and SOLARI_API_KEY.")
    store.close()
    process.exitCode = 1
    return
  }

  // 5. Persist, then score against everything we've ever learned.
  store.recordRun(runId, req, elapsed)
  store.saveResults(runId, results)

  const ctx: ScoreContext = {
    req,
    weather,
    corroboration: store.corroborationFor(runId),
    history: store.historyFor([...new Set(all.map((c) => c.id))]),
    weights: store.getWeights(),
  }
  const ranked = rank(all, ctx)

  // 6. Assemble and show.
  const itinerary = buildItinerary(ranked, req, weather)
  renderItinerary(itinerary, req, bool(args, "explain"))

  const planId = randomUUID()
  store.savePlan(planId, runId, `${place.label} ${req.days[0]}`, itinerary.days)

  // 7. Optional prose write-up.
  if (!bool(args, "no-writeup") && (await claudeAvailable())) {
    console.log("\nWriting it up…")
    const prose = await writeUp(summarize(itinerary, req))
    if (prose) {
      console.log(`\n${BAR}`)
      console.log(prose)
      console.log(BAR)
    }
  }

  const taste = describeTaste(ctx.weights)
  console.log(`\nWhat I know about you so far: ${taste.join(" · ")}`)
  console.log(`\nTell me how it went and the next plan gets better:`)
  const first = itinerary.days[0]?.items[0]
  if (first) {
    console.log(`  npm run feedback -- ${first.scored.candidate.id.slice(0, 8)} did`)
    console.log(`  npm run feedback -- ${first.scored.candidate.id.slice(0, 8)} rated 5`)
  }
  store.close()
}

async function cmdFeedback(args: Args): Promise<void> {
  const [idPrefix, kind, rawValue] = args._
  if (!idPrefix || !kind) {
    throw new Error("Usage: npm run feedback -- <candidate-id> <kept|skipped|did|rated> [1-5]")
  }
  const valid = ["kept", "skipped", "did", "rated"]
  if (!valid.includes(kind)) throw new Error(`kind must be one of: ${valid.join(", ")}`)

  const store = new Store(DB_PATH)
  try {
    const found = store.resolveCandidate(idPrefix)
    if (!found) {
      // Ambiguous or missing — never guess, because rating the wrong venue
      // corrupts the learner in a way that's very hard to spot later.
      throw new Error(`No single candidate matches "${idPrefix}". Use a longer id prefix.`)
    }
    const value = kind === "rated" ? Number(rawValue) : 1
    if (kind === "rated" && !(value >= 1 && value <= 5)) {
      throw new Error("rated needs a value from 1 to 5")
    }

    store.addSignal(found.id, kind, value)
    const { updated, signalsUsed } = relearn(store)
    console.log(`Recorded: ${found.title} — ${kind}${kind === "rated" ? ` ${value}/5` : ""}`)
    console.log(`Relearned from ${signalsUsed} signal(s).`)
    console.log(describeTaste(updated).map((s) => `  ${s}`).join("\n"))
  } finally {
    store.close()
  }
}

async function cmdHistory(): Promise<void> {
  const store = new Store(DB_PATH)
  try {
    const c = store.counts()
    console.log(`\n${BAR}`)
    console.log(`${c.runs} runs · ${c.candidates} known places · ${c.sightings} sightings · ${c.signals} signals`)
    console.log(BAR)
    for (const run of store.recentRuns(10)) {
      console.log(`  ${run.created_at.slice(0, 16).replace("T", " ")}  ${run.place_label.padEnd(22)} ${(run.elapsed_ms / 1000).toFixed(1)}s`)
    }
    console.log(`\nLearned preferences:`)
    console.log(describeTaste(store.getWeights()).map((s) => `  ${s}`).join("\n"))
  } finally {
    store.close()
  }
}

function cmdSources(): void {
  console.log("\nBrowser sources (run in parallel on Solari):")
  for (const s of ALL_SOURCES) console.log(`  ${s.id}`)
  console.log("\nDirect API sources (no browser needed):")
  console.log("  weather   Open-Meteo, keyless")
  console.log(`  reddit    official API — ${redditConfigured() ? "configured" : "not configured, will be skipped"}`)
}

// ─────────────────────────────────────────────────────────── entry

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const args = parseArgs(argv.slice(1))

  switch (command) {
    case "plan":
      await cmdPlan(args)
      break
    case "feedback":
      await cmdFeedback(args)
      break
    case "history":
      await cmdHistory()
      break
    case "sources":
      cmdSources()
      break
    default:
      console.log(`WeekendFun — parallel cloud browsers that plan your weekend.

  npm run plan -- "Tampa, FL"
  npm run plan -- "Seattle, WA" --vibes "outdoorsy, cheap" --budget 150 --explain
  npm run plan -- "Austin, TX" --ask "date night, no driving, under \\$100"
  npm run feedback -- <candidate-id> did
  npm run history
  npm run sources
  npm run geo-proof              prove the location targeting actually works

Flags: --vibes --budget --adults --kids --mobility --avoid --days
       --sources --concurrency --retries --explain --record --no-writeup`)
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
