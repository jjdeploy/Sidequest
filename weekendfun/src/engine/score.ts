/**
 * Ranking: deterministic, explainable, and it works with the LLM switched off.
 *
 * Every candidate gets a score built from named components, and each component
 * keeps the sentence that justifies it. So `--explain` isn't a reconstruction
 * after the fact — it's literally the arithmetic that produced the ordering.
 * If a plan recommends something odd, you can see which term caused it.
 *
 * The learned weights (see learn.ts) only ever *scale* these components. That
 * keeps a cold-start run sensible: with no history, every learned weight is
 * 1.0 and this degrades to a decent generic ranker rather than to noise.
 */
import type { Candidate, Category, PlanRequest, Weather } from "../types.js"
import { milesBetween } from "../sources/util.js"
import type { Verdict } from "./relevance.js"
import { isWashout } from "../sources/weather.js"

export interface ScoreComponent {
  name: string
  points: number
  why: string
}

export interface Scored {
  candidate: Candidate
  score: number
  components: ScoreComponent[]
  /** Distinct sources that found it on this run. */
  corroboration: number
}

export interface ScoreContext {
  req: PlanRequest
  weather: Weather[]
  /** candidateId -> distinct source count, from Store.corroborationFor. */
  corroboration: Map<string, number>
  /** candidateId -> lifetime history, from Store.historyFor. */
  history: Map<string, { shown: number; kept: number; skipped: number; did: number; rating: number | null }>
  /** Learned taste vector. Missing keys default to 1.0 (neutral). */
  weights: Record<string, number>
  /** candidateId -> admission verdict, from engine/relevance.ts. */
  relevance: Map<string, Verdict>
  /** Categories the request actually asked about, from requestedCategories. */
  requested: Set<Category>
}

/** Categories that mostly happen outside, for the weather penalty. `indoor`
 *  on the candidate wins when a source actually told us. */
const OUTDOOR_CATEGORIES = new Set(["outdoors", "active"])

function learned(weights: Record<string, number>, key: string): number {
  const v = weights[key]
  return typeof v === "number" && Number.isFinite(v) ? v : 1.0
}

/** Travel tolerance by how the party is getting around. Miles. */
const REACH: Record<PlanRequest["mobility"], number> = {
  walk: 1.5,
  transit: 6,
  car: 25,
}

export function scoreCandidate(c: Candidate, ctx: ScoreContext): Scored {
  const parts: ScoreComponent[] = []
  const add = (name: string, points: number, why: string) => {
    if (points !== 0) parts.push({ name, points, why })
  }

  // ── Corroboration ────────────────────────────────────────────────────────
  // The strongest honest signal we have. Independent sources agreeing on a
  // place means far more than any single source's ranking, and it's the one
  // thing a parallel fan-out can compute that a single scraper cannot.
  const corr = ctx.corroboration.get(c.id) ?? 1
  if (corr > 1) {
    add("corroboration", (corr - 1) * 14, `${corr} independent sources found this`)
  }

  // ── Quality ──────────────────────────────────────────────────────────────
  // Rating alone is noise at low review counts — 5.0 from three people says
  // nothing. Scale the rating's contribution by confidence in it.
  if (c.rating !== null) {
    const reviews = c.reviewCount ?? 0
    // Confidence starts near zero for a handful of reviews. Without this a
    // 5.0-from-22-people gift shop outranked a 4.5-from-22,000 aquarium.
    const confidence = Math.min(1, Math.log10(reviews + 1) / 4)
    const above = c.rating - 3.8 // roughly the median for public venues
    add(
      "rating",
      above * 10 * (0.15 + 0.85 * confidence),
      `${c.rating.toFixed(1)}★${reviews ? ` from ${reviews.toLocaleString()} reviews` : " (few reviews)"}`,
    )
  }

  // Separate from rating: how many people have actually been. A place with
  // twenty thousand reviews is a real destination whatever its score, and a
  // weekend plan should lean on that.
  if ((c.reviewCount ?? 0) > 50) {
    add("well known", Math.log10(c.reviewCount!) * 2, `${c.reviewCount!.toLocaleString()} people have reviewed it`)
  }

  // ── What was actually asked for ──────────────────────────────────────────
  // Modest on purpose. This nudges the catalogue's ordering so the things you
  // asked about surface first; making sure at least one of them reaches the
  // plan is the itinerary's job, because that is a question about the shape
  // of a weekend rather than about how good a venue is.
  if (ctx.requested.has(c.category)) {
    add("you asked for this", 12, `you asked for something in "${c.category}"`)
  }

  // ── Timeliness ───────────────────────────────────────────────────────────
  // An aquarium is open every weekend of the year; a street festival is on
  // THIS Saturday and then it's gone. Without this the plan is just "the
  // city's top-rated permanent venues", which is the one thing you didn't
  // need eight browsers to find out.
  //
  // Timeliness, locality and "is this even a thing to do" are all decided by
  // the admission gate now — see engine/relevance.ts. Its findings arrive
  // already scored and already explained, so they become components verbatim
  // rather than being re-derived here from a different reading of the same
  // fields. That divergence is what let the bonus say "happening this
  // weekend" while only checking which website it came from.
  for (const f of ctx.relevance.get(c.id)?.findings ?? []) {
    if (f.points !== 0) add(f.dimension, f.points, f.why)
  }

  // ── Price fit ────────────────────────────────────────────────────────────
  const heads = Math.max(1, ctx.req.party.adults + ctx.req.party.kids)
  const perPersonBudget = ctx.req.budgetUsd / heads / Math.max(1, ctx.req.days.length)
  if (c.priceUsd === 0) {
    // Modest: stacked on the timeliness bonus, a bigger number let free
    // junk outrank everything worth actually doing.
    add("free", 5 * learned(ctx.weights, "w:free"), "free")
  } else if (c.priceUsd !== null) {
    const ratio = c.priceUsd / Math.max(1, perPersonBudget)
    if (ratio > 1) {
      // Over budget for a single item — not disqualifying (one splurge can be
      // the point of a weekend) but it has to earn its place.
      add("over budget", -Math.min(30, (ratio - 1) * 22), `$${c.priceUsd} vs ~$${Math.round(perPersonBudget)}/person/day`)
    } else {
      add("affordable", 6 * (1 - ratio), `$${c.priceUsd}, comfortably inside budget`)
    }
  } else {
    // Unknown is NOT free. An unpriced thing is a planning risk, so it takes a
    // small penalty — enough to break ties against a known price, not enough
    // to bury genuinely good options that simply didn't publish a number.
    add("price unknown", -5, "no price published")
  }

  // ── Evidence floor ───────────────────────────────────────────────────────
  // No rating, no reviews, and nobody else found it. Such a candidate is only
  // ever in the running because of the free and timeliness bonuses, which is
  // how a plan ended up recommending an airport ticketing information session.
  // Bonuses should lift things we have some reason to trust, not everything.
  if (c.rating === null && (c.reviewCount ?? 0) === 0 && corr === 1) {
    add("unverified", -10, "no rating, no reviews, and only one source saw it")
  }

  // ── Learned taste ────────────────────────────────────────────────────────
  const catWeight = learned(ctx.weights, `cat:${c.category}`)
  if (catWeight !== 1) {
    add(
      "your taste",
      (catWeight - 1) * 25,
      catWeight > 1
        ? `you've liked ${c.category} before`
        : `you've passed on ${c.category} before`,
    )
  }

  // ── Weather ──────────────────────────────────────────────────────────────
  // A constraint, not decoration: an 80%-rain Saturday should actually demote
  // outdoor plans in the ranking, not just print a warning next to them.
  const isOutdoor = c.indoor === false || (c.indoor === null && OUTDOOR_CATEGORIES.has(c.category))
  if (isOutdoor && ctx.weather.length > 0) {
    const bad = ctx.weather.filter(isWashout)
    if (bad.length === ctx.weather.length) {
      add("weather", -18, `outdoor, and every day looks like ${bad[0]!.summary}`)
    } else if (bad.length > 0) {
      add("weather", -7, `outdoor, and ${bad.length} of ${ctx.weather.length} days look wet`)
    }
  }
  if (!isOutdoor && ctx.weather.some(isWashout)) {
    add("indoor bonus", 5, "indoor, which suits the forecast")
  }

  // ── Reachability ─────────────────────────────────────────────────────────
  // Only Maps returns coordinates, so most candidates skip this rather than
  // being penalised for a missing field.
  if (c.lat !== undefined && c.lng !== undefined) {
    const miles = milesBetween({ lat: c.lat, lng: c.lng }, ctx.req.place)
    const reach = REACH[ctx.req.mobility]
    if (miles > reach) {
      add("too far", -Math.min(25, (miles - reach) * 2), `${miles.toFixed(1)} mi away, ${ctx.req.mobility}`)
    } else if (miles < reach * 0.3) {
      add("close by", 4, `${miles.toFixed(1)} mi from the centre`)
    }
  }

  // ── History ──────────────────────────────────────────────────────────────
  // The part that makes repeat runs feel like they know you.
  const h = ctx.history.get(c.id)
  if (h) {
    if (h.rating !== null) {
      add("you rated it", (h.rating - 3) * 12, `you rated this ${h.rating.toFixed(1)}/5`)
    }
    if (h.did > 0) {
      // You went. Worth suggesting again, but not ahead of something new.
      add("been there", -6, `you've already done this ${h.did}x`)
    }
    if (h.skipped >= 2 && h.kept === 0) {
      add("repeatedly skipped", -14, `shown ${h.shown}x, skipped every time`)
    }
    if (h.kept > 0) {
      add("previously kept", h.kept * 8, `you kept this in ${h.kept} earlier plan(s)`)
    }
  }

  const score = parts.reduce((sum, p) => sum + p.points, 0)
  return { candidate: c, score, components: parts, corroboration: corr }
}

/**
 * Merge duplicate sightings, then rank.
 *
 * Candidates arrive once per source. Merging keeps the richest version of each
 * field — Maps has coordinates, TripAdvisor has review counts, Time Out has
 * the readable blurb — so the merged row is better than any single source's.
 */
export function rank(candidates: Candidate[], ctx: ScoreContext): Scored[] {
  const merged = new Map<string, Candidate>()
  for (const c of candidates) {
    const prev = merged.get(c.id)
    if (!prev) {
      merged.set(c.id, { ...c })
      continue
    }
    // Take the rating from whichever source counted more reviews, so the
    // number shown matches the number stored (see store/db.ts) and a thin
    // source can't overwrite a well-evidenced score.
    const prevReviews = prev.reviewCount ?? 0
    const nextReviews = c.reviewCount ?? 0
    const better = nextReviews > prevReviews ? c : prev

    merged.set(c.id, {
      ...prev,
      priceUsd: prev.priceUsd ?? c.priceUsd,
      priceNote: prev.priceNote ?? c.priceNote,
      rating: better.rating ?? prev.rating ?? c.rating,
      reviewCount: Math.max(prevReviews, nextReviews) || (prev.reviewCount ?? c.reviewCount),
      lat: prev.lat ?? c.lat,
      lng: prev.lng ?? c.lng,
      address: prev.address ?? c.address,
      indoor: prev.indoor ?? c.indoor,
      // Prefer the longest evidence: it's the one that actually explains why.
      evidence: c.evidence.length > prev.evidence.length ? c.evidence : prev.evidence,
    })
  }

  return [...merged.values()]
    .map((c) => scoreCandidate(c, ctx))
    .sort((a, b) => b.score - a.score)
}

/** One-line "why this is here", for the plan output. */
export function explain(s: Scored, max = 3): string {
  return [...s.components]
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, max)
    .map((c) => c.why)
    .join("; ")
}
