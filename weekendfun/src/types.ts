/**
 * Shared vocabulary for the whole pipeline.
 *
 * Every source produces `Candidate[]`. Everything downstream — scoring,
 * itinerary assembly, the learning loop — only ever sees Candidates, so adding
 * a source never touches the engine.
 */

export type SourceId =
  | "google-maps"
  | "groupon"
  | "eventbrite"
  | "allevents"
  | "tripadvisor"
  | "timeout"
  // Reachable only with credentials — see sources/reddit.ts. Yelp 403s all
  // automated traffic regardless of proxy tier, stealth, or captcha solving,
  // so it is deliberately absent rather than silently failing every run.
  | "reddit"
  | "weather"

/** Coarse buckets. The learner keeps a per-category weight, so keep this list
 *  short — one weight per category needs enough signals to mean anything. */
export type Category =
  | "food"
  | "drink"
  | "outdoors"
  | "culture"
  | "music"
  | "nightlife"
  | "active"
  | "family"
  | "shopping"
  | "event"
  | "other"

export const CATEGORIES: Category[] = [
  "food", "drink", "outdoors", "culture", "music",
  "nightlife", "active", "family", "shopping", "event", "other",
]

export type Mobility = "walk" | "transit" | "car"

export interface Place {
  /** Free-text city as the user typed it, e.g. "Tampa, FL". */
  label: string
  city: string
  /** Lowercase US state name, e.g. "florida". Solari's proxy wants this form. */
  state?: string
  /** Lowercase ISO-3166-1 alpha-2. */
  country: string
  lat: number
  lng: number
  /** IANA zone, e.g. "America/New_York". Applied to the browser context so
   *  Intl/Date inside the page agree with where we claim to be. */
  timezone: string
}

export interface PlanRequest {
  place: Place
  /** Local ISO dates (YYYY-MM-DD) the plan should cover. */
  days: string[]
  party: {
    adults: number
    kids: number
    /** Ages of the kids, when known — drives the family filter. */
    kidAges?: number[]
  }
  /** Total budget for the whole plan, in USD, across the whole party. */
  budgetUsd: number
  /** Free-text vibe tags: "chill", "outdoorsy", "date night", "cheap". */
  vibes: string[]
  mobility: Mobility
  /** Categories or keywords to exclude outright. */
  avoid: string[]
  /** When they said they wanted it. "bowling at night" is two requests, and
   *  dropping half of it is how bowling ended up scheduled for 10am. */
  timeOfDay?: "morning" | "afternoon" | "evening"
}

/** A time window a candidate is available in, in local wall-clock time. */
export interface Window {
  /** ISO local datetime, e.g. "2026-09-05T19:30". */
  start: string
  end?: string
}

export interface Candidate {
  /** Stable across runs: hash of source + normalized title + rough geo. Lets
   *  the learner recognise a venue it has already shown you. */
  id: string
  source: SourceId
  title: string
  url: string
  category: Category
  /** Per-person cost in USD. `null` means genuinely unknown, not free — the
   *  scorer treats those differently, so never coerce one into the other. */
  priceUsd: number | null
  /** What the page actually said, when it wasn't a clean number ("$$", "Free
   *  entry, cash bar"). Kept for the write-up and for debugging extraction. */
  priceNote?: string
  rating: number | null
  reviewCount: number | null
  address?: string
  lat?: number
  lng?: number
  /** Set for dated events; `null` for always-on venues. */
  windows: Window[] | null
  /** `null` when the source doesn't say. Drives the rain contingency. */
  indoor: boolean | null
  /** Verbatim snippet from the page that justifies this candidate. Shown in
   *  the plan so every recommendation is traceable to something real. */
  evidence: string
  scrapedAt: string
  /** Solari session that found it — the key to its rrweb replay. */
  sessionId?: string
}

export interface SourceResult {
  source: SourceId
  candidates: Candidate[]
  /** Wall-clock ms from launch to close, for the parallelism story. */
  elapsedMs: number
  sessionId?: string
  /** Populated instead of candidates when the source failed. A failed source
   *  never fails the run — you get a thinner plan and a visible reason. */
  error?: string
  /** True when the residential proxy was unavailable and this ran on direct
   *  egress instead. Still geo-correct — the geolocation override is what
   *  localises, not the proxy — but more visible to sites that block
   *  datacenter traffic. */
  direct?: boolean
}

export interface Weather {
  date: string
  highF: number
  lowF: number
  precipChance: number
  summary: string
}
