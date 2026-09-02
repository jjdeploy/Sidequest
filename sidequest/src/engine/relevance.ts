/**
 * The candidate admission gate.
 *
 * `solari/geo.ts` refuses to let a source search until the browser proves
 * where it is. This is the same idea one layer down: nothing enters the plan
 * until it has been asked whether it is actually about what you requested.
 *
 * Every bug worth fixing in this repo has been the same shape — a source
 * produced something plausible and nobody checked:
 *
 *   a September 19th festival planned for the 5th   (nobody checked the date)
 *   a Palm Coast concert in a Tampa weekend         (nobody checked the place)
 *   "earn CE credits" as a Saturday night out       (only two sources checked)
 *   "&amp; Ho... Read more" stored as an address    (nobody checked the text)
 *
 * Each of those was fixed where it was found, which is why the next one kept
 * happening somewhere else. So the checks live here, in one place, and run
 * over every candidate from every source. Adding a source no longer means
 * remembering a checklist; adding a check covers the sources that already
 * exist and the ones that don't yet.
 *
 * Three rules the checks obey:
 *
 *  1. **Unknown is not a failure.** 70% of candidates carry no coordinates at
 *     all. Treating "we can't tell" as "it's fine" is how Palm Coast got in;
 *     treating it as "it's wrong" would throw away most of the plan. It gets
 *     its own state and it gets counted, so the gaps are visible.
 *
 *  2. **Fatal only on hard evidence.** Coordinates and a site's own published
 *     distance are unambiguous, so they can reject outright. A city name
 *     matched in free text cannot be — "Orlando's Bar" is a real Tampa venue —
 *     so that tier only ever costs points.
 *
 *  3. **Findings carry their reason.** They become score components verbatim,
 *     so a rejection is as inspectable as an endorsement.
 */
import type { Candidate, Place, PlanRequest } from "../types.js"
import { milesBetween } from "../sources/util.js"
import { isErrandKind, isJunkEvent } from "../sources/util.js"
import { isDegenerate } from "../sources/text.js"
import { eventDateOf, prettyDate } from "../sources/when.js"
import { isAdultOnly, partyIsOver21 } from "./age.js"

export type Dimension = "place" | "time" | "kind" | "age"
export type State = "ok" | "fail" | "unknown"

export interface Finding {
  dimension: Dimension
  state: State
  /** Shown to the user verbatim, in `--explain` and in the dashboard. */
  why: string
  /** Score adjustment. Negative for failures; 0 for ok and unknown. */
  points: number
  /** Set when the check proved the candidate does not belong in the plan. */
  fatal: boolean
}

export interface Verdict {
  findings: Finding[]
  /** True when any check proved this does not belong. The itinerary refuses
   *  these outright rather than merely ranking them low. */
  fatal: boolean
}

export interface ScreenContext {
  place: Place
  req: PlanRequest
  /** Resolve a locality name to coordinates, or null when it isn't a place.
   *  Injected so the gate stays synchronous-testable and the caller owns the
   *  network and the cache. */
  resolveLocality?: (name: string) => Promise<{ lat: number; lng: number } | null>
}

/**
 * How far out of town is too far, by how the party is getting around.
 *
 * Generous on purpose: this rejects, so it should only fire on things nobody
 * would call local. The itinerary's own hop penalties do the fine-grained
 * work of keeping a day's travel sane.
 */
const MAX_MILES: Record<PlanRequest["mobility"], number> = { walk: 12, transit: 25, car: 45 }

/** Beyond this, a text-matched locality is far enough to be worth saying so. */
const SUSPICIOUS_MILES = 45

// ─────────────────────────────────────────────────────────────────── place

/** A distance the site itself published, e.g. Groupon's "West Boise, Meridian7.3 mi". */
function publishedMiles(c: Candidate): number | null {
  const hay = `${c.evidence} ${c.address ?? ""}`
  // `mi\b` requires a word boundary AFTER "mi", and Groupon writes its
  // distance with nothing after it: "West Boise, Meridian7.3 mi4.3(15)".
  // So the one source that publishes its own distance was the one source
  // this never read. The lookahead accepts a digit or punctuation next
  // while still refusing "5 min" and "miles".
  const m = hay.match(/(\d{1,3}(?:\.\d)?)\s*mi(?![a-z])/i)
  if (!m) return null
  const miles = Number(m[1])
  return Number.isFinite(miles) ? miles : null
}

/**
 * Locality names a listing mentions, most specific first.
 *
 * Sites put the location at the end of a card and separate it with one of a
 * small set of delimiters. That is a convention of listing pages generally,
 * not a quirk of any one site here, which is why it is worth reading in the
 * shared gate rather than in six scrapers.
 */
function localityMentions(c: Candidate): string[] {
  const out: string[] = []
  const push = (s: string | undefined) => {
    const v = s?.trim()
    // Two words or fewer keeps this to place-shaped tokens rather than
    // sentences, and drops anything with digits (street addresses, times).
    if (v && v.length >= 4 && v.length <= 40 && !/\d/.test(v) && v.split(/\s+/).length <= 3) {
      if (!out.includes(v)) out.push(v)
    }
  }

  // The segment after a location delimiter, when there is one.
  for (const sep of [" @ ", " · ", " • "]) {
    const parts = c.evidence.split(sep)
    if (parts.length > 1) push(parts[parts.length - 1])
  }
  // The tail of a comma-separated address is a locality nearly everywhere.
  if (c.address?.includes(",")) push(c.address.split(",").pop() ?? undefined)

  return out.slice(0, 2)
}

async function checkPlace(c: Candidate, ctx: ScreenContext): Promise<Finding> {
  const limit = MAX_MILES[ctx.req.mobility]

  // Tier 1: real coordinates. Unambiguous, so it may reject.
  if (c.lat !== undefined && c.lng !== undefined) {
    const miles = milesBetween(ctx.place, { lat: c.lat, lng: c.lng })
    return miles > limit
      ? { dimension: "place", state: "fail", fatal: true, points: -60,
          why: `${miles.toFixed(0)} mi from ${ctx.place.city} — outside a ${ctx.req.mobility} trip` }
      : { dimension: "place", state: "ok", fatal: false, points: 0,
          why: `${miles.toFixed(1)} mi from the centre` }
  }

  // Tier 2: a distance the site published itself. Also unambiguous.
  const stated = publishedMiles(c)
  if (stated !== null) {
    return stated > limit
      ? { dimension: "place", state: "fail", fatal: true, points: -60,
          why: `the listing says ${stated} mi out — outside a ${ctx.req.mobility} trip` }
      : { dimension: "place", state: "ok", fatal: false, points: 0,
          why: `the listing says ${stated} mi out` }
  }

  // Tier 3: a locality named in the text. Fuzzy, so it only ever costs points.
  if (ctx.resolveLocality) {
    for (const name of localityMentions(c)) {
      const hit = await ctx.resolveLocality(name)
      if (!hit) continue
      const miles = milesBetween(ctx.place, hit)
      if (miles > SUSPICIOUS_MILES) {
        return { dimension: "place", state: "fail", fatal: false, points: -35,
          why: `looks like it's in ${name}, about ${miles.toFixed(0)} mi from ${ctx.place.city}` }
      }
      return { dimension: "place", state: "ok", fatal: false, points: 0, why: `in ${name}` }
    }
  }

  return { dimension: "place", state: "unknown", fatal: false, points: 0,
    why: "no location published — can't confirm it's local" }
}

// ──────────────────────────────────────────────────────────────────── time

function checkTime(c: Candidate, ctx: ScreenContext): Finding {
  const when = eventDateOf(c)
  if (when === null) {
    // A venue is open every weekend; that is not the same as not knowing.
    const dated = c.source === "eventbrite" || c.source === "allevents"
    return dated
      ? { dimension: "time", state: "unknown", fatal: false, points: 5,
          why: "an event rather than an everyday venue, though the listing didn't say when" }
      : { dimension: "time", state: "ok", fatal: false, points: 0, why: "an everyday venue" }
  }
  if (ctx.req.days.includes(when)) {
    return { dimension: "time", state: "ok", fatal: false, points: 16,
      why: `on ${prettyDate(when)}, one of the days you asked for` }
  }
  return { dimension: "time", state: "fail", fatal: true, points: -45,
    why: `dated ${prettyDate(when)}, which isn't this weekend` }
}

// ──────────────────────────────────────────────────────────────────── kind

function checkKind(c: Candidate): Finding {
  // An extraction that produced two characters is not a venue. cleanField
  // already recognises these, but buildCandidate has to return SOMETHING, so
  // it falls back to the raw title and a card reading "Ba" reaches the plan.
  // Rejecting is the gate's job, not the builder's.
  if (isDegenerate(c.title)) {
    return { dimension: "kind", state: "fail", fatal: true, points: -60,
      why: `the title came back as "${c.title}" — the scrape didn't find a real name` }
  }

  // This filter used to live inside two scrapers, so a networking seminar
  // from any other source sailed through. It is not about events; it is
  // about whether something is a way to spend a weekend.
  if (isJunkEvent(c.title, c.evidence)) {
    return { dimension: "kind", state: "fail", fatal: true, points: -60,
      why: "reads as business, admin or virtual programming rather than a weekend out" }
  }

  // The source said what it is, and what it is is an errand.
  //
  // "Big Frog Custom T-Shirts & More" took a Saturday morning in Palm Coast
  // and "Slingin' Wood Pro Shop" — a bowling SUPPLY retailer — took an
  // Asheville afternoon, both because a search found them and nothing ever
  // asked what they were. Maps had written it on the card.
  if (isErrandKind(c.kind)) {
    return { dimension: "kind", state: "fail", fatal: true, points: -60,
      why: `the listing calls itself a ${c.kind!.toLowerCase()} — somewhere you go when something needs doing` }
  }
  return { dimension: "kind", state: "ok", fatal: false, points: 0, why: "a real thing to go and do" }
}

// ───────────────────────────────────────────────────────────────────── age

/**
 * The 21+ gate.
 *
 * The only check here whose answer depends on the party rather than on the
 * listing, and the only one where the user has explicitly asked for a hard
 * line. Everything else in this file is trying to work out whether a listing
 * is what it claims to be; this one already knows, and is asking whether the
 * people going are allowed in.
 *
 * Fatal in one direction only. Ticking 21+ opens the bars; it never closes
 * the aquarium.
 */
function checkAge(c: Candidate, ctx: ScreenContext): Finding {
  if (!isAdultOnly(c)) {
    return { dimension: "age", state: "ok", fatal: false, points: 0, why: "nobody gets carded for this" }
  }
  return partyIsOver21(ctx.req)
    ? { dimension: "age", state: "ok", fatal: false, points: 0,
        why: "a 21+ room, and you said the party is 21+" }
    : { dimension: "age", state: "fail", fatal: true, points: -60,
        why: "a 21-and-over room — tick 21+ if that's your party" }
}

// ────────────────────────────────────────────────────────────────── screen

export interface ScreenSummary {
  total: number
  admitted: number
  rejected: number
  /** dimension -> how many candidates each state applied to. */
  byDimension: Record<Dimension, { ok: number; fail: number; unknown: number }>
}

/**
 * Judge every candidate. Nothing is dropped here — the verdict travels with
 * the candidate so ranking can explain it and the itinerary can refuse it.
 * Deleting rejects outright would make corroboration counts and the
 * dashboard's candidate total quietly disagree with what was found.
 */
export async function screen(
  candidates: Candidate[],
  ctx: ScreenContext,
): Promise<{ verdicts: Map<string, Verdict>; summary: ScreenSummary }> {
  const verdicts = new Map<string, Verdict>()
  const summary: ScreenSummary = {
    total: candidates.length,
    admitted: 0,
    rejected: 0,
    byDimension: {
      place: { ok: 0, fail: 0, unknown: 0 },
      time: { ok: 0, fail: 0, unknown: 0 },
      kind: { ok: 0, fail: 0, unknown: 0 },
      age: { ok: 0, fail: 0, unknown: 0 },
    },
  }

  for (const c of candidates) {
    // One verdict per distinct candidate: the same venue found by three
    // sources is one thing, and screening it three times would triple its
    // penalties when the scorer merges them.
    if (verdicts.has(c.id)) continue

    const findings = [await checkPlace(c, ctx), checkTime(c, ctx), checkKind(c), checkAge(c, ctx)]
    const fatal = findings.some((f) => f.fatal)
    verdicts.set(c.id, { findings, fatal })

    for (const f of findings) summary.byDimension[f.dimension][f.state]++
    if (fatal) summary.rejected++
    else summary.admitted++
  }

  return { verdicts, summary }
}

/** Neutral verdict, for candidates the gate never saw. */
export const ADMITTED: Verdict = { findings: [], fatal: false }
