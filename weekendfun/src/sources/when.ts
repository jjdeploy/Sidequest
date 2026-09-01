/**
 * When is this event, actually?
 *
 * Every event source publishes a date and every one of them publishes it
 * differently, and until this existed all of them were thrown away. The
 * sources scraped the date into the evidence string, showed it to the user,
 * and then handed the scorer a candidate with `windows: null` — so a listing
 * for September 19th earned the same "happening this weekend" bonus as one
 * for the Saturday you asked about, and the itinerary, which never looked at
 * dates at all, was free to schedule a Saturday-night party on Sunday.
 *
 * Formats measured in the wild:
 *
 *   Sat, Sep 19 - 4th Annual Food & Wine Classic     eventbrite, month-first
 *   Featured Sat, 19 Sep, 2026 - 05:00 PM            allevents, day-first
 *   Thu, 24 Sep • 06:00 PM                           allevents, no year
 *   Framed Resin Art ClassSaturday at 11:00 AM       eventbrite, weekday only
 *
 * The year is usually missing and the timezone always is, so this resolves
 * against the days being planned rather than against "now": the nearest
 * reading of an ambiguous date is the one near the weekend in question.
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}
const MONTH_RE = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec"

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

const DAY_MS = 86_400_000
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export interface ParsedWhen {
  /** Local date, YYYY-MM-DD. */
  date: string
  /** Local 24h time, HH:MM, when the listing published one. */
  time?: string
  /** True when a month and day were published; false when the listing only
   *  named a weekday and the date was inferred from the days being planned. */
  exact: boolean
}

/** "06:00 PM" / "5:00PM" / "11:00 AM" -> "18:00" / "17:00" / "11:00". */
function parseTime(raw: string): string | undefined {
  const m = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (!m) return undefined
  let hour = Number(m[1])
  if (hour > 12) return undefined
  const min = m[2] ?? "00"
  const pm = m[3]!.toLowerCase() === "pm"
  if (pm && hour !== 12) hour += 12
  if (!pm && hour === 12) hour = 0
  return `${String(hour).padStart(2, "0")}:${min}`
}

/**
 * Pick the year for a month/day with none published.
 *
 * "Sep 19" in a plan for January is next September, not eight months ago.
 * Trying the anchor's year and its neighbours and taking the nearest is
 * simpler than reasoning about it and gets December/January right for free.
 */
function resolveYear(month: number, day: number, anchorIso: string): string | null {
  const anchor = utc(anchorIso)
  const anchorYear = Number(anchorIso.slice(0, 4))
  let best: { iso: string; gap: number } | null = null
  for (const year of [anchorYear - 1, anchorYear, anchorYear + 1]) {
    const ms = Date.UTC(year, month, day)
    // Reject a rolled-over date: Date.UTC(2026, 1, 31) is March 3rd.
    const d = new Date(ms)
    if (d.getUTCMonth() !== month || d.getUTCDate() !== day) continue
    const gap = Math.abs(ms - anchor)
    if (!best || gap < best.gap) best = { iso: isoOf(ms), gap }
  }
  return best?.iso ?? null
}

/** The date nearest `anchorIso` falling on `weekday`, forward on a tie. */
function nearestWeekday(anchorIso: string, weekday: number): string {
  const anchor = utc(anchorIso)
  for (const offset of [0, 1, -1, 2, -2, 3, -3]) {
    const ms = anchor + offset * DAY_MS
    if (new Date(ms).getUTCDay() === weekday) return isoOf(ms)
  }
  return anchorIso // unreachable: every weekday occurs within ±3 days
}

/**
 * Read a date out of an event listing.
 *
 * `days` is the weekend being planned; it anchors every ambiguous reading.
 * Returns null when the text publishes nothing date-shaped, which is a real
 * answer — "we don't know when this is" has to stay distinguishable from
 * "this is on Saturday".
 */
export function parseEventWhen(raw: string, days: string[]): ParsedWhen | null {
  const anchor = days[0]
  if (!anchor) return null
  const text = raw.replace(/\s+/g, " ")
  const time = parseTime(text)

  // Day-first: "19 Sep, 2026", "24 Sep". Tried first so the year in
  // "19 Sep, 2026" is consumed here rather than mistaken for a day.
  const dayFirst = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_RE})[a-z]*\\.?,?\\s*(\\d{4})?`, "i"))
  if (dayFirst) {
    const day = Number(dayFirst[1])
    const month = MONTHS[dayFirst[2]!.toLowerCase()]!
    const year = dayFirst[3]
    const date = year ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
                      : resolveYear(month, day, anchor)
    if (date) return { date, time, exact: true }
  }

  // Month-first: "Sep 19", "September 19th, 2026".
  //
  // The trailing \b on the day number is load-bearing: without it
  // "(Starting September 2026)" reads as September 20th.
  const monthFirst = text.match(
    new RegExp(`\\b(${MONTH_RE})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b,?\\s*(\\d{4})?`, "i"),
  )
  if (monthFirst) {
    const month = MONTHS[monthFirst[1]!.toLowerCase()]!
    const day = Number(monthFirst[2])
    const year = monthFirst[3]
    const date = year ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
                      : resolveYear(month, day, anchor)
    if (date) return { date, time, exact: true }
  }

  // Weekday only: "Saturday at 11:00 AM". Common on Eventbrite cards for
  // anything in the next week. Resolved to the nearest such day, which is
  // enough to answer the only question being asked of it — is this one of
  // the days we're planning?
  // No leading BOUNDARY on purpose. Eventbrite card text is concatenated with no
  // separators — "Framed Resin Art ClassSaturday at 11:00 AM" — so a word
  // boundary before the weekday never matches. The trailing guard does the
  // work instead: allow an optional plural ("SOCIAL HOUSE SATURDAYS") and
  // then require a non-letter, so this cannot fire inside a longer word.
  const named = text.match(/(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?(?![a-z])/i)
  if (named) {
    return { date: nearestWeekday(anchor, WEEKDAYS[named[1]!.toLowerCase()]!), time, exact: false }
  }

  return null
}

/** The date an event is on, or null for anything not dated. */
export function eventDateOf(c: { windows?: Array<{ start: string }> | null }): string | null {
  const start = c.windows?.[0]?.start
  return start ? start.slice(0, 10) : null
}

/** "2026-09-19" -> "Sat Sep 19", for score explanations. */
export function prettyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
}
