/** Shared extraction helpers. Kept boring on purpose — every source depends
 *  on these behaving identically, or the dedupe and the scorer disagree. */
import { createHash } from "node:crypto"
import { cleanField } from "./text.js"
import type { Candidate, Category, SourceId } from "../types.js"

/**
 * Stable candidate id: same venue, same id, across runs AND across sources.
 *
 * Title only — deliberately NOT the coordinates. Only Google Maps returns
 * geometry, so hashing position too gave "The Florida Aquarium" three
 * different ids when Maps, TripAdvisor and Time Out all found it, and the
 * cross-source agreement that should have made it a top pick vanished.
 * Merging on the name is what makes corroboration work, and it's also what
 * lets the learner say "you have skipped this place three times".
 *
 * The tradeoff is two genuinely different venues sharing a name in one city.
 * That is rare, and the cost is one merged row — much cheaper than losing
 * every corroboration signal in the system.
 */
export function candidateId(title: string): string {
  const norm = title
    .toLowerCase()
    // Drop listicle numbering ("1. Busch Gardens") and the possessive/
    // punctuation noise that differs between sources.
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
  return createHash("sha1").update(norm).digest("hex").slice(0, 16)
}

export function parsePrice(raw: string | null | undefined): { usd: number | null; note?: string } {
  if (!raw) return { usd: null }
  const s = raw.trim()
  if (!s) return { usd: null }

  if (/\bfree\b|\bno cover\b|\$0\b/i.test(s)) return { usd: 0, note: s }

  // "$12", "$12.50", "From $25", "$15 - $40". A range is a range: take the
  // midpoint rather than the low end, or "$1-10" reports as a $1 dinner.
  // A hyphenated range often carries only one "$" ("$1-10"), so look for that
  // shape explicitly before falling back to counting dollar signs.
  const hyphenRange = s.match(/\$\s?(\d+(?:\.\d{1,2})?)\s*[-\u2013\u2014]\s*\$?\s?(\d+(?:\.\d{1,2})?)/)
  if (hyphenRange) {
    const lo = Number(hyphenRange[1])
    const hi = Number(hyphenRange[2])
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return { usd: Math.round(((lo + hi) / 2) * 100) / 100, note: s }
    }
  }

  const money = s.match(/\$\s?(\d+(?:\.\d{1,2})?)/g)
  if (money && money.length > 0) {
    const values = money
      .map((m) => Number(m.replace(/[^0-9.]/g, "")))
      .filter((n) => !Number.isNaN(n))
    if (values.length === 1) return { usd: values[0]!, note: s }
    if (values.length > 1) {
      const lo = Math.min(...values)
      const hi = Math.max(...values)
      return { usd: Math.round(((lo + hi) / 2) * 100) / 100, note: s }
    }
  }

  // Yelp/Maps style "$$" bands. Rough midpoints, per person.
  const band = s.match(/^\s*(\$+)\s*$/)
  if (band) {
    const n = band[1]!.length
    return { usd: [10, 25, 55, 100][n - 1] ?? 25, note: `${band[1]} (estimated)` }
  }

  return { usd: null, note: s }
}

export function parseRating(raw: string | null | undefined): number | null {
  if (!raw) return null
  const m = raw.match(/(\d(?:\.\d)?)\s*(?:star|\/\s*5|out of 5)?/i)
  if (!m) return null
  const n = Number(m[1])
  return n >= 0 && n <= 5 ? n : null
}

export function parseReviewCount(raw: string | null | undefined): number | null {
  if (!raw) return null
  const s = raw.replace(/,/g, "")
  // Must be anchored to something that actually means "review count" — either
  // parentheses, as Maps and TripAdvisor render it ("4.7(1234)"), or the word
  // itself. A bare leading number matched the "4" in "4.7 stars" and every
  // venue in the plan came out with exactly 4 reviews.
  const paren = s.match(/\((\d{1,8})\)/)
  if (paren) return Number(paren[1])
  const worded = s.match(/(\d{1,8})\s*(?:reviews?|ratings?)\b/i)
  if (worded) return Number(worded[1])
  return null
}

/** Keyword-driven category guess, used when a source doesn't say. */
export function guessCategory(text: string, fallback: Category = "other"): Category {
  const s = text.toLowerCase()
  const rules: Array<[RegExp, Category]> = [
    // Every pattern is word-anchored. Four of these were not, and each
    // unanchored token found a word to hide in: "art" matched "Block
    // P-art-y" and filed a street party under culture, "park" matched
    // "S-park-man Wharf", "zoo" matched "Bazooka". The category is not
    // cosmetic — it is what feedback teaches the learner about, so a wrong
    // one quietly trains a preference the user never expressed.
    //
    // Prefixes that ARE deliberate keep an explicit \w*: theat(re|er),
    // brewer(y|ies), historic(al), amphitheat(re|er).
    [/\b(museums?|galler(?:y|ies)|history|historic\w*|theat\w*|arts?|artists?|exhibits?|librar(?:y|ies)|cultural|heritage)\b/, "culture"],
    [/\b(bars?|brewer\w*|brewing|cocktails?|wine|pubs?|distiller\w*|taproom|cider|speakeasy)\b/, "drink"],
    [/\b(clubs?|nightlife|dancing?|dj|lounges?)\b/, "nightlife"],
    [/\b(concerts?|live music|bands?|music venue|jazz|symphony|orchestra|amphitheat\w*|open mic)\b/, "music"],
    [/\b(parks?|trails?|gardens?|beach\w*|hikes?|hiking|nature|lakes?|rivers?|botanical?|waterfront|greenway|boardwalk)\b/, "outdoors"],
    [/\b(kayak\w*|bikes?|biking|climbing|gyms?|surf\w*|skat\w+|paddle\w*|yoga|pilates|fitness|workout|bootcamp|run(?:ning)? club|golf|tennis)\b/, "active"],
    [/\b(zoos?|aquariums?|playgrounds?|children|kids|family|amusement|arcades?|petting farm)\b/, "family"],
    // Food is tested BEFORE shopping, and the order is the fix: these rules
    // are first-match-wins and "shop" is the most promiscuous token in the
    // list. "Blind Tiger Coffee Roasters - Tampa City Center Cafe - Coffee
    // Shop" matched the shopping rule and was filed under shopping. Every
    // "<food> shop" has that shape; no shopping venue is called coffee.
    [/\b(restaurants?|food|cafes?|coffee|espresso|brunch|dinner|eatery|bakery|patisserie|deli|sandwich\w*|tacos?|taqueria|pizza|bbq|barbecue|grill|kitchen|diner|bistro|burgers?|noodle|ramen|sushi|seafood|creamery|ice cream|donuts?|doughnuts?)\b/, "food"],
    [/\b(markets?|shops?|shopping|boutiques?|malls?|thrift|vintage|bookstores?|antiques?)\b/, "shopping"],
    [/\b(festivals?|fairs?|events?|shows?|guided tours?|parades?|meetups?|part(?:y|ies)|celebrations?)\b/, "event"],
  ]
  for (const [re, cat] of rules) if (re.test(s)) return cat
  return fallback
}

/**
 * Is this "event" actually something you'd do on a weekend?
 *
 * Eventbrite and AllEvents are full of free listings that are really business
 * marketing: CE-credit networking, MLM recruiting, insurance seminars, and
 * webinars. They rank well on a free-and-dated bonus and are useless in a
 * weekend plan — an early run proudly scheduled "HPM- Archwell MA/ACA
 * networking event - earn CE credits" for a Saturday night.
 *
 * Virtual events are excluded outright for a simpler reason: an itinerary is a
 * sequence of places you travel between, and a Zoom link is not a place.
 */
export function isJunkEvent(title: string, evidence = ""): boolean {
  const s = `${title} ${evidence}`.toLowerCase()

  // Not somewhere you can go.
  if (/\b(virtual|online|webinar|zoom|livestream|live stream|remote)\b/.test(s)) return true

  // Work, not a weekend.
  if (
    /\b(networking|ce credits?|ceus?|continuing education|professional development|seminar|conference|summit|expo|trade show|career fair|job fair|recruit\w*|mlm|real estate investing|insurance|franchise|masterclass|bootcamp|certification|b2b|lead generation)\b/.test(s)
  ) {
    return true
  }

  // Sales pitches wearing a party hat.
  if (/\b(free consultation|info(?:rmational)? session|open house|orientation|demo day)\b/.test(s)) return true

  // School and admin logistics. Careful to stay narrow — "college football
  // game" is a great Saturday, "College Visit to Middleton HS" is not.
  if (/\b(college visit|campus tour|school visit|parent night|open enrollment|registration (?:day|night|opens)|pta|pto meeting|graduation|academic advising)\b/.test(s)) {
    return true
  }

  // Civic and wellness programming — worthy, but nobody means this by "weekend
  // fun". Caught real examples: "Heart Health Lunch & Learn", "TPA Ticketing
  // Expansion Project Informational Session".
  if (/\b(lunch (?:and|&) learn|town hall|public (?:meeting|hearing|forum)|board meeting|support group|screening clinic|health (?:fair|series)|healthy aging|blood drive)\b/.test(s)) {
    return true
  }

  return false
}

/**
 * Google Maps' own type descriptor -> our category.
 *
 * An explicit table, NOT `guessCategory`. Running these through the generic
 * matcher filed "Coffee shop" under shopping (it contains "shop") and
 * "Tourist attraction" under events (it contains "tour"). These strings are a
 * small closed vocabulary that Maps controls, so map them directly and fall
 * back to the name when it's something unlisted.
 */
/**
 * How Google Maps' own type descriptor is dug out of a result card.
 *
 * A string rather than a RegExp because it has to cross into the page via
 * `evaluateAll` — and keeping it here means the fragile part is testable
 * instead of buried in a browser callback nobody can reach.
 *
 * Card text runs together as:
 *   "<name><name> 4.6Tourist attraction ·  · 401 W Kennedy BlvdHome to..."
 *
 * The separator inside the descriptor has to allow hyphens. Without that,
 * "4.9Custom t-shirt store ·" matched nothing at all, the descriptor was
 * lost, and a t-shirt shop got categorised by the search term that found it.
 * Same for "Go-kart track", "Drive-in theater", "Bed-and-breakfast".
 */
export const MAPS_TYPE_PATTERN = "\\d\\.\\d([A-Z][a-z]+(?:[\\s-][a-z]+)*)\\s*·"

export function categoryFromMapsType(raw: string): Category | null {
  const s = raw.toLowerCase().trim()
  if (!s) return null
  const table: Array<[RegExp, Category]> = [
    // Anchored, for the same reason guessCategory is: an unanchored token
    // finds a word to hide in. "pub" matched "Notary public" and filed a
    // notary under drinks; "park" would have matched "Park & Ride".
    //
    // "tourist attraction" is deliberately absent. Maps applies it to
    // parks, beaches and bowling alleys alike — it is a search-result
    // label, not a type — and matching it filed six Palm Coast parks
    // under culture. Falling through to the name gets "Waterfront Park"
    // right.
    [/\b(museums?|galler(?:y|ies)|historical?|landmarks?|monuments?)\b|观光/, "culture"],
    [/\b(theat\w*|performing arts|opera|cinemas?|movies?)\b/, "culture"],
    [/\b(live music|concerts?|music venue|jazz)\b/, "music"],
    [/\b(night ?clubs?|dance clubs?|disco)\b/, "nightlife"],
    [/\b(bars?|pubs?|brewer\w*|brewpub|winer\w*|wine bar|cocktails?|taprooms?|distiller\w*)\b/, "drink"],
    [/\b(coffee|cafes?|café|restaurants?|baker(?:y|ies)|delis?|food|pizza|diners?|steak\w*|sushi|barbecue|ice cream)\b/, "food"],
    [/\b(parks?|gardens?|beach\w*|trails?|nature|lakes?|scenic|waterfront|greenway)\b/, "outdoors"],
    [/\b(zoos?|aquariums?|amusement|theme park|water park|playgrounds?|children\w*)\b/, "family"],
    [/\b(gyms?|fitness|climbing|kayak\w*|bowling|golf|skating|go-kart|arcades?)\b/, "active"],
    [/\b(shopping|stores?|shops?|markets?|malls?|boutiques?)\b/, "shopping"],
  ]
  for (const [re, cat] of table) if (re.test(s)) return cat
  return null
}

/** Collapse whitespace and trim to something quotable in a plan. */
export function snippet(raw: string, max = 220): string {
  const s = raw.replace(/\s+/g, " ").trim()
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

export interface BuildArgs {
  source: SourceId
  title: string
  url: string
  category: Category
  evidence: string
  priceRaw?: string | null
  ratingRaw?: string | null
  reviewsRaw?: string | null
  address?: string
  lat?: number
  lng?: number
  windows?: Candidate["windows"]
  indoor?: boolean | null
}

/** One place that builds a Candidate, so every source produces the same shape. */
export function buildCandidate(a: BuildArgs): Candidate {
  const price = parsePrice(a.priceRaw)
  // Every scraped string goes through cleanField, here, once. Six sites means
  // six sets of markup artifacts, and leaving each scraper to handle its own
  // meant "&amp; Ho... Read more" was stored as a street address. See text.ts.
  const title = cleanField(a.title) ?? a.title.trim()
  return {
    id: candidateId(title),
    source: a.source,
    title: snippet(title, 120),
    url: a.url,
    category: a.category,
    priceUsd: price.usd,
    priceNote: price.note,
    rating: parseRating(a.ratingRaw),
    reviewCount: parseReviewCount(a.reviewsRaw),
    address: cleanField(a.address)?.slice(0, 160),
    lat: a.lat,
    lng: a.lng,
    windows: a.windows ?? null,
    indoor: a.indoor ?? null,
    evidence: snippet(cleanField(a.evidence) ?? a.evidence),
    scrapedAt: new Date().toISOString(),
  }
}

/** Great-circle distance in miles. Used everywhere travel time matters. */
export function milesBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 3958.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
