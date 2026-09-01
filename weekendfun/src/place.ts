/**
 * Resolving "tampa" into somewhere real.
 *
 * Uses Open-Meteo's geocoder: keyless, no signup, and it returns the IANA
 * timezone alongside the coordinates — which the browser context needs, so
 * this saves a second lookup.
 *
 * A bare city name is ambiguous ("Tampa" is also in Kansas, and there's a
 * Tâmpa in Romania). We surface the alternatives rather than silently taking
 * the first hit, because guessing wrong here quietly poisons every downstream
 * result AND the learning store with a whole different city's venues.
 */
import type { Place } from "./types.js"

interface GeoHit {
  name: string
  admin1?: string
  country_code: string
  latitude: number
  longitude: number
  timezone: string
  population?: number
}

/** US state name -> postal code, for building site URLs like "fl--tampa". */
const STATE_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
}

export function stateAbbr(admin1: string | undefined): string | undefined {
  if (!admin1) return undefined
  return STATE_ABBR[admin1.trim().toLowerCase()]
}

function toPlace(h: GeoHit): Place {
  const abbr = stateAbbr(h.admin1)
  return {
    label: [h.name, abbr ?? h.admin1, h.country_code !== "US" ? h.country_code : undefined]
      .filter(Boolean)
      .join(", "),
    city: h.name,
    state: h.admin1,
    country: h.country_code.toLowerCase(),
    lat: h.latitude,
    lng: h.longitude,
    timezone: h.timezone,
  }
}

/**
 * Geocode a free-text location.
 *
 * Accepts "tampa", "Tampa, FL", or "Tampa FL". The qualifier is matched against
 * the region name and postal code so "Tampa, KS" doesn't hand back Florida.
 */
export async function geocode(query: string): Promise<{ best: Place; alternates: Place[] }> {
  const [rawCity, ...rest] = query.split(",")
  const city = (rawCity ?? query).trim()
  const qualifier = rest.join(",").trim().toLowerCase()

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search")
  url.searchParams.set("name", city)
  url.searchParams.set("count", "10")
  url.searchParams.set("language", "en")
  url.searchParams.set("format", "json")

  const res = await fetch(url)
  if (!res.ok) throw new Error(`geocoder returned HTTP ${res.status} for "${query}"`)
  const body = (await res.json()) as { results?: GeoHit[] }
  const hits = body.results ?? []
  if (hits.length === 0) throw new Error(`no place matched "${query}"`)

  let ranked = hits
  if (qualifier) {
    const matches = hits.filter((h) => {
      const admin = (h.admin1 ?? "").toLowerCase()
      const abbr = (stateAbbr(h.admin1) ?? "").toLowerCase()
      return admin === qualifier || abbr === qualifier || admin.startsWith(qualifier)
    })
    if (matches.length > 0) ranked = matches
  }

  // Open-Meteo already sorts by relevance, but population is the better
  // tiebreak for "which Tampa did they mean" when no qualifier was given.
  const sorted = [...ranked].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
  const best = sorted[0]!

  return {
    best: toPlace(best),
    alternates: sorted.slice(1, 4).map(toPlace),
  }
}
