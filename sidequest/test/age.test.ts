/**
 * The 21+ flag.
 *
 * One toggle, and it has to mean something absolute: if the party did not say
 * everyone is 21, a bar must not appear in the plan at all. Not ranked low —
 * absent. That is a different promise from every other preference in here,
 * and the tests below are written for the two ways it goes wrong:
 *
 *   too eager   a sushi bar, a juice bar, a "$18+" ticket price, a family
 *               festival whose blurb happens to mention a cash bar
 *   too lax     a taproom that reached the plan because nobody checked
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { isAdultOnly, partyIsOver21 } from "../src/engine/age.js"
import { request } from "./helpers.js"

describe("isAdultOnly: a name is evidence, a passing mention is not", () => {
  const adult = [
    "The Independent Bar & Cafe",
    "Cigar City Brewing",
    "Coppertail Brewery",
    "Angel's Share Speakeasy",
    "Ybor City Wine Bar",
    "Hyde Park Taproom",
    "Hattricks Sports Bar",
    "Bar Louie",
    "The Dubliner Irish Pub",
    "Keel Farms Cidery",
    "Club Prana",
    "Tampa Bay Brewery Crawl",
    "Sunset Wine Tasting on the Riverwalk",
  ]
  for (const title of adult) {
    test(`${title} is a 21+ room`, () => {
      assert.equal(isAdultOnly({ title }), true, title)
    })
  }

  const allAges = [
    "Ichicoro Ramen Sushi Bar",
    "Squeeze Juice Bar",
    "Buddy Brew Coffee",
    "Holy Hog Barbecue",
    "The Bar Method Tampa",       // a barre studio, not a bar
    "Sandbar Grill",
    "Tampa Riverwalk",
    "Glazer Children's Museum",
    "Ybor City Book Club",
  ]
  for (const title of allAges) {
    test(`${title} is not`, () => {
      assert.equal(isAdultOnly({ title }), false, title)
    })
  }

  test("an explicit age gate anywhere in the listing counts", () => {
    assert.equal(isAdultOnly({ title: "Rooftop Yoga", evidence: "21+ only, ID required" }), true)
    assert.equal(isAdultOnly({ title: "Comedy Night", evidence: "18 and over" }), true)
  })

  test("a price is not an age", () => {
    // "$18+" is how half of Eventbrite writes a ticket price. Reading it as
    // an age gate would delete the cheap end of every event source.
    assert.equal(isAdultOnly({ title: "Riverfront Art Fair", evidence: "Tickets from $18+" }), false)
    assert.equal(isAdultOnly({ title: "Family Fun Day", evidence: "$21+ per car" }), false)
  })

  test("a cash bar in the blurb does not make a street festival 21+", () => {
    // The venue patterns read the NAME only. Evidence is a snippet from a
    // page and mentions a bar constantly — food halls, weddings, festivals.
    assert.equal(
      isAdultOnly({ title: "Seminole Heights Block Party", evidence: "Free entry, cash bar, kids welcome" }),
      false,
    )
  })

  test("a bar inside a restaurant is an amenity, not the business", () => {
    // All four are verbatim from the stored candidate table, and all four
    // were being deleted from under-21 plans by the bare word "bar".
    for (const title of [
      "Solid Grill & Bar",
      "Nene's Restaurant & Bar",
      "Aji Ceviche Bar Peruvian Restaurant",
      "DI Coffee Bar - Midtown",
    ]) {
      assert.equal(isAdultOnly({ title }), false, title)
    }
  })

  test("...but a brewery with a kitchen is still a brewery", () => {
    assert.equal(isAdultOnly({ title: "Hi-Wire Brewing RAD Beer Garden & Kitchen" }), true)
    assert.equal(isAdultOnly({ title: "Wedge Brewing Company Pizzeria" }), true)
  })

  test("a lounge is only a lounge when it says what kind", () => {
    assert.equal(isAdultOnly({ title: "Gaming Lounge" }), false)
    assert.equal(isAdultOnly({ title: "Ash & Ale Cigar Lounge" }), true)
  })

  test("the drink and nightlife categories are adult by construction", () => {
    assert.equal(isAdultOnly({ title: "Place 7", category: "drink" }), true)
    assert.equal(isAdultOnly({ title: "Place 8", category: "nightlife" }), true)
    assert.equal(isAdultOnly({ title: "Place 9", category: "food" }), false)
  })
})

describe("partyIsOver21: the flag is about everyone, not the person typing", () => {
  test("off unless it is ticked", () => {
    assert.equal(partyIsOver21(request()), false)
  })

  test("on when it is ticked", () => {
    assert.equal(partyIsOver21(request({ party: { adults: 2, kids: 0, over21: true } })), true)
  })

  test("a kid in the party overrides the tick", () => {
    // Ticking 21+ and then saying you are bringing a four-year-old is not a
    // request for a bar crawl; it is two answers that cannot both be true.
    // The party wins, because that is the one that names a real person.
    assert.equal(partyIsOver21(request({ party: { adults: 2, kids: 1, over21: true } })), false)
  })
})
