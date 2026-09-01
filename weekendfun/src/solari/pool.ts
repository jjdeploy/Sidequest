/**
 * The fan-out: N geo-verified cloud browsers, all working at once.
 *
 * Two invariants this enforces so no individual source has to:
 *
 *  1. **Nothing searches before the geo gate passes.** The pool opens the
 *     context, verifies the page agrees about where it is, and only then hands
 *     the source a context to work in. A source physically cannot run against
 *     an unverified browser, because it never receives one.
 *
 *  2. **A failing source never fails the run.** Weekend planning degrades
 *     gracefully — seven sources and a visible "Groupon timed out" beats an
 *     exception where a plan should be. Every failure is captured and reported.
 *
 * Concurrency is capped locally, but `ConcurrencyLimitExceeded` is still
 * treated as backpressure rather than failure: the cap is account-wide, so a
 * leaked session from a crashed run can eat slots we thought were ours.
 */
import { Solari, SolariError, type LaunchOptions } from "@solarisdk/browser"
import type { BrowserSession } from "@solarisdk/browser"
import type { BrowserContext } from "patchright-core"
import type { Candidate, Place, PlanRequest, SourceId, SourceResult } from "../types.js"
import type { Keyword } from "../engine/keywords.js"
import { describeProxy, GeoGateError, openLocalContext, proxyFor } from "./geo.js"

/** Everything a source needs. It never sees the raw browser or the pool. */
export interface SourceContext {
  /** Geo-verified. Open pages from here, never from `browser.newPage()` —
   *  that would use the default context, which has no location override. */
  ctx: BrowserContext
  place: Place
  keywords: Keyword[]
  req: PlanRequest
  /** Solari session id, for the replay link on anything this source finds. */
  sessionId: string
  log: (msg: string) => void
}

export interface SourceTask {
  id: SourceId
  run: (c: SourceContext) => Promise<Candidate[]>
  /** Managed captcha solving. Costs time, so it's opt-in per source rather
   *  than blanket-on. Requires stealth, which the pool always sets. */
  captcha?: boolean
}

export type PoolEvent =
  | { type: "launch"; source: SourceId; proxy: string }
  | { type: "gated"; source: SourceId; sessionId: string; ms: number }
  | { type: "note"; source: SourceId; msg: string }
  | { type: "done"; source: SourceId; found: number; ms: number }
  | { type: "retry"; source: SourceId; attempt: number; reason: string }
  | { type: "fail"; source: SourceId; reason: string }

export interface PoolOptions {
  apiKey: string
  /** Starter plan allows 20 concurrent browsers; default leaves headroom for
   *  anything else on the account. */
  maxConcurrent?: number
  recording?: boolean
  retries?: number
  /** Hard ceiling on one source's whole run, not per navigation. Without this
   *  a single source that stalls (a captcha that never resolves, an infinite
   *  redirect) holds a session and blocks the run past any useful deadline.
   *  A weekend planner that takes ten minutes has already failed. */
  sourceTimeoutMs?: number
  onEvent?: (e: PoolEvent) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const isConcurrencyLimit = (e: unknown) =>
  e instanceof SolariError && e.code === "ConcurrencyLimitExceeded"

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

class SourceTimeout extends Error {}

/** Race a promise against a deadline. The loser keeps running — we can't
 *  cancel an in-flight navigation — but the pool stops waiting on it and
 *  closes the browser in `finally`, which tears the page down for real. */
async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new SourceTimeout(`${label} exceeded ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class BrowserPool {
  private readonly solari: Solari
  private readonly maxConcurrent: number
  private readonly recording: boolean
  private readonly retries: number
  private readonly sourceTimeoutMs: number
  private readonly onEvent?: (e: PoolEvent) => void
  /**
   * Run id, combined with the source name to make a PER-SOURCE sticky IP.
   *
   * This was originally one sticky id shared by the whole fan-out, on the
   * theory that N browsers from one residential IP look like one person
   * browsing in tabs. Measured, that is backwards: six browsers hitting
   * Eventbrite and AllEvents simultaneously from a single IP got throttled so
   * hard the first navigation never returned, and both sources died on the
   * watchdog while the other four finished in ~12s. Per-source sticky keeps a
   * stable IP across a source's own retries (which is what stickiness is
   * actually for) while spreading the fan-out across the pool.
   */
  private readonly runId = `wf-${Date.now().toString(36)}`
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(opts: PoolOptions) {
    this.solari = new Solari({ apiKey: opts.apiKey })
    this.maxConcurrent = Math.max(1, Math.min(20, opts.maxConcurrent ?? 12))
    this.recording = opts.recording ?? false
    this.retries = opts.retries ?? 1
    this.sourceTimeoutMs = opts.sourceTimeoutMs ?? 90_000
    this.onEvent = opts.onEvent
  }

  private emit(e: PoolEvent) {
    this.onEvent?.(e)
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return
    }
    await new Promise<void>((r) => this.waiting.push(r))
    this.active++
  }

  private release(): void {
    this.active--
    this.waiting.shift()?.()
  }

  /** Run every source in parallel. Always resolves, one result per task. */
  async fanOut(
    tasks: SourceTask[],
    place: Place,
    keywords: Keyword[],
    req: PlanRequest,
  ): Promise<SourceResult[]> {
    return Promise.all(tasks.map((t) => this.runOne(t, place, keywords, req)))
  }

  private async runOne(
    task: SourceTask,
    place: Place,
    keywords: Keyword[],
    req: PlanRequest,
  ): Promise<SourceResult> {
    const started = Date.now()
    const attempts = this.retries + 1

    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.acquire()
      let browser: BrowserSession | undefined
      try {
        const proxy = proxyFor(place, `${this.runId}-${task.id}`)
        const launch: LaunchOptions = {
          // `proxy` and `captcha` both REQUIRE stealth — a proxied request from
          // an obviously-automated browser is the pairing that gets blocked.
          stealth: true,
          proxy,
          captcha: task.captcha ?? false,
          recording: this.recording,
        }
        this.emit({ type: "launch", source: task.id, proxy: describeProxy(proxy) })

        browser = await this.solari.launch(launch)
        const sessionId = browser.id

        // The gate. Throws GeoGateError if the page won't confirm where it is.
        // Deadlined too: a hung gate is just as blocking as a hung scrape.
        const ctx = await withDeadline(
          openLocalContext(browser, place),
          30_000,
          `${task.id} geo gate`,
        )
        this.emit({ type: "gated", source: task.id, sessionId, ms: Date.now() - started })

        const candidates = (
          await withDeadline(
            task.run({
              ctx,
              place,
              keywords,
              req,
              sessionId,
              log: (msg) => this.emit({ type: "note", source: task.id, msg }),
            }),
            this.sourceTimeoutMs,
            task.id,
          )
        ).map((c) => ({ ...c, sessionId }))

        const elapsedMs = Date.now() - started
        this.emit({ type: "done", source: task.id, found: candidates.length, ms: elapsedMs })
        return { source: task.id, candidates, elapsedMs, sessionId }
      } catch (err) {
        const reason = reasonOf(err)
        // Retrying a timeout just burns the same wall clock again for the same
        // result. Take what we have and let the plan be one source thinner.
        if (attempt < attempts && !(err instanceof SourceTimeout)) {
          this.emit({ type: "retry", source: task.id, attempt, reason })
          const backoff = isConcurrencyLimit(err)
            ? 4000 * attempt + Math.random() * 1000
            : err instanceof GeoGateError
              ? 500 // a fresh context usually fixes it; no point waiting
              : 1200 * attempt
          await sleep(backoff)
          continue
        }
        this.emit({ type: "fail", source: task.id, reason })
        return { source: task.id, candidates: [], elapsedMs: Date.now() - started, error: reason }
      } finally {
        // close() releases the session too. Skipping it holds the slot until
        // the plan deadline and starves everything still queued.
        if (browser) await browser.close().catch(() => {})
        this.release()
      }
    }

    return { source: task.id, candidates: [], elapsedMs: Date.now() - started, error: "no attempts" }
  }

  /** REQUIRED. The client holds a loopback proxy open for connection retries,
   *  and that handle keeps the event loop alive — skip this and the CLI prints
   *  a perfect plan and then hangs forever. */
  async close(): Promise<void> {
    await this.solari.close()
  }
}
