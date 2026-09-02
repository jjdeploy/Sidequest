/**
 * The plan pipeline, with the terminal taken out of it.
 *
 * This is exactly what `npm run plan` does — geocode, decide keywords, fan
 * out, persist, score, assemble — but it reports progress through a callback
 * instead of `console.log`. The CLI renders those events as text; the
 * dashboard renders them as a live gantt chart. Both call this.
 *
 * Extracting it mattered more than it looks. The dashboard needs the same
 * ordering guarantee the CLI has (keywords before browsers, geo gate before
 * scraping) and the same persistence (a plan you rate in the browser has to
 * teach the same store the CLI reads). A second copy of this orchestration
 * would have drifted from the first one within a week.
 *
 * Every event is JSON-serializable on purpose: the dashboard ships them
 * straight down an SSE socket with no translation layer.
 */
import { randomUUID } from "node:crypto"
import { buildItinerary, type Itinerary } from "./engine/itinerary.js"
import { buildKeywords, requestedCategories, stripTimeWords, timeOfDayFrom, type Keyword } from "./engine/keywords.js"
import { describeTaste } from "./engine/learn.js"
import { makeLocalityResolver } from "./engine/localities.js"
import { screen, type ScreenSummary, type Verdict } from "./engine/relevance.js"
import { rank, type Scored, type ScoreContext } from "./engine/score.js"
import { claudeAvailable, parseIntake, writeUp } from "./llm/claude.js"
import { geocode } from "./place.js"
import { BrowserPool, type PoolEvent } from "./solari/pool.js"
import { sourcesByName } from "./sources/index.js"
import { fetchReddit, redditConfigured } from "./sources/reddit.js"
import { fetchWeather } from "./sources/weather.js"
import type { Store } from "./store/db.js"
import type { Candidate, Mobility, Place, PlanRequest, SourceResult, Weather } from "./types.js"

/**
 * The upcoming Saturday and Sunday, as local dates in the target city.
 *
 * Deliberately does all arithmetic on Y/M/D integers via `Date.UTC`, never on
 * a local `Date`. The obvious version — build a local Date, add days, call
 * `toISOString().slice(0,10)` — silently shifts the answer by a day, because
 * `toISOString` converts to UTC first. It planned Sunday and Monday for a
 * request made on a Monday in Florida.
 */
export function nextWeekend(timezone: string): string[] {
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

// ────────────────────────────────────────────────────────── building a request

/** Everything the caller might want to override. All optional — the defaults
 *  here are the ones the CLI documents. */
export interface RequestDraft {
  days?: string[]
  adults?: number
  kids?: number
  budgetUsd?: number
  vibes?: string[]
  mobility?: Mobility
  avoid?: string[]
  timeOfDay?: PlanRequest["timeOfDay"]
  /** Free text, parsed by Claude when it's available. Layers on top of the
   *  explicit fields rather than replacing them. */
  ask?: string
}

export interface ResolvedRequest {
  req: PlanRequest
  /** Other places that matched the name. Surfaced, never silently discarded —
   *  planning a weekend in Tampa, Kansas is a confusing kind of wrong. */
  alternates: Place[]
  /** Present when `ask` was given: what Claude made of it, or why it didn't. */
  askNote: string | null
}

export async function resolvePlanRequest(where: string, draft: RequestDraft): Promise<ResolvedRequest> {
  const { best: place, alternates } = await geocode(where)

  const req: PlanRequest = {
    place,
    days: draft.days?.length ? draft.days : nextWeekend(place.timezone),
    party: { adults: draft.adults ?? 2, kids: draft.kids ?? 0 },
    budgetUsd: draft.budgetUsd ?? 200,
    vibes: draft.vibes?.filter(Boolean) ?? [],
    mobility: draft.mobility ?? "car",
    avoid: draft.avoid?.filter(Boolean) ?? [],
    timeOfDay: draft.timeOfDay,
  }

  let askNote: string | null = null
  if (draft.ask) {
    // Read the request deterministically FIRST, from the words they typed.
    //
    // The vocabulary in keywords.ts already matches on substrings, so handing
    // it the raw sentence gets "bowling at night" to bowling and to nightlife
    // without asking anything. The model then widens that; it does not decide
    // it. Two things follow: the same sentence gives the same plan every
    // time, and `--ask` degrades to something useful with the claude CLI
    // absent instead of doing nothing at all.
    req.timeOfDay = timeOfDayFrom(draft.ask)
    // With the time taken out, so "night" isn't also read as a mood.
    const what = stripTimeWords(draft.ask)
    if (what) req.vibes = [...req.vibes, what]

    const parsed = await parseIntake(draft.ask)
    if (parsed) {
      if (parsed.vibes?.length) req.vibes = [...req.vibes, ...parsed.vibes]
      if (parsed.budgetUsd) req.budgetUsd = parsed.budgetUsd
      if (parsed.adults) req.party.adults = parsed.adults
      if (parsed.kids !== undefined) req.party.kids = parsed.kids
      if (parsed.kidAges?.length) req.party.kidAges = parsed.kidAges
      if (parsed.mobility) req.mobility = parsed.mobility
      if (parsed.avoid?.length) req.avoid = [...req.avoid, ...parsed.avoid]
      // Only if our own reading found nothing — the deterministic answer wins.
      if (!req.timeOfDay && parsed.timeOfDay) req.timeOfDay = parsed.timeOfDay
      // The deterministic read and the model often land on the same word.
      req.vibes = [...new Set(req.vibes.map((v) => v.trim()).filter(Boolean))]
      askNote = [
        req.vibes.join(", "),
        req.timeOfDay && `in the ${req.timeOfDay}`,
        `${req.budgetUsd}`,
        req.mobility,
      ].filter(Boolean).join(" · ")
    } else {
      // No model, or it failed. The deterministic read still stands.
      askNote = [
        draft.ask,
        req.timeOfDay && `in the ${req.timeOfDay}`,
      ].filter(Boolean).join(" · ")
    }
  }

  return { req, alternates, askNote }
}

// ──────────────────────────────────────────────────────────────────── events

/**
 * Progress, as it happens.
 *
 * `at` is milliseconds since the fan-out started, stamped here rather than in
 * the pool. The pool reports each source's own elapsed time, which is the
 * right thing for a log line but useless for a gantt chart: launches are
 * staggered, so lanes start at different offsets. Stamping arrival time is
 * what lets the dashboard draw six bars against one shared clock and make the
 * parallelism visible.
 */
export type PlanEvent =
  | { type: "place"; place: Place; alternates: Place[]; askNote: string | null }
  | { type: "request"; req: PlanRequest }
  | { type: "keywords"; keywords: Keyword[] }
  | { type: "launching"; sources: string[]; browsers: number; concurrency: number; recording: boolean }
  | { type: "pool"; at: number; event: PoolEvent }
  | { type: "reddit"; found: number; configured: boolean }
  | { type: "weather"; weather: Weather[] }
  | { type: "gathered"; total: number; ok: number; of: number; elapsedMs: number; sequentialMs: number }
  | { type: "screened"; summary: ScreenSummary }
  | { type: "ranked"; top: RankedView[] }
  | { type: "itinerary"; planId: string; runId: string; itinerary: ItineraryView }
  | { type: "taste"; taste: string[]; weights: Record<string, number> }
  | { type: "writeup"; text: string }
  | { type: "error"; message: string }

/** The wire shape of a scored candidate. Flattened so the browser never has
 *  to know about the `Scored` / `Candidate` nesting. */
export interface RankedView {
  id: string
  title: string
  url: string
  source: string
  category: string
  priceUsd: number | null
  rating: number | null
  reviewCount: number | null
  lat: number | null
  lng: number | null
  address: string | null
  evidence: string
  image: string | null
  corroboration: number
  score: number
  components: Array<{ name: string; points: number; why: string }>
  sessionId: string | null
}

export interface ItineraryView {
  days: Array<{
    date: string
    weather: Weather | null
    costUsd: number
    items: Array<{ slot: string; hopMiles: number | null; why: string; candidate: RankedView }>
  }>
  totalUsd: number
  budgetUsd: number
  notes: string[]
}

function toView(s: Scored): RankedView {
  const c = s.candidate
  return {
    id: c.id,
    title: c.title,
    url: c.url,
    source: c.source,
    category: c.category,
    priceUsd: c.priceUsd,
    rating: c.rating,
    reviewCount: c.reviewCount,
    lat: c.lat ?? null,
    lng: c.lng ?? null,
    address: c.address ?? null,
    evidence: c.evidence,
    image: c.image ?? null,
    corroboration: s.corroboration,
    score: s.score,
    components: s.components,
    sessionId: c.sessionId ?? null,
  }
}

function itineraryView(it: Itinerary, budgetUsd: number): ItineraryView {
  return {
    days: it.days.map((d) => ({
      date: d.date,
      weather: d.weather ?? null,
      costUsd: d.costUsd,
      items: d.items.map((i) => ({
        slot: i.slot,
        hopMiles: i.hopMiles,
        why: i.why,
        candidate: toView(i.scored),
      })),
    })),
    totalUsd: it.totalUsd,
    budgetUsd,
    notes: it.notes,
  }
}

// ─────────────────────────────────────────────────────────────────── running

export interface PlanOptions {
  apiKey: string
  /** Empty means every source. */
  sources?: string[]
  concurrency?: number
  retries?: number
  sourceTimeoutMs?: number
  staggerMs?: number
  /** Hard ceiling on the whole fan-out. Partial results are normal. */
  deadlineMs?: number
  /** Stored browser profile, one per city. */
  profileId?: string
  keywordLimit?: number
  /** rrweb session recording. Costs nothing extra to run, and it's what makes
   *  the replay links on the dashboard work. */
  record?: boolean
  writeup?: boolean
  verbose?: boolean
}

export interface PlanOutcome {
  runId: string
  planId: string
  req: PlanRequest
  keywords: Keyword[]
  results: SourceResult[]
  /** What the admission gate admitted and rejected, and why. */
  screening: ScreenSummary
  verdicts: Map<string, Verdict>
  weather: Weather[]
  ranked: Scored[]
  itinerary: Itinerary
  elapsedMs: number
  weights: Record<string, number>
  writeup: string | null
}

/** Thrown when every source came back empty — a real failure, as opposed to a
 *  thin plan, and the two deserve different messages. */
export class NoCandidatesError extends Error {}

/**
 * Run one plan end to end.
 *
 * The store is passed in rather than opened here: the CLI wants a connection
 * for the length of one command, the dashboard wants one for the length of the
 * process, and neither should have to fight the other over who closes it.
 */
export async function runPlan(
  req: PlanRequest,
  store: Store,
  opts: PlanOptions,
  emit: (e: PlanEvent) => void = () => {},
): Promise<PlanOutcome> {
  emit({ type: "request", req })

  // 1. Decide what to search for BEFORE spending a single browser session.
  //    Deciding this while holding twelve sessions open would waste the
  //    expensive thing to save the cheap one.
  const keywords = buildKeywords(req, opts.keywordLimit ?? 8)
  emit({ type: "keywords", keywords })

  // 2. Fan out.
  const sources = sourcesByName(opts.sources ?? [])
  const recording = opts.record ?? false
  // Google Maps takes one browser per keyword, so the count of browsers is
  // no longer the count of sources.
  const browserCount = sources.reduce((n, s) => n + (s.shard?.(keywords)?.length || 1), 0)
  emit({
    type: "launching",
    sources: sources.map((s) => s.id),
    browsers: browserCount,
    concurrency: opts.concurrency ?? 18,
    recording,
  })

  const runId = randomUUID()
  const started = Date.now()
  const pool = new BrowserPool({
    apiKey: opts.apiKey,
    // Google Maps now takes one browser per keyword, so a full fan-out is
    // ~13 browsers rather than 6. The Starter plan allows 20.
    maxConcurrent: opts.concurrency ?? 18,
    recording,
    retries: opts.retries ?? 0,
    // Kept just under the global deadline: a source that hasn't answered by
    // then cannot contribute, so it may as well free its slot.
    sourceTimeoutMs: opts.sourceTimeoutMs ?? 18_000,
    // 13 units at the old 400ms gap spent five seconds staggering before the
    // last one even launched, which is a quarter of the whole budget.
    staggerMs: opts.staggerMs ?? 150,
    deadlineMs: opts.deadlineMs ?? 20_000,
    // One profile per city: cookie banners get accepted once rather than on
    // every browser on every run, and the location these sites keep in their
    // own cookies ends up agreeing with the geolocation override.
    profileId: opts.profileId,
    onEvent: (event) => emit({ type: "pool", at: Date.now() - started, event }),
  })

  let results: SourceResult[] = []
  let weather: Weather[] = []
  try {
    const [browserResults, wx, redditCandidates] = await Promise.all([
      pool.fanOut(sources, req.place, keywords, req),
      fetchWeather(req.place, req.days).catch(() => [] as Weather[]),
      // Not a browser source — Reddit blocks all scraping, so this is the
      // official API and runs alongside the fan-out for free.
      fetchReddit(req.place, (msg) => {
        if (opts.verbose) emit({ type: "pool", at: Date.now() - started, event: { type: "note", source: "reddit", msg } })
      }),
    ])
    results = browserResults
    weather = wx

    if (redditCandidates.length > 0) {
      results.push({ source: "reddit", candidates: redditCandidates, elapsedMs: 0 })
    }
    emit({ type: "reddit", found: redditCandidates.length, configured: redditConfigured() })
  } finally {
    // REQUIRED: the client holds a loopback proxy open, and that handle keeps
    // the event loop alive. Without this we produce a perfect plan and hang.
    await pool.close()
  }

  const elapsedMs = Date.now() - started
  emit({ type: "weather", weather })

  const all: Candidate[] = results.flatMap((r) => r.candidates)
  const failed = results.filter((r) => r.error).length
  emit({
    type: "gathered",
    total: all.length,
    ok: results.length - failed,
    of: results.length,
    elapsedMs,
    // What this would have cost run one source at a time. The honest version
    // of the parallelism claim: it's the sum of the same work, not a guess.
    sequentialMs: results.reduce((n, r) => n + r.elapsedMs, 0),
  })

  if (all.length === 0) {
    throw new NoCandidatesError(
      "Every source came back empty. Check your connection and SOLARI_API_KEY.",
    )
  }

  // 3. The admission gate: is each candidate actually about what was asked
  //    for — the right place, the right days, and a thing you'd go and do?
  //    See engine/relevance.ts for why this is one gate and not six filters.
  const { verdicts, summary } = await screen(all, {
    place: req.place,
    req,
    resolveLocality: makeLocalityResolver(store, req.place),
  })
  emit({ type: "screened", summary })

  // Rejects never reach the store. Keeping them would inflate corroboration
  // ("three sources agree" on a networking seminar) and leave the learner
  // with categories for things that were never offered.
  const kept = results.map((r) => ({
    ...r,
    candidates: r.candidates.filter((c) => !verdicts.get(c.id)?.fatal),
  }))
  const admitted = kept.flatMap((r) => r.candidates)

  if (admitted.length === 0) {
    throw new NoCandidatesError(
      `Found ${all.length} listings but none survived screening — nothing was in ` +
        `${req.place.city} on ${req.days.join(" or ")}. Try a wider budget or different days.`,
    )
  }

  // 4. Persist, then score against everything we've ever learned.
  store.recordRun(runId, req, elapsedMs)
  store.saveResults(runId, kept)

  const weights = store.getWeights()
  const ctx: ScoreContext = {
    req,
    weather,
    corroboration: store.corroborationFor(runId),
    history: store.historyFor([...new Set(admitted.map((c) => c.id))]),
    weights,
    relevance: verdicts,
    requested: requestedCategories(keywords),
  }
  const ranked = rank(admitted, ctx)
  // Everything, not a top slice. The page shows the plan and then every
  // other option underneath it, so truncating here would quietly cap the
  // catalogue at 40 and there would be no way to tell from the outside.
  emit({ type: "ranked", top: ranked.map(toView) })

  // 5. Assemble.
  const itinerary = buildItinerary(ranked, req, weather, ctx.requested, req.timeOfDay)
  const planId = randomUUID()
  store.savePlan(planId, runId, `${req.place.label} ${req.days[0]}`, itinerary.days)
  emit({ type: "itinerary", planId, runId, itinerary: itineraryView(itinerary, req.budgetUsd) })
  emit({ type: "taste", taste: describeTaste(weights), weights })

  // 6. Optional prose. Never on the critical path — the plan is already sent.
  let prose: string | null = null
  if ((opts.writeup ?? true) && (await claudeAvailable())) {
    prose = await writeUp(summarizeForWriteUp(itinerary, req))
    if (prose) emit({ type: "writeup", text: prose })
  }

  return {
    runId, planId, req, keywords, results, weather, ranked, itinerary,
    elapsedMs, weights, writeup: prose, screening: summary, verdicts,
  }
}

/** Compact text handed to Claude for the write-up. */
export function summarizeForWriteUp(it: Itinerary, req: PlanRequest): string {
  const lines = [
    `Trip: ${req.place.label}. Party: ${req.party.adults} adults, ${req.party.kids} kids. ` +
      `Budget: $${req.budgetUsd}. Getting around by ${req.mobility}. ` +
      `Vibes: ${req.vibes.join(", ") || "unspecified"}.`,
  ]
  for (const day of it.days) {
    const w = day.weather
    // Name the weekday. Given a bare "2026-09-05" the model guesses, and it
    // guessed Friday for a Saturday — in prose sitting directly under a
    // heading that said Saturday.
    const weekday = new Date(`${day.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })
    lines.push(`
${weekday} ${day.date}${w ? ` (${w.highF}F, ${w.summary}, ${w.precipChance}% rain)` : ""}:`)
    for (const item of day.items) {
      const c = item.scored.candidate
      const price = c.priceUsd === null ? "price unknown" : c.priceUsd === 0 ? "free" : `$${c.priceUsd}`
      lines.push(`- ${item.slot}: ${c.title} (${c.category}, ${price}). Evidence: ${c.evidence.slice(0, 160)}`)
    }
  }
  lines.push(`\nTotal cost: $${it.totalUsd.toFixed(0)}.`)
  return lines.join("\n")
}
