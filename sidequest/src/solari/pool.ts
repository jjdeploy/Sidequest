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
  /**
   * Split this source's work across several browsers.
   *
   * Google Maps is the only source that loops over queries — one navigation
   * per keyword, in sequence, in a single browser. That made it the long pole
   * by construction: every other source does one or two page loads, so the
   * fan-out's wall clock was Maps' keyword count times a page load, and a
   * small-town run spent 90 seconds there and returned nothing.
   *
   * The Starter plan allows twenty concurrent browsers and we were using six.
   * A task that returns shards here gets one browser per shard, each with its
   * own geo gate, running at the same time as everything else; the results
   * merge back under one source id. Sources that do a single page load return
   * nothing and stay as they are — sharding them would spend browser slots to
   * save nothing.
   */
  shard?: (keywords: Keyword[]) => Keyword[][]

  /**
   * Override the pool's watchdog for this source.
   *
   * Worth setting wherever a source's healthy time is well known: the fan-out
   * runs in parallel, so its wall clock is the SLOWEST source, and one flaky
   * source sitting on the default budget doubles how long the user waits for a
   * plan that was otherwise ready. A source that normally finishes in 13s does
   * not need 90 seconds to prove it has failed.
   */
  timeoutMs?: number
}

export type PoolEvent =
  | { type: "launch"; source: SourceId; proxy: string }
  | { type: "gated"; source: SourceId; sessionId: string; ms: number }
  | { type: "note"; source: SourceId; msg: string }
  | { type: "done"; source: SourceId; found: number; ms: number }
  /**
   * What a unit actually came back with, the moment it came back.
   *
   * `done` says how many; this says which. Separate because the counts drive
   * the gantt and the ring and are worth keeping small, while this is only
   * ever for showing a reader that something is arriving — it is raw, it is
   * pre-screening, and nothing downstream reads it.
   */
  | { type: "landed"; source: SourceId; titles: string[] }
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
  /** Gap between successive source launches, to avoid a thundering herd. */
  staggerMs?: number
  /**
   * Stored browser profile (cookies + localStorage) to attach to every
   * browser in this fan-out.
   *
   * One per city. Cookie banners get accepted once instead of on every
   * browser on every run, the location these sites keep in their own cookies
   * agrees with the geolocation override instead of being negotiated fresh,
   * and a browser with history is less obviously a robot — which matters for
   * the sources that already block us.
   */
  profileId?: string
  /**
   * Hard ceiling on the WHOLE fan-out, not one source.
   *
   * Sources run in parallel, so the plan finishes when the slowest one does,
   * and any single source can hang: measured, Groupon has taken 93s and
   * Google Maps 90s on the same city that otherwise finishes in 21. No amount
   * of per-source tuning gets a reliable answer under half a minute while
   * that is true. This stops waiting and lets the plan be built from whatever
   * arrived, with the stragglers named rather than silently absent.
   */
  deadlineMs?: number
  onEvent?: (e: PoolEvent) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const isConcurrencyLimit = (e: unknown) =>
  e instanceof SolariError && e.code === "ConcurrencyLimitExceeded"

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Did this fail because the proxy tunnel wouldn't open?
 *
 * Distinct from "the site blocked us" and worth telling apart, because the
 * response is different: a blocked site is that source's problem, a dead
 * tunnel is every source's problem and is survivable.
 */
const isProxyFailure = (e: unknown) =>
  /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED/i.test(reasonOf(e))

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
  private readonly staggerMs: number
  private readonly profileId?: string
  private readonly deadlineMs: number
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
  /**
   * Browsers currently open.
   *
   * The deadline is worthless without this. Stopping waiting on a promise
   * does not stop the work behind it: the first version returned at 20s and
   * then blocked for another 50 in `close()`, because six browsers were
   * still mid-navigation and the session teardown waits for them. Closing a
   * session rejects whatever it was doing, which is what makes the abandoned
   * work actually stop.
   */
  private readonly live = new Set<BrowserSession>()

  constructor(opts: PoolOptions) {
    this.solari = new Solari({ apiKey: opts.apiKey })
    this.maxConcurrent = Math.max(1, Math.min(20, opts.maxConcurrent ?? 12))
    this.recording = opts.recording ?? false
    // Zero by default now that a global deadline exists. A retry costs the
    // same wall clock again for the same answer, and under a 20s budget it
    // can never land: Time Out spent 70 seconds on one 30s attempt plus one
    // 30s retry, and contributed nothing either time.
    this.retries = opts.retries ?? 0
    this.sourceTimeoutMs = opts.sourceTimeoutMs ?? 90_000
    this.staggerMs = opts.staggerMs ?? 400
    this.profileId = opts.profileId
    this.deadlineMs = opts.deadlineMs ?? 20_000
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

  /**
   * Run every source in parallel. Always resolves, one result per task.
   *
   * Launches are staggered by a few hundred milliseconds rather than fired all
   * at once. Measured: TripAdvisor finishes in ~11s on its own but blew a 75s
   * watchdog roughly half the time inside a six-way fan-out — the work hadn't
   * got slower, the thundering herd had. A small ramp costs a second of wall
   * clock and buys back a source.
   */
  async fanOut(
    tasks: SourceTask[],
    place: Place,
    keywords: Keyword[],
    req: PlanRequest,
  ): Promise<SourceResult[]> {
    // Expand each task into the browsers it actually wants. A source that
    // declares `shard` becomes several units of work under one source id.
    const units: Array<{ task: SourceTask; keywords: Keyword[] }> = []
    for (const task of tasks) {
      const shards = task.shard?.(keywords)
      if (shards && shards.length > 0) {
        for (const slice of shards) if (slice.length > 0) units.push({ task, keywords: slice })
      } else {
        units.push({ task, keywords })
      }
    }

    const started = Date.now()
    const partial = new Map<SourceId, SourceResult>()
    const record = (r: SourceResult) => {
      // Announce the arrival before merging it, so the page can show a venue
      // the instant a browser has read it rather than at the end of the
      // twenty seconds. Capped: this is a ticker, not a transfer.
      if (r.candidates.length > 0) {
        this.emit({
          type: "landed",
          source: r.source,
          titles: r.candidates.slice(0, 12).map((c) => c.title),
        })
      }
      const prior = partial.get(r.source)
      partial.set(
        r.source,
        prior
          ? {
              source: r.source,
              candidates: [...prior.candidates, ...r.candidates],
              elapsedMs: Math.max(prior.elapsedMs, r.elapsedMs),
              sessionId: prior.sessionId ?? r.sessionId,
              // A source only counts as failed when every one of its shards
              // did. One slow Maps query shouldn't blank the other five.
              error: prior.candidates.length + r.candidates.length > 0
                ? undefined
                : (prior.error ?? r.error),
            }
          : r,
      )
    }

    // Results are recorded as they land, so the deadline can take whatever
    // has arrived rather than losing everything to one straggler.
    const running = units.map(async (u, i) => {
      if (i > 0) await sleep(i * this.staggerMs)
      record(await this.runOne(u.task, place, u.keywords, req, i))
    })

    const timedOut = await Promise.race([
      Promise.all(running).then(() => false),
      sleep(this.deadlineMs).then(() => true),
    ])

    if (timedOut) {
      // Stop the work, not just the waiting.
      this.abandon()
      for (const task of tasks) {
        if (!partial.has(task.id)) {
          this.emit({ type: "fail", source: task.id, reason: `no answer within ${this.deadlineMs}ms` })
          partial.set(task.id, {
            source: task.id,
            candidates: [],
            elapsedMs: Date.now() - started,
            error: `missed the ${(this.deadlineMs / 1000).toFixed(0)}s deadline`,
          })
        }
      }
    }

    // Preserve the caller's source order, so logs and the gantt stay stable.
    return tasks.map(
      (t) =>
        partial.get(t.id) ?? {
          source: t.id,
          candidates: [],
          elapsedMs: Date.now() - started,
          error: "never started",
        },
    )
  }

  private async runOne(
    task: SourceTask,
    place: Place,
    keywords: Keyword[],
    req: PlanRequest,
    /** Distinguishes shards of the same source, so each gets its own IP. */
    unit = 0,
  ): Promise<SourceResult> {
    const started = Date.now()
    const attempts = this.retries + 1

    let usedProxy = true
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.acquire()
      let browser: BrowserSession | undefined
      try {
        // Sticky per UNIT, not per source. Eight Google Maps shards sharing
        // one sticky id meant eight simultaneous searches from a single
        // residential IP — the exact throttling this stickiness was
        // introduced to avoid, just moved one level down.
        const proxy = proxyFor(place, `${this.runId}-${task.id}-${unit}`)
        const launch: LaunchOptions = {
          // `proxy` and `captcha` both REQUIRE stealth — a proxied request from
          // an obviously-automated browser is the pairing that gets blocked.
          stealth: true,
          proxy,
          captcha: task.captcha ?? false,
          recording: this.recording,
          profileId: this.profileId,
        }
        this.emit({ type: "launch", source: task.id, proxy: describeProxy(proxy) })

        browser = await this.solari.launch(launch)
        this.live.add(browser)
        let sessionId = browser.id

        // The gate. Throws GeoGateError if the page won't confirm where it is.
        // Deadlined too: a hung gate is just as blocking as a hung scrape.
        let ctx
        try {
          ctx = await withDeadline(openLocalContext(browser, place), 30_000, `${task.id} geo gate`)
        } catch (err) {
          // The residential proxy going down should not take the whole plan
          // with it. This repo's central finding is that the proxy is NOT what
          // localises us — the geolocation override is — so a browser with no
          // proxy is still standing in the right city. What we lose is the
          // sources that block datacenter egress, notably Groupon.
          //
          // Measured the day this was written: a plain launch reached
          // example.com in 1.5s while every proxied tunnel failed. Without
          // this, that produced six lanes of "no answer" and no plan at all.
          if (!isProxyFailure(err) || !launch.proxy) throw err

          this.emit({ type: "note", source: task.id, msg: "proxy tunnel failed — retrying on direct egress" })
          this.live.delete(browser)
          await browser.close().catch(() => {})

          browser = await this.solari.launch({ ...launch, proxy: undefined })
          this.live.add(browser)
          sessionId = browser.id
          usedProxy = false
          ctx = await withDeadline(openLocalContext(browser, place), 30_000, `${task.id} geo gate`)
        }
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
            task.timeoutMs ?? this.sourceTimeoutMs,
            task.id,
          )
        ).map((c) => ({ ...c, sessionId }))

        const elapsedMs = Date.now() - started
        this.emit({ type: "done", source: task.id, found: candidates.length, ms: elapsedMs })
        return { source: task.id, candidates, elapsedMs, sessionId, direct: !usedProxy }
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
        if (browser) {
          this.live.delete(browser)
          await browser.close().catch(() => {})
        }
        this.release()
      }
    }

    return { source: task.id, candidates: [], elapsedMs: Date.now() - started, error: "no attempts" }
  }

  /**
   * Close every browser still open, without waiting for its work.
   *
   * Called when the fan-out deadline fires. Each abandoned `runOne` then
   * fails fast on its own rejected navigation and unwinds, so `close()`
   * returns promptly instead of inheriting the slowest source's tail.
   */
  private abandon(): void {
    for (const browser of this.live) void browser.close().catch(() => {})
    this.live.clear()
  }

  /** REQUIRED. The client holds a loopback proxy open for connection retries,
   *  and that handle keeps the event loop alive — skip this and the CLI prints
   *  a perfect plan and then hangs forever. */
  async close(): Promise<void> {
    await this.solari.close()
  }
}
