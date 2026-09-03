/**
 * The extraction layer.
 *
 * Every case here is a bug that shipped and produced a plausible wrong answer
 * rather than an error, which is exactly the class of failure a scraper is
 * worst at noticing. The test names say what went wrong, not what the
 * function does.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  categoryFromMapsType,
  guessCategory,
  isJunkEvent,
  milesBetween,
  parsePrice,
  parseRating,
  parseReviewCount,
} from "../src/sources/util.js"
import { MAPS_TYPE_PATTERN } from "../src/sources/util.js"
import { cleanField, decodeEntities, isDegenerate } from "../src/sources/text.js"

describe("guessCategory: unanchored tokens hide inside longer words", () => {
  // Four of the ten rules were unanchored, and each token found a word to
  // hide in. The category is not cosmetic — it is what feedback teaches the
  // learner about — so a wrong one trains a preference nobody expressed.
  const cases: Array<[string, string]> = [
    ["5pm In Tampa The R&B Block Party", "event"],       // "art" matched "P-art-y"
    ["SUNDRESS & SNEAKERS DAY PARTY", "event"],
    ["Sparkman Wharf shops", "shopping"],                 // "park" matched "S-park-man"
    ["Bazooka Charlie's", "other"],                       // "zoo" matched "Ba-zoo-ka"
    ["Signature Salon", "other"],                         // "nature" matched "Sig-nature"
  ]
  for (const [title, want] of cases) {
    test(`${title} -> ${want}`, () => assert.equal(guessCategory(title), want))
  }
})

describe("guessCategory: food is tested before shopping", () => {
  // First-match-wins, and "shop" is the most promiscuous token in the list.
  // "Blind Tiger Coffee Roasters - Coffee Shop" was filed under shopping,
  // and rating it in the dashboard taught the learner about shopping.
  const cases: Array<[string, string]> = [
    ["Blind Tiger Coffee Roasters - Tampa City Center Cafe - Coffee Shop", "food"],
    ["Bay Cities Sandwich Shop", "food"],
    ["Buddy Brew Coffee", "food"],
    // ...without swallowing things that really are shops.
    ["Ybor City Saturday Market", "shopping"],
    ["Oxford Exchange Bookstore", "shopping"],
    ["Vintage thrift boutique", "shopping"],
  ]
  for (const [title, want] of cases) {
    test(`${title} -> ${want}`, () => assert.equal(guessCategory(title), want))
  }
})

describe("guessCategory: things that must keep working", () => {
  const cases: Array<[string, string]> = [
    ["Tampa Museum of Art", "culture"],
    ["Straz Center for the Performing Arts", "culture"],
    ["Curtis Hixon Waterfront Park", "outdoors"],
    ["The Florida Aquarium", "family"],
    ["Cigar City Brewing taproom", "drink"],
    ["Jazz at the Palladium", "music"],
    ["Gasparilla Festival", "event"],
    // An unanchored "eat" filed this under food. It reads as `active` now
    // that escape rooms are in the vocabulary, which is what it always
    // should have been — the point being defended here is that it is not
    // food.
    ["Great Escape Room", "active"],
  ]
  for (const [title, want] of cases) {
    test(`${title} -> ${want}`, () => assert.equal(guessCategory(title), want))
  }
})

describe("guessCategory: the things people actually go and do", () => {
  test("bowling is a category the planner searches for and could not name", () => {
    // categoryFromMapsType knew about bowling; guessCategory never did. So a
    // bowling listing from any source that publishes no type descriptor —
    // Groupon, in the run that caught this — came back as `other`, which
    // cost it the evening slot that had been booked for bowling.
    assert.equal(guessCategory("Electrifying Bowlero Bowling Fun, Shoes Included"), "active")
    assert.equal(guessCategory("Sunset Lanes Bowling Center"), "active")
    assert.equal(guessCategory("Saturn 5 Arcade"), "active")
    assert.equal(guessCategory("Breakout Escape Room"), "active")
    assert.equal(guessCategory("Stone Axe Throwing"), "active")
  })

  test("...without matching the words hiding inside other words", () => {
    assert.notEqual(guessCategory("Lowry Parcade"), "active")
    assert.notEqual(guessCategory("Poke Bowl Kitchen"), "active")
    assert.notEqual(guessCategory("Super Bowl Watch Party"), "active")
  })
})

describe("guessCategory: a club is not necessarily that kind of club", () => {
  test("a warehouse store is not nightlife", () => {
    // The bare token "club" filed Sam's Club and BJ's Wholesale Club under
    // nightlife, which was harmless until the 21+ gate started reading the
    // category — at which point a warehouse store became a room a
    // twenty-year-old is turned away from.
    assert.notEqual(guessCategory("Sam's Club"), "nightlife")
    assert.notEqual(guessCategory("BJ's Wholesale Club"), "nightlife")
    assert.notEqual(guessCategory("Italian Language Program @ the Italian Club"), "nightlife")
  })

  test("an actual nightclub still is", () => {
    assert.equal(guessCategory("Club Prana Nightclub"), "nightlife")
    assert.equal(guessCategory("Vibe Dance Club"), "nightlife")
  })
})

describe("categoryFromMapsType", () => {
  test('"Coffee shop" is food, not shopping', () => {
    assert.equal(categoryFromMapsType("Coffee shop"), "food")
  })
  test('"Bowling alley" is active — this is how Sunset Lanes gets categorised', () => {
    assert.equal(categoryFromMapsType("Bowling alley"), "active")
  })
  test('"Tourist attraction" resolves to nothing, so the name decides', () => {
    // Maps applies it to parks, beaches and bowling alleys alike. Treating it
    // as a category filed six small-town parks under culture.
    assert.equal(categoryFromMapsType("Tourist attraction"), null)
    assert.equal(categoryFromMapsType("Tourist attraction") ?? guessCategory("Waterfront Park"), "outdoors")
  })
  test("an unknown descriptor returns null rather than guessing", () => {
    assert.equal(categoryFromMapsType("Notary public"), null)
    assert.equal(categoryFromMapsType(""), null)
  })
})

describe("parseReviewCount", () => {
  test('does not read the "4" out of "4.7 stars"', () => {
    // A bare leading number matched the rating, and every venue in the plan
    // came back with exactly 4 reviews.
    assert.equal(parseReviewCount("4.7 stars"), null)
  })
  test("reads the parenthesised form Maps and TripAdvisor use", () => {
    assert.equal(parseReviewCount("4.7(4,605)"), 4605)
  })
  test("reads the worded form", () => {
    assert.equal(parseReviewCount("4.5 stars 22,001 Reviews"), 22001)
  })
  test("returns null when there is no count, rather than zero", () => {
    // null means "not published"; 0 would mean "nobody has reviewed it", and
    // the scorer treats those very differently.
    assert.equal(parseReviewCount("Open · Closes 12 AM"), null)
  })
})

describe("parsePrice", () => {
  test("free is 0, unknown is null, and they are not the same thing", () => {
    assert.equal(parsePrice("Free").usd, 0)
    assert.equal(parsePrice("").usd, null)
    assert.equal(parsePrice(null).usd, null)
  })
  test("a range is a range: the midpoint, not the low end", () => {
    // Taking the low end reports "$1-10" as a $1 dinner. The hyphen shape is
    // matched explicitly because it usually carries only one dollar sign.
    assert.equal(parsePrice("$10–20").usd, 15)
    assert.equal(parsePrice("$15 - $40").usd, 27.5)
  })
  test("plain dollars", () => {
    assert.equal(parsePrice("$25.99").usd, 25.99)
  })
})

describe("parseRating", () => {
  test("reads Maps' aria-label", () => assert.equal(parseRating("4.6 stars"), 4.6))
  test("null when absent", () => assert.equal(parseRating(""), null))
})

describe("isJunkEvent", () => {
  // Eventbrite and AllEvents are full of listings that are business
  // marketing. They rank well on a free-and-dated bonus and are useless in a
  // weekend plan. An early run proudly scheduled the first of these for a
  // Saturday night.
  const junk = [
    "HPM- Archwell MA/ACA networking event - earn CE credits",
    "Virtual Summit: Scaling Your Practice",
    "Heart Health Lunch & Learn",
    "TPA Ticketing Expansion Project Informational Session",
    "College Visit to Middleton HS",
    "Real Estate Investing Masterclass",
  ]
  for (const title of junk) test(`rejects "${title.slice(0, 40)}…"`, () => assert.equal(isJunkEvent(title), true))

  const fine = [
    "5pm In Tampa The R&B Block Party",
    "Gasparilla Music Festival",
    "Bob Ross Sip & Paint Night",
    "Tampa Tarpons vs Dunedin Blue Jays",
    // "college football game" is a great Saturday; the school filter has to
    // stay narrow enough not to eat it.
    "USF college football game",
  ]
  for (const title of fine) test(`keeps "${title}"`, () => assert.equal(isJunkEvent(title), false))
})

describe("isJunkEvent: a discount is not a thing to do", () => {
  test("a Groupon promo line is not a Sunday morning", () => {
    // "10% Cashback" was scheduled as the Sunday morning of a real plan.
    // Groupon prints the offer where the venue name goes on some cards.
    assert.equal(isJunkEvent("10% Cashback"), true)
    assert.equal(isJunkEvent("Up to 50% Off"), true)
    assert.equal(isJunkEvent("$25 Cash Back at Solid Grill & Bar"), true)
  })

  test("a real venue that mentions a discount is not junk", () => {
    assert.equal(isJunkEvent("Sky Lanes Bowling", "Two games for $18, 20% off before noon"), false)
  })
})

describe("text hygiene: what a truncated card leaves behind", () => {
  // All three verbatim from one Tampa run, and two of them were printed on
  // plan cards. Groupon runs its card text together and the title extraction
  // stops mid-punctuation.
  test("a dangling bracket is not part of the name", () => {
    assert.equal(cleanField("AMC Theatres("), "AMC Theatres")
    assert.equal(cleanField("Brio Italian Grille("), "Brio Italian Grille")
    assert.equal(cleanField("Sunset Lanes ["), "Sunset Lanes")
  })

  test("the next sentence running into the name is cut at the seam", () => {
    // "…Brooksville, FLAccess to 2," is a merchant name with the start of
    // the offer copy glued to it. A state code followed straight by a
    // capitalised word is where the card ended and the blurb began.
    assert.equal(
      cleanField("Woods ATV Rentals - Brooksville, FLAccess to 2,"),
      "Woods ATV Rentals - Brooksville, FL",
    )
  })

  test("...without touching a name that legitimately has brackets in it", () => {
    assert.equal(cleanField("Cantina Louie (Ormond Beach, FL)"), "Cantina Louie (Ormond Beach, FL)")
    assert.equal(cleanField("The One Stop (Bar, Live Music & Kitchen)"), "The One Stop (Bar, Live Music & Kitchen)")
  })
})

describe("text hygiene", () => {
  test("decodes double-encoded entities", () => {
    assert.equal(decodeEntities("Fish &amp;amp; Chips"), "Fish & Chips")
    assert.equal(decodeEntities("caf&#233;"), "café")
  })
  test('strips the chrome sites append to truncated text', () => {
    // "&amp; Ho... Read more" was stored as a street address, which looks
    // populated but is a lie the scorer cannot detect.
    assert.equal(cleanField("&amp; Ho... Read more"), undefined)
    assert.equal(cleanField("1920 Ybor Save this event: 5pm In Tampa"), "1920 Ybor")
  })
  test("an extraction that produced two characters is not a venue", () => {
    assert.equal(isDegenerate("Ba"), true)
    assert.equal(isDegenerate("& Ho"), true)
    assert.equal(isDegenerate("·  ·"), true)
    assert.equal(isDegenerate("Bing's Landing"), false)
  })
})

describe("milesBetween", () => {
  test("zero distance to itself", () => {
    assert.ok(milesBetween(TAMPA_PT, TAMPA_PT) < 0.001)
  })
  test("Tampa to the Atlantic coast is about 150 miles", () => {
    const miles = milesBetween(TAMPA_PT, { lat: 29.585, lng: -81.2078 })
    assert.ok(miles > 130 && miles < 170, `got ${miles}`)
  })
})

const TAMPA_PT = { lat: 27.94752, lng: -82.45843 }

describe("MAPS_TYPE_PATTERN: digging the descriptor out of a result card", () => {
  // Verbatim card text. The descriptor is the single most valuable field Maps
  // gives us — it is the difference between "Bowling alley" and guessing — so
  // the regex that extracts it gets tested rather than living unreachable
  // inside a browser callback.
  const typeOf = (card: string) => card.match(new RegExp(MAPS_TYPE_PATTERN))?.[1]?.trim() ?? null

  test("plain two-word descriptor", () => {
    assert.equal(typeOf("Sunset LanesSunset Lanes 4.0Bowling alley ·  · 11 Old Kings Rd"), "Bowling alley")
  })

  test("hyphenated descriptors are not lost", () => {
    // This is the bug: the separator only allowed spaces, so "Custom t-shirt
    // store" matched nothing, the descriptor was dropped, and the candidate
    // got categorised by the search term that happened to find it.
    assert.equal(
      typeOf("Big Frog Custom T-Shirts & MoreBig Frog Custom T-Shirts & More 4.9Custom t-shirt store ·  · 250"),
      "Custom t-shirt store",
    )
    assert.equal(typeOf("Speedway KartsSpeedway Karts 4.3Go-kart track ·  · 9 Main St"), "Go-kart track")
    assert.equal(typeOf("The MotorVuThe MotorVu 4.1Drive-in movie theater ·  · 1 Rd"), "Drive-in movie theater")
  })

  test("a review count between the rating and the descriptor", () => {
    // Maps renders the count inconsistently in the coordinate-search rail, so
    // the SAME venue flips between "4.0Bowling alley" and
    // "4.0(212)Bowling alley" run to run. Requiring the descriptor to follow
    // the rating immediately lost it on 308 of 1,184 stored cards — 26% — and
    // those all fell back to "other", which is how a bowling alley stopped
    // being a bowling alley between two identical searches.
    assert.equal(
      typeOf("Idaho Botanical GardenIdaho Botanical Garden 4.6(3,351)Tourist attraction ·  · 2355 N O"),
      "Tourist attraction",
    )
    assert.equal(
      typeOf("Sunset LanesSunset Lanes 4.0(212)Bowling alley ·  · 11 Old Kings Rd"),
      "Bowling alley",
    )
    assert.equal(
      typeOf("Zoo BoiseZoo Boise 4.2(7,050)Tourist attraction ·  · 355 Julia Davis Dr"),
      "Tourist attraction",
    )
  })

  test("single-word descriptor", () => {
    assert.equal(typeOf("Varn ParkVarn Park 4.7Park ·  · 3665 N Oceanshore Blvd"), "Park")
  })

  test("and the descriptors it finds still map to the right category", () => {
    assert.equal(categoryFromMapsType("Custom t-shirt store"), "shopping")
    assert.equal(categoryFromMapsType("Go-kart track"), "active")
    assert.equal(categoryFromMapsType("Bowling alley"), "active")
  })
})
