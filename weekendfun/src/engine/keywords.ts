/**
 * What to actually search for — decided before a single browser launches.
 *
 * Two reasons this runs first rather than inline per source:
 *
 *  1. A browser session is a held resource. Deciding the query set while
 *     holding a dozen of them open wastes the expensive thing to save the
 *     cheap thing. Plan on the CPU, then spend the sessions.
 *  2. It keeps the searches honest. Every query is derived from the user's
 *     stated request, so when a plan surfaces a dive bar you can trace it
 *     back to the "nightlife" vibe that asked for it.
 *
 * ── Who reads these ───────────────────────────────────────────────────────
 *
 * Only Google Maps. The other five sources browse fixed city feeds and never
 * look at a keyword. That matters more than it sounds: this list used to open
 * with "things to do this weekend" and "events this weekend", which are
 * event-shaped questions Maps answers badly, and no event source ever saw
 * them. Now that Maps gets one browser per keyword, those two terms were
 * spending two of eight browsers on nothing.
 *
 * So every term here is a PLACE term — the kind of thing Maps is a directory
 * of. "bowling", "museums", "breweries". Dated events are the event sources'
 * job and they don't need to be asked.
 *
 * ── The invariant ─────────────────────────────────────────────────────────
 *
 * The learned taste vector must never reach this function. Weights scale
 * scores in engine/score.ts; intent chooses queries here; the two never
 * touch. If learning could narrow the search, a category rated badly once
 * would stop being searched, and therefore stop being shown, and therefore
 * never recover — a collapse that is invisible from the outside because the
 * results still look plausible. Ranking-only is the whole safeguard.
 *
 * Entirely deterministic — no model in the path. `--ask` can widen the set
 * from free text, but the planner works with it switched off.
 */
import { CATEGORIES, type Category, type PlanRequest } from "../types.js"

export interface Keyword {
  /** The literal search term handed to a source. */
  term: string
  category: Category
  /** Why this term is here — shown in `--explain`, and it's what makes a
   *  surprising recommendation auditable instead of magic. */
  because: string
  /** Seed priority, 0..1. Decides which terms survive the limit. */
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
  active: [["bowling", "active"], ["bike trails", "active"], ["climbing gym", "active"], ["mini golf", "active"]],
  romantic: [["rooftop bars", "drink"], ["waterfront restaurants", "food"], ["sunset spots", "outdoors"], ["wine bars", "drink"]],
  family: [["family attractions", "family"], ["children's museum", "family"], ["mini golf", "active"], ["playgrounds", "family"]],
  touristy: [["tourist attractions", "culture"], ["landmarks", "culture"], ["observation deck", "culture"]],
  artsy: [["art galleries", "culture"], ["indie theater", "culture"], ["craft market", "shopping"], ["mural walk", "culture"]],
  sporty: [["sports bars", "drink"], ["bowling", "active"], ["golf", "active"]],
  // Wet-weather and "we just want somewhere to go" intent. Maps indexes all
  // of these densely, which is exactly what a thin city needs.
  indoors: [["bowling", "active"], ["arcades", "active"], ["museums", "culture"], ["movie theater", "culture"]],
}

/**
 * The floor: one strong Maps term per category the itinerary needs to fill.
 *
 * This is the "I'm new here and bored" query set, and it exists because the
 * old fallback was two event phrases. A Palm Coast run with no stated vibes
 * searched only "things to do this weekend" and "events this weekend", so the
 * town's bowling alley was never a near miss — it was never queried.
 *
 * Ordered by how much a stranger to a city actually wants them.
 */
const FLOOR: Array<[string, Category, string]> = [
  ["tourist attractions", "culture", "the first thing anyone new to a city looks up"],
  ["restaurants", "food", "everyone eats, and it anchors the evening slot"],
  ["parks", "outdoors", "free, open, and the most reliable thing in a small town"],
  ["museums", "culture", "the wet-weather answer"],
  ["bowling", "active", "something to actually do, not just somewhere to stand"],
  ["live music venues", "music", "what an evening is for"],
  ["breweries", "drink", "where a town's evening actually happens"],
  ["family attractions", "family", "covers the slot a group with kids needs"],
]

/** Below this many terms we're not using the browsers we have, so top up
 *  from the floor. Eight is the Maps shard cap. */
const MIN_TERMS = 5

/**
 * Weight above which a term came from the request rather than the floor.
 *
 * Vibes are 0.85, party 0.9, budget 0.8; the floor is 0.45–0.55 and the
 * mobility nudge is 0.7. Everything at or above this was asked for, one way
 * or another, which is what downstream needs to know.
 */
const ASKED_FOR = 0.75

/**
 * The categories the user actually asked about.
 *
 * Search intent has to reach ranking, not just querying. Typing "bowling"
 * found Palm Coast Lanes and then ranked it below a park nobody mentioned,
 * because the scorer only ever saw generic quality — a 4.0 with no review
 * count loses to a 4.7 from 268 reviews every time, and should, unless
 * somebody asked for bowling.
 */
export function requestedCategories(keywords: Keyword[]): Set<Category> {
  return new Set(keywords.filter((k) => k.weight >= ASKED_FOR).map((k) => k.category))
}

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
  if (/rain|indoor|inside|bowling|arcade/.test(s)) hits.push("indoors")
  if (/sport|game|golf/.test(s)) hits.push("sporty")
  return [...new Set(hits)]
}

/**
 * Build the query set for a request.
 *
 * Returns at most `limit` keywords, highest weight first, deduped by term.
 * The cap matters: each keyword is now a whole browser, so an unbounded set
 * would eat the concurrency budget the other five sources need.
 */
export function buildKeywords(req: PlanRequest, limit = 8): Keyword[] {
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

  // 1. What the user actually asked for, which always outranks the floor.
  for (const raw of req.vibes) {
    for (const vibe of normalizeVibe(raw)) {
      for (const [term, category] of VIBE_TERMS[vibe] ?? []) {
        add(term, category, `you asked for "${raw}"`, 0.85)
      }
    }
  }

  // 2. Party shape overrides vibes — a plan with a 4-year-old in it needs
  //    family options whether or not anyone said the word "family".
  if (req.party.kids > 0) {
    const ages = req.party.kidAges?.length ? ` (ages ${req.party.kidAges.join(", ")})` : ""
    for (const [term, category] of VIBE_TERMS.family!) {
      add(term, category, `you're bringing ${req.party.kids} kid(s)${ages}`, 0.9)
    }
  }

  // 3. Budget drives the search, not just the filter. Asking for "free things
  //    to do" finds options that filtering an expensive list never would.
  const perPersonPerDay =
    req.budgetUsd / Math.max(1, req.party.adults + req.party.kids) / Math.max(1, req.days.length)
  if (perPersonPerDay < 40) {
    for (const [term, category] of VIBE_TERMS.cheap!) {
      add(term, category, `budget works out to ~$${Math.round(perPersonPerDay)}/person/day`, 0.8)
    }
  }

  // 4. Walkers can't reach the next town over; bias them toward density.
  if (req.mobility === "walk") {
    add("downtown walkable area", "other", "you're on foot, so density beats variety", 0.7)
  }

  // 5. The floor.
  //
  //    Only tops up — it never overrides stated intent, because "don't search
  //    restaurants if they didn't ask about food" is the whole point of
  //    deriving queries from a request. It fires when someone said nothing at
  //    all (the common case for "I'm bored, what's here?"), and it skips
  //    categories the vibes already cover so a request for "outdoorsy" doesn't
  //    get parks twice.
  if (out.size < MIN_TERMS) {
    const covered = new Set([...out.values()].map((k) => k.category))
    for (const [term, category, because] of FLOOR) {
      if (out.size >= Math.max(MIN_TERMS, limit)) break
      if (covered.has(category)) continue
      covered.add(category)
      add(term, category, because, 0.55)
    }
    // Still thin — a single narrow vibe in a small town. Fill from the floor
    // regardless of category rather than launch three browsers out of eight.
    for (const [term, category, because] of FLOOR) {
      if (out.size >= MIN_TERMS) break
      add(term, category, because, 0.45)
    }
  }

  const avoid = req.avoid.map((a) => a.toLowerCase()).filter(Boolean)
  const kept = [...out.values()].filter(
    (k) =>
      !avoid.some(
        (a) => k.term.toLowerCase().includes(a) || (CATEGORIES as string[]).includes(a) && k.category === a,
      ),
  )

  return kept.sort((a, b) => b.weight - a.weight).slice(0, limit)
}
