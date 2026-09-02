/**
 * Reddit — what people who actually live there say.
 *
 * This is the source no itinerary app has, and the reason these plans read as
 * local rather than as a tourist board. r/tampa knows the food truck rally is
 * better than the ticketed festival down the street.
 *
 * ── Why this is an HTTP call and not a browser ──────────────────────────────
 * Scraping Reddit does not work, at all, from anywhere. Measured: old.reddit,
 * www.reddit and the .json endpoint each return 403 across residential proxy,
 * datacenter egress, stealth, managed captcha solving, and Cloudflare Web Bot
 * Auth. Reddit's own block page names the two supported routes — log in, or
 * use a developer token — so we use the token. Automating a logged-in personal
 * account would violate their ToS and risk the account, which is not a good
 * trade for a public repo.
 *
 * The official API is free, keeps us inside the Data API terms, and needs no
 * browser at all. Spending a cloud browser on a JSON endpoint would be theatre.
 *
 * ── Setup (optional — this source skips itself without it) ──────────────────
 *   1. https://www.reddit.com/prefs/apps -> "create app"
 *   2. type: script     redirect uri: http://localhost:8080  (unused)
 *   3. REDDIT_CLIENT_ID     = the string under the app name
 *      REDDIT_CLIENT_SECRET = the field labelled "secret"
 */
import type { Candidate, Place } from "../types.js"
import { buildCandidate, guessCategory } from "./util.js"

/** Reddit requires a descriptive UA and rate-limits generic ones harshly. */
const USER_AGENT = "nodejs:sidequest:0.1.0 (by /u/sidequest-bot)"

export function redditConfigured(): boolean {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET)
}

/**
 * App-only OAuth (`client_credentials`).
 *
 * Grants read access to public listings without acting as any user — exactly
 * the scope we want, and nothing more.
 */
async function getToken(): Promise<string> {
  const id = process.env.REDDIT_CLIENT_ID!
  const secret = process.env.REDDIT_CLIENT_SECRET!
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: "grant_type=client_credentials",
  })
  if (!res.ok) {
    throw new Error(
      `Reddit token request failed (HTTP ${res.status}). Check REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET.`,
    )
  }
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) throw new Error("Reddit returned no access_token")
  return body.access_token
}

interface Listing {
  data?: {
    children?: Array<{
      data?: {
        title?: string
        permalink?: string
        score?: number
        subreddit?: string
        selftext?: string
        num_comments?: number
      }
    }>
  }
}

async function search(token: string, path: string): Promise<Listing> {
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
  })
  if (!res.ok) throw new Error(`Reddit API HTTP ${res.status} for ${path}`)
  return (await res.json()) as Listing
}

/** Every city subreddit is mostly this, and none of it is a weekend plan. */
const NOISE = /moving|apartment|rent|realtor|job|hiring|salary|traffic|hurricane|politic|crime|insurance|lost|found|recommend a (doctor|dentist|lawyer)/i

/**
 * Fetch local discussion for a place.
 *
 * Returns [] rather than throwing when unconfigured, so the planner runs fine
 * for anyone who clones the repo with only a Solari key.
 *
 * These candidates are deliberately low-confidence — no coordinates, no price.
 * A thread title is an opinion, not a venue. Their job is to *corroborate*:
 * the scorer treats a place Maps found AND Reddit talks about as far stronger
 * than either alone.
 */
export async function fetchReddit(
  place: Place,
  log: (msg: string) => void = () => {},
): Promise<Candidate[]> {
  if (!redditConfigured()) {
    log("skipped (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set)")
    return []
  }

  const sub = place.city.toLowerCase().replace(/[^a-z0-9]/g, "")
  const out = new Map<string, Candidate>()

  try {
    const token = await getToken()

    const queries: Array<[string, string]> = [
      [
        `r/${sub}`,
        `/r/${sub}/search?q=${encodeURIComponent("things to do OR weekend OR events")}&restrict_sr=1&sort=top&t=month&limit=25`,
      ],
      [
        "site-wide",
        `/search?q=${encodeURIComponent(`${place.city} things to do this weekend`)}&sort=top&t=month&limit=25`,
      ],
    ]

    for (const [label, path] of queries) {
      try {
        const listing = await search(token, path)
        const children = listing.data?.children ?? []
        log(`${label} -> ${children.length} threads`)

        for (const child of children) {
          const d = child.data
          if (!d?.title || !d.permalink) continue
          if (NOISE.test(d.title)) continue
          const score = d.score ?? 0
          // One upvote is one person's opinion; a dozen is local consensus.
          if (score < 5) continue

          const c = buildCandidate({
            source: "reddit",
            title: d.title,
            url: `https://www.reddit.com${d.permalink}`,
            category: guessCategory(`${d.title} ${d.selftext ?? ""}`, "other"),
            evidence: `r/${d.subreddit ?? sub}, ${score} points, ${d.num_comments ?? 0} comments: "${d.title}"`,
            indoor: null,
          })
          if (!out.has(c.id)) out.set(c.id, c)
        }

        if (out.size >= 10) break
      } catch (err) {
        // A missing subreddit is a 404 and completely normal for small cities.
        log(`${label} failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  } catch (err) {
    log(`auth failed: ${err instanceof Error ? err.message : err}`)
    return []
  }

  return [...out.values()]
}
