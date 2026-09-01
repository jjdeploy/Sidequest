/**
 * What to actually search for — decided before a single browser launches.
 *
 * Two reasons this runs first rather than inline per source:
 *
 *  1. A browser session is a held resource. Deciding the query set while
 *     holding twelve of them open wastes the expensive thing to save the cheap
 *     thing. Plan on the CPU, then spend the sessions.
 *  2. It keeps the searches honest. Every query is derived from the user's
 *     stated request, so when a plan surfaces a dive bar you can trace it back
 *     to the "nightlife" vibe that asked for it.
 *
 * Entirely deterministic — no model in the path. `llm/intake.ts` can widen the
 * set from free text, but the planner works with it switched off.
 */
import type { Category, PlanRequest } from "../types.js"

export interface Keyword {
  /** The literal search term handed to a source. */
  term: string
  category: Category
  /** Why this term is here — shown in `--explain`, and it's what makes a
   *  surprising recommendation auditable instead of magic. */
  because: string
  /** Seed priority, 0..1. The learner's weights adjust this per user later. */
  weight: number
}

/** Vibe word -> the searches it justifies. Matched as substrings, so "date
 *  night" and "datenight" and "romantic date" all land on the same entry. */
const VIBE_TERMS: Record<string, Array<[string, Category]>> = {
  chill: [["coffee shops", "food"], ["parks", "outdoors"], ["bookstores", "shopping"], ["scenic viewpoints", "outdoors"]],
  outdoorsy: [["hiking trails", "outdoors"], ["parks", "outdoors"], ["kayaking", "active"], ["botanical garden", "outdoors"]],
  foodie: [["best restaurants", "food"], ["food halls", "food"], ["farmers market", "food"], ["dessert", "food"]],
  nightlife: [["cocktail bars", "drink"], ["live music venues", "music"], ["dance clubs", "nightlife"], ["breweries", "drink"]],
  cheap: [["free things to do", "other"], ["happy hour", "drink"], ["free museum days", "culture"], ["public parks", "outdoors"]],
  cultural: [["museums", "culture"], ["art galleries", "culture"], ["historic district", "culture"], ["theater", "culture"]],
  active: [["bike trails", "active"], ["climbing gym", "active"], ["kayak rental", "active"], ["walking tours", "active"]],
  romantic: [["rooftop bars", "drink"], ["waterfront restaurants", "food"], ["sunset spots", "outdoors"], ["wine bars", "drink"]],
  family: [["family attractions", "family"], ["children's museum", "family"], ["zoo", "family"], ["playgrounds", "family"]],
  touristy: [["top attractions", "culture"], ["landmarks", "culture"], ["observation deck", "culture"]],
  artsy: [["art galleries", "culture"], ["indie theater", "culture"], ["craft market", "shopping"], ["mural walk", "culture"]],
  sporty: [["sports bars", "drink"], ["games this weekend", "event"], ["golf", "active"]],
}

/** Always worth asking, whatever the vibe — these are what "what's on this
 *  weekend" actually means, and they're time-boxed so they can't be cached. */
const BASELINE: Array<[string, Category, string]> = [
  ["things to do this weekend", "event", "the baseline question anyone would ask"],
  ["events this weekend", "event", "dated, local, and the most perishable signal we have"],
]

function normalizeVibe(v: string): string[] {
  const s = v.toLowerCase().trim()
  const hits: string[] = []
  for (const key of Object.keys(VIBE_TERMS)) {
    if (s.includes(key)) hits.push(key)
  }
  // A few phrasings that don't contain their own key.
  if (/date|romantic|anniversary/.test(s)) hits.push("romantic")
  if (/kid|child|family|toddler/.test(s)) hits.push("family")
  if (/budget|broke|free|cheap/.test(s)) hits.push("cheap")
  if (/party|bar|club|drink/.test(s)) hits.push("nightlife")
  if (/art|museum|history|culture/.test(s)) hits.push("cultural")
  if (/hike|outside|outdoor|nature|beach/.test(s)) hits.push("outdoorsy")
  if (/eat|food|restaurant|dinner|brunch/.test(s)) hits.push("foodie")
  return [...new Set(hits)]
}

/**
 * Build the query set for a request.
 *
 * Returns at most `limit` keywords, highest weight first, deduped by term. The
 * cap matters: each keyword is a page load inside a source's browser, so an
 * unbounded set turns a 30-second fan-out into a five-minute one.
 */
export function buildKeywords(req: PlanRequest, limit = 12): Keyword[] {
  const out = new Map<string, Keyword>()

  const add = (term: string, category: Category, because: string, weight: number) => {
    const key = term.toLowerCase()
    const existing = out.get(key)
    // Two vibes asking for the same thing is evidence, not a duplicate — keep
    // the stronger justification and bump it.
    if (existing) {
      existing.weight = Math.min(1, existing.weight + 0.15)
      return
    }
    out.set(key, { term, category, because, weight })
  }

  for (const [term, category, because] of BASELINE) add(term, category, because, 0.9)

  for (const raw of req.vibes) {
    for (const vibe of normalizeVibe(raw)) {
      for (const [term, category] of VIBE_TERMS[vibe] ?? []) {
        add(term, category, `you asked for "${raw}"`, 0.75)
      }
    }
  }

  // Party shape overrides vibes — a plan with a 4-year-old in it needs family
  // options whether or not anyone said the word "family".
  if (req.party.kids > 0) {
    const ages = req.party.kidAges?.length ? ` (ages ${req.party.kidAges.join(", ")})` : ""
    for (const [term, category] of VIBE_TERMS.family!) {
      add(term, category, `you're bringing ${req.party.kids} kid(s)${ages}`, 0.85)
    }
  }

  // Budget drives the search, not just the filter. Asking for "free things to
  // do" finds options that filtering an expensive list never would.
  const perPersonPerDay = req.budgetUsd / Math.max(1, req.party.adults + req.party.kids) / Math.max(1, req.days.length)
  if (perPersonPerDay < 40) {
    for (const [term, category] of VIBE_TERMS.cheap!) {
      add(term, category, `budget works out to ~$${Math.round(perPersonPerDay)}/person/day`, 0.8)
    }
  }

  // Walkers can't reach the next town over; bias them toward density.
  if (req.mobility === "walk") {
    add("downtown walkable area", "other", "you're on foot, so density beats variety", 0.7)
  }

  const avoid = req.avoid.map((a) => a.toLowerCase())
  const kept = [...out.values()].filter(
    (k) => !avoid.some((a) => k.term.toLowerCase().includes(a) || k.category === a),
  )

  return kept.sort((a, b) => b.weight - a.weight).slice(0, limit)
}
