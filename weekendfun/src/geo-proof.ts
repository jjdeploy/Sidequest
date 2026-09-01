/**
 * The premise, tested — run this before trusting anything else in the repo.
 *
 *   npm run geo-proof
 *
 * Two cloud browsers, in parallel, asking one location-sensitive question from
 * two different "places". Both egress from the same residential pool, so any
 * difference in the answers comes from the geolocation override alone.
 *
 * It also prints where the packets actually came from, which is how the
 * proxy-narrowing dead end in solari/geo.ts was found in the first place.
 */
import { Solari } from "@solarisdk/browser"
import { describeProxy, openLocalContext, proxyFor } from "./solari/geo.js"
import { geocode } from "./place.js"
import type { Place } from "./types.js"

const QUERY = "live music"

interface Probe {
  place: Place
  egress: string
  venues: string[]
}

async function probe(solari: Solari, place: Place): Promise<Probe> {
  const proxy = proxyFor(place, `geoproof-${place.city}`)
  console.log(`  [${place.label}] launching, egress ${describeProxy(proxy)} ...`)

  const browser = await solari.launch({ stealth: true, proxy })
  try {
    // Where did the packets really come from? Not used for anything — just
    // shown, so the difference between "where we egress" and "where we are"
    // is visible rather than assumed.
    const scratch = await browser.newPage()
    await scratch.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded" })
    const info = JSON.parse(await scratch.locator("pre").innerText().catch(() => "{}"))
    await scratch.close()
    const egress = `${info.city ?? "?"}, ${info.region ?? "?"} (${info.ip ?? "?"})`

    // The gate: nothing searches until the page confirms where it is.
    const ctx = await openLocalContext(browser, place)
    console.log(`  [${place.label}] geo gate passed`)

    const page = await ctx.newPage()
    await page.goto(
      `https://www.google.com/maps/search/${encodeURIComponent(QUERY)}/@${place.lat},${place.lng},13z`,
      { waitUntil: "domcontentloaded", timeout: 45_000 },
    )
    await page.waitForTimeout(6000)

    const venues = await page
      .locator('a[href*="/maps/place/"]')
      .evaluateAll((els) =>
        els
          .map((e) => (e as HTMLAnchorElement).getAttribute("aria-label"))
          .filter((v): v is string => Boolean(v))
          .slice(0, 8),
      )
      .catch(() => [] as string[])

    return { place, egress, venues }
  } finally {
    await browser.close()
  }
}

async function main() {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set — copy .env.example to .env")

  const [tampa, seattle] = await Promise.all([geocode("Tampa, FL"), geocode("Seattle, WA")])

  const solari = new Solari({ apiKey })
  try {
    console.log(`Asking "${QUERY}" from two cities, in parallel...\n`)
    const started = Date.now()
    const [a, b] = await Promise.all([probe(solari, tampa.best), probe(solari, seattle.best)])
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)

    for (const p of [a, b]) {
      console.log(`\n=== ${p.place.label} ===`)
      console.log(`  egress from : ${p.egress}`)
      console.log(`  browser at  : ${p.place.lat.toFixed(4)}, ${p.place.lng.toFixed(4)} (${p.place.timezone})`)
      console.log(`  venues:`)
      if (p.venues.length === 0) console.log(`    (none extracted)`)
      p.venues.forEach((v, i) => console.log(`    ${i + 1}. ${v}`))
    }

    console.log(`\n=== verdict (both ran in parallel, ${elapsed}s wall clock) ===`)

    // Guard the degenerate case. An empty result set trivially "doesn't
    // overlap" with anything, and reporting that as proof would be a lie.
    if (a.venues.length < 3 || b.venues.length < 3) {
      console.log("  INCONCLUSIVE — one side returned too few venues to compare.")
      console.log("  Extraction probably broke; fix that before reading anything into this.")
      process.exitCode = 1
      return
    }

    const setB = new Set(b.venues)
    const shared = a.venues.filter((v) => setB.has(v))
    const overlap = Math.round((shared.length / a.venues.length) * 100)
    const sameEgress = a.egress.split("(")[1] !== b.egress.split("(")[1] ? "different" : "the same"

    console.log(`  egress IPs   : ${sameEgress}`)
    console.log(`  venue overlap: ${overlap}% (${shared.length}/${a.venues.length})`)
    console.log(
      overlap === 0
        ? "  -> Completely different cities' venues from one proxy pool.\n" +
          "     Geolocation override works; the fan-out is worth building."
        : `  -> ${overlap}% overlap. Expected 0% for cities this far apart —\n` +
          "     check the geo gate is really applying before each search.",
    )
  } finally {
    // Required, or the process never exits.
    await solari.close()
  }
}

main().catch((err) => {
  console.error("\ngeo-proof failed:", err instanceof Error ? err.message : err)
  process.exitCode = 1
})
