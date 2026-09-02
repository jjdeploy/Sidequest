/**
 * Weather — not a browser source.
 *
 * Open-Meteo is a keyless JSON API, so burning a cloud browser session on it
 * would be theatre. The fan-out is for pages that fight back; this is a fetch.
 *
 * Weather isn't a candidate, it's a *constraint*: an 80%-rain Saturday should
 * demote every outdoor option in the ranking, not just print an umbrella
 * emoji next to them. It feeds the scorer, which is why it returns Weather[]
 * rather than Candidate[].
 */
import type { Place, Weather } from "../types.js"

/** WMO weather codes -> something a human would say. */
function describe(code: number): string {
  if (code === 0) return "clear"
  if (code <= 2) return "mostly sunny"
  if (code === 3) return "overcast"
  if (code <= 48) return "fog"
  if (code <= 57) return "drizzle"
  if (code <= 67) return "rain"
  if (code <= 77) return "snow"
  if (code <= 82) return "rain showers"
  if (code <= 86) return "snow showers"
  return "thunderstorms"
}

export async function fetchWeather(place: Place, days: string[]): Promise<Weather[]> {
  const url = new URL("https://api.open-meteo.com/v1/forecast")
  url.searchParams.set("latitude", String(place.lat))
  url.searchParams.set("longitude", String(place.lng))
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code")
  url.searchParams.set("temperature_unit", "fahrenheit")
  url.searchParams.set("timezone", place.timezone)
  // The free forecast reaches ~16 days. Asking beyond that returns nulls
  // rather than an error, which is the quiet kind of wrong — so we ask for a
  // window and then only trust the days we actually got numbers for.
  url.searchParams.set("forecast_days", "16")

  const res = await fetch(url)
  if (!res.ok) throw new Error(`weather API returned HTTP ${res.status}`)
  const body = (await res.json()) as {
    daily?: {
      time: string[]
      temperature_2m_max: (number | null)[]
      temperature_2m_min: (number | null)[]
      precipitation_probability_max: (number | null)[]
      weather_code: (number | null)[]
    }
  }
  const d = body.daily
  if (!d) return []

  const wanted = new Set(days)
  const out: Weather[] = []
  d.time.forEach((date, i) => {
    if (!wanted.has(date)) return
    const high = d.temperature_2m_max[i]
    const low = d.temperature_2m_min[i]
    const code = d.weather_code[i]
    // Past the forecast horizon these come back null. A plan that silently
    // treats "unknown" as "sunny" is worse than one that says it doesn't know.
    if (high === null || high === undefined || low === null || low === undefined) return
    out.push({
      date,
      highF: Math.round(high),
      lowF: Math.round(low),
      precipChance: d.precipitation_probability_max[i] ?? 0,
      summary: describe(code ?? 0),
    })
  })
  return out
}

/** True when the day is bad enough that outdoor plans should lose points. */
export function isWashout(w: Weather): boolean {
  return w.precipChance >= 60 || w.highF >= 100 || w.highF <= 35
}
