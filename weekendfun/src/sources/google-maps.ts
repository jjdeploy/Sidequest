/**
 * Google Maps — the venue backbone.
 *
 * Maps is the only source that reliably gives coordinates, and coordinates are
 * what make the itinerary real: without them you can't tell whether two things
 * are a 5-minute walk or a 40-minute drive apart. So this source runs first in
 * spirit even though everything runs in parallel — the others enrich what Maps
 * anchors.
 *
 * Localization is by explicit `@lat,lng,zoom` in the URL, not by IP. See
 * solari/geo.ts for why.
 */
import type { Page } from "patchright-core"
import type { Candidate } from "../types.js"
import type { SourceContext, SourceTask } from "../solari/pool.js"
import { buildCandidate, categoryFromMapsType, guessCategory } from "./util.js"

/** Maps encodes the place's position in the URL as `!3d<lat>!4d<lng>`. It's
 *  the only place coordinates appear in the DOM reliably, so we mine the href
 *  rather than the card. */
function coordsFromHref(href: string): { lat?: number; lng?: number } {
  const m = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)
  if (!m) return {}
  return { lat: Number(m[1]), lng: Number(m[2]) }
}

async function searchOne(page: Page, term: string, lat: number, lng: number) {
  await page.goto(
    `https://www.google.com/maps/search/${encodeURIComponent(term)}/@${lat},${lng},13z`,
    { waitUntil: "domcontentloaded", timeout: 45_000 },
  )

  // The results rail renders after the map settles. Waiting on the selector
  // rather than a fixed sleep keeps the fan-out fast when Maps is quick.
  await page
    .waitForSelector('a[href*="/maps/place/"]', { timeout: 20_000 })
    .catch(() => {})
  await page.waitForTimeout(1500)

  return page.locator('a[href*="/maps/place/"]').evaluateAll((els) =>
    els.slice(0, 14).map((el) => {
      const a = el as HTMLAnchorElement
      // The card is the anchor's parent block; ratings and price live as
      // siblings, not children, so walk up before reading.
      const card = a.closest("div[jsaction]") ?? a.parentElement ?? a
      const text = (card.textContent ?? "").replace(/\s+/g, " ").trim()
      const label = a.getAttribute("aria-label") ?? ""
      // Maps renders the whole thing in one label: "4.5 stars 22,001 Reviews".
      // That is far more reliable than the concatenated card text, which
      // sometimes omits the count entirely and left top venues looking like
      // they had no reviews at all.
      const ratingEl = card.querySelector('span[role="img"][aria-label*="star"]')

      // Card text runs together as
      //   "<name><name> 4.6Tourist attraction ·  · 401 W Kennedy BlvdHome to..."
      // Two useful things fall out of that shape, both otherwise discarded:
      // the street address (the itinerary can use a real location) and Maps'
      // own type descriptor, which beats guessing a category from the name.
      const addrMatch = text.match(/·\s*·?\s*(\d{1,6}\s+[A-Z][^·]{4,50}?)(?=[A-Z][a-z]{3,}|$)/)
      const typeMatch = text.match(/\d\.\d([A-Z][a-z]+(?:\s[a-z]+)*)\s*·/)

      return {
        title: label,
        href: a.href,
        text,
        address: addrMatch ? addrMatch[1]!.trim() : "",
        // e.g. "Tourist attraction", "Live music venue", "Coffee shop".
        mapsType: typeMatch ? typeMatch[1]!.trim() : "",
        // NOTE: this is only ever "4.6 stars" in this layout — Maps does not
        // render review counts in the coordinate-search rail, so reviewCount
        // legitimately comes back null here. TripAdvisor fills it in where the
        // two overlap.
        ratingLabel: ratingEl?.getAttribute("aria-label") ?? "",
        // "$10–20", "$$" — Maps is inconsistent, so hand the raw string to the
        // shared parser rather than guessing here.
        priceText: (text.match(/\$\d[\d–\-—\s.$]*|\$+(?=\s|$)/) ?? [""])[0],
      }
    }),
  )
}

export const googleMaps: SourceTask = {
  id: "google-maps",

  async run({ ctx, place, keywords, log }: SourceContext): Promise<Candidate[]> {
    const page = await ctx.newPage()
    const out = new Map<string, Candidate>()

    // One browser, many queries — a session is the expensive resource, a page
    // load is not. Cap the terms so a rich vibe list can't run for minutes.
    const terms = keywords.slice(0, 6)

    try {
      for (const kw of terms) {
        try {
          const rows = await searchOne(page, kw.term, place.lat, place.lng)
          log(`"${kw.term}" -> ${rows.length} places`)

          for (const r of rows) {
            if (!r.title) continue
            const { lat, lng } = coordsFromHref(r.href)
            const c = buildCandidate({
              source: "google-maps",
              title: r.title,
              url: r.href,
              // Infer from the NAME only. The card text carries the search
              // context ("events", "venue"), which made parks come back as
              // "music" and the convention center as "shopping". When the name
              // says nothing, the keyword's own category is both more accurate
              // and traceable back to why we searched at all.
              // Maps' own descriptor first — "Live music venue" is a fact,
              // where inferring from the name is a guess. Falls through to the
              // name when Maps says something not in the table.
              category:
                categoryFromMapsType(r.mapsType) ?? guessCategory(r.title, kw.category),
              evidence: r.text || r.title,
              priceRaw: r.priceText,
              ratingRaw: r.ratingLabel,
              reviewsRaw: r.ratingLabel || r.text,
              address: r.address || undefined,
              lat,
              lng,
              // Maps doesn't say indoor/outdoor. Leave it null and let the
              // category-based fallback in the scorer decide.
              indoor: null,
            })
            // First sighting wins: earlier keywords have higher weight, so the
            // term that best justifies a venue is the one attached to it.
            if (!out.has(c.id)) out.set(c.id, c)
          }
        } catch (err) {
          // One bad query shouldn't cost the other five.
          log(`"${kw.term}" failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    } finally {
      await page.close().catch(() => {})
    }

    return [...out.values()]
  },
}
