/**
 * Dates, which this project has got wrong in two separate ways.
 *
 * Once by planning the wrong two days (`toISOString` shifting the date), and
 * once by planning the right days and filling them with events happening on
 * other ones (the scraped date being discarded).
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { eventDateOf, parseEventWhen, prettyDate } from "../src/sources/when.js"
import { nextWeekend } from "../src/pipeline.js"
import { candidate, WEEKEND } from "./helpers.js"

describe("parseEventWhen: the formats these sites actually publish", () => {
  // Verbatim from stored listings. Four shapes, none of which agree.
  const cases: Array<[string, string | null]> = [
    ["Sat, Sep 19 - 4th Annual Food & Wine Classic at Hammock Beach", "2026-09-19"],
    ["Featured Sat, 19 Sep, 2026 - 05:00 PM 4th Annual Food & Wine Classic", "2026-09-19"],
    ["Thu, 24 Sep • 06:00 PM Beats and Eats Riverside 118+ Interested", "2026-09-24"],
    ["Featured Fri, 09 Oct, 2026 - 12:00 AM Constellation FURYK & FRIENDS", "2026-10-09"],
    ["Sat, 05 Sep, 2026 - 12:00 PM", "2026-09-05"],
    ["Sun, 06 Sep • 11:00 AM", "2026-09-06"],
    ["Wed, Sep 23 - How to Get More Film, TV & Theatre Auditions", "2026-09-23"],
    // Eventbrite's other card shape glues the weekday onto the title with no
    // separator, so a leading word boundary never matches.
    ["Framed Resin Art ClassSaturday at 11:00 AMTuscany Villas", "2026-09-05"],
    ["WHITE ME DOWN All White Day PartySunday at 3:00 PMSeabreeze", "2026-09-06"],
    ["Rock The Beach - A Tribute to Studio 54 & MoreFriday at 7:00 PM", "2026-09-04"],
    ["SOCIAL HOUSE SATURDAYS AT 7TH & GROVE", "2026-09-05"],
  ]
  for (const [text, want] of cases) {
    test(`${JSON.stringify(text.slice(0, 44))} -> ${want}`, () => {
      assert.equal(parseEventWhen(text, WEEKEND)?.date ?? null, want)
    })
  }
})

describe("parseEventWhen: refuses to invent a date", () => {
  test('"(Starting September 2026)" is not September 20th', () => {
    // Without a trailing boundary on the day number, "September 2026" reads
    // as the 20th.
    assert.equal(parseEventWhen("Italian Language Program @ the Italian Club (Starting September 2026)", WEEKEND), null)
  })
  test("a venue with no date at all returns null, not a guess", () => {
    assert.equal(parseEventWhen("The Florida Aquarium 4.5 (22,001) Aquarium", WEEKEND), null)
    assert.equal(parseEventWhen("Henry B. Plant Museum 4.6 Tourist attraction 401 W Kennedy Blvd", WEEKEND), null)
  })
})

describe("parseEventWhen: ambiguity resolves against the weekend being planned", () => {
  test("a missing year picks the nearest reading, across the new year", () => {
    const jan = ["2027-01-02", "2027-01-03"]
    assert.equal(parseEventWhen("Mon, Dec 28 - NYE warmup", jan)?.date, "2026-12-28")
    assert.equal(parseEventWhen("Sat, Jan 2 - Party", jan)?.date, "2027-01-02")
  })
  test("a weekday-only listing is marked inexact, so nothing claims false precision", () => {
    const exact = parseEventWhen("Sat, 05 Sep, 2026 - 06:00 PM", WEEKEND)
    const vague = parseEventWhen("Framed Resin Art ClassSaturday at 11:00 AM", WEEKEND)
    assert.equal(exact?.exact, true)
    assert.equal(vague?.exact, false)
  })
  test("the time comes through in 24h", () => {
    assert.equal(parseEventWhen("Sat, 05 Sep, 2026 - 06:00 PM", WEEKEND)?.time, "18:00")
    assert.equal(parseEventWhen("Fri, 09 Oct, 2026 - 12:00 AM", WEEKEND)?.time, "00:00")
  })
})

describe("eventDateOf", () => {
  test("a venue has no date; an event does", () => {
    assert.equal(eventDateOf(candidate()), null)
    assert.equal(eventDateOf(candidate({ windows: [{ start: "2026-09-05T17:00" }] })), "2026-09-05")
  })
})

describe("prettyDate", () => {
  test("names the day, because a bare ISO date made the write-up say Friday", () => {
    assert.equal(prettyDate("2026-09-05"), "Sat, Sep 5")
  })
})

describe("nextWeekend", () => {
  test("returns a Saturday and the Sunday after it", () => {
    const [sat, sun] = nextWeekend("America/New_York") as [string, string]
    // `getUTCDay` is safe here: both are plain Y-M-D strings, and building
    // them as UTC noon is what keeps this from re-introducing the very bug
    // the function exists to avoid.
    assert.equal(new Date(`${sat}T12:00:00Z`).getUTCDay(), 6, `${sat} should be a Saturday`)
    assert.equal(new Date(`${sun}T12:00:00Z`).getUTCDay(), 0, `${sun} should be a Sunday`)
    assert.equal(
      (Date.parse(`${sun}T00:00:00Z`) - Date.parse(`${sat}T00:00:00Z`)) / 86_400_000,
      1,
      "the two days must be consecutive",
    )
  })

  test("the answer is the target city's weekend, not the machine's", () => {
    // The original built a local Date, added days, then sliced the ISO
    // string — which converts to UTC first and planned Sunday and Monday for
    // a request made on a Monday in Florida.
    for (const tz of ["America/New_York", "Pacific/Kiritimati", "Pacific/Niue", "Asia/Tokyo"]) {
      const [sat] = nextWeekend(tz) as [string]
      assert.equal(new Date(`${sat}T12:00:00Z`).getUTCDay(), 6, `${tz} gave ${sat}`)
    }
  })
})
