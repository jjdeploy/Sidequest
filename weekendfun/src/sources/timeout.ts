/**
 * Time Out — the local voice.
 *
 * This is the closest legitimate substitute for the r/<city> signal we wanted
 * and can't have (Reddit 403s all logged-out automation — see sources/reddit.ts).
 * Time Out is written by people who live in the city, so it surfaces the
 * neighbourhood spot that no ranking algorithm would, and it says *why* in a
 * sentence we can quote back to the user as evidence.
 *
 * Editorial, so it's opinion rather than data: no prices, no coordinates. It
 * earns its slot by corroborating and by explaining, not by volume.
 */
import type { Candidate } from "../types.js"
import type { SourceContext, SourceTask } from "../solari/pool.js"
import { buildCandidate, guessCategory } from "./util.js"

function citySlug(city: string): string {
  return city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export const timeout: SourceTask = {
  id: "timeout",

  async run({ ctx, place, log }: SourceContext): Promise<Candidate[]> {
    const page = await ctx.newPage()
    const out = new Map<string, Candidate>()
    const slug = citySlug(place.city)

    // Time Out redirects /things-to-do to its current best-of listicle, so we
    // follow rather than guess the slug.
    const feeds = [
      ["things to do", `https://www.timeout.com/${slug}/things-to-do`],
      ["restaurants", `https://www.timeout.com/${slug}/restaurants`],
    ] as const

    try {
      for (const [label, url] of feeds) {
        try {
          const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
          // Time Out has no page for every city; a 404 here is expected, not
          // an error worth retrying.
          if (resp && resp.status() >= 400) {
            log(`${label}: HTTP ${resp.status()} (no Time Out edition for ${place.city})`)
            continue
          }
          await page.waitForSelector("article", { timeout: 12_000 }).catch(() => {})
          await page.waitForTimeout(1500)

          const rows = await page.locator("article").evaluateAll((els) =>
            els.slice(0, 20).map((el) => {
              const h = el.querySelector("h3, h2")
              const link = el.querySelector("a[href]") as HTMLAnchorElement | null
              const text = (el.textContent ?? "").replace(/\s+/g, " ").trim()
              // Listicle headings are numbered: "1. Busch Gardens Tampa Bay".
              const rawTitle = (h?.textContent ?? "").replace(/\s+/g, " ").trim()
              const title = rawTitle.replace(/^\d+\.\s*/, "")
              // Drop the photo credit that prefixes most blurbs.
              const blurb = text
                .replace(rawTitle, "")
                .replace(/^Photograph:[^.]*\.?\s*/i, "")
                .trim()
              return { title, href: link?.href?.split("?")[0] ?? "", blurb }
            }),
          )
          log(`${label} -> ${rows.length} picks`)

          for (const r of rows) {
            if (!r.title || r.title.length < 3) continue
            const c = buildCandidate({
              source: "timeout",
              title: r.title,
              url: r.href || page.url(),
              category: guessCategory(`${r.title} ${r.blurb}`, "culture"),
              // The blurb IS the value here — it's a local telling you why.
              evidence: r.blurb ? `Time Out: ${r.blurb}` : `Time Out ${place.city} pick: ${r.title}`,
              indoor: null,
            })
            if (!out.has(c.id)) out.set(c.id, c)
          }
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
