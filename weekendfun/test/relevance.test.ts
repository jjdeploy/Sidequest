/**
 * The admission gate.
 *
 * Its three rules are the whole design, and each one is easy to break by
 * accident in a way that still looks reasonable:
 *
 *   unknown is not a failure
 *   fatal only on hard evidence
 *   findings carry their reason
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { screen } from "../src/engine/relevance.js"
import { candidate, request, TAMPA, WEEKEND } from "./helpers.js"

const ctx = { place: TAMPA, req: request() }

const judge = async (c: Parameters<typeof candidate>[0]) => {
  const cand = candidate(c)
  const { verdicts } = await screen([cand], ctx)
  const v = verdicts.get(cand.id)!
  return {
    fatal: v.fatal,
    place: v.findings.find((f) => f.dimension === "place")!,
    time: v.findings.find((f) => f.dimension === "time")!,
    kind: v.findings.find((f) => f.dimension === "kind")!,
  }
}

describe("place", () => {
  test("coordinates in town are confirmed", async () => {
    const v = await judge({ lat: 27.95, lng: -82.46 })
    assert.equal(v.place.state, "ok")
    assert.equal(v.fatal, false)
  })

  test("coordinates 150 miles away are fatal — this is hard evidence", async () => {
    const v = await judge({ lat: 29.585, lng: -81.2078 })
    assert.equal(v.place.state, "fail")
    assert.equal(v.place.fatal, true)
    assert.match(v.place.why, /mi from Tampa/)
  })

  test("no coordinates is UNKNOWN, not ok and not a failure", async () => {
    // 70% of candidates land here. Calling it "ok" is how out-of-town
    // results got in; calling it "wrong" would delete most of the plan.
    const v = await judge({ evidence: "Sat, 05 Sep, 2026 - 05:00 PM" })
    assert.equal(v.place.state, "unknown")
    assert.equal(v.place.fatal, false)
    assert.equal(v.place.points, 0)
  })

  test("a distance the site published itself is read and used", async () => {
    // Groupon prints its own: "West Boise, Meridian7.3 mi4.3(15)".
    const near = await judge({ source: "groupon", evidence: "West Boise, Meridian7.3 mi4.3(15)$25" })
    assert.equal(near.place.state, "ok")
    const far = await judge({ source: "groupon", evidence: "Somewhere Else 88 mi 4.3(15)$25" })
    assert.equal(far.place.state, "fail")
    assert.equal(far.place.fatal, true)
  })

  test("a locality matched in free text can cost points but never rejects", async () => {
    // "Orlando's Bar" is a real Tampa venue. Text matching is fuzzy, so it
    // is not allowed to be the thing that throws a candidate away.
    const { verdicts } = await screen(
      [candidate({ evidence: "Some Gig @ Orlando", address: "1 Main St, Orlando" })],
      { ...ctx, resolveLocality: async () => ({ lat: 28.5383, lng: -81.3792 }) },
    )
    const v = [...verdicts.values()][0]!
    const place = v.findings.find((f) => f.dimension === "place")!
    assert.equal(place.state, "fail")
    assert.equal(place.fatal, false, "a text match must never be fatal")
    assert.ok(place.points < 0)
    assert.equal(v.fatal, false)
  })

  test("mobility decides how far is too far", async () => {
    // Twenty miles north: nothing by car, impossible on foot.
    const outOfTown = { lat: 28.24, lng: -82.45 }
    const { verdicts: byCar } = await screen([candidate({ id: "a", ...outOfTown })], ctx)
    const { verdicts: onFoot } = await screen([candidate({ id: "b", ...outOfTown })], {
      ...ctx,
      req: request({ mobility: "walk" }),
    })
    assert.equal(byCar.get("a")!.fatal, false)
    assert.equal(onFoot.get("b")!.fatal, true)
  })
})

describe("time", () => {
  test("an event on one of the requested days earns the bonus", async () => {
    const v = await judge({ source: "eventbrite", windows: [{ start: `${WEEKEND[0]}T17:00` }] })
    assert.equal(v.time.state, "ok")
    assert.ok(v.time.points > 0)
    assert.match(v.time.why, /Sat, Sep 5/)
  })

  test("an event on another date is rejected outright", async () => {
    // The bug: this used to score identically to one on the actual Saturday,
    // because the bonus keyed off which website it came from.
    const v = await judge({ source: "eventbrite", windows: [{ start: "2026-09-19T17:00" }] })
    assert.equal(v.time.state, "fail")
    assert.equal(v.time.fatal, true)
    assert.match(v.time.why, /isn't this weekend/)
  })

  test("a venue is not an undated event — it's open every weekend", async () => {
    const v = await judge({ source: "google-maps" })
    assert.equal(v.time.state, "ok")
    assert.equal(v.time.points, 0)
  })

  test("an events-feed listing with no published date is unknown, and still admitted", async () => {
    const v = await judge({ source: "allevents" })
    assert.equal(v.time.state, "unknown")
    assert.equal(v.fatal, false)
  })
})

describe("kind", () => {
  test("business programming is filtered whatever source it came from", async () => {
    // This filter used to live inside two scrapers, so the same listing from
    // any of the other four sailed through.
    for (const source of ["google-maps", "groupon", "timeout", "tripadvisor"] as const) {
      const v = await judge({ source, title: "MA/ACA networking event - earn CE credits" })
      assert.equal(v.kind.fatal, true, `${source} should have been filtered`)
    }
  })

  test("a two-character title is an extraction failure, not a venue", async () => {
    const v = await judge({ title: "Ba" })
    assert.equal(v.kind.state, "fail")
    assert.equal(v.kind.fatal, true)
  })
})

describe("the summary is what makes the gaps visible", () => {
  test("counts every dimension, including unknown", async () => {
    const { summary } = await screen(
      [
        candidate({ id: "1", lat: 27.95, lng: -82.46 }),                                  // place ok
        candidate({ id: "2" }),                                                            // place unknown
        candidate({ id: "3", lat: 29.585, lng: -81.2078 }),                                // place fail
        candidate({ id: "4", source: "eventbrite", windows: [{ start: "2026-09-19T10:00" }] }), // time fail
      ],
      ctx,
    )
    assert.equal(summary.total, 4)
    assert.equal(summary.byDimension.place.ok, 1)
    assert.equal(summary.byDimension.place.unknown, 2)
    assert.equal(summary.byDimension.place.fail, 1)
    assert.equal(summary.byDimension.time.fail, 1)
    assert.equal(summary.rejected, 2)
    assert.equal(summary.admitted, 2)
  })

  test("the same venue seen by three sources is judged once", async () => {
    // Screening a merged candidate once per sighting would triple its
    // penalties the moment the scorer merged them.
    const { summary } = await screen(
      [
        candidate({ id: "same", source: "google-maps" }),
        candidate({ id: "same", source: "timeout" }),
        candidate({ id: "same", source: "tripadvisor" }),
      ],
      ctx,
    )
    assert.equal(summary.total, 3)
    assert.equal(summary.admitted + summary.rejected, 1)
  })
})
