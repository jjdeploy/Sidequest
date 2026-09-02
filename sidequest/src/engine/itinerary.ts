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
import { eventDateOf, eventPartOfDay } from "../sources/when.js"
import { isWashout } from "../sources/weather.js"
import { mentions } from "./keywords.js"

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
  /**
   * Things they asked for by name that the plan could not book, and why.
   *
   * Separate from `notes` because it is a different kind of sentence. A note
   * is housekeeping — no forecast, ran out of budget. This is an answer to a
   * question the user actually asked, and going unanswered is news: a weekend
   * that quietly leaves out the one thing you typed looks like the town is
   * empty rather than like the search came up short.
   */
  unmet: string[]
}

/** Something the user typed the word for, and the category it belongs to. */
export interface Required {
  term: string
  category: string
}

const REACH: Record<PlanRequest["mobility"], number> = { walk: 1.5, transit: 6, car: 25 }

/** Miles between two consecutive stops, when both published coordinates. */
function hopFrom(prev: Scored | null, s: Scored): number | null {
  const a = prev?.candidate
  const b = s.candidate
  if (!a || a.lat === undefined || a.lng === undefined) return null
  if (b.lat === undefined || b.lng === undefined) return null
  return milesBetween({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng })
}

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
  /** Categories the request asked about — see engine/keywords.ts. */
  requested: Set<string> = new Set(),
  /** When they asked for it, if they said. */
  timeOfDay?: PlanRequest["timeOfDay"],
  /**
   * The terms they typed themselves — see engine/keywords.ts. These are
   * requirements rather than preferences: each one claims a slot at the hour
   * they asked for before the rest of the weekend is filled in around it, and
   * says so in `unmet` when it cannot.
   */
  required: Required[] = [],
): Itinerary {
  /**
   * Categories asked for that haven't made the plan yet.
   *
   * If someone types "bowling", there should be bowling in their weekend.
   * A score bonus alone can't promise that: an explicitly requested venue is
   * often a thin one — Palm Coast Lanes is 4.0 with no review count — and it
   * will lose to a well-reviewed park that nobody mentioned however much you
   * nudge it. So the FIRST candidate of each requested category gets a large
   * one-time preference, and the category drops out as soon as it's placed.
   * One guaranteed slot each, not six.
   */
  /**
   * ...but never more of them than there are slots to honour them in.
   *
   * The reservation has two halves: a large bonus in the right slot, and an
   * equal push OUT of the wrong ones to keep the category free until its hour
   * comes round. The second half is only defensible while the hour is still
   * coming. "bowling at night, clubbing the other night" expanded to five
   * owed categories chasing two evenings — the three that lost were still
   * being held out of the four daytime slots for an evening they were never
   * going to get, so they disappeared from the plan altogether. That is how a
   * request for bowling produced a weekend with no bowling in it.
   *
   * Set iteration is insertion order, and engine/keywords.ts hands these over
   * strongest first, so the ones that survive the cut are the ones asked for
   * hardest. The rest are ordinary candidates again: no bonus, no penalty,
   * free to land wherever they fit.
   */
  const honourable = timeOfDay ? req.days.length : SLOTS.length * req.days.length
  const owed = new Set([...requested].slice(0, honourable))

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

  /**
   * The constraints that are not negotiable, wherever they are asked from.
   *
   * Factored out because the booking pass below has to obey exactly the same
   * ones as the auction. A requirement that books a Saturday event into
   * Sunday, or a nightclub into the morning slot, is worse than one that
   * quietly failed.
   */
  const fitsSlot = (c: Scored["candidate"], date: string, slot: Slot): boolean => {
    // An event happens when it happens.
    //
    // The hard constraint, and the one that was missing outright: nothing in
    // here ever looked at a date, so "SOCIAL HOUSE SATURDAYS" was scheduled
    // on a Sunday and a September 19th festival was scheduled for the 5th.
    // Venues have `windows === null` and stay unconstrained.
    const happensOn = eventDateOf(c)
    if (happensOn !== null && happensOn !== date) return false

    // ...and at the hour it happens. A listing that says 12:00 PM is not an
    // evening plan, whatever category it falls into. Only applies when the
    // listing published a time.
    const startsIn = eventPartOfDay(c)
    if (startsIn !== null && startsIn !== slot.label.toLowerCase()) return false

    // Nobody wants a brewery at ten in the morning. The slot preference
    // costs a drink venue ten points in the wrong slot, and New Belgium
    // Brewing, 4.8 from thousands of reviews, cleared ten points and opened
    // an Asheville Saturday. For this one category the hour is not a
    // preference to be outbid.
    if (slot.label === "Morning" && (c.category === "drink" || c.category === "nightlife")) return false

    return true
  }

  /** Cost for this party. Per person; a $40 ticket for a family of four is
   *  $160. */
  const costOf = (s: Scored) => (s.candidate.priceUsd ?? 0) * heads

  // Booking.
  //
  // "bowling at night, club at night" is two bookings, not two preferences.
  // Reserving them by score never held: the bonus was cancelled first by the
  // slot preference, then by the per-source balance, and each fix worked for
  // one shape of request and broke on the next. So the slots are claimed
  // outright, before the auction runs, and the auction fills in around them.
  //
  // Whatever cannot be booked is said out loud in `unmet`.
  const unmet: string[] = []
  const booked = new Map<string, Scored>()
  const key = (date: string, slot: string) => `${date}|${slot}`

  if (required.length > 0) {
    // The slots that can honour the request, in the order they happen.
    const openings = dayOrder.flatMap((date) =>
      SLOTS.filter((slot) => !timeOfDay || timeOfDay.toLowerCase() === slot.label.toLowerCase())
        .map((slot) => ({ date, slot })))
    const when = timeOfDay ? ` in the ${timeOfDay}` : ""
    let next = 0

    for (const want of required) {
      const spot = openings[next]
      if (!spot) {
        unmet.push(
          `You asked for ${want.term}${when} — the weekend ran out of ` +
            `${timeOfDay ?? "slot"}s before it got there.`,
        )
        continue
      }

      // The word first, the category second. "bowling" and a pinball museum
      // are both `active`, and only one of them is bowling — a reservation
      // made for a word should be spent on something that answers it.
      let best: { s: Scored; rank: number } | null = null
      for (const s of ranked) {
        if (used.has(s.candidate.id)) continue
        const c = s.candidate
        if (!fitsSlot(c, spot.date, spot.slot)) continue
        if (costOf(s) > remainingBudget) continue
        const byName = mentions(want.term, `${c.title} ${c.evidence}`)
        if (!byName && c.category !== want.category) continue
        const rank = (byName ? 1000 : 0) + s.score
        if (!best || rank > best.rank) best = { s, rank }
      }

      if (!best) {
        unmet.push(`You asked for ${want.term}${when} — nothing in ${req.place.city} matched.`)
        continue
      }

      booked.set(key(spot.date, spot.slot.label), best.s)
      used.add(best.s.candidate.id)
      remainingBudget -= costOf(best.s)
      owed.delete(best.s.candidate.category)
      next++
    }
  }

  for (const date of dayOrder) {
    const w = byDate.get(date)
    const washout = w ? isWashout(w) : false
    const day: DayPlan = { date, weather: w, items: [], costUsd: 0 }
    let prev: Scored | null = null

    for (const slot of SLOTS) {
      // A slot claimed by the booking pass is not up for auction.
      const reserved = booked.get(key(date, slot.label))
      if (reserved) {
        sourceUse.set(reserved.candidate.source, (sourceUse.get(reserved.candidate.source) ?? 0) + 1)
        // Already taken out of the budget above; the day still has to show
        // what it cost.
        day.costUsd += costOf(reserved)
        day.items.push({
          slot: slot.label, scored: reserved, hopMiles: hopFrom(prev, reserved), why: explain(reserved),
        })
        prev = reserved
        continue
      }

      let best: { s: Scored; fit: number; hop: number | null } | null = null

      for (const s of ranked) {
        if (used.has(s.candidate.id)) continue
        const c = s.candidate

        if (!fitsSlot(c, date, slot)) continue
        if (costOf(s) > remainingBudget) continue

        let fit = s.score

        // Time-of-day suitability.
        fit += slot.prefer.includes(c.category) ? 12 : -10

        // Don't put two of the same thing back to back.
        if (prev && prev.candidate.category === c.category) fit -= 20

        // Geography.
        const hop = hopFrom(prev, s)
        if (hop !== null) fit -= hopPenalty(hop, req.mobility)

        // Diminishing returns per source, so the plan draws on the whole
        // fan-out rather than whichever source happens to score highest.
        //
        // Waived for something they asked for by name. Asheville, "bowling at
        // night": Sky Lanes had the reservation and still lost the Sunday
        // evening, because Maps had won three slots by then and this charged
        // the town's only bowling alley -27 while charging a brewery found by
        // an idle source nothing. Balance is there to stop Maps taking all six
        // slots; it is not a reason to drop the one thing that was actually
        // requested.
        if (!owed.has(c.category)) fit -= (sourceUse.get(c.source) ?? 0) * 9

        // The one-time guarantee. Big enough to clear the gap between a
        // requested-but-thin venue and an unrequested-but-excellent one.
        //
        // If they said WHEN, hold the whole bonus for that slot and give
        // nothing anywhere else. A consolation bonus does not work here: the
        // first attempt handed out +20 in the other slots, which combined
        // with the ranking bonus still beat a 4.8-star park, and "bowling at
        // night" came back as bowling at ten in the morning again. Slots are
        // visited in order, so waiting costs nothing — the reservation fires
        // when the right hour comes round.
        //
        // Withholding the bonus is not enough on its own, which is how
        // "bowling at night" came back as bowling at ten for the third time:
        // in a small town the bowling alley is often also the best thing
        // going at ten in the morning, so it won the slot on its own score
        // before the evening came round. The wrong hours get an equal push
        // the other way — held back, not banned, so an otherwise empty slot
        // still takes it.
        if (owed.has(c.category)) {
          const rightTime = !timeOfDay || timeOfDay.toLowerCase() === slot.label.toLowerCase()
          fit += rightTime ? 60 : -60
        }

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
      owed.delete(best.s.candidate.category)
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

  return { days, totalUsd, notes, unmet }
}
