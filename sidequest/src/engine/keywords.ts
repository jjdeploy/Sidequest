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
import { isAdultOnly, partyIsOver21 } from "./age.js"

export interface Keyword {
  /** The literal search term handed to a source. */
  term: string
  category: Category
  /** Why this term is here — shown in `--explain`, and it's what makes a
   *  surprising recommendation auditable instead of magic. */
  because: string
  /** Seed priority, 0..1. Decides which terms survive the limit. */
  weight: number
  /**
   * They typed the word for this one themselves.
   *
   * A flag and not a high weight, because weight is already carrying two
   * other jobs — seed priority, and a corroboration bump when two vibes ask
   * for the same term. That bump takes 0.85 to 1.00, which sailed straight
   * over the numeric tier this replaced and put an inferred cocktail bar
   * back among the things the user had asked for.
   */
  said?: boolean
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
 * What a venue of this kind is actually called.
 *
 * A search term and a venue name are different registers. Almost no bowling
 * alley has "bowling" in its name — Palm Coast Lanes, Sky Lanes, Star Bowl,
 * AMF. An arcade is a Retrocade, a music venue is a Hall, a cinema is a
 * Cinema. Matching the literal word finds one alley by luck and misses the
 * rest of the country.
 *
 * Hand-written, and that is fine here: the left-hand column is not open
 * text. Every term this is ever asked about comes from the closed vocabulary
 * in this file, so the table has a finite job and a visible edge.
 *
 * The patterns are deliberately loose — "lanes" is in Memory Lane Antiques,
 * "hall" is in City Hall — because engine/itinerary.ts only lets an alias
 * decide anything when the listing is ALSO filed under the category the
 * request was for. A loose name and the right category is a bowling alley;
 * a loose name on its own is a coincidence.
 */
const ALSO_CALLED: Record<string, RegExp> = {
  bowling: /\b(?:lanes?|alley|bowl\w*|strike)\b/i,
  arcades: /\b(?:arcade|barcade|retrocade|pinball|amusements?)\b/i,
  "dance clubs": /\b(?:clubs?|disco\w*|dance\w*|dj|nightlife)\b/i,
  "cocktail bars": /\b(?:bars?|lounges?|taverns?|cocktails?|speakeas\w*)\b/i,
  "wine bars": /\b(?:wine|vino|cellars?|winer\w*)\b/i,
  "sports bars": /\b(?:sports?|bars?|taverns?|pubs?)\b/i,
  "rooftop bars": /\b(?:rooftop|terrace|sky ?bar|top of)\b/i,
  breweries: /\b(?:brewer\w*|brewing|brewpubs?|taprooms?|ale\w*|beer)\b/i,
  "live music venues": /\b(?:music|amphitheat\w*|halls?|stage|venue|listening room|opry)\b/i,
  "movie theater": /\b(?:cinemas?|theat\w*|drive-?in|imax)\b/i,
  "mini golf": /\b(?:golf|putt\w*|links)\b/i,
  "climbing gym": /\b(?:climb\w*|boulder\w*|crag)\b/i,
  kayaking: /\b(?:kayak\w*|paddle\w*|canoe|tubing|outfitters?)\b/i,
  "bike trails": /\b(?:bikes?|cycl\w*|greenway|trail)\b/i,
  "hiking trails": /\b(?:trails?|greenway|preserve|forest|falls|summit|ridge|gorge|overlook)\b/i,
  parks: /\b(?:parks?|gardens?|greenway|commons?|square|riverwalk)\b/i,
  museums: /\b(?:museums?|galler\w*|collection|historic\w*|heritage)\b/i,
  "art galleries": /\b(?:galler\w*|arts?|studios?|glassworks|pottery|makers?)\b/i,
  "coffee shops": /\b(?:coffee|espresso|roaster\w*|cafes?|café)\b/i,
  bookstores: /\b(?:books?|bookshop|bookstore|libr\w*)\b/i,
  "farmers market": /\b(?:markets?|farmers?|grower\w*)\b/i,
  restaurants: /\b(?:restaurants?|kitchens?|grille?|bistro|diner|eatery)\b/i,
}

/**
 * Does this venue name answer that search term?
 *
 * The NAME, never the description. Reading the whole listing booked Biltmore
 * Estate as an evening of bowling — the house has a two-lane alley in the
 * basement, so the word really is in the blurb. What a listing is called is a
 * claim about what it is; what its description mentions in passing is not.
 */
export function answersTo(term: string, title: string): boolean {
  if (mentions(term, title)) return true
  return ALSO_CALLED[term.toLowerCase()]?.test(title) ?? false
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
 * Marking the terms the user typed the word for themselves.
 *
 * The vocabulary above expands one word into a family of searches, which is
 * exactly what you want a search to do — "clubbing" should go looking for
 * dance clubs AND cocktail bars AND live music, because a town might call
 * its one club any of those. It is not what you want a REQUEST to do.
 *
 * "bowling at night, clubbing the other night" expanded to five asked-for
 * categories. engine/itinerary.ts reserves an evening slot for each and
 * holds each out of every other slot to keep it free — so five reservations
 * chased two evenings, an inferred cocktail bar won one of them, and the
 * bowling the user had actually typed was pushed out of the remaining four
 * slots by its own reservation and never appeared at all.
 *
 * So the expansion still searches, and only the words they said reserve.
 */

/**
 * Does this text contain the term, near enough?
 *
 * Crude stemming on purpose. "clubbing" has to reach the term "dance clubs"
 * and "bowling" has to reach "bowling", and nothing subtler than a common
 * prefix is needed for that. The four-character floor keeps "bar" out of
 * "barbecue" and stops two-letter words matching everything.
 *
 * Asked twice of every term, of two different texts: did the user write it,
 * and does this candidate answer it. engine/itinerary.ts asks the second —
 * a reservation made for the word "bowling" should be spent on a bowling
 * alley, not on whatever else in town happens to be filed under `active`.
 */
export function mentions(term: string, text: string): boolean {
  const hay = text.toLowerCase()
  return term.toLowerCase().split(/\s+/).some((w) => {
    const stem = w.replace(/(?:ies|ing|es|s)$/, "")
    return stem.length >= 4 && hay.includes(stem)
  })
}

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
  // When any term came from their own words, those are the request and the
  // rest of the expansion is just search. With no free text — mood chips
  // only — nothing reaches that tier and the vibes are all we have.
  const said = keywords.filter((k) => k.said)
  const source = said.length > 0 ? said : keywords.filter((k) => k.weight >= ASKED_FOR)
  return new Set(source.map((k) => k.category))
}

/**
 * When they said they wanted it, read straight from their own words.
 *
 * This existed only as a field the LLM filled in, which made it a coin flip:
 * the same sentence returned `timeOfDay: "evening"` on one run and nothing
 * on the next, and with nothing the reserved slot fires at the first hour of
 * the weekend — so "bowling at night" came back as bowling at 10am, then
 * correctly, then at 10am again.
 *
 * A model is the right tool for reading an unusual request. It is the wrong
 * tool for a decision that has to be the same every time, and "does this
 * sentence say evening" is not a hard question.
 */
export function timeOfDayFrom(text: string): PlanRequest["timeOfDay"] {
  const s = text.toLowerCase()
  if (/\b(night|nights|tonight|evening|after dark|nightcap|late)\b|\d\s*pm\b/.test(s)) return "evening"
  if (/\b(morning|mornings|breakfast|brunch|early|sunrise)\b|\d\s*am\b/.test(s)) return "morning"
  if (/\b(afternoon|afternoons|midday|lunch|lunchtime)\b/.test(s)) return "afternoon"
  return undefined
}

/**
 * The same words, removed.
 *
 * "bowling at night" is one activity and one time. Feeding the whole
 * sentence to the vibe vocabulary matched "night" as nightlife as well, so a
 * request for bowling quietly became a request for bowling AND cocktail bars
 * AND live music AND breweries — five categories, all pinned to the two
 * evening slots, and the bowling lost. A time phrase is consumed by
 * timeOfDayFrom; it must not also be read as a mood.
 */
export function stripTimeWords(text: string): string {
  return text
    // "at night", "in the morning" — the preposition goes with it.
    .replace(/\b(?:at|in|on|during|this|the)\s+(?:night|nights|tonight|evening|evenings|morning|mornings|afternoon|afternoons|midday|sunrise)\b/gi, " ")
    // ...and the bare word on its own.
    .replace(/\b(?:night|nights|tonight|evening|evenings|morning|mornings|afternoon|afternoons|midday|sunrise|after dark)\b/gi, " ")
    .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, " ")
    // What the removal leaves behind. "clubbing the other night" becomes
    // "clubbing the other", which reads like the parser gave up halfway and
    // is shown to the user verbatim in the hint under the search box.
    .replace(/\b(?:the\s+)?other\b(?=\s*[,.]|\s*$)/gi, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/[\s,]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
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
  // "a night out" and "after dark" contain none of the vocabulary's own keys,
  // so nothing matched at all and the floor took over — which is how
  // "bowling at night" ended up asking for nothing in particular.
  if (/party|bar|club|drink|night|evening|after dark/.test(s)) hits.push("nightlife")
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

  // Everyone is 21, or nobody is. See engine/age.ts.
  const adult = partyIsOver21(req)

  const add = (term: string, category: Category, because: string, weight: number) => {
    // Don't spend a browser on a room the party can't enter.
    //
    // The admission gate would throw these results away anyway, so this is
    // not the safety check — it is the budget. Each keyword is one of eight
    // browsers, and "cocktail bars" was taking one of them to produce a page
    // of candidates already decided against. Refusing here rather than
    // filtering the finished list also lets the floor top the set back up,
    // so a nightlife request from a 19-year-old still comes back with eight
    // real searches instead of four.
    if (!adult && isAdultOnly({ title: term, category })) return
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

  // 5. Ticking 21+ has to change the search, or it is decorative.
  //
  //    Deliberately below ASKED_FOR: engine/itinerary.ts reserves a slot for
  //    every category at or above that weight, and 21+ is permission, not a
  //    request. It should make a bar POSSIBLE, not compulsory — somebody who
  //    ticks the box and asks for hiking wants hiking.
  if (adult) {
    add("cocktail bars", "drink", "you said the party is 21+", 0.7)
    add("breweries", "drink", "you said the party is 21+", 0.7)
  }

  // 6. The floor.
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

  // Promote the terms they wrote the word for. Done here rather than in the
  // vibe loop because a term can arrive from several vibes at once, and what
  // matters is whether the finished term is one they said.
  const said = req.vibes.join(" ").toLowerCase()
  for (const k of out.values()) {
    if (mentions(k.term, said)) k.said = true
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
