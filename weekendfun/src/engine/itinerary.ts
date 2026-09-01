/**
 * Turning a ranked list into an actual weekend.
 *
 * A ranked list is not a plan. The top ten might be four breweries, three of
 * them across town from each other, all on the day it rains. This module does
 * the part that makes it a schedule:
 *
 *   - variety      no two adjacent slots from the same category
 *   - geography    penalise hops the party can't reasonably make
 *   - weather      outdoor things get demoted on wet days
 *   - budget       the plan totals up, and stops when it runs out
 *
 * Greedy with lookahead rather than a real optimiser. A weekend is 6 slots
 * over 2 days from ~100 candidates; an exact solver would be more code, more
 * cost, and no more convincing to anyone reading the output.
 */
import type { PlanRequest, Weather } from "../types.js"
import type { Scored } from "./score.js"
import { explain } from "./score.js"
import { milesBetween } from "../sources/util.js"
import { eventDateOf } from "../sources/when.js"
import { isWashout } from "../sources/weather.js"

/** Slots are wall-clock shapes, not exact times — the sources rarely give us
 *  real opening hours, and inventing "10:04am" would be false precision. */
export interface Slot {
  label: string
  /** Rough hour, used only to order the day and to pick plausible fits. */
  hour: number
  /** Categories that make sense at this time of day. */
  prefer: string[]
}

const SLOTS: Slot[] = [
  { label: "Morning", hour: 10, prefer: ["outdoors", "active", "food", "family", "shopping"] },
  { label: "Afternoon", hour: 14, prefer: ["culture", "outdoors", "family", "shopping", "active"] },
  { label: "Evening", hour: 19, prefer: ["food", "music", "drink", "nightlife", "event"] },
]

export interface PlanItem {
  slot: string
  scored: Scored
  /** Miles from the previous item, when both have coordinates. */
  hopMiles: number | null
  why: string
}

export interface DayPlan {
  date: string
  weather: Weather | undefined
  items: PlanItem[]
  costUsd: number
}

export interface Itinerary {
  days: DayPlan[]
  totalUsd: number
  /** Items we wanted but had to drop, and the reason — shown to the user so a
   *  thin plan explains itself rather than looking like a failure. */
  notes: string[]
}

const REACH: Record<PlanRequest["mobility"], number> = { walk: 1.5, transit: 6, car: 25 }

function hopPenalty(miles: number, mobility: PlanRequest["mobility"]): number {
  const reach = REACH[mobility]
  if (miles <= reach * 0.4) return 0
  if (miles <= reach) return (miles / reach) * 12
  return 30 + (miles - reach) * 3
}

/**
 * Build the itinerary.
 *
 * Days are filled in date order, and each candidate carries its own weather
 * penalty — see the note on `dayOrder` for why planning the driest day first
 * turned out to be a bad idea despite sounding like a good one.
 */
export function buildItinerary(
  ranked: Scored[],
  req: PlanRequest,
  weather: Weather[],
): Itinerary {
  const byDate = new Map(weather.map((w) => [w.date, w]))
  const notes: string[] = []
  const used = new Set<string>()

  const heads = Math.max(1, req.party.adults + req.party.kids)
  let remainingBudget = req.budgetUsd

  // Fill days in DATE order.
  //
  // This used to plan the driest day first so outdoor options landed on it.
  // That backfired badly: the first day the user reads got whatever was left
  // after the better day had taken every top-ranked venue, so a Saturday came
  // back as two gift shops. The per-item weather penalty below already keeps
  // outdoor plans off wet days, which was the actual goal — it just does it
  // without robbing day one.
  const dayOrder = [...req.days]

  // How many slots each source has already won. Six browsers running in
  // parallel is pointless if Google Maps' review counts let it take every
  // slot — which is exactly what happened before this existed.
  const sourceUse = new Map<string, number>()

  const plannedByDate = new Map<string, DayPlan>()

  for (const date of dayOrder) {
    const w = byDate.get(date)
    const washout = w ? isWashout(w) : false
    const day: DayPlan = { date, weather: w, items: [], costUsd: 0 }
    let prev: Scored | null = null

    for (const slot of SLOTS) {
      let best: { s: Scored; fit: number; hop: number | null } | null = null

      for (const s of ranked) {
        if (used.has(s.candidate.id)) continue
        const c = s.candidate

        // An event happens when it happens.
        //
        // The hard constraint, and the one that was missing outright: nothing
        // in here ever looked at a date, so "SOCIAL HOUSE SATURDAYS" was
        // scheduled on a Sunday and a September 19th festival was scheduled
        // for the 5th. Venues have `windows === null` — they're open every
        // weekend — and stay unconstrained.
        const happensOn = eventDateOf(c)
        if (happensOn !== null && happensOn !== date) continue

        // Cost is per person; a $40 ticket for a family of four is $160.
        const cost = (c.priceUsd ?? 0) * heads
        if (cost > remainingBudget) continue

        let fit = s.score

        // Time-of-day suitability.
        fit += slot.prefer.includes(c.category) ? 12 : -10

        // Don't put two of the same thing back to back.
        if (prev && prev.candidate.category === c.category) fit -= 20

        // Geography.
        let hop: number | null = null
        if (
          prev &&
          prev.candidate.lat !== undefined && prev.candidate.lng !== undefined &&
          c.lat !== undefined && c.lng !== undefined
        ) {
          hop = milesBetween(
            { lat: prev.candidate.lat, lng: prev.candidate.lng },
            { lat: c.lat, lng: c.lng },
          )
          fit -= hopPenalty(hop, req.mobility)
        }

        // Diminishing returns per source, so the plan draws on the whole
        // fan-out rather than whichever source happens to score highest.
        fit -= (sourceUse.get(c.source) ?? 0) * 9

        // Keep the outdoor things off the wet day where we can.
        const outdoor = c.indoor === false || (c.indoor === null && (c.category === "outdoors" || c.category === "active"))
        if (washout && outdoor) fit -= 25

        if (!best || fit > best.fit) best = { s, fit, hop }
      }

      if (!best) {
        notes.push(`${date} ${slot.label.toLowerCase()}: nothing left that fits the budget.`)
        continue
      }

      used.add(best.s.candidate.id)
      sourceUse.set(best.s.candidate.source, (sourceUse.get(best.s.candidate.source) ?? 0) + 1)
      const cost = (best.s.candidate.priceUsd ?? 0) * heads
      remainingBudget -= cost
      day.costUsd += cost
      day.items.push({
        slot: slot.label,
        scored: best.s,
        hopMiles: best.hop,
        why: explain(best.s),
      })
      prev = best.s
    }

    plannedByDate.set(date, day)
  }

  // Render in the order the user thinks about their weekend.
  const days = req.days.map((d) => plannedByDate.get(d)).filter((d): d is DayPlan => Boolean(d))
  const totalUsd = days.reduce((sum, d) => sum + d.costUsd, 0)

  if (weather.length === 0) {
    notes.push("No forecast available for these dates — outdoor options weren't weather-adjusted.")
  }

  return { days, totalUsd, notes }
}
