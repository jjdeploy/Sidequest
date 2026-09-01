/**
 * Making a cloud browser genuinely *be* somewhere.
 *
 * ── What we tried first, and why it isn't here ──────────────────────────────
 * Solari's proxy accepts `{ country, state, city }`, so the obvious design was
 * to pin egress to the user's city and let every site geo-rank us natively.
 * Measured on a Starter plan, that narrowing is inert: `state: "washington",
 * city: "seattle"` and `state: "florida", city: "tampa"` both egress from
 * AT&T North Carolina, and the gateway's own confirmation object echoes back
 * only `{ timezoneId, country, tier }` — never the state or city we asked for.
 * Reproduce with `npm run geo-proof`.
 *
 * ── What actually works, and is better anyway ───────────────────────────────
 * Tell the *page* where it is instead of hoping the *packet* implies it:
 *   - explicit coordinates in the URL where a site accepts them
 *   - a Playwright context with `geolocation` + `permissions: ["geolocation"]`
 *   - a matching `timezoneId` and `locale`, so Intl and Date don't contradict
 *     the coordinates and mark us as a bot
 *
 * Same query from one North Carolina IP: Tampa coords returned 1920 Ybor and
 * The Sapphire; Seattle coords returned Neumos and The Crocodile. Deterministic,
 * works for any city on earth, and independent of what's in the proxy pool.
 *
 * The proxy still earns its place — a *residential* IP is what gets us past
 * the datacenter blocks on Groupon and Yelp. It just isn't how we localize.
 */
import type { BrowserContext } from "patchright-core"
import type { ProxyRequest } from "@solarisdk/browser"
import type { BrowserSession } from "@solarisdk/browser"
import type { Place } from "../types.js"

/**
 * Residential egress in the right country.
 *
 * Deliberately country-level: see the note above. `session` pins one IP for
 * `sessionDuration` minutes so a whole fan-out looks like one person browsing
 * in tabs rather than N strangers, which is both more honest and less blockable.
 */
export function proxyFor(place: Place, stickyId?: string): ProxyRequest {
  const proxy: ProxyRequest = {
    country: place.country.toLowerCase(),
    tier: "residential",
  }
  if (stickyId) {
    // Sticky ids are alnum + dash, 32 chars max; longer is rejected.
    proxy.session = stickyId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 32)
    // Max 30. Must outlast the slowest source, or later pages in the same run
    // land on a fresh IP mid-scrape.
    proxy.sessionDuration = 20
  }
  return proxy
}

export function describeProxy(p: ProxyRequest): string {
  return `${p.country?.toUpperCase() ?? "??"} ${p.tier ?? "residential"}`
}

/** Thrown when the geolocation gate fails. The caller retries or drops the
 *  source — it must never fall through to scraping. */
export class GeoGateError extends Error {}

/** How far the page's reported position may drift from what we set, in degrees.
 *  We set the coordinates ourselves, so this is a sanity bound on the override
 *  having applied at all, not a real accuracy budget. */
const TOLERANCE_DEG = 0.05

/**
 * Open a context that is *verified* to be in `place`.
 *
 * The verification is the point. A context whose geolocation override silently
 * failed still scrapes perfectly — it just returns results for wherever the
 * egress IP happens to be. Those look completely valid, get scored, and get
 * written into the learning store as if they were the user's city. That is the
 * single worst failure mode in this system, so it is a hard precondition:
 * nothing searches until the page has told us, in its own words, where it is.
 */
export async function openLocalContext(
  browser: BrowserSession,
  place: Place,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    geolocation: { latitude: place.lat, longitude: place.lng, accuracy: 50 },
    permissions: ["geolocation"],
    timezoneId: place.timezone,
    locale: "en-US",
  })

  const page = await ctx.newPage()
  try {
    // about:blank has no secure origin, and the geolocation API refuses to
    // answer on one — so ask from a real https page.
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30_000 })

    const reported = await page.evaluate(
      () =>
        new Promise<{ lat?: number; lng?: number; error?: string }>((resolve) =>
          navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
            (e) => resolve({ error: e.message }),
            { timeout: 8000 },
          ),
        ),
    )

    if (reported.error !== undefined || reported.lat === undefined || reported.lng === undefined) {
      throw new GeoGateError(
        `browser refused geolocation for ${place.label}: ${reported.error ?? "no position"}`,
      )
    }

    const drift = Math.max(
      Math.abs(reported.lat - place.lat),
      Math.abs(reported.lng - place.lng),
    )
    if (drift > TOLERANCE_DEG) {
      throw new GeoGateError(
        `geolocation override did not take for ${place.label}: ` +
          `asked for ${place.lat.toFixed(4)},${place.lng.toFixed(4)} ` +
          `but page reports ${reported.lat.toFixed(4)},${reported.lng.toFixed(4)}`,
      )
    }

    const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
    if (tz !== place.timezone) {
      // Not fatal on its own, but a page that sees Florida coordinates on a
      // Pacific clock is a fingerprinting tell, so it's worth knowing about.
      throw new GeoGateError(
        `timezone mismatch for ${place.label}: page reports ${tz}, expected ${place.timezone}`,
      )
    }
  } finally {
    await page.close().catch(() => {})
  }

  return ctx
}
