# Demo script

A three-minute recording. Everything below is deterministic — the same city
and the same sentence produce the same plan, so you can rehearse a take and
the real one will match it.

## Before you record

```bash
npm run dashboard          # http://localhost:5173
```

- Browser at **1440×900**, bookmarks bar hidden, zoom 100%.
- Use a **small town** rather than a big one. It is the harder and more honest
  demo: a dense city hides a bad planner behind good inventory. Pick one you do
  not mind naming on camera.
- Have a second tab on the repo's README if you want to cut to the diagram.
- One run takes ~25s wall clock. Don't cut it — the wait *is* the product.

## Shots

**1 · The problem (0:00–0:15)**

Landing page, don't touch anything yet.

> "It's Friday. You just moved here and you have no idea what's on
> this weekend. That's spread across a dozen sites and not one of them will
> sell you an API — which is why nobody has solved this."

**2 · Ask for something specific (0:15–0:30)**

Type the town. Open the weekend popover, pick a weekend. In the free
text box type `bowling at night`.

> "I'm not going to ask for 'things to do'. I'm going to ask for something
> specific, because that's where these things fall over."

Hit the search button.

**3 · The fan-out — the Solari shot (0:30–1:00)**

Let the ring fill. Point at the pips landing one by one, and the line under
them.

> "Thirteen real browsers, launched in the cloud, all at once. Each one is
> standing at the town's coordinates — and none of them is allowed to search
> until the page it opened confirms those coordinates back. That's the gate."

Read the counter out loud as it climbs. Land on:

> "Twenty-five seconds. Run one at a time, that's about four minutes."

**4 · The plan (1:00–1:20)**

> "Saturday: breakfast, then Princess Place Preserve, then bowling at seven —
> because I asked for bowling at night, and that's a booking, not a
> preference. If the town had no alley, it would say so above the plan
> instead of quietly leaving it out."

**5 · Provenance — the part to linger on (1:20–2:00)**

Open **How this was found** on one card.

> "Nothing here is a model's opinion. Every score is named components you can
> read — three sources agreed, 4.6 from 268 reviews, 1.2 miles from the
> centre."

Then hit **Watch it get found**.

> "And this is the browser session that found it. Actual replay. If you don't
> believe a recommendation, you can watch where it came from."

**6 · The gate (2:00–2:20)**

Scroll to the screening summary.

> "124 listings came back, 57 survived. Place, dates, kind, age — and the
> rejections are as inspectable as the picks. Twenty-five of those were
> refused for being errands: a bowling *supply* shop, a business brokerage. We
> know because Google Maps writes what a place is on the card, and we read it."

**7 · The 21+ switch (2:20–2:40)**

Back to the landing page, flip **21+**, note the caption changing.

> "One switch that's a gate rather than a nudge. Off, and nothing that would
> card you appears at all. On, and the bars come back. Breweries were never
> gated — they let a family in."

**8 · Close (2:40–3:00)**

> "There's no model anywhere in the decision path. The browsers read; ordinary
> code decides, and shows its working. At a hundred cities I'd put an agent in
> exactly two places — validating what a listing actually is, and the taste
> judgement in selection — and I'd still keep the scheduling deterministic."

## If a take goes wrong

- **A source lane goes red.** Leave it in and say so — partial results are the
  designed behaviour, and a 20-second deadline that stops waiting is a better
  story than six green bars.
- **The proxy fails.** Also leave it in: `direct` in the lane means the
  residential tunnel died and it fell back to direct egress. The geolocation
  override is what localises, not the proxy — that's the finding worth saying
  out loud.
- **A plan looks thin.** A small town genuinely is thin. Say the number of
  candidates that survived screening rather than pretending.

## Retaking the screenshots

The three images in this folder are what a reader sees before they read a
word, so they have to match what the app currently looks like. Retake all
three whenever the UI changes:

| File | Shot |
|---|---|
| `landing.jpg` | The landing page, nothing typed, 21+ switch visible. |
| `fanout.jpg` | Mid-run: the ring part-filled, source pips landing, the "in position" count climbing. |
| `plan.jpg` | The finished plan — the timeline, and enough of the catalogue below it to show there is more. |

Browser at 1440×900, bookmarks hidden, zoom 100%, and crop out the OS chrome.
Then drop them in over the top of the existing files — both READMEs reference
these exact names.
