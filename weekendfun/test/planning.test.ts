/**
 * Keywords, ranking and itinerary assembly.
 *
 * These are the deterministic parts, which means they are testable, which
 * means there is no excuse for the bugs that lived here.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { buildKeywords, requestedCategories, stripTimeWords, timeOfDayFrom } from "../src/engine/keywords.js"
import { buildItinerary } from "../src/engine/itinerary.js"
import { rank } from "../src/engine/score.js"
import { candidate, request, scored, WEEKEND } from "./helpers.js"
import type { Category } from "../src/types.js"

const terms = (req: Parameters<typeof buildKeywords>[0]) => buildKeywords(req, 8).map((k) => k.term)

describe("buildKeywords: an empty request still asks a real question", () => {
  test('the fallback is what a stranger to a city would type', () => {
    // It used to be two event phrases — "things to do this weekend" and
    // "events this weekend" — which Google Maps answers badly and which no
    // event source ever saw. A town with three bowling alleys returned none.
    const t = terms(request())
    assert.ok(t.includes("bowling"), `bowling missing from ${t.join(", ")}`)
    assert.ok(t.includes("restaurants"))
    assert.ok(t.includes("parks"))
    assert.ok(t.length >= 5, "an empty request should still fill most of the browser budget")
  })

  test("no term is an event-shaped phrase, because only Maps reads these", () => {
    for (const t of terms(request())) {
      assert.doesNotMatch(t, /this weekend/, `"${t}" is a question, not a place`)
    }
  })
})

describe("buildKeywords: stated intent wins outright", () => {
  test('"chill, outdoorsy" gets no restaurants padded in', () => {
    // Not searching for food when nobody mentioned food is the entire point
    // of deriving queries from a request.
    const t = terms(request({ vibes: ["chill", "outdoorsy"] }))
    assert.ok(t.includes("parks"))
    assert.ok(t.includes("hiking trails"))
    assert.ok(!t.includes("restaurants"), `padded with restaurants: ${t.join(", ")}`)
  })

  test("a party with kids gets family options whether or not anyone said family", () => {
    const t = terms(request({ party: { adults: 2, kids: 2, kidAges: [6, 9] } }))
    assert.ok(t.includes("family attractions") || t.includes("playgrounds"))
  })

  test("a tight budget changes what we search for, not just what we filter", () => {
    const t = terms(request({ budgetUsd: 40 }))
    assert.ok(t.includes("free things to do"))
  })

  test("avoid removes a category from the search", () => {
    const t = terms(request({ vibes: ["foodie"], avoid: ["outdoors"] }))
    assert.ok(!t.includes("parks"))
  })

  test("every term carries the reason it is there", () => {
    for (const k of buildKeywords(request({ vibes: ["chill"] }), 8)) {
      assert.ok(k.because.length > 0, `"${k.term}" has no justification`)
    }
  })
})

describe("buildKeywords: the learner must never reach it", () => {
  test("the same request produces the same terms regardless of anything learned", () => {
    // If learning could narrow the search, a category rated badly once would
    // stop being searched, then stop being shown, and never recover — while
    // the results still looked plausible. The signature takes no weights;
    // this test exists so a later change cannot quietly add them.
    const a = terms(request({ vibes: ["chill"] }))
    const b = terms(request({ vibes: ["chill"] }))
    assert.deepEqual(a, b)
    assert.equal(buildKeywords.length <= 2, true, "buildKeywords must take only (req, limit)")
  })
})

describe("rank: merging sightings of one venue", () => {
  const ctx = {
    req: request(),
    weather: [],
    corroboration: new Map([["aquarium", 3]]),
    history: new Map(),
    weights: {},
    relevance: new Map(),
    requested: new Set<Category>(),
  }

  test("the rating comes from whichever source counted more reviews", () => {
    // Maps counted 5,606 reviews for the Tampa Riverwalk and TripAdvisor
    // 1,906; whichever ran last was silently overwriting the richer answer.
    const [merged] = rank(
      [
        candidate({ id: "aquarium", source: "tripadvisor", rating: 4.0, reviewCount: 1906 }),
        candidate({ id: "aquarium", source: "google-maps", rating: 4.5, reviewCount: 5606 }),
      ],
      ctx,
    )
    assert.equal(merged!.candidate.rating, 4.5)
    assert.equal(merged!.candidate.reviewCount, 5606)
  })

  test("three sightings collapse to one candidate", () => {
    const out = rank(
      [
        candidate({ id: "aquarium", source: "google-maps" }),
        candidate({ id: "aquarium", source: "timeout" }),
        candidate({ id: "aquarium", source: "tripadvisor" }),
      ],
      ctx,
    )
    assert.equal(out.length, 1)
    assert.equal(out[0]!.corroboration, 3)
  })
})

describe("buildItinerary: an event goes on the day it happens", () => {
  const req = request()

  test("a Saturday event is never scheduled on Sunday", () => {
    // "SOCIAL HOUSE SATURDAYS" was scheduled for Sunday evening. The Claude
    // write-up noticed and said so in prose; the code that built the plan had
    // no idea, because nothing in it ever looked at a date.
    const saturdayOnly = scored(
      candidate({
        id: "sat-party", category: "event", title: "Saturday Night Thing",
        windows: [{ start: `${WEEKEND[0]}T21:00` }],
      }),
      500,
    )
    const it = buildItinerary([saturdayOnly], req, [])
    const sunday = it.days.find((d) => d.date === WEEKEND[1])!
    assert.equal(
      sunday.items.some((i) => i.scored.candidate.id === "sat-party"),
      false,
      "a Saturday-dated event appeared on Sunday",
    )
    const saturday = it.days.find((d) => d.date === WEEKEND[0])!
    assert.ok(saturday.items.some((i) => i.scored.candidate.id === "sat-party"))
  })

  test("an event dated outside the weekend is never scheduled at all", () => {
    const wrongWeekend = scored(
      candidate({ id: "sep19", category: "event", windows: [{ start: "2026-09-19T17:00" }] }),
      500,
    )
    const it = buildItinerary([wrongWeekend], req, [])
    const placed = it.days.flatMap((d) => d.items).some((i) => i.scored.candidate.id === "sep19")
    assert.equal(placed, false)
  })

  test("a venue has no date and can go on either day", () => {
    const venue = scored(candidate({ id: "museum", category: "culture" }), 500)
    const it = buildItinerary([venue], req, [])
    assert.equal(it.days.flatMap((d) => d.items).length, 1, "used once, on one of the days")
  })
})

describe("buildItinerary: it is a schedule, not a ranked list", () => {
  const req = request()
  const many = (n: number, category: Parameters<typeof candidate>[0]["category"]) =>
    Array.from({ length: n }, (_, i) => scored(candidate({ id: `${category}-${i}`, category }), 100 - i))

  test("no two adjacent slots share a category when there is an alternative", () => {
    const it = buildItinerary([...many(8, "food"), ...many(8, "outdoors"), ...many(8, "culture")], req, [])
    for (const day of it.days) {
      for (let i = 1; i < day.items.length; i++) {
        assert.notEqual(
          day.items[i]!.scored.candidate.category,
          day.items[i - 1]!.scored.candidate.category,
          `${day.date} repeated ${day.items[i]!.scored.candidate.category} back to back`,
        )
      }
    }
  })

  test("nothing is scheduled twice", () => {
    const it = buildItinerary(many(20, "food"), req, [])
    const ids = it.days.flatMap((d) => d.items.map((i) => i.scored.candidate.id))
    assert.equal(new Set(ids).size, ids.length)
  })

  test("the budget is per person and it stops when it runs out", () => {
    const pricey = Array.from({ length: 6 }, (_, i) =>
      scored(candidate({ id: `p${i}`, category: "food", priceUsd: 60 }), 100),
    )
    // $60 x 2 people = $120 a slot, against a $300 budget: two fit, not six.
    const it = buildItinerary(pricey, request({ budgetUsd: 300 }), [])
    assert.ok(it.totalUsd <= 300, `spent ${it.totalUsd}`)
    assert.equal(it.days.flatMap((d) => d.items).length, 2)
  })

  test("a thin plan says why rather than looking like a failure", () => {
    const it = buildItinerary([], request({ budgetUsd: 10 }), [])
    assert.ok(it.notes.length > 0)
  })

  test("days come back in the order the user thinks about them", () => {
    const it = buildItinerary(many(12, "food"), req, [])
    assert.deepEqual(it.days.map((d) => d.date), WEEKEND)
  })
})

describe("what you asked for reaches the ranking, not just the search", () => {
  test("requestedCategories separates stated intent from the floor", () => {
    // The floor sits at 0.45-0.55 and exists to stop an empty request
    // producing an empty sweep. It is not something anyone asked for, so it
    // must not earn the ranking bonus.
    const asked = requestedCategories(buildKeywords(request({ vibes: ["bowling"] }), 8))
    assert.ok(asked.has("active"), "bowling is an 'active' request")

    const floorOnly = requestedCategories(buildKeywords(request(), 8))
    assert.equal(floorOnly.size, 0, "an empty request asks for nothing in particular")
  })

  test("an asked-for category scores above an identical one nobody mentioned", () => {
    const base = {
      req: request(), weather: [], corroboration: new Map(),
      history: new Map(), weights: {}, relevance: new Map(),
    }
    const lanes = candidate({ id: "lanes", category: "active", rating: 4.0 })
    const [asked] = rank([lanes], { ...base, requested: new Set<Category>(["active"]) })
    const [unasked] = rank([lanes], { ...base, requested: new Set<Category>() })
    assert.ok(asked!.score > unasked!.score)
    assert.ok(asked!.components.some((c) => c.name === "you asked for this"))
  })

  test("ask for bowling and there is bowling in the weekend", () => {
    // The bug this exists for: "Palm Coast Lanes" is 4.0 with no review
    // count, so on generic quality it loses to a 4.7-from-268-reviews park
    // every time — and should, unless somebody asked for bowling. A score
    // nudge alone can't close that gap; the itinerary reserves one slot.
    const lanes = scored(candidate({ id: "lanes", title: "Palm Coast Lanes", category: "active" }), 5)
    const parks = Array.from({ length: 12 }, (_, i) =>
      scored(candidate({ id: `park-${i}`, category: "outdoors", rating: 4.8, reviewCount: 4000 }), 90 - i),
    )

    const without = buildItinerary([lanes, ...parks], request(), [])
    assert.equal(
      without.days.flatMap((d) => d.items).some((i) => i.scored.candidate.id === "lanes"),
      false,
      "unrequested, it should lose on merit",
    )

    const withAsk = buildItinerary([lanes, ...parks], request(), [], new Set(["active"]))
    assert.equal(
      withAsk.days.flatMap((d) => d.items).some((i) => i.scored.candidate.id === "lanes"),
      true,
      "requested, it has to appear",
    )
  })

  test("but only one slot — asking for bowling doesn't fill the weekend with it", () => {
    const lanes = Array.from({ length: 6 }, (_, i) =>
      scored(candidate({ id: `lanes-${i}`, category: "active" }), 5),
    )
    const parks = Array.from({ length: 12 }, (_, i) =>
      scored(candidate({ id: `park-${i}`, category: "outdoors", rating: 4.8, reviewCount: 4000 }), 90 - i),
    )
    const it = buildItinerary([...lanes, ...parks], request(), [], new Set(["active"]))
    const active = it.days.flatMap((d) => d.items).filter((i) => i.scored.candidate.category === "active")
    assert.equal(active.length, 1, `got ${active.length} active slots`)
  })
})

describe("saying WHEN you want it", () => {
  const lanes = () => scored(candidate({ id: "lanes", title: "Palm Coast Lanes", category: "active" }), 5)
  // Scores in the range real ones land in: a strong venue scores around 30-45
  // (corroboration 14 + rating 8 + well-known 7), not 90. A fixture that
  // scores 90 makes the reservation look broken when it isn't.
  const filler = () =>
    Array.from({ length: 14 }, (_, i) =>
      scored(candidate({ id: `p-${i}`, category: i % 2 ? "outdoors" : "food", rating: 4.8, reviewCount: 4000 }), 38 - i),
    )
  const slotOf = (it: ReturnType<typeof buildItinerary>, id: string) =>
    it.days.flatMap((d) => d.items).find((i) => i.scored.candidate.id === id)?.slot ?? null

  test('with no stated time it takes the first slot it can', () => {
    const it = buildItinerary([lanes(), ...filler()], request(), [], new Set(["active"]))
    assert.equal(slotOf(it, "lanes"), "Morning")
  })

  test('"bowling at night" puts bowling at night', () => {
    // The reservation used to fire in whatever slot came first, so an evening
    // request came back as ten in the morning. A consolation bonus in the
    // other slots didn't fix it either — combined with the ranking bonus it
    // still beat a 4.8-star park.
    const it = buildItinerary([lanes(), ...filler()], request({ timeOfDay: "evening" }), [], new Set(["active"]), "evening")
    assert.equal(slotOf(it, "lanes"), "Evening")
  })

  test("morning means morning", () => {
    const it = buildItinerary([lanes(), ...filler()], request({ timeOfDay: "morning" }), [], new Set(["active"]), "morning")
    assert.equal(slotOf(it, "lanes"), "Morning")
  })

  test("afternoon means afternoon", () => {
    const it = buildItinerary([lanes(), ...filler()], request({ timeOfDay: "afternoon" }), [], new Set(["active"]), "afternoon")
    assert.equal(slotOf(it, "lanes"), "Afternoon")
  })
})

describe("reading the request without asking a model", () => {
  // timeOfDay used to come only from the LLM, which made it a coin flip: the
  // same sentence returned "evening" on one run and nothing on the next, and
  // with nothing the reserved slot fires at the first hour of the weekend. So
  // "bowling at night" came back as bowling at 10am, then correctly, then at
  // 10am again. A model is the wrong tool for a decision that has to be the
  // same every time.
  const cases: Array<[string, string | undefined]> = [
    ["bowling at night", "evening"],
    ["something tonight", "evening"],
    ["live music after dark", "evening"],
    ["drinks at 9pm", "evening"],
    ["mini golf in the morning", "morning"],
    ["brunch somewhere", "morning"],
    ["museums in the afternoon", "afternoon"],
    ["lunch by the water", "afternoon"],
    ["bowling", undefined],
    ["somewhere cheap", undefined],
  ]
  for (const [text, want] of cases) {
    test(`"${text}" -> ${want ?? "(unstated)"}`, () => assert.equal(timeOfDayFrom(text), want))
  }

  test("the raw sentence alone is enough to ask for bowling", () => {
    // resolvePlanRequest pushes the untouched text into vibes, so the
    // substring vocabulary sees the user's own words whether or not the
    // claude CLI is installed.
    const asked = requestedCategories(buildKeywords(request({ vibes: ["bowling at night"] }), 8))
    assert.ok(asked.has("active"), `got ${[...asked].join(", ")}`)
  })

  test("and it still lands in the evening", () => {
    const lanes = scored(candidate({ id: "lanes", category: "active" }), 5)
    const filler = Array.from({ length: 14 }, (_, i) =>
      scored(candidate({ id: `p-${i}`, category: i % 2 ? "outdoors" : "food", rating: 4.8, reviewCount: 4000 }), 38 - i),
    )
    const when = timeOfDayFrom("bowling at night")
    const it = buildItinerary([lanes, ...filler], request({ timeOfDay: when }), [], new Set(["active"]), when)
    const slot = it.days.flatMap((d) => d.items).find((i) => i.scored.candidate.id === "lanes")?.slot
    assert.equal(slot, "Evening")
  })
})

describe("a time phrase is a time, not a mood", () => {
  // Feeding the whole sentence to the vibe vocabulary matched "night" as
  // nightlife too, so "bowling at night" quietly became a request for bowling
  // AND cocktail bars AND live music AND breweries — five categories, all
  // pinned to the two evening slots, and the bowling lost its slot to them.
  test("the time comes out of the text once it has been read", () => {
    assert.equal(stripTimeWords("bowling at night"), "bowling")
    assert.equal(stripTimeWords("live music tonight"), "live music")
    assert.equal(stripTimeWords("drinks at 9pm"), "drinks at")
    assert.equal(stripTimeWords("bowling"), "bowling", "nothing to strip")
    assert.equal(stripTimeWords("somewhere on the water"), "somewhere on the water")
  })

  test('"bowling at night" asks for bowling, not for nightlife', () => {
    const withTime = requestedCategories(buildKeywords(request({ vibes: ["bowling at night"] }), 8))
    const stripped = requestedCategories(buildKeywords(request({ vibes: [stripTimeWords("bowling at night")] }), 8))
    assert.ok(withTime.has("nightlife"), "the whole sentence drags nightlife in")
    assert.ok(!stripped.has("nightlife"), `stripped still asked for: ${[...stripped].join(", ")}`)
    assert.ok(stripped.has("active"), "but it still asks for bowling")
  })

  test("the whole path holds together: text in, evening bowling out", () => {
    const ask = "bowling at night"
    const when = timeOfDayFrom(ask)
    const asked = requestedCategories(buildKeywords(request({ vibes: [stripTimeWords(ask)] }), 8))

    const lanes = scored(candidate({ id: "lanes", category: "active" }), 5)
    const filler = Array.from({ length: 16 }, (_, i) =>
      scored(candidate({ id: `p-${i}`, category: i % 2 ? "outdoors" : "food", rating: 4.8, reviewCount: 4000 }), 38 - i),
    )
    const it = buildItinerary([lanes, ...filler], request({ timeOfDay: when }), [], asked, when)
    const slot = it.days.flatMap((d) => d.items).find((i) => i.scored.candidate.id === "lanes")?.slot
    assert.equal(slot, "Evening")
  })
})
