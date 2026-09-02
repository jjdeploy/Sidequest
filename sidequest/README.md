# Sidequest

**You're bored. This town isn't.**

> A weekend planner that runs thirteen geo-verified cloud browsers in
> parallel, reads a dozen local listing sites at once, and assembles a
> Saturday and Sunday you can actually follow. Built on
> [Solari](https://getsolari.com).

## The problem

You have just moved, or you are visiting, and it is Friday. What's on this
weekend is scattered across a dozen sites — Maps, Eventbrite, AllEvents,
Groupon, TripAdvisor, Time Out, the local subreddit — and **not one of them
will sell you an API** for it. Every attempt to unify local listings has died
on exactly that: you'd have to convince every platform to cooperate, and they
have no reason to.

And the answers are local in a way that ordinary requests cannot reach. The
web personalises on where your traffic comes from and what you have clicked
before. Someone who just moved has the wrong IP history and no click history,
so the internet keeps showing them their old life.

## The solution

So this doesn't ask for permission. It opens **real browsers in the cloud,
stands them at your coordinates**, and reads every source at the same time. A
browser is a permissionless interface: if a site has a page, it can be read.

Then ordinary, readable code turns what came back into a schedule — screened
for whether it is near you, on your days, something you would actually go and
do, and something you are old enough to get into.

```
   your request          13 cloud browsers            deterministic engine
                         each proves its own
"bowling at night"  ──▶  coordinates before   ──▶     screen · rank · book   ──▶  a weekend
   Palm Coast, FL        it is allowed to             one gate, four checks
                         search
```

Every recommendation is traceable to a line of text on a page a browser
actually loaded, and the session that found it can be replayed.

```bash
npm install
cp .env.example .env      # add your SOLARI_API_KEY
npm run dashboard         # http://localhost:5173
```

![The landing page](docs/landing.jpg)

## How Solari is used

Every browser in the fan-out is a Solari session. Five of the SDK's
capabilities are load-bearing here, and one deliberately is not.

| What | Where | Why it matters here |
|---|---|---|
| `solari.launch()` + patchright `BrowserContext` | `src/solari/pool.ts` | One session per source, and one per keyword for Maps. Thirteen at once on the Starter plan's twenty. |
| `newContext({ geolocation, timezoneId, locale })` | `src/solari/geo.ts` | The override is what localises the browser. Not the proxy — see below. |
| `stealth` | launch options | Five of six sources serve a different page, or none, to obvious automation. |
| `proxy` (residential) | launch options | Only for the sources that block datacenter egress. Falls back to direct when the tunnel dies. |
| `recording` (rrweb) | `src/solari/pool.ts` | Every session is replayable, so "watch it get found" is a real button and not a claim. |
| `captcha` | launch options | On, and never needed on these six. Kept because the cost of being wrong is a dead lane. |

What the SDK is **not** used for is as interesting: no LLM browsing loop, no
"agent, go find me something to do". The browsers navigate and read; the
decisions happen in ordinary code afterwards. See
[No agent in the loop](#no-agent-in-the-loop-and-where-one-would-go).

```ts
// src/solari/geo.ts — the shape of every lane in the fan-out
const browser = await solari.launch({ stealth: true, proxy, captcha: true, recording })
const context = await browser.newContext({
  geolocation: { latitude: place.lat, longitude: place.lng },
  permissions: ["geolocation"],
  timezoneId: place.timezone,
  locale: "en-US",
})
// ...and nothing searches until the page confirms those coordinates back.
```

## Why a cloud browser is load-bearing here

Three things, and none of them are "scraping is convenient".

**You have to be standing there.** The web personalises on where your traffic
comes from and what you've clicked before. Someone who just moved has the wrong
IP history and no click history, so the internet keeps showing them their old
life. `npm run geo-proof` asks *"live music"* from two cities at the same
moment and diffs the answers:

| Tampa browser | Seattle browser |
|---|---|
| 1920 Ybor | Neumos |
| The Sapphire Tampa | The Crocodile |
| Chewy's Lounge | Dimitriou's Jazz Alley |

**0% overlap** — from the same residential IP pool.

**You don't have to be there yet.** Same mechanism, and it's the thing nothing
else can do: put a city you're moving to in the box, and the answers are that
city's, not a guess made from here.

**Corroboration needs breadth in one shot.** Independent sources agreeing on a
place means more than any one of them ranking it first, and it's the one signal
a parallel fan-out computes that a single scraper cannot.

## 13 browsers, not 6

![The fan-out](docs/fanout.jpg)

Google Maps is the only source that publishes coordinates, ratings, *and*
Google's own type descriptor — and the only one that lists ordinary local
businesses rather than ticketed events. It also used to loop its keywords
sequentially inside one browser, which made it the long pole by construction:
every other source does one or two page loads, so the fan-out's wall clock was
Maps' keyword count times a navigation.

A source can now declare `shard`, and the pool gives it one browser per
keyword. The Starter plan allows twenty concurrent browsers; we were using six.

Measured on the same Palm Coast query, before and after:

```
92.8s   29 candidates   1/6 sources   place: 0 confirmed / 35 unknown
22.2s  106 candidates   5/6 sources   place: 51 confirmed / 31 unknown
```

There's a hard **20-second deadline on the whole fan-out**, and partial results
are normal rather than exceptional — measured, any single source can hang for
90 seconds, and no amount of per-source tuning survives that. Stopping waiting
isn't enough on its own: the pool tracks live sessions and closes them when the
deadline fires, because otherwise the run returns at 20s and then blocks for
another 50 while abandoned browsers finish navigating.

### When the proxy dies, the plan doesn't

The residential proxy went down mid-build — every tunnel returning
`ERR_TUNNEL_CONNECTION_FAILED` while a plain launch reached example.com in
1.5s. Six lanes of "no answer" and no plan at all.

That shouldn't happen, and the reason is the finding above: **the proxy isn't
what localises us, the geolocation override is.** A browser with no proxy is
still standing in the right city. So a failed tunnel now falls back to direct
egress once, says so, and carries on:

```
12 of 12 in position · 100 candidates · 5/6 sources · 20.1s
```

What you lose is the sources that block datacenter traffic — Groupon, mainly.
What you keep is the plan.

## Nothing searches until the browser proves where it is

A context whose geolocation override silently failed still scrapes perfectly —
it just returns results for wherever the egress IP happens to be. Those look
completely valid, get ranked, and land in the store as if they were your city.

So it's a hard precondition:

```
geolocation override did not take for Tampa, FL:
  asked for 27.9475,-82.4584 but page reports 35.7796,-78.6382
```

A source physically cannot run against an unverified browser, because it never
receives one.

### The part that surprised me

The obvious way to localise is Solari's proxy geo-narrowing —
`proxy: { country: "us", state: "florida", city: "tampa" }`. Measured on a
Starter plan, **that narrowing is inert**: `seattle` and `tampa` both egress
from AT&T North Carolina, and the gateway's confirmation object only ever
echoes back `{ timezoneId, country, tier }`.

What works is telling the *page* where it is rather than hoping the *packet*
implies it — explicit coordinates in the URL, plus a context with
`geolocation`, matching `timezoneId`, and `locale`. Deterministic, works for
any city on earth, and doesn't depend on what's in the proxy pool.

The residential proxy still earns its place: it's what gets past Groupon's
datacenter block. It just isn't how you localise.

## One gate, not six filters

Every bug worth fixing in this repo had the same shape — a source produced
something plausible and nobody checked:

- a September 19th festival planned for the 5th (nobody checked the date)
- "earn CE credits" as a Saturday night out (only two sources checked)
- `&amp; Ho... Read more` stored as a street address (nobody checked the text)

Each got fixed where it was found, which is why the next one kept appearing
somewhere else. `engine/relevance.ts` asks four questions of every candidate
from every source — is it near this city, is it on these days, is it a thing
you'd actually go and do, and is the party old enough to get in — and attaches
a verdict that ranking explains and the itinerary obeys.

```
106 listings · 66 admitted · 40 rejected
  place  51 confirmed · 1 elsewhere · 31 published no location
  dates  72 on your days · 11 on other dates
  kind    6 filtered as business, admin, or a broken scrape
  age     9 refused as 21+ rooms
```

Three rules it holds to:

- **Unknown is not a failure.** 70% of candidates carry no coordinates at all.
  Treating that as "fine" is how bad results get in; treating it as "wrong"
  would delete most of the plan. It's its own state, and it's counted, so the
  gaps are visible rather than implied.
- **Fatal only on hard evidence.** Coordinates and a site's own published
  distance can reject outright. A city name matched in free text cannot —
  "Orlando's Bar" is a real Tampa venue — so that tier only costs points.
- **Findings carry their reason**, and become score components verbatim.

### Read the label the site already wrote

Google Maps prints its own type on nearly every result card — `Bowling
alley`, `Cocktail bar`, `Business broker`, `Bowling supply shop`. This was
parsing that descriptor, mapping it down to one of eleven coarse categories,
and throwing the words away. Everything that then went wrong was an attempt
to re-derive from a name what the page had already said in plain English:

| In a real plan | The card said |
|---|---|
| "Palm Coast Lanes" stopped being bowling | `Bowling alley` |
| "Big Frog Custom T-Shirts" took a Saturday morning | `Custom t-shirt store` |
| "We Sell Restaurants" was filed under food | `Business broker` |
| a bowling **supply** shop answered a search for bowling | `Bowling supply shop` |
| Sam's Club was filed under nightlife | `Warehouse store` |

Measured on one Palm Coast run: **44 of the 48** candidates that reached
ranking carried a descriptor. It is now kept on the candidate, stored, and
consulted first by the age gate, by the booking pass, and by a new check that
refuses an errand — somewhere you go when something needs doing, rather than
somewhere you go on a Saturday. Browsing still counts: bookshops, galleries,
markets and malls stay.

This is the cheapest kind of fix there is, and the reason it was available is
that a real browser sees the whole page. An API would have returned a
category enum.

### The 21+ switch

One control on the landing page is a gate rather than a nudge. Every other
preference leans on the score — a vibe raises it, a budget trims the list,
weather demotes a park. This one removes things: leave 21+ off and nothing
that would card you reaches the plan at all. Not ranked low, not greyed out,
not sitting in the catalogue underneath. Absent.

The line is **strictly 21+** — the rooms that would card you at the door.
Bars, nightclubs, clubs, speakeasies, casinos, cigar and hookah lounges, and
the events that are a tasting in disguise. Not restaurants, whatever they are
called and however good the bar in them is; not breweries, taprooms, wineries
or pubs, which admit a family and simply decline to serve half of it. "Does
this place sell drink" is nearly everywhere and is not the question.

Which means reading a listing's age with no field that says so, and the two
halves of a listing are worth very different amounts:

- **The name is evidence.** "Bar Louie" is a bar; "Solid Grill & Bar" is a
  grill. Which word comes first is the whole difference.
- **The blurb is not.** Evidence text mentions a bar constantly — "cash bar",
  "full bar" — at weddings, food halls and street festivals anyone can walk
  into. Matching venue words there would quietly delete the family end of the
  plan. An age the listing states outright (`21+`, `18 and over`) is the
  exception, and it settles the question wherever it appears — but `$18+` is
  a ticket price, and reading that as an age gate would delete the cheap end
  of every event source.

It is enforced twice. `engine/relevance.ts` is the guarantee; `engine/
keywords.ts` is the budget — searching for "cocktail bars" would spend one of
eight browsers on a page of candidates already decided against. Ticking the
box widens the search but never reserves a slot: 21+ is permission, not a
request, and somebody who ticks it and asks for hiking wants hiking. A kid in
the party overrides the tick, because that is the answer that names a real
person. See `engine/age.ts`.

## The six sources answer different questions

| Source | What it's for |
|---|---|
| **Google Maps** | venues, **coordinates**, ratings, and Google's own type descriptor. The spine. |
| **Eventbrite** | dated, ticketed events |
| **AllEvents** | dated events, long tail, and small cities where Eventbrite is empty |
| **Groupon** | what is *discounted right now* — and it publishes its own distance |
| **TripAdvisor** | consensus ranking, and the review counts Maps doesn't render |
| **Time Out** | local editorial voice — the *why*, in a sentence worth quoting |
| **Weather** | a **constraint**, not a candidate (Open-Meteo, keyless) |
| **Reddit** | optional, official API — see below |

### Reddit

Reddit blocks all logged-out automation. Measured: 403 across residential
proxy, datacenter egress, stealth, managed captcha solving, Cloudflare Web Bot
Auth, and the `.json` endpoint. Its own block page names the two supported
routes — log in, or use a developer token.

This uses the token. Automating a logged-in personal account would violate
their ToS and risk the account, which is a bad trade for a public repo. Add
`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`
([create a `script` app](https://www.reddit.com/prefs/apps)) and it turns on.
Without them the source skips itself and everything else runs.

## Search for what a bored person would search for

![The plan, and everything else](docs/plan.jpg)

Only Maps reads keywords; the others browse fixed city feeds. So the query set
is entirely place terms — the kind of thing Maps is a directory of.

Stated intent wins outright. Ask for "chill, outdoorsy" and you get parks,
hiking trails, coffee and scenic viewpoints, and you get *no* restaurants
padded in, because not searching for food when nobody mentioned food is the
point of deriving queries from a request.

Say nothing and it runs the sweep a stranger to a city would actually type:

```
tourist attractions · restaurants · parks · bowling
live music venues · breweries · family attractions
```

That fallback is why a town with three bowling alleys now returns them. The old
one was two event phrases, so Palm Coast Lanes was never a near miss — it was
never queried.

### Intent has to reach the ranking, not just the search

Typing "bowling" found Palm Coast Lanes and then left it out of the plan.
Every part was individually right: the keyword builder searched bowling, Maps
found the alley, the gate admitted it — and the scorer had never heard of the
request. On generic quality a 4.0 with no review count loses to a
4.7-from-268-reviews park every time, and should, unless somebody asked for
bowling.

Two things fix it, and they're deliberately different sizes. Ranking gets a
modest `+12 you asked for this`, which reorders the catalogue. The itinerary
reserves **one** slot per requested category, because an explicitly requested
venue is often a thin one and no score nudge closes a thirty-point gap. One
slot each, not six — ask for bowling and there's bowling in your weekend, not
a weekend of bowling.

The first attempt put a custom t-shirt shop in that slot. Maps had labelled it
`Custom t-shirt store`, but the descriptor regex only allowed spaces between
words, so the hyphen dropped the whole match — and the category then fell back
to *the term we searched for*. Which is how a search for "bowling" filed a
print shop under "active". The pattern allows hyphens now and lives in
`util.ts` where it can be tested, and the fallback is `other`: the keyword says
what we looked for, never what we found.

### And when you said you wanted it

"bowling at night" came back with no bowling at all, for two reasons that had
nothing to do with each other.

The intake prompt's examples were all mood words — `"chill"`, `"outdoorsy"`,
`"date night"` — so the model helpfully generalised the request into
`["night out"]` and threw the actual noun away. Then nothing matched: the vibe
vocabulary only recognised the literal string "nightlife", so "night out"
matched no key at all, the floor took over, and the request asked for nothing
in particular. The prompt now says to keep concrete activities as themselves,
and "night", "evening" and "after dark" all reach nightlife.

There was also no concept of *when*, and the first fix for that put the
extraction in the LLM's hands — which made it a coin flip. The same sentence
returned `timeOfDay: "evening"` on one run and nothing on the next, and with
nothing the reserved slot fires at the first hour of the weekend. "bowling at
night" came back as bowling at 10am, then correctly, then at 10am again.

A model is the right tool for reading an unusual request. It is the wrong tool
for a decision that has to be the same every time, and *does this sentence say
evening* is not a hard question. The time is read deterministically from the
user's own words now, and the model only widens what that found. Two things
follow: the same sentence gives the same plan, and `--ask` degrades to
something useful with the `claude` CLI absent instead of doing nothing.

The time phrase is then **removed** before the text is matched for mood.
Leaving it in matched "night" as nightlife as well, so a request for bowling
quietly became a request for bowling *and* cocktail bars *and* live music
*and* breweries — five categories, all pinned to the two evening slots, and
the bowling lost its slot to them.

`timeOfDay` is a field, and the reserved slot waits for it — the whole bonus in the hour you asked for and
nothing anywhere else. A consolation bonus in the other slots doesn't work:
combined with the ranking bonus it still beat a 4.8-star park, and the answer
came back as bowling at ten in the morning a second time.

```
Read your request as: bowling · in the evening · $300 · car
  Evening    Palm Coast Lanes
```

### Two requests in one sentence

"bowling at night, clubbing the other night" came back with an ale lounge one
night and no bowling at all — the same symptom, three more causes, each of
which had looked like a good idea on its own.

**The expansion was mistaken for the request.** One typed word becomes a
family of searches, which is exactly right for searching: a town might call
its one club a cocktail bar, a live music venue or a brewery, so ask for all
of them. It is not right for reserving. Five categories ended up owed an
evening, two evenings existed, an inferred cocktail bar won one of them, and
the bowling that had actually been typed lost. So the terms now carry a
`said` flag — set when the user wrote the word themselves — and only those
reserve. It is a flag rather than a high weight because weight already
carries a corroboration bump that takes 0.85 to 1.00 and sailed straight over
the numeric tier this replaced.

**A reservation nothing can honour is just a ban.** The reservation has two
halves: a bonus in the right slot, and an equal push out of the wrong ones to
keep the category free until its hour comes. The second half is only
defensible while the hour is still coming — the three categories that lost
the auction were still being held out of all four daytime slots for an
evening they were never going to get, so they left the plan entirely. There
are now never more reservations than there are slots to honour them in.

**Source balance was outbidding the request.** With that fixed, Sky Lanes
Bowling still lost the Sunday evening: it scored 4.75, it had the +60, and
Google Maps had won three slots by then — so the per-source diminishing
return charged the town's only bowling alley −27 while charging a brewery
found by an idle source nothing. Balance exists so Maps cannot take all six
slots. It is not a reason to drop the one thing somebody typed the name of,
so it is waived for a category that is still owed.

**And then the category honoured the letter and not the spirit.** The next
run put the Asheville Pinball Museum in the evening. Pinball is `active` and
so is bowling, and a museum with hundreds of reviews beats an alley with
none.

### So the slot is booked, not bid for

Four fixes to the same mechanism, each of which held for one shape of request
and broke on the next, is a mechanism in the wrong place. A typed request is
not a preference to be scored — it is a booking.

`buildItinerary` now runs a booking pass before the auction. Each term the
user wrote the word for claims a slot at the hour they asked for, matched on
the word first and the category second, and obeying exactly the same hard
constraints as the auction — a requirement that books a Saturday event into
Sunday would be worse than one that failed. Then the auction fills in around
what is already booked.

And what could not be booked is said out loud, above the plan rather than in
a footnote under it:

```
You asked for bowling in the evening — nothing in Asheville matched.
You asked for dance clubs in the evening — the weekend ran out of evenings
before it got there.
```

A weekend that quietly leaves out the thing you typed reads as an empty town
rather than as a search that came up short.

**An invariant, written into `keywords.ts` because it's the kind of thing a
later change breaks by accident:** the learned taste vector must never reach
the keyword builder. Weights scale scores; intent chooses queries; the two
never touch. If learning could narrow the search, a category rated badly once
would stop being searched, then stop being shown, and never recover — and the
results would look plausible the whole way down.

## Ranking is deterministic and shows its working

No model decides what goes in your weekend. Every score is named components you
can read:

```bash
npm run plan -- "Tampa, FL" -- --explain
```

```
  Afternoon  Henry B. Plant Museum
             +28.0 corroboration: 3 independent sources found this
              +7.3 rating: 4.6★ from 1,428 reviews
              +6.2 well known: 1,428 people have reviewed it
              +5.0 indoor bonus: indoor, which suits the forecast
              -5.0 price unknown: no price published
```

`--explain` isn't a reconstruction after the fact. It's the arithmetic that
produced the ordering, and the same numbers appear in the browser under
*How this was found*.

The itinerary builder then does what a ranked list can't: no two adjacent slots
from the same category, geography-aware hops, outdoor things demoted on wet
days, one source never owning every slot, a running budget total, and a dated
event only ever placed on the day it actually happens.

## It learns

```bash
npm run feedback -- 394495 rated 5     # loved it
npm run feedback -- d53985 did         # actually went
```

```
Relearned from 4 signal(s).
  leans toward: event (1.24)
  leans away from: culture (0.88), family (0.88)
```

The taste vector is a handful of numbers in SQLite you can print
(`npm run history`). Weights are clamped to `[0.4, 1.8]` and only ever *scale*
the base components, so a cold start degrades to a sensible generic ranker
rather than to noise, and two clicks can't invert your results. It's a full
recompute from signal history, not an incremental nudge — so deleting a bad
signal actually undoes it.

## Tests, and what they're for

```bash
npm test        # 109 tests, no dependencies, ~1s
```

`node --test` with `tsx`, so there's no framework and nothing new to install.
The store tests run against `:memory:`, which is one of the reasons
`node:sqlite` was worth choosing over a native module.

Every test is **named for a bug that shipped**, because every one of them
produced a plausible wrong answer rather than an error — which is the failure
mode a scraper is worst at noticing:

```
✔ 5pm In Tampa The R&B Block Party -> event          ("art" matched "P-art-y")
✔ Blind Tiger Coffee Roasters - Coffee Shop -> food  ("shop" beat "coffee")
✔ does not read the "4" out of "4.7 stars"
✔ a Saturday event is never scheduled on Sunday
✔ an event dated outside the weekend is never scheduled at all
✔ no coordinates is UNKNOWN, not ok and not a failure
✔ a locality matched in free text can cost points but never rejects
✔ the stored category is the one the user was shown
✔ it is a full recompute, so deleting a signal actually undoes it
✔ "chill, outdoorsy" gets no restaurants padded in
```

Writing them found two more, immediately:

- `categoryFromMapsType` had the same unanchored-token bug as
  `guessCategory` — `pub` matched "Notary **pub**lic", filing a notary under
  drinks.
- `publishedMiles` required a word boundary after `mi`, and Groupon writes its
  distance as `7.3 mi4.3(15)`. So the one source that publishes its own
  distance was the one source that was never read.

## It works outside the city it was written in

```bash
npm run harden
```

Runs the real fan-out across a spread of cities and prints a source × city
yield matrix, with `retries: 0` on purpose — retries hide flakiness, and the
point is to see it.

## Commands

```bash
npm run dashboard                     the browser UI — start here
npm test                              109 tests, no dependencies
npm run plan -- "Tampa, FL"
npm run plan -- "Seattle, WA" -- --vibes "outdoorsy, cheap" --budget 150
npm run plan -- "Austin, TX" -- --ask "date night, no driving, under $100"
npm run feedback -- <candidate-id> <kept|skipped|did|rated> [1-5]
npm run history
npm run sources
npm run geo-proof                     prove the location targeting works
npm run harden                        run every source against several cities
```

Flags: `--vibes --budget --adults --kids --over21 --mobility --avoid --days --sources --concurrency --retries --explain --record --no-writeup`

**Note the second `--` before any flag.** npm parses the first batch after `--`
as its own config and drops the flag names, so a single dash runs with defaults
and says nothing. The CLI detects that and tells you. Without npm in the way,
one dash is enough: `npx tsx src/cli.ts plan "Tampa, FL" --explain`.

## No agent in the loop, and where one would go

There is **no LLM anywhere in the decision path**. Nothing chooses your
weekend but code you can read. The browsers navigate and read; screening,
ranking, scheduling and learning are ordinary functions with named score
components, and the same sentence produces the same plan every time.

That is a deliberate choice rather than an omission, and it has been tested
the hard way. The first version asked a model to read *when* a request wanted
something. It answered `"evening"` on one run and nothing on the next, from
the identical sentence — so "bowling at night" came back as bowling at ten in
the morning, then correctly, then at ten again. A model is the right tool for
reading an unusual request. It is the wrong tool for a decision that has to be
the same every time. That read is now four lines of regex and it has never
been wrong since.

Claude does appear twice, both times outside the decision path and both times
optional: `--ask` widens a free-text request *after* the deterministic read
has already had it, and a write-up turns the finished plan into prose. Both
shell out to the `claude` CLI in headless mode, which works on a Pro/Max
subscription with **no API key** — so cloning this needs exactly one secret.
If `claude` isn't installed you lose the prose and keep the plan.

It earns its keep even there. On one run it read the finished plan and said
*"the party size is listed as 0 adults and 0 kids, which doesn't match a real
weekend"* — a real bug in the server's query parsing that nothing else caught.
Three times now the write-up has noticed something the planner did not.

### At scale, an agent earns its place — in two specific jobs

This runs for one city at a time against six sources. Scale it to a hundred
cities and a long tail of sources and two seams start to hurt, both of them
visible in this repo already:

**1. Validating what came back.** Nothing in the pipeline knows what a listing
*is*. It knows what a search returned and what the page said. That gap is the
single largest source of wrong answers here — a bowling *supply* retailer
scheduled as an afternoon out, a business brokerage filed under food, a
warehouse store filed under nightlife. Every fix has been another pattern for
a case we had met. A model asked *"is this a place someone would spend a
Saturday, and would it card a twenty-year-old?"* answers correctly on the
first try, for a listing nobody has seen before.

**2. Helping with the selection itself.** The itinerary is greedy with a
booking pass — good enough for six slots from a hundred candidates, and
visibly not a model of taste. "A rainy Sunday with a seven-year-old and
$60 left" is a judgement, and judgement is what a model is for.

The design that keeps both honest is the same one the `timeOfDay` failure
argues for: **the model labels, the code decides.** One batched call per run
attaches facts to candidates — what kind of place this is, whether it is 21+,
which request it answers — and every downstream decision stays the
deterministic function it is now, consuming those labels exactly as it
consumes a category today. Cache the label against the candidate id the store
already keys on, and a venue is labelled once ever: the cost amortises to
nothing and the same sentence still gives the same plan.

It is not built, on purpose. At this size the deterministic version is more
inspectable, cheaper, and better to demo — and the seams where it would go are
marked in the code rather than guessed at here.

## Six things that cost an afternoon

Kept here because the Solari cookbook asks for exactly this, and every one
produced a plausible-looking wrong answer rather than an error.

- **`waitForSelector` is not bounded by its own timeout.** With
  `{ timeout: 6_000 }` on a busy SPA it took **65 seconds** — its polling can't
  get scheduled on a saturated page. It ate whole source budgets while logging
  nothing. A bounded `waitForTimeout` plus a direct query is both faster and
  honest; `evaluateAll` on a missing selector returns `[]`, which is the right
  answer for "nothing matched" anyway.
- **The event dates were scraped, displayed, and then thrown away.** Every
  source set `windows: null` — Eventbrite under a comment claiming "the
  itinerary matches on day name", which it never did. Measured over 206 stored
  listings, **83 were on a different date**, each collecting the same
  "+16 happening this weekend" as one on the actual Saturday.
- **`Number("")` is 0, not NaN.** An absent query parameter passed
  `Number.isFinite` and became zero. The page omits `concurrency`, so the pool
  was built with `maxConcurrent: 0`, clamped to one browser, and a
  thirteen-browser fan-out ran single file until the deadline killed it.
- **A deadline that doesn't cancel anything isn't a deadline.** The fan-out
  returned at 20s and then blocked for another 50 in `close()`, because six
  browsers were still mid-navigation. Stopping waiting on a promise does not
  stop the work behind it.
- **`npm run x -- --flag value` does not pass the flag.** npm 11 parses what
  follows `--` as its own config: it records `--sources timeout` as a boolean
  config named `sources`, drops the flag name from argv, and leaves `timeout`
  behind as a stray positional.
- **`toISOString()` shifts the date.** Building a local `Date`, adding days,
  then slicing the ISO string planned Sunday and Monday for a request made on a
  Monday in Florida. Do the arithmetic on Y/M/D integers via `Date.UTC`.

## Layout

```
src/
  pipeline.ts         the plan, as events — the CLI and the web UI share it
  cli.ts              argument parsing and terminal rendering
  web/                node:http + SSE server, and one page of vanilla JS
  place.ts            geocoding — disambiguates Tampa FL from Tampa KS
  solari/geo.ts       the geolocation gate (and why proxy pinning is dead)
  solari/pool.ts      sharded fan-out, live-session tracking, global deadline
  engine/keywords.ts  what to search for, decided before any browser launches
  engine/relevance.ts the admission gate: place, time, kind, age
  engine/age.ts       what counts as a 21+ room, and why it is two gates
  engine/score.ts     deterministic ranking with named components
  engine/itinerary.ts ranked list -> an actual schedule
  engine/learn.ts     signals -> taste vector
  sources/when.ts     the four date formats event sites actually publish
  sources/text.ts     entity decoding and truncation chrome, in one place
  store/db.ts         node:sqlite, no native modules
  sources/            one file per source
```

No framework, no bundler, two runtime dependencies. MIT.
