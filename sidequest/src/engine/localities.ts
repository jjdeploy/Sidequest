/**
 * "Is "Palm Coast" near Tampa?" — asked once, ever.
 *
 * The admission gate needs to turn a place name it found in a listing into
 * coordinates. That is a network call, and the same handful of names recur
 * across every run in a city, so the answers are cached in SQLite and the
 * geocoder is asked at most once per distinct name for the life of the store.
 *
 * Negative answers are cached too, and that is the half that matters: most
 * lookups are not places at all ("The Olympic Venue", "Central Downtown"),
 * and without a negative cache every run would re-ask about all of them.
 *
 * Lives outside relevance.ts so the gate stays a pure function of its inputs
 * and can be tested without a network or a database.
 */
import { geocode } from "../place.js"
import type { Store } from "../store/db.js"
import type { Place } from "../types.js"

/** Ceiling on new lookups in one run, so a source that starts emitting
 *  garbage can't turn a 25-second plan into a geocoding session. */
const MAX_NEW_LOOKUPS = 30

export type LocalityResolver = (name: string) => Promise<{ lat: number; lng: number } | null>

export function makeLocalityResolver(store: Store, place: Place): LocalityResolver {
  const memo = new Map<string, { lat: number; lng: number } | null>()
  let fresh = 0

  return async (raw: string) => {
    const name = raw.trim().toLowerCase()
    if (!name) return null

    const local = memo.get(name)
    if (local !== undefined) return local

    const cached = store.getLocality(name)
    if (cached !== undefined) {
      memo.set(name, cached)
      return cached
    }

    if (fresh >= MAX_NEW_LOOKUPS) return null
    fresh++

    let hit: { lat: number; lng: number } | null = null
    try {
      const { best } = await geocode(raw)
      // Only trust a match in the same country. Open-Meteo will happily
      // resolve "Ybor" to somewhere in Europe, and a false "2,700 mi away"
      // is a much worse answer than "we don't know".
      if (best.country === place.country) hit = { lat: best.lat, lng: best.lng }
    } catch {
      // Not a place, or the geocoder is down. Both mean "can't tell", and
      // the gate treats that as unknown rather than as a failure.
      hit = null
    }

    store.putLocality(name, hit)
    memo.set(name, hit)
    return hit
  }
}
