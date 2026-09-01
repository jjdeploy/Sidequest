# Idea: persona trend radar

**Status: idea only. Nothing built. Do not implement.**

Parked here so it isn't lost. Separate project from Bearings — if it gets
built, it belongs in its own repo, not a branch of this one.

## The one-liner

Persistent browser profiles as *sensors*. Train several personas by browsing a
niche, then read what the platforms serve each one, and diff. The output is
what's rising for a specific audience in a specific place, right now.

## Why it needs a cloud browser

`profileId` — cookies and localStorage that survive between runs — is the only
capability that makes this possible, and it's the one nobody reaches for. A
persona *is* accumulated browsing history. You cannot build one with a fresh
browser, which is precisely why this isn't a Playwright project.

Add geo placement (trends are regional) and N-at-once (the diff is the
product) and it uses three Solari primitives that no single-browser tool has.

## The design that makes it credible: a control persona

Run N trained personas **plus one deliberately untrained one**.

- Anything the control also sees is globally trending, and worthless.
- Anything only the trained personas see is the niche breaking out before it
  is obvious.

That subtraction is the whole product. Without the control you cannot separate
"this is popular everywhere" from "this is popular for you", and every naive
version of this idea fails on exactly that.

## Second mechanic: corroboration, again

The same scoring Bearings already uses, pointed sideways. A topic appearing
across four independent personas is signal; in one, it's noise.

And the diff that matters is **over time** — what appeared today that wasn't
there yesterday — not what is biggest. Biggest is available everywhere and
worth nothing.

## What is actually observable, logged out

Public surfaces only:

- TikTok web For You (personalises fast, famously) and Explore
- YouTube homepage, Trending tab, search autocomplete
- Google autocomplete and People Also Ask — regional, and badly underrated
- Pinterest Trends
- Amazon Movers & Shakers, per category
- Google Trends

Login-gated, leave alone: Instagram Explore, X. Reddit already has an official
API and blocks everything else — see `weekendfun/src/sources/reddit.ts`.

## The honest constraints

**ToS.** Automated access is against TikTok's and YouTube's terms. The posture
has to match the one already taken on Reddit in Bearings: synthetic personas
only, never a real account, no login, public surfaces, modest volume — and say
so plainly in the README rather than staying quiet about it.

**It is observation, not decompilation.** You get what the algorithm served
under controlled conditions, not why. "Weather station", not "we decoded the
ranker". The honest claim is also the stronger one, because it is
demonstrable.

**Training a persona is slow.** A profile has to scroll and watch for a few
minutes before it is a useful sensor. This is exactly why profiles matter: pay
it once, reuse it forever. First run minutes, every run after seconds.

## What would transfer from Bearings

Most of it. `solari/pool.ts` and `solari/geo.ts` nearly unchanged — personas
shard exactly the way keywords do. Corroboration scoring, the SSE dashboard,
`node:sqlite` for the time series.

## The demo

A grid: personas down, topics across, the control column greyed out, cells
lighting up as they're served. Click a cell to watch the replay of the browser
actually being served it.
