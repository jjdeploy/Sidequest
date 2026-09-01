/**
 * AllEvents.in — dated events, and the one source that works everywhere.
 *
 * Eventbrite is richer but skews toward ticketed, promoted events. AllEvents
 * aggregates the long tail — the free market, the neighbourhood thing — and it
 * covers small cities where Eventbrite returns almost nothing. Between them
 * the dated half of a plan holds up outside major metros.
 *
 * Its cards carry the date and the street address inline, which makes this the
 * only event source that can hand the itinerary a real location.
 */
import type { Candidate } from "../types.js"
import type { SourceContext, SourceTask } from "../solari/pool.js"
import { buildCandidate, guessCategory, isJunkEvent } from "./util.js"
import { parseEventWhen } from "./when.js"

function citySlug(city: string): string {
  return city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export const allevents: SourceTask = {
  id: "allevents",

  async run({ ctx, place, req, log }: SourceContext): Promise<Candidate[]> {
    const page = await ctx.newPage()
    const out = new Map<string, Candidate>()
    const slug = citySlug(place.city)

    const feeds = [
      ["this weekend", `https://allevents.in/${slug}/this-weekend`],
      ["next weekend", `https://allevents.in/${slug}/next-weekend`],
    ] as const

    try {
      for (const [label, url] of feeds) {
        try {
          log(`fetching ${label} ...`)
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
          // Under a wide fan-out this page renders slower than it does alone;
          // 3s was enough standalone and intermittently returned an empty list
          // at six-way concurrency.
          await page.waitForTimeout(4500)
          // Deliberately NO `waitForSelector` here.
          //
          // Measured through the pool: `waitForSelector(..., {timeout: 6_000})`
          // on this page took 65 SECONDS to return. Its polling runs against a
          // page whose JS thread is saturated, so the timeout fires nowhere
          // near when it claims to, and it single-handedly blew the source's
          // whole watchdog budget. The bounded settle above already gives the
          // cards time to render, and `evaluateAll` on a missing selector just
          // returns [] — which is the correct outcome for "no events" anyway.
          // The markup alternates between these two card shapes depending on
          // which layout the site serves. Pick whichever is actually present
          // rather than silently returning nothing.
          const primary = "article.semantic-event-container"
          const fallback = "li.event-card"
          const sel = (await page.locator(primary).count().catch(() => 0)) > 0 ? primary : fallback

          const rows = await page
            .locator(sel)
            .evaluateAll((els) =>
              els.slice(0, 25).map((el) => {
                // Capped for the same reason as eventbrite.ts: unbounded card
                // text plus a greedy regex is what wedges the page thread.
                const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400)
                const link = el.querySelector("a[href]") as HTMLAnchorElement | null
                // Cards are laid out as
                // "<title> Date and Time <when> Location <where>".
                const titleMatch = text.match(/^(.{3,120}?)\s+Date and Time/)
                const whenMatch = text.match(/Date and Time\s+(.{5,60}?)(?:\s*\+\s*\d+ more)?\s+Location/)
                const whereMatch = text.match(/Location\s+(.{5,90})$/)
                const priceMatch = text.match(/Free|\$\d[\d.,]*/i)
                return {
                  title: titleMatch ? titleMatch[1]!.trim() : text.slice(0, 90),
                  href: link?.href?.split("?")[0] ?? "",
                  when: whenMatch ? whenMatch[1]!.trim() : "",
                  where: whereMatch ? whereMatch[1]!.trim() : "",
                  priceText: priceMatch ? priceMatch[0] : "",
                }
              }),
            )
          log(`${label} -> ${rows.length} events (${sel})`)

          for (const r of rows) {
            if (!r.title || !r.href) continue
            if (isJunkEvent(r.title, r.where)) continue
            // "Sat, 05 Sep, 2026 - 05:00 PM" and friends — see when.ts.
            const when = parseEventWhen(r.when || r.title, req.days)
            const c = buildCandidate({
              source: "allevents",
              title: r.title,
              url: r.href,
              category: guessCategory(r.title, "event"),
              evidence: [r.when, r.where].filter(Boolean).join(" @ ") || r.title,
              priceRaw: r.priceText,
              address: r.where || undefined,
              windows: when ? [{ start: `${when.date}T${when.time ?? "00:00"}` }] : null,
              indoor: null,
            })
            if (!out.has(c.id)) out.set(c.id, c)
          }

          if (out.size >= 10) break
        } catch (err) {
          log(`${label} failed: ${err instanceof Error ? err.message : err}`)
        }
      }
    } finally {
      await page.close().catch(() => {})
    }

    return [...out.values()]
  },
}
