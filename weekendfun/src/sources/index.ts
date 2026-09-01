/**
 * The source registry.
 *
 * Adding a source is: write the file, add it here. Nothing downstream changes,
 * because everything downstream only ever sees `Candidate[]`.
 *
 * Ordering is cosmetic (it's the log order), but the grouping is not — the
 * comment blocks record what each source is *for*, which is what stops this
 * from drifting into six scrapers that all fetch restaurant lists.
 */
import type { SourceTask } from "../solari/pool.js"
import { googleMaps } from "./google-maps.js"
import { eventbrite } from "./eventbrite.js"
import { allevents } from "./allevents.js"
import { groupon } from "./groupon.js"
import { tripadvisor } from "./tripadvisor.js"
import { timeout } from "./timeout.js"

/**
 * Every source that works without credentials.
 *
 * Deliberately covers four different *kinds* of signal rather than four
 * copies of one:
 *   google-maps  venues + coordinates   (the only source with real geometry)
 *   eventbrite   dated, ticketed events
 *   allevents    dated events, long tail + small cities
 *   groupon      what is discounted right now
 *   tripadvisor  consensus ranking, for corroboration
 *   timeout      local editorial voice, for the "why"
 */
export const ALL_SOURCES: SourceTask[] = [
  googleMaps,
  eventbrite,
  allevents,
  groupon,
  tripadvisor,
  timeout,
]

export function sourcesByName(names: string[]): SourceTask[] {
  if (names.length === 0) return ALL_SOURCES
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const picked = ALL_SOURCES.filter((s) => wanted.has(s.id))
  const unknown = [...wanted].filter((n) => !ALL_SOURCES.some((s) => s.id === n))
  if (unknown.length > 0) {
    throw new Error(
      `unknown source(s): ${unknown.join(", ")}. Known: ${ALL_SOURCES.map((s) => s.id).join(", ")}`,
    )
  }
  return picked
}
