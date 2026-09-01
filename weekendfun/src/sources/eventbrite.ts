/**
 * Eventbrite — the dated stuff.
 *
 * Maps tells you a venue exists; Eventbrite tells you something is happening
 * there on Saturday at 8pm. Those are the candidates with real dates, which is
 * what turns a list of places into a schedule.
 *
 * Localized by URL slug (`/d/fl--tampa/`), which is why place.ts bothers to
 * resolve the state abbreviation.
 */
import type { Candidate } from "../types.js"
import type { SourceContext, SourceTask } from "../solari/pool.js"
import { stateAbbr } from "../place.js"
import { buildCandidate, guessCategory, isJunkEvent } from "./util.js"

/** Eventbrite's slug is "<region>--<city>", lowercased and hyphenated:
 *  "fl--tampa", "ny--new-york". Non-US falls back to the country code. */
function locationSlug(city: string, state: string | undefined, country: string): string {
  const citySlug = city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  const region = (stateAbbr(state) ?? country).toLowerCase()
  return `${region}--${citySlug}`
}

export const eventbrite: SourceTask = {
  id: "eventbrite",
  // Eventbrite fronts Cloudflare in some regions; solving beats retrying.
  captcha: true,

  async run({ ctx, place, log }: SourceContext): Promise<Candidate[]> {
    const page = await ctx.newPage()
    const out = new Map<string, Candidate>()
    const slug = locationSlug(place.city, place.state, place.country)

    // Eventbrite's own date filters are far more reliable than scraping
    // everything and filtering client-side, so let it do the work.
    const feeds = ["events--this-weekend", "events--next-weekend", "events"]

    try {
      for (const feed of feeds) {
        const url = `https://www.eventbrite.com/d/${slug}/${feed}/`
        try {
          log(`fetching ${feed} ...`)
          // `waitUntil: "commit"`, NOT "domcontentloaded".
          //
          // This site keeps a long tail of resources loading, so
          // "domcontentloaded" never settles and `goto` sits there until its
          // own timeout — then every later call on the page queues behind it
          // and the whole source dies on the watchdog having logged nothing.
          // "commit" resolves as soon as the response starts, and a bounded
          // wait afterwards is enough for the cards to render. Measured: 7s
          // and a full page, versus a 110s hang.
          await page.goto(url, { waitUntil: "commit", timeout: 25_000 })
          await page.waitForTimeout(3000)
          // Deliberately NO `waitForSelector` here.
          //
          // Measured through the pool: `waitForSelector(..., {timeout: 6_000})`
          // on this page took 65 SECONDS to return. Its polling runs against a
          // page whose JS thread is saturated, so the timeout fires nowhere
          // near when it claims to, and it single-handedly blew the source's
          // whole watchdog budget. The bounded settle above already gives the
          // cards time to render, and `evaluateAll` on a missing selector just
          // returns [] — which is the correct outcome for "no events" anyway.
          const rows = await page.locator("a.event-card-link").evaluateAll((els) =>
            els.slice(0, 20).map((el) => {
              const a = el as HTMLAnchorElement
              // NOT `closest("section")` — on this page that resolves to the
              // whole results container, so `textContent` returns the entire
              // document. Twenty of those, each fed to a greedy `[^•]*`
              // regex, backtracks hard enough to wedge the page's JS thread:
              // `evaluateAll` then never returns and the source dies on the
              // watchdog. Stay inside the card, and cap the text regardless —
              // no field we want lives past a couple of hundred characters.
              const card = a.closest("li, div.event-card") ?? a.parentElement ?? a
              const text = (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400)
              const dateMatch = text.match(
                /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+[A-Z][a-z]{2}\s+\d{1,2}[^•]*/,
              )
              const priceMatch = text.match(/Free|\$\d[\d.,]*/i)
              return {
                title: (a.getAttribute("aria-label") ?? "").replace(/^View\s+/i, ""),
                href: a.href.split("?")[0] ?? a.href,
                text,
                dateText: dateMatch ? dateMatch[0] : "",
                priceText: priceMatch ? priceMatch[0] : "",
              }
            }),
          )
          log(`${feed} -> ${rows.length} events`)

          for (const r of rows) {
            if (!r.title || !r.href.includes("/e/")) continue
            // Drop business-marketing and virtual listings before they ever
            // reach the scorer — see isJunkEvent.
            if (isJunkEvent(r.title, r.text)) continue
            const c = buildCandidate({
              source: "eventbrite",
              title: r.title,
              url: r.href,
              category: guessCategory(r.title, "event"),
              evidence: r.dateText ? `${r.dateText} - ${r.title}` : r.text,
              priceRaw: r.priceText,
              // Deliberately not parsed into a real instant: the card omits the
              // year and the timezone, so a parsed datetime would be inventing
              // precision we do not have. The itinerary matches on day name.
              windows: null,
              indoor: null,
            })
            if (!out.has(c.id)) out.set(c.id, c)
          }

          // The weekend feeds are the point; only fall through to the generic
          // feed when they came back thin.
          if (out.size >= 8) break
        } catch (err) {
          log(`${feed} failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    } finally {
      await page.close().catch(() => {})
    }

    return [...out.values()]
  },
}
