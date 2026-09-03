# Sidequest

**You're bored. This town isn't.**

> Thirteen geo-verified cloud browsers, launched in parallel, reading a dozen
> local listing sites at once — and a Saturday and Sunday you can actually
> follow. A fork of the [Solari cookbook](https://github.com/solari-sdk/solari-cookbook)
> with a real application on top, built on [Solari](https://getsolari.com).

### → [**`sidequest/`**](sidequest) — the project, and the full write-up

<!-- The poster is the video's own opening frame, so the click is continuous.

     Clicking opens the mp4 in GitHub's viewer, which plays it. For a player
     embedded directly in this page instead, drag docs/demo.mp4 into the
     GitHub web editor for this file — GitHub rewrites it to a
     user-attachments URL that renders inline, and that link can replace the
     one below. -->
[![Watch the demo](sidequest/docs/demo-poster.jpg)](sidequest/docs/demo.mp4)

<div align="center"><sub><b>▶ One minute, end to end</b> — a request, thirteen browsers, and a weekend.</sub></div>

---

**[The problem](#the-problem)** · **[The solution](#the-solution)** ·
**[How Solari is used](sidequest/README.md#how-solari-is-used)** ·
**[Where it goes next](#where-it-goes-next)**

```bash
cd sidequest
npm install
cp .env.example .env      # add your SOLARI_API_KEY
npm run dashboard         # http://localhost:5173
```

<!-- Demo video: paste the link here once recorded. docs/demo-script.md has
     the shot list; the run is deterministic so a rehearsed take matches. -->
**▶ [Three-minute demo](#)** — *link to be added*

## The problem

It's Friday, you're new here, and you have no idea what's on. That answer is
split across a dozen sites and **not one of them will sell you an API**. Every
attempt to unify local listings has died on exactly that — you'd have to
convince every platform to cooperate, and they have no reason to.

Worse, the answers are local in a way an ordinary request cannot reach. The
web personalises on where your traffic comes from and what you have clicked
before, so someone who just moved keeps getting shown their old life.

## The solution

So this doesn't ask. It opens real browsers in the cloud, stands them at your
coordinates, and reads all of them at the same time. A browser is a
permissionless interface: if a site has a page, it can be read.

![The fan-out](sidequest/docs/fanout.jpg)

One browser per source — and for Google Maps, one per search term. The Starter
plan allows twenty concurrent browsers; this uses thirteen, finishes in the
time the slowest one takes, and treats partial results as normal behind a hard
20-second deadline.

Same Palm Coast query, before and after that change:

```
92.8s   29 candidates   1/6 sources   place: 0 confirmed / 35 unknown
22.2s  106 candidates   5/6 sources   place: 51 confirmed / 31 unknown
```

**Nothing searches until the browser proves where it is.** Each session is
handed a geolocation override and then has to confirm those coordinates back
before it is allowed to run a single query. A browser whose location silently
failed returns perfectly valid results for the wrong city, which is the one
failure that looks exactly like success.

## Then a plan, and everything else it found

![The plan and the catalogue](sidequest/docs/plan.jpg)

A ranked list is not a weekend. The itinerary balances variety, geography,
weather and budget — and what you typed is a **booking rather than a
preference**: ask for "bowling at night" and the evening slot is claimed
before the rest of the weekend is filled in around it. If the town has no
alley, the plan says so above itself rather than quietly leaving it out.

Three more things make it a planner rather than a scraper:

- **Corroboration.** Independent sources agreeing on a venue means more than
  any one of them ranking it first — and it is the signal only a parallel
  fan-out can compute.
- **One admission gate, not six filters.** Every candidate from every source
  is asked whether it is near this city, on these days, a thing you would
  actually go and do, and whether you are old enough to get in. "Unknown" is
  its own state and it gets counted, because 70% of listings publish no
  location at all and pretending otherwise is how bad results got in.
- **It learns.** Rate a plan and the next one differs. Deterministic,
  inspectable, and it works with the LLM switched off.

## No model decides your weekend

There is no LLM anywhere in the decision path. The browsers read; screening,
ranking, scheduling and learning are ordinary functions with named score
components, and the same sentence gives the same plan every time. That is a
tested choice rather than an omission — the write-up has the run where a model
answered the identical question two different ways — and it comes with an
honest account of the two jobs an agent *would* take at a hundred cities.

Why the geolocation override earns its place, measured — `npm run geo-proof`
asks *"live music"* from two cities at the same moment, from the same
residential IP pool:

| Tampa browser | Seattle browser |
|---|---|
| 1920 Ybor | Neumos |
| The Sapphire Tampa | The Crocodile |
| Chewy's Lounge | Dimitriou's Jazz Alley |

**0% overlap.** And you do not have to be there yet: put a city you are moving
to in the box and the answers are that city's, not a guess made from here.

---

Full details, the measured dead ends, how each Solari capability is used, and
six gotchas that each cost an afternoon:
**[sidequest/README.md](sidequest/README.md)**.
A three-minute demo walkthrough: **[sidequest/docs/demo-script.md](sidequest/docs/demo-script.md)**.

## Where it goes next

Two seams would hurt at a hundred cities, and both are visible in the code
already.

**Nothing knows what a listing *is*.** It knows what a search returned and
what the page said. That gap is the largest single source of wrong answers
here — a bowling *supply* shop scheduled as an afternoon out, a business
brokerage filed under food. Most were fixed by reading the type descriptor
Google Maps already publishes, but one cannot be fixed with a pattern at all:
Pin Chasers is a Tampa bowling alley found by the search for bowling *and* by
the search for arcades, and whichever browser finished first decided what it
was. A model asked *"is this a place someone would spend a Saturday, and
would it card a twenty-year-old?"* answers that on the first try and does not
care which browser got home first.

**And the selection itself is greedy.** Good enough for six slots out of a
hundred candidates, and visibly not a model of taste. "A rainy Sunday with a
seven-year-old and $60 left" is a judgement.

The shape that keeps both honest is the one the deterministic version already
argues for: **the model labels, the code decides.** One batched call attaches
facts to candidates — what kind of place, whether it is 21+, which request it
answers — cached against the candidate id the store already keys on, so a
venue is labelled once ever and the same sentence still gives the same plan.
Ranking and scheduling stay the deterministic functions they are now.

It is not built, deliberately. At this size the deterministic version is more
inspectable, cheaper, and better to demo — and the seams are marked in the
code rather than guessed at here. The longer argument, with the run where a
model answered the same question two different ways, is in
[the project README](sidequest/README.md#no-agent-in-the-loop-and-where-one-would-go).

---

## The upstream cookbook

The original Solari examples are unchanged in [`examples/`](examples) — short, runnable, one idea each.

| Cloud browser | | Sandbox | | Desktop | |
| --- | --- | --- | --- | --- | --- |
| [browser-quickstart-ts](examples/browser-quickstart-ts) | TS | [sandbox-quickstart-ts](examples/sandbox-quickstart-ts) | TS | [desktop-computer-use-py](examples/desktop-computer-use-py) | Py |
| [browser-quickstart-py](examples/browser-quickstart-py) | Py | [sandbox-code-interpreter-py](examples/sandbox-code-interpreter-py) | Py | | |
| [browser-stealth-proxy-ts](examples/browser-stealth-proxy-ts) | TS | [sandbox-port-preview-ts](examples/sandbox-port-preview-ts) | TS | | |
| [browser-profiles-ts](examples/browser-profiles-ts) | TS | | | | |
| [browser-session-recording-py](examples/browser-session-recording-py) | Py | | | | |

```bash
cd examples/browser-quickstart-ts
npm install
export SOLARI_API_KEY=slr_live_...
npm start
```

One `slr_live_` key works across browsers, sandboxes and desktops.

- Docs — [docs.getsolari.com](https://docs.getsolari.com)
- Console — [console.getsolari.com](https://console.getsolari.com)

MIT licensed.
