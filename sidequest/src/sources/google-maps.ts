/**
 * Google Maps — the venue backbone.
 *
 * Maps is the only source that reliably gives coordinates, and coordinates are
 * what make an itinerary real: without them you can't tell whether two things
 * are a five-minute walk or a forty-minute drive apart. It's also the only
 * source that returns ordinary local businesses — a bowling alley, a bakery,
 * a trampoline park — rather than ticketed events or editorial picks.
 *
 * Localization is by explicit `@lat,lng,zoom` in the URL, not by IP. See
 * solari/geo.ts for why.
 *
 * ── Two things this file used to get badly wrong ──────────────────────────
 *
 * It ran every keyword sequentially in ONE browser. Every other source does
 * one or two page loads, so Maps' wall clock was its keyword count times a
 * navigation, and it set the time for the entire parallel fan-out. Measured
 * on Palm Coast: three runs, two of which spent 90 seconds here and returned
 * nothing at all. It now declares `shard`, so the pool gives it one browser
 * per keyword and they run at the same time as everything else.
 *
 * And it called `waitForSelector`, which the two event sources had already
 * removed for cause: on a page whose JS thread is saturated its polling can't
 * get scheduled, so a 20-second timeout doesn't fire anywhere near 20 seconds.
 * Maps is the heaviest page we load. That call is what ate the 90 seconds.
 */
import type { Page } from "patchright-core"
import type { Candidate } from "../types.js"
import type { SourceContext, SourceTask } from "../solari/pool.js"
import { buildCandidate, categoryFromMapsType, guessCategory, MAPS_TYPE_PATTERN } from "./util.js"

/** How many places to take from one search. The rail holds far more, but the
 *  top of a Maps result list is where the relevance is, and a wider net costs
 *  the whole fan-out its deadline. */
const PER_SEARCH = 10

/** Maps encodes the place's position in the URL as `!3d<lat>!4d<lng>`. It's
 *  the only place coordinates appear in the DOM reliably, so we mine the href
 *  rather than the card. */
function coordsFromHref(href: string): { lat?: number; lng?: number } {
  const m = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)
  if (!m) return {}
  return { lat: Number(m[1]), lng: Number(m[2]) }
}

async function searchOne(page: Page, term: string, lat: number, lng: number) {
  // "commit" returns as soon as the navigation is committed rather than
  // waiting on a resource tail Maps never finishes. The bounded settle below
  // is what actually gives the rail time to render.
  await page.goto(
    `https://www.google.com/maps/search/${encodeURIComponent(term)}/@${lat},${lng},13z`,
    { waitUntil: "commit", timeout: 20_000 },
  )
  await page.waitForTimeout(2500)

  // One scroll of the results rail. The first screen renders about seven
  // cards; one nudge is enough for PER_SEARCH and costs under a second.
  // Wrapped in a catch because the feed element is not always present, and
  // "no more results" is a perfectly good answer.
  await page
    .locator('div[role="feed"]')
    .first()
    .evaluate((el) => el.scrollBy(0, el.scrollHeight))
    .catch(() => {})
  await page.waitForTimeout(900)

  // `evaluateAll` on a missing selector returns [], which is the right answer
  // for "nothing matched" — no waiting required to establish that.
  return page.locator('a[href*="/maps/place/"]').evaluateAll(
    (els, [limit, typePattern]: [number, string]) =>
      els.slice(0, limit as number).map((el) => {
        const a = el as HTMLAnchorElement
        // The card is the anchor's parent block; ratings and price live as
        // siblings, not children, so walk up before reading.
        const card = a.closest("div[jsaction]") ?? a.parentElement ?? a
        const text = (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400)
        const label = a.getAttribute("aria-label") ?? ""
        // Maps renders the whole thing in one label: "4.5 stars 22,001 Reviews".
        // That is far more reliable than the concatenated card text, which
        // sometimes omits the count entirely and left top venues looking like
        // they had no reviews at all.
        const ratingEl = card.querySelector('span[role="img"][aria-label*="star"]')

        // The card's thumbnail, when it has rendered one. Lazy-loaded, so the
        // first few results usually have it and later ones often don't — the
        // plan has to look right either way, which is why the fallback is a
        // designed one rather than a broken image.
        const img = card.querySelector("img") as HTMLImageElement | null
        const imgSrc = img?.src?.startsWith("http") ? img.src : ""

        // Card text runs together as
        //   "<name><name> 4.6Tourist attraction ·  · 401 W Kennedy BlvdHome to..."
        // Two useful things fall out of that shape, both otherwise discarded:
        // the street address, and Maps' own type descriptor — which beats
        // guessing a category from the name, because Maps actually says
        // "Bowling alley" and "Nature preserve".
        const addrMatch = text.match(/·\s*·?\s*(\d{1,6}\s+[A-Z][^·]{4,50}?)(?=[A-Z][a-z]{3,}|$)/)
        const typeMatch = text.match(new RegExp(typePattern))

        return {
          title: label,
          href: a.href,
          text,
          address: addrMatch ? addrMatch[1]!.trim() : "",
          mapsType: typeMatch ? typeMatch[1]!.trim() : "",
          // NOTE: only ever "4.6 stars" in this layout — Maps does not render
          // review counts in the coordinate-search rail, so reviewCount
          // legitimately comes back null. TripAdvisor fills it in on overlap.
          ratingLabel: ratingEl?.getAttribute("aria-label") ?? "",
          // "$10–20", "$$" — Maps is inconsistent, so hand the raw string to
          // the shared parser rather than guessing here.
          priceText: (text.match(/\$\d[\d–\-—\s.$]*|\$+(?=\s|$)/) ?? [""])[0],
          imgSrc,
        }
      }),
    [PER_SEARCH, MAPS_TYPE_PATTERN] as [number, string],
  )
}

export const googleMaps: SourceTask = {
  id: "google-maps",

  // Maps is the source most likely to show a consent wall to a fresh browser,
  // and it is the one source whose absence costs us every coordinate in the
  // plan. Worth the extra seconds.
  captcha: true,

  /**
   * One browser per keyword.
   *
   * Capped at eight so a long vibe list can't consume the whole concurrency
   * budget and starve the other five sources — the Starter plan allows twenty
   * browsers, and the rest of the fan-out needs five of them.
   */
  shard: (keywords) => keywords.slice(0, 8).map((k) => [k]),

  // Each shard is now a single search, so it has no business taking longer
  // than a page load and a settle. Failing fast matters more than succeeding
  // slowly: the plan is built from whatever arrives before the deadline.
  timeoutMs: 16_000,

  async run({ ctx, place, keywords, log }: SourceContext): Promise<Candidate[]> {
    const page = await ctx.newPage()
    const out = new Map<string, Candidate>()

    try {
      // Normally one term, because the pool shards this source. The loop
      // stays so the source still works unsharded — `npm run harden` and the
      // geo proof both call it that way.
      for (const kw of keywords) {
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
              // Maps' own descriptor first — "Live music venue" is a fact,
              // where inferring from the name is a guess. Then the name.
              //
              // It does NOT fall through to the keyword's category. That says
              // what we SEARCHED for, not what we found, and Maps returns
              // tangential results constantly: a search for "bowling" turned
              // up a custom t-shirt shop, which was duly filed under "active"
              // and took a slot in the plan. "other" is the honest answer when
              // neither the descriptor nor the name says anything.
              category: categoryFromMapsType(r.mapsType) ?? guessCategory(r.title, "other"),
              // ...and keep the descriptor itself. Mapping it down to one of
              // eleven categories and discarding the words lost the most
              // reliable fact on the card: "Bowling alley" is not a guess.
              kind: r.mapsType || undefined,
              evidence: r.text || r.title,
              priceRaw: r.priceText,
              ratingRaw: r.ratingLabel,
              reviewsRaw: r.ratingLabel || r.text,
              address: r.address || undefined,
              image: r.imgSrc || undefined,
              lat,
              lng,
              // Maps doesn't say indoor/outdoor. Leave it null and let the
              // category-based fallback in the scorer decide.
              indoor: null,
            })
            // First sighting wins.
            //
            // True within one browser, where the keywords are walked in
            // weight order. NOT true across shards: each keyword now gets its
            // own browser and they merge in whatever order they finish, so a
            // venue found by two searches is typed by whichever raced home
            // first. Pin Chasers, a Tampa bowling alley, came back as `Video
            // arcade` because the arcade shard beat the bowling one — see the
            // README on where a labelling pass would earn its place.
            if (!out.has(c.id)) out.set(c.id, c)
          }
        } catch (err) {
          // One bad query shouldn't cost the others.
          log(`"${kw.term}" failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    } finally {
      await page.close().catch(() => {})
    }

    return [...out.values()]
  },
}
