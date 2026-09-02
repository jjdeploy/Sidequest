/**
 * TripAdvisor — the "is this actually worth it" check.
 *
 * Google Maps ratings skew high and thin; TripAdvisor's attraction ranking is
 * the closest thing to a consensus ordering of what a city is known for. We
 * use it less to *find* things than to corroborate: a venue Maps found that
 * also sits in TripAdvisor's top 30 is a much safer recommendation.
 *
 * Extraction note: a listing card is several sibling anchors that all point at
 * the SAME review URL, each holding one fragment — "2. The Florida Aquarium",
 * "4.24.2 of 5 bubbles(6,013)", "Admission tickets from $41", then the blurb.
 * Treating each anchor as its own result produced candidates literally titled
 * "Admission tickets from $46", so we group by href and reassemble the card.
 */
import type { Candidate } from "../types.js"
import type { SourceContext, SourceTask } from "../solari/pool.js"
import { buildCandidate, guessCategory } from "./util.js"

/** The review URL carries the name: ...-Reviews-The_Florida_Aquarium-Tampa... */
function titleFromHref(href: string): string {
  const m = href.match(/-Reviews-([^/]+?)-[A-Z][a-z]+_/)
  if (!m) return ""
  return m[1]!.replace(/_/g, " ").trim()
}

export const tripadvisor: SourceTask = {
  id: "tripadvisor",
  captcha: true,
  // Healthy runs finish in 11-14s even for large metros; measured standalone
  // in Austin and Seattle. It is also the most contention-sensitive source and
  // the least essential (corroboration only), so cap it well below the pool
  // default rather than letting a bad run set the wall clock for the plan.
  timeoutMs: 45_000,

  async run({ ctx, place, log }: SourceContext): Promise<Candidate[]> {
    const page = await ctx.newPage()
    const out = new Map<string, Candidate>()

    try {
      // Resolve the city's internal geo id by searching. Hardcoding ids would
      // work for Tampa and break for every other city — the kind of demo that
      // falls over live.
      const searchUrl =
        "https://www.tripadvisor.com/Search?q=" +
        encodeURIComponent(`${place.city} ${place.state ?? ""} things to do`)
      // "commit", not "domcontentloaded" — TripAdvisor keeps a long resource
      // tail and domcontentloaded intermittently never settled, which is what
      // blew the watchdog in Burlington and Boise. See sources/eventbrite.ts.
      await page.goto(searchUrl, { waitUntil: "commit", timeout: 20_000 })
      await page.waitForTimeout(3500)

      const attractionsHref = await page
        .locator("a[href*='Attractions-g']")
        .first()
        .getAttribute("href")
        .catch(() => null)

      if (!attractionsHref) {
        log(`no TripAdvisor geo id resolved for ${place.city}`)
        return []
      }

      // Confirm the search actually landed on OUR city. TripAdvisor happily
      // returns a neighbouring metro for an ambiguous query, and because this
      // source carries no coordinates the distance penalty downstream cannot
      // catch it — a Tampa plan came back recommending The Ringling, which is
      // in Sarasota, 60 miles away.
      const slugCity = place.city.toLowerCase().replace(/[^a-z]/g, "")
      if (!attractionsHref.toLowerCase().replace(/[^a-z]/g, "").includes(slugCity)) {
        log(`search resolved to a different city (${attractionsHref.slice(0, 60)}) — skipping`)
        return []
      }

      const listUrl = attractionsHref.startsWith("http")
        ? attractionsHref
        : `https://www.tripadvisor.com${attractionsHref}`
      await page.goto(listUrl, { waitUntil: "commit", timeout: 20_000 })
      // No `waitForSelector` — its polling is not bounded by its own timeout on
      // a busy page (65s observed against a 6s limit elsewhere in this repo),
      // and it was the whole reason this source blew its watchdog in Boise.
      // A bounded settle plus a direct query is faster and cannot hang.
      await page.waitForTimeout(3000)

      // Pin to the listing's own geo id. Validating the LISTING url wasn't
      // enough: TripAdvisor's Tampa page also lists attractions in nearby
      // metros, so The Ringling (g34618, Sarasota, 60 miles away) kept landing
      // in a Tampa plan. Every attraction must carry the same -g<id>- as the
      // page we asked for.
      const geoId = listUrl.match(/-(g\d+)-/)?.[1] ?? ""
      log(`listing ${geoId || "unknown geo"}`)

      // Collect every fragment, keyed by the review URL that owns it.
      const cards = await page.locator("a[href*='/Attraction_Review']").evaluateAll((els) => {
        const byHref: Record<string, string[]> = {}
        for (const el of els) {
          const a = el as HTMLAnchorElement
          const href = a.href.split("?")[0] ?? a.href
          const text = (a.textContent ?? "").replace(/\s+/g, " ").trim()
          if (!text) continue
          ;(byHref[href] ??= []).push(text)
        }
        return Object.entries(byHref).slice(0, 40)
      })
      log(`-> ${cards.length} attractions`)

      let skippedOutOfArea = 0
      for (const [href, fragments] of cards) {
        if (geoId && !href.includes(`-${geoId}-`)) {
          skippedOutOfArea++
          continue
        }
        // "2. The Florida Aquarium" — the ranked title is the fragment that
        // starts with a number and isn't a rating or a price.
        const titleFrag = fragments.find(
          (f) => /^\d+\.\s+\S/.test(f) && !/of 5 bubbles/.test(f),
        )
        const rated = fragments.find((f) => /of 5 bubbles/.test(f)) ?? ""
        const priced = fragments.find((f) => /from \$\d/.test(f)) ?? ""
        // The blurb is the longest remaining fragment.
        const blurb =
          fragments
            .filter((f) => f !== titleFrag && f !== rated && f !== priced)
            .sort((a, b) => b.length - a.length)[0] ?? ""

        const title = (titleFrag ?? "").replace(/^\d+\.\s*/, "").trim() || titleFromHref(href)
        if (!title || title.length < 3) continue

        const c = buildCandidate({
          source: "tripadvisor",
          title,
          url: href,
          category: guessCategory(`${title} ${blurb}`, "culture"),
          evidence: blurb || `TripAdvisor top attraction in ${place.city}: ${title}`,
          // "4.24.2 of 5 bubbles(6,013)" — the leading "4.2" is the aria value
          // repeated, so the shared parser reading the first number is correct.
          ratingRaw: rated,
          reviewsRaw: rated.replace(/^[\d.]+/, ""),
          priceRaw: priced,
          indoor: null,
        })
        if (!out.has(c.id)) out.set(c.id, c)
      }
      if (skippedOutOfArea > 0) log(`skipped ${skippedOutOfArea} attractions in other cities`)
    } catch (err) {
      log(`failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      await page.close().catch(() => {})
    }

    return [...out.values()]
  },
}
