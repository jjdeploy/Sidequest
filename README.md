# WeekendFun

**Twelve cloud browsers, in parallel, each one standing in your city, arguing about what you should do this weekend. Then it remembers what you actually liked.**

Built on [Solari](https://getsolari.com) — a fork of the [Solari cookbook](https://github.com/solari-sdk/solari-cookbook) with a real application on top.

### → [**`weekendfun/`**](weekendfun) — the project, and the full write-up

```bash
cd weekendfun
npm install
cp .env.example .env      # add your SOLARI_API_KEY
npm run plan -- "Tampa, FL" -- --vibes "chill, live music" --budget 220
npm run dashboard         # ...or watch it happen, at localhost:5173
```

```
Launching 6 cloud browsers in parallel:
  ✓ google-maps   in position, verified (2.1s)
  ✓ groupon       in position, verified (2.4s)
  ● timeout        20 found (8.3s)
  ● groupon        27 found (11.7s)
  ● google-maps    34 found (21.6s)

102 candidates from 6/6 sources in 21.6s

Saturday, Sep 5  85°/78°F, thunderstorms, 66% rain
────────────────────────────────────────────────────────────────────
  Morning    Kava Culture Tampa
             $15      food
             4.6★ from 600 reviews; indoor, which suits the forecast

  Afternoon  Henry B. Plant Museum
             —        culture  (0.4 mi hop)
             3 independent sources found this; indoor, which suits the forecast

  Evening    Bob Ross Sip & Paint Night at Kava Culture Downtown Tampa
             free     event
             a dated event, not an everyday venue; free
```

## Or watch it happen

![The WeekendFun dashboard](weekendfun/docs/dashboard.jpg)

`npm run dashboard` puts the fan-out on one clock — a lane per browser, the
striped head of each bar being the geolocation gate and the solid part the
source actually reading. Underneath: the plan on a map, thumbs that feed the
learner, and an rrweb replay of the browser session that found each venue.

## Why it needs cloud browsers

Google Maps, Groupon, Eventbrite and Yelp all answer *"what's on this weekend"* differently depending on **where the browser is**. You cannot `fetch()` your way to a local answer.

So: one browser per source, all placed in your city, all at once. Six sources answer in the time the slowest one takes. `npm run geo-proof` asks *"live music"* from two cities simultaneously and diffs the answers:

| Tampa browser | Seattle browser |
|---|---|
| 1920 Ybor | Neumos |
| The Sapphire Tampa | The Crocodile |
| Chewy's Lounge | Dimitriou's Jazz Alley |

**0% overlap** — from the same residential IP pool.

Three things make it a planner rather than a scraper:

- **Corroboration.** Three independent sources finding the same venue means more than any one ranking it first — and it's the signal only a parallel fan-out can compute.
- **A geolocation gate.** Nothing searches until the browser proves where it is, because a silently-failed override returns plausible results for the wrong city and poisons the store.
- **It learns.** Rate a plan; the next one is different. Deterministic, inspectable, and it works with the LLM switched off.

Full details, the measured dead ends, and five gotchas that each cost an afternoon: **[weekendfun/README.md](weekendfun/README.md)**.

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
