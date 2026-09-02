/**
 * Keywords, ranking and itinerary assembly.
 *
 * These are the deterministic parts, which means they are testable, which
 * means there is no excuse for the bugs that lived here.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { blockedByAgeGate, buildKeywords, requestedCategories, stripTimeWords, timeOfDayFrom, understoodNothing } from "../src/engine/keywords.js"
import { buildItinerary } from "../src/engine/itinerary.js"
import { rank } from "../src/engine/score.js"
import { candidate, request, scored, WEEKEND } from "./helpers.js"
import type { Category } from "../src/types.js"
import { eventPartOfDay } from "../src/sources/when.js"

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

  test("a sighting without a descriptor does not erase one that has it", () => {
    // Only Maps publishes a descriptor, and whichever sighting arrived first
    // won every field it did not name — so a TripAdvisor row landing ahead of
    // the Maps one deleted the single most reliable fact on the candidate.
    const [merged] = rank(
      [
        candidate({ id: "same", title: "Pin Chasers", source: "tripadvisor" }),
        candidate({ id: "same", title: "Pin Chasers", source: "google-maps", kind: "Bowling alley" }),
      ],
      ctx,
    )
    assert.equal(merged!.candidate.kind, "Bowling alley")
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

  test("night still means night in a town with nothing else in it", () => {
    // Palm Coast, verbatim. Withholding the reservation from the wrong slots
    // is not enough on its own: in a small town the requested venue is often
    // also the best thing available at ten in the morning, so it won the slot
    // on merit before the evening ever came round. The whole point of saying
    // "at night" is that it should be held back.
    const thin = Array.from({ length: 10 }, (_, i) =>
      scored(candidate({ id: `t-${i}`, category: i % 2 ? "outdoors" : "food", rating: 3.9 }), 4 - i * 0.2),
    )
    const it = buildItinerary([lanes(), ...thin], request({ timeOfDay: "evening" }), [], new Set(["active"]), "evening")
    assert.equal(slotOf(it, "lanes"), "Evening")
  })

  test("but a held category still shows up if it is the only thing in town", () => {
    // Held back, not banned. If the alternative is an empty slot, the plan
    // takes the bowling alley at ten rather than printing an apology.
    const only = [lanes(), scored(candidate({ id: "lanes-2", category: "active" }), 4)]
    const it = buildItinerary(only, request({ timeOfDay: "evening" }), [], new Set(["active"]), "evening")
    const slots = it.days.flatMap((d) => d.items).map((i) => i.slot)
    assert.ok(slots.length > 0, "the plan should not come back empty")
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
    // Two requests in one sentence. Taking "night" out of "the other night"
    // left "bowling , clubbing the other" sitting in the hint under the
    // search box, which reads like the parser gave up halfway.
    assert.equal(stripTimeWords("bowling at night, clubbing the other night"), "bowling, clubbing")
  })

  test('"bowling at night" asks for bowling, not for nightlife', () => {
    // A 21+ party on both sides, because the point being demonstrated here is
    // the time word contaminating the vibe read. Without the flag the 21+
    // gate drops the nightlife terms first and the contamination is invisible
    // — still fixed, but fixed by the wrong rule to be testing.
    const party = { adults: 2, kids: 0, over21: true }
    const withTime = buildKeywords(request({ party, vibes: ["bowling at night"] }), 8).map((k) => k.term)
    const stripped = buildKeywords(request({ party, vibes: [stripTimeWords("bowling at night")] }), 8).map((k) => k.term)
    // Read at the search level, which is where the contamination still
    // shows: requestedCategories now only counts the words they typed, so
    // the inferred nightlife terms no longer reserve a slot either way.
    // "dance clubs" comes only from the nightlife vibe. Cocktail bars and
    // breweries are on this list either way — the 21+ party puts them there.
    assert.ok(withTime.includes("dance clubs"), "the whole sentence drags nightlife in")
    assert.ok(!stripped.includes("dance clubs"), `stripped still asked for: ${stripped.join(", ")}`)
    assert.ok(stripped.includes("bowling"), "but it still asks for bowling")
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

describe("an event goes in the slot it actually starts in", () => {
  // We parsed the start time, stored it, and then picked the slot by category
  // anyway — so a sourdough class starting at 12:00 PM was scheduled for the
  // evening. The Claude write-up spotted it and said so in prose, which is
  // the second time the prose has noticed something the planner hadn't.
  test("eventPartOfDay reads the hour", () => {
    const at = (t: string) => eventPartOfDay({ windows: [{ start: `2026-09-05T${t}` }] })
    assert.equal(at("09:00"), "morning")
    assert.equal(at("11:29"), "morning")
    assert.equal(at("12:00"), "afternoon")
    assert.equal(at("16:29"), "afternoon")
    assert.equal(at("17:00"), "evening")
    assert.equal(at("21:30"), "evening")
  })

  test("midnight means the listing gave no time, not an event at midnight", () => {
    // parseEventWhen defaults there when only a date was published.
    assert.equal(eventPartOfDay({ windows: [{ start: "2026-09-05T00:00" }] }), null)
    assert.equal(eventPartOfDay({ windows: null }), null)
  })

  test("a noon class never lands in the evening slot", () => {
    const noon = scored(
      candidate({ id: "class", category: "event", windows: [{ start: `${WEEKEND[0]}T12:00` }] }),
      500,
    )
    const it = buildItinerary([noon], request(), [])
    const placed = it.days.flatMap((d) => d.items).find((i) => i.scored.candidate.id === "class")
    assert.equal(placed?.slot, "Afternoon")
  })

  test("an evening gig never lands in the morning slot", () => {
    const gig = scored(
      candidate({ id: "gig", category: "music", windows: [{ start: `${WEEKEND[0]}T21:00` }] }),
      500,
    )
    const it = buildItinerary([gig], request(), [])
    assert.equal(
      it.days.flatMap((d) => d.items).find((i) => i.scored.candidate.id === "gig")?.slot,
      "Evening",
    )
  })

  test("a venue with no published time is still free to go anywhere", () => {
    const venue = scored(candidate({ id: "park", category: "outdoors" }), 500)
    const it = buildItinerary([venue], request(), [])
    assert.equal(it.days.flatMap((d) => d.items).length, 1)
  })
})

describe("buildKeywords: don't spend a browser on a bar you can't enter", () => {
  const terms = (r: Parameters<typeof buildKeywords>[0]) => buildKeywords(r).map((k) => k.term)

  test("a nightlife request stops asking for bars when the party isn't 21+", () => {
    // The gate would throw these results away anyway. Searching for them
    // first burns browsers out of a budget of eight — the expensive resource
    // spent on candidates that are already decided.
    //
    // Breweries are not on that list: they are not strictly 21+, so they are
    // still worth a search and still worth a slot.
    const t = terms(request({ vibes: ["nightlife"] }))
    assert.ok(!t.some((x) => /bar|club/.test(x)), `still asking for: ${t.join(", ")}`)
  })

  test("...and still comes back with a full set of terms", () => {
    // Filtering must not leave a thin query set. The floor tops it back up.
    assert.ok(terms(request({ vibes: ["nightlife"] })).length >= 5)
  })

  test("ticking 21+ puts the bars back", () => {
    const t = terms(request({ vibes: ["nightlife"], party: { adults: 2, kids: 0, over21: true } }))
    assert.ok(t.some((x) => /bar|brewer|club/.test(x)), `expected nightlife terms, got: ${t.join(", ")}`)
  })

  test("21+ on its own is enough to look for a drink", () => {
    // Ticking the box with no vibes at all should change the search, or the
    // flag is decorative.
    const t = terms(request({ party: { adults: 2, kids: 0, over21: true } }))
    assert.ok(t.some((x) => /bar|brewer/.test(x)), t.join(", "))
  })

  test("but it never becomes a reservation", () => {
    // requestedCategories drives the itinerary's one-slot guarantee. Ticking
    // 21+ makes a bar POSSIBLE; it must not make one COMPULSORY.
    const cats = requestedCategories(buildKeywords(request({ party: { adults: 2, kids: 0, over21: true } })))
    assert.ok(!cats.has("drink"), "21+ should widen the search, not reserve a slot")
  })
})

describe("buildItinerary: a brewery is not a ten-in-the-morning plan", () => {
  test("the best-reviewed brewery in town still does not open the weekend", () => {
    // Asheville with 21+ ticked came back with New Belgium at 10am on the
    // Saturday: the slot preference costs a drink venue ten points, and a
    // brewery that big clears ten points on reviews alone. Time of day is not
    // a preference for this category — it is the difference between a plan
    // somebody follows and one they laugh at.
    const brewery = scored(candidate({ id: "brew", category: "drink", rating: 4.8, reviewCount: 5000 }), 95)
    const rest = Array.from({ length: 8 }, (_, i) =>
      scored(candidate({ id: `f-${i}`, category: i % 2 ? "outdoors" : "culture" }), 20 - i))
    const it = buildItinerary([brewery, ...rest], request({ party: { adults: 2, kids: 0, over21: true } }), [])

    const slots = it.days.flatMap((d) => d.items).filter((i) => i.scored.candidate.id === "brew")
    assert.equal(slots.length, 1, "it should still be in the weekend somewhere")
    assert.notEqual(slots[0]!.slot, "Morning")
  })
})

describe("two things asked for, two nights", () => {
  // "bowling at night, clubbing the other night" came back with an ale
  // lounge one night and no bowling at all.
  //
  // The vibe vocabulary expands a typed word into a family of searches, and
  // "clubbing" alone pulls in cocktail bars, live music venues, dance clubs
  // and breweries. All four are marked asked-for, so the plan owed FIVE
  // categories a reserved evening slot, held all five out of the other four
  // slots with the matching penalty, and had two evenings to settle it in.
  // Bowling lost the auction and then had nowhere else to go.
  const ask = "bowling at night, clubbing the other night"

  test("only the words they actually typed reserve a slot", () => {
    const asked = requestedCategories(buildKeywords(
      request({ vibes: [stripTimeWords(ask)], party: { adults: 2, kids: 0, over21: true } }), 8))
    assert.deepEqual([...asked].sort(), ["active", "nightlife"])
  })

  test("...and the searches themselves still widen", () => {
    // The expansion is good — it is what finds a club in a town that calls
    // it something else. It just should not be mistaken for a request.
    const t = buildKeywords(
      request({ vibes: [stripTimeWords(ask)], party: { adults: 2, kids: 0, over21: true } }), 8,
    ).map((k) => k.term)
    assert.ok(t.includes("bowling"), t.join(", "))
    assert.ok(t.some((x) => /bars|music|brewer/.test(x)), t.join(", "))
  })

  test("both of them get a night", () => {
    const bowling = scored(candidate({ id: "lanes", category: "active" }), 6)
    const club = scored(candidate({ id: "club", category: "nightlife" }), 6)
    const filler = Array.from({ length: 14 }, (_, i) =>
      scored(candidate({ id: `f-${i}`, category: i % 2 ? "outdoors" : "food", rating: 4.9, reviewCount: 9000 }), 40 - i))
    const it = buildItinerary(
      [bowling, club, ...filler],
      request({ party: { adults: 2, kids: 0, over21: true } }),
      [], new Set(["active", "nightlife"]), "evening",
    )
    const placed = it.days.flatMap((d) => d.items.map((i) => [i.slot, i.scored.candidate.id]))
    assert.ok(placed.some(([slot, id]) => id === "lanes" && slot === "Evening"), JSON.stringify(placed))
    assert.ok(placed.some(([slot, id]) => id === "club" && slot === "Evening"), JSON.stringify(placed))
  })

  test("no more reservations than there are nights to honour them in", () => {
    // Five categories owed a slot and two evenings to put them in. The four
    // that lose are still held out of every daytime slot by the penalty that
    // was keeping them free for an evening they are never going to get — so
    // they vanish from the plan entirely, which is what happened to the
    // bowling. A reservation nothing can honour is just a ban.
    const owed = ["active", "culture", "drink", "music", "nightlife"] as const
    const wanted = owed.map((category, i) =>
      scored(candidate({ id: `w-${i}`, category }), 40))
    const weak = Array.from({ length: 8 }, (_, i) =>
      scored(candidate({ id: `weak-${i}`, category: i % 2 ? "outdoors" : "food" }), 5))

    const it = buildItinerary(
      [...wanted, ...weak],
      request({ party: { adults: 2, kids: 0, over21: true } }),
      [], new Set(owed), "evening",
    )

    const daytime = it.days
      .flatMap((d) => d.items)
      .filter((i) => i.slot !== "Evening")
      .map((i) => i.scored.candidate.id)
    assert.ok(
      daytime.some((id) => id.startsWith("w-")),
      `every asked-for category was held out of the daytime: ${daytime.join(", ")}`,
    )
  })
})

describe("a request outranks source balance", () => {
  test("the one bowling alley in town still gets its night", () => {
    // Asheville, "bowling at night": Sky Lanes Bowling scored 4.75 and had
    // the +60 reservation, and still lost the Sunday evening to New Belgium
    // Brewing at 30.4. Google Maps had taken three slots by then, so the
    // per-source diminishing return charged the bowling alley -27 and the
    // brewery, found by a source that had won nothing yet, zero.
    //
    // Source balance exists so Maps cannot take all six slots. It is not a
    // reason to drop the one thing somebody typed the name of.
    const bowling = scored(candidate({ id: "lanes", source: "google-maps", category: "active" }), 4.75)
    const brewery = scored(candidate({ id: "brew", source: "tripadvisor", category: "drink" }), 30)
    const mapsFill = Array.from({ length: 4 }, (_, i) =>
      scored(candidate({ id: `m-${i}`, source: "google-maps", category: i % 2 ? "culture" : "outdoors" }), 29 - i))

    const it = buildItinerary(
      [brewery, ...mapsFill, bowling],
      request({ days: [WEEKEND[0]!], party: { adults: 2, kids: 0, over21: true } }),
      [], new Set(["active"]), "evening",
    )

    const evening = it.days[0]!.items.find((i) => i.slot === "Evening")
    assert.equal(evening?.scored.candidate.id, "lanes")
  })
})

describe("what you typed is a requirement, not a preference", () => {
  const both = [{ term: "bowling", category: "active" as const }, { term: "dance clubs", category: "nightlife" as const }]

  test("bowling at night and a club at night get both nights", () => {
    // Not "scores higher". Booked. The two evenings are claimed before the
    // rest of the weekend is filled in around them.
    const lanes = scored(candidate({ id: "lanes", title: "Sky Lanes Bowling", category: "active" }), 4)
    const club = scored(candidate({ id: "club", title: "Club Prana", category: "nightlife" }), 4)
    const heavies = Array.from({ length: 12 }, (_, i) =>
      scored(candidate({ id: `h-${i}`, category: i % 2 ? "food" : "music", rating: 4.9, reviewCount: 9000 }), 60 - i))

    const it = buildItinerary([...heavies, lanes, club], request(), [], new Set(), "evening", both)
    const evenings = it.days.flatMap((d) => d.items).filter((i) => i.slot === "Evening")
      .map((i) => i.scored.candidate.id).sort()
    assert.deepEqual(evenings, ["club", "lanes"])
    assert.equal(it.unmet.length, 0)
  })

  test("the word wins inside its own category", () => {
    const pinball = scored(candidate({ id: "pin", title: "Asheville Pinball Museum", category: "active" }), 25)
    const lanes = scored(candidate({ id: "lanes", title: "Sky Lanes Bowling", category: "active" }), 4)
    const it = buildItinerary([pinball, lanes], request({ days: [WEEKEND[0]!] }), [], new Set(), "evening",
      [{ term: "bowling", category: "active" }])
    assert.equal(it.days[0]!.items.find((i) => i.slot === "Evening")?.scored.candidate.id, "lanes")
  })

  test("Palm Coast Lanes is bowling, and does not say so", () => {
    // The venue almost never repeats the search term. An alley is called
    // Lanes, an arcade is called a Retrocade, a music venue is called a
    // Hall. Matching the literal word finds Sky Lanes Bowling by luck and
    // misses every other alley in the country.
    const pinball = scored(candidate({ id: "pin", title: "Asheville Pinball Museum", category: "active" }), 30)
    const lanes = scored(candidate({ id: "lanes", title: "Palm Coast Lanes", category: "active" }), 3)
    const it = buildItinerary([pinball, lanes], request({ days: [WEEKEND[0]!] }), [], new Set(), "evening",
      [{ term: "bowling", category: "active" }])
    assert.equal(it.days[0]!.items.find((i) => i.slot === "Evening")?.scored.candidate.id, "lanes")
  })

  test("the card says Bowling alley, which settles it outright", () => {
    // No alias needed and no category guess needed: Maps labelled it.
    const opaque = scored(candidate({ id: "amf", title: "AMF Beacon", kind: "Bowling alley", category: "other" }), 3)
    const pinball = scored(candidate({ id: "pin", title: "Asheville Pinball Museum", category: "active" }), 30)
    const it = buildItinerary([pinball, opaque], request({ days: [WEEKEND[0]!] }), [], new Set(), "evening",
      [{ term: "bowling", category: "active" }])
    assert.equal(it.days[0]!.items.find((i) => i.slot === "Evening")?.scored.candidate.id, "amf")
  })

  test("...but only where the category agrees", () => {
    // "Lanes" is a loose signal — Penny Lane Antiques, Memory Lane Diner.
    // Safe because it only decides anything when the listing is filed under
    // the category the request was for.
    const antiques = scored(candidate({ id: "ant", title: "Memory Lane Antiques", category: "shopping" }), 40)
    const pinball = scored(candidate({ id: "pin", title: "Asheville Pinball Museum", category: "active" }), 3)
    const it = buildItinerary([antiques, pinball], request({ days: [WEEKEND[0]!] }), [], new Set(), "evening",
      [{ term: "bowling", category: "active" }])
    assert.equal(it.days[0]!.items.find((i) => i.slot === "Evening")?.scored.candidate.id, "pin")
  })

  test("a blurb that mentions bowling is not a bowling alley", () => {
    // Biltmore Estate was booked as the Sunday evening bowling. The house
    // has a two-lane alley in the basement, so the word is in the listing —
    // and the booking pass was reading the whole listing. The name is
    // evidence; a blurb is not. Same rule the 21+ gate already runs on, for
    // the same reason.
    const biltmore = scored(candidate({
      id: "biltmore", title: "Biltmore Estate", category: "culture",
      evidence: "…a two-lane bowling alley in the basement, a pool…",
    }), 40)
    const lanes = scored(candidate({ id: "lanes", title: "Sky Lanes Bowling", category: "active" }), 3)
    const it = buildItinerary([biltmore, lanes], request({ days: [WEEKEND[0]!] }), [], new Set(), "evening",
      [{ term: "bowling", category: "active" }])
    assert.equal(it.days[0]!.items.find((i) => i.slot === "Evening")?.scored.candidate.id, "lanes")
  })

  test("...and it does not outrank a plain category match either", () => {
    // With no alley in town, the nearest `active` thing is closer to the
    // request than a stately home whose blurb happens to say the word.
    const biltmore = scored(candidate({
      id: "biltmore", title: "Biltmore Estate", category: "culture",
      evidence: "…a two-lane bowling alley in the basement…",
    }), 40)
    const pinball = scored(candidate({ id: "pin", title: "Asheville Pinball Museum", category: "active" }), 3)
    const it = buildItinerary([biltmore, pinball], request({ days: [WEEKEND[0]!] }), [], new Set(), "evening",
      [{ term: "bowling", category: "active" }])
    assert.equal(it.days[0]!.items.find((i) => i.slot === "Evening")?.scored.candidate.id, "pin")
  })

  test("...and the category carries it when nothing matches the word", () => {
    const pinball = scored(candidate({ id: "pin", title: "Asheville Pinball Museum", category: "active" }), 4)
    const dinner = scored(candidate({ id: "food", title: "Curate", category: "food" }), 40)
    const it = buildItinerary([dinner, pinball], request({ days: [WEEKEND[0]!] }), [], new Set(), "evening",
      [{ term: "bowling", category: "active" }])
    assert.equal(it.days[0]!.items.find((i) => i.slot === "Evening")?.scored.candidate.id, "pin")
  })

  test("when the town has neither, the plan says so in its own words", () => {
    // The point of a requirement is that failing it is news. A weekend that
    // quietly leaves out the one thing you asked for looks like the town is
    // empty rather than like the search came up short.
    const filler = Array.from({ length: 8 }, (_, i) =>
      scored(candidate({ id: `f-${i}`, category: i % 2 ? "food" : "culture" }), 30 - i))
    const it = buildItinerary(filler, request(), [], new Set(), "evening", both)
    assert.equal(it.unmet.length, 2, JSON.stringify(it.unmet))
    assert.match(it.unmet.join(" "), /bowling/)
    assert.match(it.unmet.join(" "), /club/i)
  })

  test("with no hour named, it books the slot that suits it", () => {
    // "live music" with no time on it should not become Saturday at ten
    // merely because that slot came first in the list.
    const band = scored(candidate({ id: "band", title: "The Grey Eagle", category: "music" }), 5)
    const filler = Array.from({ length: 10 }, (_, i) =>
      scored(candidate({ id: `f-${i}`, category: i % 2 ? "outdoors" : "culture" }), 30 - i))
    const it = buildItinerary([...filler, band], request(), [], new Set(), undefined,
      [{ term: "live music venues", category: "music" }])
    const at = it.days.flatMap((d) => d.items).find((i) => i.scored.candidate.id === "band")
    assert.equal(at?.slot, "Evening")
  })

  test("more requests than nights is also news", () => {
    const one = [{ term: "bowling", category: "active" as const }, { term: "dance clubs", category: "nightlife" as const }]
    const lanes = scored(candidate({ id: "lanes", title: "Sky Lanes Bowling", category: "active" }), 4)
    const club = scored(candidate({ id: "club", title: "Club Prana", category: "nightlife" }), 4)
    const it = buildItinerary([lanes, club], request({ days: [WEEKEND[0]!] }), [], new Set(), "evening", one)
    assert.equal(it.unmet.length, 1, JSON.stringify(it.unmet))
    assert.match(it.unmet[0]!, /evening/i)
  })
})

describe("the 21+ switch has to say what it cost you", () => {
  const ask = stripTimeWords("bowling at night, club at night")

  test("a club request is reported, not silently dropped", () => {
    // The keyword builder refuses to spend a browser on a room the party
    // cannot enter, which is right — but it also meant the request never
    // became a requirement, so nothing was owed and `unmet` came back empty.
    // The user asked for a club by name and got a weekend with no club and
    // no reason given, which is the exact failure `unmet` exists to prevent.
    const lost = blockedByAgeGate(request({ vibes: [ask] })).map((k) => k.term)
    assert.deepEqual(lost, ["dance clubs"])
  })

  test("nothing is owed once the box is ticked", () => {
    const req = request({ vibes: [ask], party: { adults: 2, kids: 0, over21: true } })
    assert.deepEqual(blockedByAgeGate(req), [])
  })

  test("and nothing is owed to someone who never asked", () => {
    // A mood chip is not a request for a club. "live music" maps onto the
    // nightlife vocabulary internally, and those terms are dropped quietly
    // and correctly — no explanation is owed for a word nobody typed.
    assert.deepEqual(blockedByAgeGate(request({ vibes: ["nightlife"] })), [])
    assert.deepEqual(blockedByAgeGate(request({ vibes: ["outdoorsy"] })), [])
  })
})

describe("a request the vocabulary has never heard of", () => {
  test("\"skiing at night\" in Tampa is recognised as not recognised", () => {
    // Tampa has no skiing, which is fine. What is not fine is that the run
    // came back with a full, cheerful weekend and said nothing at all — the
    // word matched no vibe, so the floor quietly took over and the request
    // left no trace anywhere in the output.
    const kw = buildKeywords(request({ vibes: [stripTimeWords("skiing at night")] }), 8)
    assert.equal(understoodNothing(kw), true)
  })

  test("...but a mood it does know is not a failure to understand", () => {
    // "chill" produces no term the user typed the word for either, and must
    // not be reported as unrecognised. The difference is whether the vibe
    // vocabulary matched at all.
    for (const vibe of ["chill", "outdoorsy", "cheap", "date night"]) {
      const kw = buildKeywords(request({ vibes: [vibe] }), 8)
      assert.equal(understoodNothing(kw), false, vibe)
    }
  })
})
