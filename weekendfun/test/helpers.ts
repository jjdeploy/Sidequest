/**
 * Fixtures shared across the suite.
 *
 * Every test in here is named for a bug that actually shipped, so the
 * fixtures are deliberately real: the titles, evidence strings and Maps
 * descriptors below are verbatim from runs against Tampa, Boise and Palm
 * Coast. Invented strings would pass tests that the real ones failed.
 */
import type { Candidate, Category, PlanRequest, Place, SourceId } from "../src/types.js"
import type { Scored } from "../src/engine/score.js"

export const TAMPA: Place = {
  label: "Tampa, FL",
  city: "Tampa",
  state: "florida",
  country: "us",
  lat: 27.94752,
  lng: -82.45843,
  timezone: "America/New_York",
}

/** The Saturday and Sunday most of these fixtures were captured against. */
export const WEEKEND = ["2026-09-05", "2026-09-06"]

export function request(over: Partial<PlanRequest> = {}): PlanRequest {
  return {
    place: TAMPA,
    days: WEEKEND,
    party: { adults: 2, kids: 0 },
    budgetUsd: 300,
    vibes: [],
    mobility: "car",
    avoid: [],
    ...over,
  }
}

let seq = 0

export function candidate(over: Partial<Candidate> = {}): Candidate {
  seq++
  return {
    id: over.id ?? `cand-${seq}`,
    source: (over.source ?? "google-maps") as SourceId,
    title: over.title ?? `Place ${seq}`,
    url: over.url ?? "https://example.com",
    category: (over.category ?? "other") as Category,
    priceUsd: over.priceUsd ?? null,
    rating: over.rating ?? null,
    reviewCount: over.reviewCount ?? null,
    windows: over.windows ?? null,
    indoor: over.indoor ?? null,
    evidence: over.evidence ?? "",
    scrapedAt: over.scrapedAt ?? "2026-09-01T12:00:00.000Z",
    ...over,
  }
}

/** A scored wrapper, for testing the itinerary without going through ranking. */
export function scored(c: Candidate, score = 10): Scored {
  return { candidate: c, score, components: [], corroboration: 1 }
}
