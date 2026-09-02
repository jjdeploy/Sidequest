/**
 * Groupon — the price floor.
 *
 * Groupon is the only source that tells you a thing is *cheaper than usual*
 * right now. That makes it disproportionately useful to a budget-constrained
 * plan: it doesn't just filter the expensive stuff out, it finds the expensive
 * stuff you can suddenly afford.
 *
 * It also blocks datacenter traffic outright, which is exactly what the
 * residential proxy is for. Stealth alone is not enough here.
 */
import type { Candidate } from "../types.js"
import type { SourceContext, SourceTask } from "../solari/pool.js"
import { buildCandidate, guessCategory } from "./util.js"

/** Groupon routes by city slug: /local/tampa, /local/new-york-city. */
function citySlug(city: string): string {
  return city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

/** Badges Groupon prefixes onto the card text, which are not part of a name. */
const BADGES = /^(Popular Gift|Best Seller|Trending|Almost Gone|New|Editor's Pick|Extra \d+% Off)+/i

/**
 * Pull a readable name out of a Groupon card.
 *
 * The anchor's text content is every child run together with no separators:
 *   "Popular Gift" + "Starlite Cruises" + "Up to 37% Off Evening Boat Cruise
 *    with Buffet in Madeira Beach" + "177 Boardwalk Place East, Madeira Beach"
 *
 * The offer clause is the part worth showing a user, so prefer it and fall
 * back to the leading merchant name. Either way the trailing street address
 * has to go, or every Groupon title ends mid-postcode.
 */
function dealTitle(raw: string): string {
  const text = raw.replace(BADGES, "").trim()
  // A street address starts with a house number; that's where the card ends.
  const withoutAddress = text.replace(/\s*\d{1,6}\s+[A-Z][^,]*,.*$/, "").trim()

  const offer = withoutAddress.match(/Up to \d+% Off\s+(.{6,110})/i)
  if (offer) return offer[1]!.trim()

  // No discount clause: take the merchant name, which runs until the first
  // lowercase-to-uppercase seam ("Starlite CruisesEvening Boat..."). The
  // lowercase letter belongs to the NAME, so capture it — matching on the
  // seam itself truncated every fallback title by one character
  // ("In The Breeze Ranc", "Busch Gardens - Tamp").
  const merchant = withoutAddress.match(/^(.{3,70}?[a-z])(?=[A-Z])/)
  return (merchant ? merchant[1]! : withoutAddress).trim().slice(0, 90)
}

export const groupon: SourceTask = {
  id: "groupon",
  captcha: true,

  async run({ ctx, place, log }: SourceContext): Promise<Candidate[]> {
    const page = await ctx.newPage()
    const out = new Map<string, Candidate>()
    const slug = citySlug(place.city)

    // Groupon's own category routes beat searching — the search box is a
    // client-side app that fights automation, these are plain server-rendered
    // listings.
    const feeds = [
      ["things to do", `https://www.groupon.com/local/${slug}/things-to-do`],
      ["food & drink", `https://www.groupon.com/local/${slug}/restaurants`],
      ["all local", `https://www.groupon.com/local/${slug}`],
    ] as const

    try {
      for (const [label, url] of feeds) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
          await page.waitForSelector("a[href*='/deals/']", { timeout: 8_000 }).catch(() => {})
          await page.waitForTimeout(1500)

          const rows = await page.locator("a[href*='/deals/']").evaluateAll((els) =>
            els.slice(0, 20).map((el) => {
              const a = el as HTMLAnchorElement
              const text = (a.textContent ?? "").replace(/\s+/g, " ").trim()
              const discount = text.match(/Up to (\d+)% Off/i)
              const price = text.match(/\$\d[\d.,]*/)
              return { href: a.href.split("?")[0] ?? a.href, text, discount, price }
            }),
          )

          log(`${label} -> ${rows.length} deals`)

          for (const r of rows) {
            if (!r.text) continue
            const title = dealTitle(r.text)
            if (!title) continue
            const pct = r.discount ? Number(r.discount[1]) : null
            const c = buildCandidate({
              source: "groupon",
              title,
              url: r.href,
              category: guessCategory(r.text, "other"),
              evidence: pct
                ? `Groupon: up to ${pct}% off - ${title}`
                : `Groupon deal: ${title}`,
              priceRaw: r.price ? r.price[0] : "",
              indoor: null,
            })
            if (!out.has(c.id)) out.set(c.id, c)
          }

          if (out.size >= 15) break
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
