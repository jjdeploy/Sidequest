/**
 * The store, and the learning loop that reads it.
 *
 * Runs against `:memory:`, so this needs no fixture file and no cleanup —
 * one of the reasons `node:sqlite` was worth using over a native module.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { Store } from "../src/store/db.js"
import { relearn, describeTaste } from "../src/engine/learn.js"
import { candidate, request } from "./helpers.js"

const fresh = () => new Store(":memory:")

describe("candidates upsert", () => {
  test("the stored category is the one the user was shown", () => {
    // The in-memory merge keeps the FIRST source's category, so taking the
    // last one here made the stored category disagree with the displayed
    // one. Skipping the Florida Aquarium — shown as "family" — taught the
    // learner about "culture", because Time Out happened to write last.
    const store = fresh()
    store.recordRun("run-1", request(), 1000)
    store.saveResults("run-1", [
      { source: "google-maps", candidates: [candidate({ id: "aq", title: "The Florida Aquarium", category: "family" })], elapsedMs: 1 },
      { source: "timeout", candidates: [candidate({ id: "aq", title: "The Florida Aquarium", category: "culture" })], elapsedMs: 1 },
    ])
    assert.equal(store.resolveCandidate("aq")!.category, "family")
    store.close()
  })

  test("corroboration counts distinct sources, not sightings", () => {
    const store = fresh()
    store.recordRun("run-1", request(), 1000)
    store.saveResults("run-1", [
      { source: "google-maps", candidates: [candidate({ id: "aq", source: "google-maps" })], elapsedMs: 1 },
      { source: "timeout", candidates: [candidate({ id: "aq", source: "timeout" })], elapsedMs: 1 },
      { source: "tripadvisor", candidates: [candidate({ id: "aq", source: "tripadvisor" })], elapsedMs: 1 },
      { source: "groupon", candidates: [candidate({ id: "solo", source: "groupon" })], elapsedMs: 1 },
    ])
    const corr = store.corroborationFor("run-1")
    assert.equal(corr.get("aq"), 3)
    assert.equal(corr.get("solo"), 1)
    store.close()
  })
})

describe("sightingsFor", () => {
  test("one row per source, however many runs it has been seen on", () => {
    // The raw table has a row per source per run, so a venue found by three
    // sources across three weekends returned nine rows under a heading that
    // said "3 independent sources".
    const store = fresh()
    for (const run of ["r1", "r2", "r3"]) {
      store.recordRun(run, request(), 1000)
      store.saveResults(run, [
        { source: "google-maps", candidates: [candidate({ id: "aq", source: "google-maps", evidence: `maps ${run}` })], elapsedMs: 1 },
        { source: "timeout", candidates: [candidate({ id: "aq", source: "timeout", evidence: `timeout ${run}` })], elapsedMs: 1 },
      ])
    }
    const rows = store.sightingsFor("aq")
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.runs).sort(), [3, 3])
    store.close()
  })
})

describe("resolveCandidate", () => {
  test("an ambiguous prefix fails loudly rather than guessing", () => {
    // Silently rating the wrong venue corrupts the learner in a way that is
    // very hard to notice later.
    const store = fresh()
    store.recordRun("r", request(), 1)
    store.saveResults("r", [
      { source: "google-maps", candidates: [candidate({ id: "abc111" }), candidate({ id: "abc222" })], elapsedMs: 1 },
    ])
    assert.equal(store.resolveCandidate("abc"), null)
    assert.equal(store.resolveCandidate("abc111")!.id, "abc111")
    store.close()
  })
})

describe("locality cache", () => {
  test("negatives are cached too, because most lookups are not places", () => {
    const store = fresh()
    assert.equal(store.getLocality("the olympic venue"), undefined, "never asked")
    store.putLocality("the olympic venue", null)
    assert.equal(store.getLocality("the olympic venue"), null, "asked, and it is not a place")
    store.putLocality("palm coast", { lat: 29.585, lng: -81.2078 })
    assert.deepEqual(store.getLocality("Palm Coast"), { lat: 29.585, lng: -81.2078 })
    store.close()
  })
})

describe("the learning loop", () => {
  const seed = (store: Store) => {
    store.recordRun("r", request(), 1)
    store.saveResults("r", [
      {
        source: "google-maps",
        candidates: [
          candidate({ id: "party", category: "event", priceUsd: 0 }),
          candidate({ id: "museum", category: "culture", priceUsd: 20 }),
        ],
        elapsedMs: 1,
      },
    ])
  }

  test("a rating moves the category it was actually about", () => {
    const store = fresh()
    seed(store)
    store.addSignal("party", "rated", 5)
    store.addSignal("museum", "rated", 1)
    const { updated } = relearn(store)
    assert.ok(updated["cat:event"]! > 1, `event was ${updated["cat:event"]}`)
    assert.ok(updated["cat:culture"]! < 1, `culture was ${updated["cat:culture"]}`)
    assert.equal(updated["cat:food"], 1, "an unrated category must stay neutral")
    store.close()
  })

  test("weights are clamped, so no amount of clicking inverts the ranking", () => {
    const store = fresh()
    seed(store)
    for (let i = 0; i < 200; i++) store.addSignal("party", "rated", 5)
    const { updated } = relearn(store)
    assert.ok(updated["cat:event"]! <= 1.8)
    assert.ok(updated["cat:event"]! >= 0.4)
    store.close()
  })

  test("it is a full recompute, so deleting a signal actually undoes it", () => {
    // An incremental nudge would bake a mistake in permanently.
    const store = fresh()
    seed(store)
    const before = relearn(store).updated["cat:culture"]
    store.addSignal("museum", "rated", 1)
    const after = relearn(store).updated["cat:culture"]
    assert.notEqual(before, after)
    store.deleteSignal("museum", "rated")
    assert.equal(relearn(store).updated["cat:culture"], before)
    store.close()
  })

  test("with nothing rated, every weight is neutral", () => {
    const store = fresh()
    seed(store)
    const { updated, signalsUsed } = relearn(store)
    assert.equal(signalsUsed, 0)
    for (const [key, value] of Object.entries(updated)) {
      assert.equal(value, 1, `${key} should start neutral`)
    }
    assert.match(describeTaste(updated)[0]!, /No preferences learned yet/)
    store.close()
  })
})
