/**
 * WeekendFun — client.
 *
 * No framework and no build step, for the same reason the server has no
 * dependencies: the repo's promise is `npm install` and go. This is three
 * screens rendering a stream of events, which is about the least justified
 * place in software to reach for a virtual DOM.
 *
 * Everything scraped off the web — titles, evidence, addresses — is written
 * with `textContent`, never `innerHTML`. It is untrusted text from six sites
 * we don't control and it goes on screen next to a form.
 */

// ─────────────────────────────────────────────────────────────── helpers

const $ = (id) => document.getElementById(id)

/** Minimal element builder. Strings become text nodes, never markup. */
function el(tag, props = {}, kids = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === "class") node.className = v
    else if (k === "style") node.setAttribute("style", v)
    else if (k === "dataset") Object.assign(node.dataset, v)
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k in node) node[k] = v
    else node.setAttribute(k, v)
  }
  for (const kid of [kids].flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return node
}

const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild) }
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`
const money = (n) => (n === null ? null : n === 0 ? "free" : `$${Math.round(n)}`)

/** What each slot is called to someone reading a plan, not a schema. */
const SLOT_TIME = { Morning: "10am", Afternoon: "2pm", Evening: "7pm" }

/** Category labels in the user's words, not the enum's. */
const CATEGORY_LABEL = {
  food: "food", drink: "drinks", outdoors: "outdoors", culture: "culture",
  music: "live music", nightlife: "nightlife", active: "something to do",
  family: "family", shopping: "shops", event: "events", other: "other",
}

/**
 * Moods, in the words someone bored would use.
 *
 * These map onto the vibe vocabulary in engine/keywords.ts, which decides the
 * Google Maps searches. Skipping them is fine — the keyword builder falls
 * back to a broad sweep — but this is the low-friction onboarding question
 * that gives a first-time request any shape at all, and a first-time request
 * with no shape is the entire cold-start problem.
 */
const MOODS = [
  ["eat something good", "foodie"],
  ["get outside", "outdoorsy"],
  ["live music", "nightlife"],
  ["something to actually do", "active"],
  ["with the kids", "family"],
  ["museums and history", "cultural"],
  ["keep it cheap", "cheap"],
  ["stay indoors", "indoors"],
  ["a chill one", "chill"],
]

// ───────────────────────────────────────────────────────────────── state

const state = {
  running: false,
  t0: 0,
  lanes: new Map(),
  laneEls: new Map(),
  span: 20_000,
  recording: false,
  moods: new Set(),
  itinerary: null,
  catalogue: [],
  planned: new Set(),
  filter: "all",
  expanded: new Set(),
  weights: {},
  feedback: new Map(),
  ratings: new Map(),
  explain: false,
  stream: null,
  place: null,
  gathered: null,
  screened: null,
}

const screen = (name) => { document.body.dataset.screen = name }

/**
 * The header's middle slot: where we are, or nothing.
 *
 * The place used to be a headline on the working screen and a centred string
 * on the results bar — two treatments of one fact, and the loading screen
 * ended up the loudest thing in the product. It lives here now, one compact
 * chip, in the same position on every screen.
 */
function renderHere(place) {
  const mid = $("topbarMid")
  clear(mid)
  if (!place) return
  mid.append(el("div", { class: "here" }, [
    el("span", { class: "here-pin" }),
    el("span", { class: "here-name" }, place.label),
    el("span", { class: "here-coords" }, `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`),
  ]))
}

// ──────────────────────────────────────────────────────────────── boot

async function boot() {
  buildMoods()
  wire()
  try {
    const s = await (await fetch("/api/state")).json()
    state.weights = s.weights
    $("landingStats").textContent = s.counts.runs > 0
      ? `${s.counts.runs} weekends planned · ${s.counts.candidates.toLocaleString()} places known so far`
      : "nothing planned here yet"
  } catch {
    showError("Can't reach the WeekendFun server. Is `npm run dashboard` still running?")
  }
}

function buildMoods() {
  const box = $("moodChips")
  for (const [label, vibe] of MOODS) {
    box.append(el("button", {
      type: "button", class: "chip", textContent: label, "aria-pressed": "false",
      onclick: (e) => {
        const on = e.currentTarget.getAttribute("aria-pressed") === "true"
        if (on) state.moods.delete(vibe)
        else state.moods.add(vibe)
        e.currentTarget.setAttribute("aria-pressed", on ? "false" : "true")
      },
    }))
  }
}

function wire() {
  $("planForm").addEventListener("submit", (e) => { e.preventDefault(); if (!state.running) start() })
  // The wordmark is the way back. One header means one home button, rather
  // than a different escape hatch on each screen.
  $("brandHome").addEventListener("click", () => {
    if (state.running) return
    screen("landing")
    $("city").focus()
  })
  $("explainToggle").addEventListener("change", (e) => {
    state.explain = e.currentTarget.checked
    if (state.itinerary) renderPlan(state.itinerary)
  })
  $("aboutOpen").addEventListener("click", showAbout)
  $("modalClose").addEventListener("click", closeModal)
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal() })
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal() })
}

function showError(message) {
  const box = $("formError")
  box.textContent = message
  box.hidden = false
  screen("landing")
}

// ─────────────────────────────────────────────────────────────── running

function start() {
  const city = $("city").value.trim()
  if (!city) return

  // Recording is on by default here. It costs nothing extra to run and it is
  // what makes "Watch it get found" work — being able to replay the session
  // that produced a recommendation is the whole provenance argument, and it
  // is worth more than an option nobody would think to tick.
  const q = new URLSearchParams({
    city, vibes: [...state.moods].join(","), budget: "300", record: "1",
  })

  state.running = true
  state.t0 = performance.now()
  state.lanes.clear(); state.laneEls.clear()
  state.span = 20_000
  state.catalogue = []; state.planned.clear(); state.expanded.clear(); state.filter = "all"
  state.gathered = null; state.screened = null
  clear($("lanes")); clear($("terms"))
  $("writeupBlock").hidden = true
  $("formError").hidden = true
  $("go").disabled = true
  $("statusPlace").textContent = "locating…"
  $("statusCoords").textContent = "—"
  $("readyCount").textContent = "0"
  $("readyTotal").textContent = "–"
  renderHere(null)
  screen("working")

  const stream = new EventSource(`/api/plan?${q}`)
  state.stream = stream
  stream.onmessage = (m) => { try { handle(JSON.parse(m.data)) } catch { /* keep the stream alive */ } }
  stream.onerror = () => {
    stream.close()
    if (state.running) {
      state.running = false
      $("go").disabled = false
      showError("Lost the connection mid-search. Try again.")
    }
  }
  tick()
}

function handle(e) {
  switch (e.type) {
    case "place": onPlace(e); break
    case "keywords": onKeywords(e.keywords); break
    case "launching": onLaunching(e); break
    case "pool": onPool(e.at, e.event); break
    case "gathered": state.gathered = e; break
    case "screened": state.screened = e.summary; break
    case "ranked": state.catalogue = e.top; break
    case "itinerary": onItinerary(e.itinerary); break
    case "taste": state.weights = e.weights; renderTaste(e.weights); break
    case "writeup": $("writeupBlock").hidden = false; $("writeup").textContent = e.text; break
    case "error": state.running = false; $("go").disabled = false; showError(e.message); break
    case "done": finish(); break
    default: break
  }
}

function finish() {
  state.running = false
  $("go").disabled = false
  state.stream?.close()
  renderRig()
}

function onPlace(e) {
  state.place = e.place
  $("statusPlace").textContent = e.place.label
  $("statusCoords").textContent = `${e.place.lat.toFixed(4)}, ${e.place.lng.toFixed(4)}`
  renderHere(e.place)
}

function onKeywords(keywords) {
  const box = $("terms")
  clear(box)
  keywords.forEach((k, i) => {
    box.append(el("span", {
      class: "term", style: `animation-delay:${i * 40}ms`, title: k.because,
    }, el("b", {}, k.term)))
  })
}

// ── the fan-out ──────────────────────────────────────────────────────────

function onLaunching(e) {
  state.recording = e.recording
  // "8 of 13 in position" beats a bare count: it says how far through it is.
  $("readyTotal").textContent = String(e.browsers ?? e.sources.length)
  const lanes = $("lanes")
  clear(lanes)
  for (const id of e.sources) {
    state.lanes.set(id, {
      id, at: null, gatedAt: null, endAt: null, found: null,
      status: "queued", shards: 0, gated: 0,
    })
    const gate = el("div", { class: "bar-gate" })
    const work = el("div", { class: "bar-work" })
    const bar = el("div", { class: "lane-bar", style: "left:0;width:0" }, [gate, work])
    const out = el("div", { class: "lane-out" }, "queued")
    const row = el("div", { class: "lane" }, [
      el("div", { class: "lane-name" }, id),
      el("div", { class: "lane-track" }, bar),
      out,
    ])
    lanes.append(row)
    state.laneEls.set(id, { row, bar, gate, out })
  }
}

function onPool(at, ev) {
  const lane = state.lanes.get(ev.source)
  if (!lane) return
  // A source can now be several browsers. The lane shows the source's whole
  // span — first launch to last finish — and counts how many of its browsers
  // are in position, which is what someone waiting actually wants to know.
  switch (ev.type) {
    case "launch":
      if (lane.at === null) lane.at = at
      lane.shards++
      lane.status = "launching"
      break
    case "gated":
      lane.gatedAt = lane.gatedAt ?? at
      lane.gated++
      lane.status = "running"
      break
    case "done":
      lane.endAt = at
      lane.found = (lane.found ?? 0) + ev.found
      lane.status = "done"
      break
    case "fail":
      lane.endAt = at
      if (!lane.found) lane.status = "failed"
      break
    default:
      return
  }
  const gated = [...state.lanes.values()].reduce((n, l) => n + l.gated, 0)
  $("readyCount").textContent = String(gated)
  draw()
}

function niceSpan(ms) {
  for (const s of [10, 15, 20, 25, 30, 45, 60, 90, 120]) if (ms <= s * 1000) return s * 1000
  return Math.ceil(ms / 30_000) * 30_000
}

function draw() {
  const now = state.running ? performance.now() - state.t0 : 0
  let maxEnd = now
  for (const l of state.lanes.values()) maxEnd = Math.max(maxEnd, l.endAt ?? 0)
  state.span = Math.max(state.span, niceSpan(maxEnd * 1.05 || 10_000))

  for (const [id, lane] of state.lanes) {
    const dom = state.laneEls.get(id)
    if (!dom) continue
    const pct = (ms) => `${Math.max(0, Math.min(100, (ms / state.span) * 100))}%`
    if (lane.at === null) { dom.bar.style.width = "0"; continue }

    const end = lane.endAt ?? (state.running ? now : lane.at)
    dom.bar.style.left = pct(lane.at)
    dom.bar.style.width = pct(Math.max(0, end - lane.at))
    const gateMs = (lane.gatedAt ?? end) - lane.at
    dom.gate.style.width = `${Math.min(100, (gateMs / Math.max(1, end - lane.at)) * 100)}%`
    dom.row.classList.toggle("running", lane.status === "launching" || lane.status === "running")
    dom.row.classList.toggle("failed", lane.status === "failed")

    clear(dom.out)
    if (lane.found !== null) {
      dom.out.append(el("b", {}, String(lane.found)), " found")
    } else if (lane.status === "failed") {
      dom.out.append(el("span", { class: "bad" }, "no answer"))
    } else if (lane.gated > 0) {
      dom.out.append(el("span", { class: "ok" }, `${lane.gated}/${lane.shards} in position`))
    } else {
      dom.out.append("launching…")
    }
  }
}

function tick() {
  if (!state.running) return
  draw()
  requestAnimationFrame(tick)
}

// ── results ──────────────────────────────────────────────────────────────

function onItinerary(it) {
  state.itinerary = it
  state.planned = new Set(it.days.flatMap((d) => d.items.map((i) => i.candidate.id)))
  screen("results")
  window.scrollTo(0, 0)
  renderPlan(it)
  renderCatalogue()
  renderTaste(state.weights)
}

function renderPlan(it) {
  const host = $("days")
  clear(host)
  $("planMeta").textContent = state.place ? state.place.label : ""

  let pin = 0
  const pins = []

  it.days.forEach((day, dayIdx) => {
    const date = new Date(`${day.date}T12:00:00`)
    const name = date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    const w = day.weather
    const wet = w ? w.precipChance >= 60 : false

    const slots = el("div", {})
    for (const item of day.items) {
      pin++
      const c = item.candidate
      if (c.lat !== null && c.lng !== null) pins.push({ ...c, pin, day: dayIdx, slot: item.slot })
      slots.append(renderSlot(item, pin))
    }
    if (day.items.length === 0) {
      slots.append(el("p", { class: "slot-why", style: "padding:16px 0" },
        "Nothing here fit. Try a different mood, or a bigger budget."))
    }

    host.append(el("section", {}, [
      el("div", { class: "day-head" }, [
        el("span", { class: "day-name" }, name),
        w ? el("span", { class: `day-wx ${wet ? "wet" : ""}` },
          `${w.highF}° · ${w.summary} · ${w.precipChance}% rain`) : null,
        day.costUsd > 0 ? el("span", { class: "day-cost" }, `$${Math.round(day.costUsd)}`) : null,
      ]),
      slots,
    ]))
  })

  const foot = $("planFoot")
  clear(foot)
  foot.append(
    el("span", { class: "plan-total" }, `$${Math.round(it.totalUsd)}`),
    el("span", {}, `of the $${it.budgetUsd} you had in mind`),
    ...it.notes.map((n) => el("span", { class: "plan-note" }, n)),
  )

  renderMap(pins)
}

function renderSlot(item, pin) {
  const c = item.candidate
  const price = money(c.priceUsd)

  const facts = el("div", { class: "facts" }, [
    price ? el("span", { class: `tag ${c.priceUsd === 0 ? "tag--free" : ""}` }, price) : null,
    el("span", { class: "tag tag--cat" }, CATEGORY_LABEL[c.category] ?? c.category),
    c.rating !== null
      ? el("span", { class: "tag tag--rating" },
          `${c.rating}★${c.reviewCount ? ` · ${c.reviewCount.toLocaleString()}` : ""}`)
      : null,
    c.corroboration > 1
      ? el("button", {
          class: "tag tag--agree", type: "button",
          title: "which sources found this, and what each one said",
          onclick: () => showSightings(c),
        }, `${c.corroboration} sources agree`)
      : null,
    item.hopMiles !== null ? el("span", { class: "tag tag--far" }, `${item.hopMiles.toFixed(1)} mi away`) : null,
  ])

  return el("div", { class: "slot" }, [
    el("div", { class: "slot-when" }, [el("b", {}, SLOT_TIME[item.slot] ?? ""), item.slot]),
    el("div", {}, [
      el("div", { class: "slot-title" },
        c.url ? el("a", { href: c.url, target: "_blank", rel: "noreferrer" }, c.title) : c.title),
      facts,
      el("div", { class: "slot-why" }, item.why),
      state.explain ? renderComponents(c.components) : null,
      renderActs(c),
    ]),
  ])
}

function renderComponents(components) {
  const box = el("div", { class: "components" })
  for (const comp of components) {
    box.append(el("div", {}, [
      el("span", { class: `pts ${comp.points > 0 ? "pos" : "neg"}` },
        `${comp.points > 0 ? "+" : ""}${comp.points.toFixed(1)}`),
      el("span", {}, comp.name),
      el("span", {}, comp.why),
    ]))
  }
  return box
}

function renderActs(c) {
  const current = state.feedback.get(c.id)
  const box = el("div", { class: "acts" })
  const thumb = (kind, label) => el("button", {
    type: "button", class: `act ${current === kind ? "on" : ""}`, textContent: label,
    onclick: () => sendFeedback(c, kind, undefined, current === kind),
  })
  box.append(thumb("kept", "Keep it"), thumb("skipped", "Not this"), thumb("did", "We went"))

  const stars = el("span", { class: "stars" })
  const rated = state.ratings.get(c.id) ?? 0
  for (let n = 1; n <= 5; n++) {
    stars.append(el("button", {
      type: "button", class: `star ${n <= rated ? "lit" : ""}`, textContent: "★",
      title: `rate ${n} of 5`,
      onclick: () => sendFeedback(c, "rated", n, false),
    }))
  }
  box.append(stars)

  if (state.recording && c.sessionId) {
    box.append(el("button", {
      type: "button", class: "act act--ghost", textContent: "Watch it get found",
      onclick: () => showReplay(c.sessionId, c.title),
    }))
  }
  return box
}

// ── the catalogue: everything that didn't make the plan ──────────────────

function renderCatalogue() {
  const rest = state.catalogue.filter((c) => !state.planned.has(c.id))
  $("catCount").textContent = `${rest.length} more in ${state.place?.city ?? "town"}`

  const byCat = new Map()
  for (const c of rest) {
    const list = byCat.get(c.category) ?? []
    list.push(c)
    byCat.set(c.category, list)
  }
  const order = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)

  const filters = $("filters")
  clear(filters)
  const chip = (key, label, n) => el("button", {
    type: "button", class: "filter", "aria-pressed": String(state.filter === key),
    onclick: () => { state.filter = key; renderCatalogue() },
  }, [label, el("i", {}, String(n))])
  filters.append(chip("all", "everything", rest.length))
  for (const [cat, list] of order) filters.append(chip(cat, CATEGORY_LABEL[cat] ?? cat, list.length))

  const groups = $("groups")
  clear(groups)
  const shown = state.filter === "all" ? order : order.filter(([cat]) => cat === state.filter)
  if (shown.length === 0) {
    groups.append(el("p", { class: "taste-empty" }, "Nothing in that category this weekend."))
    return
  }
  for (const [cat, list] of shown) {
    // Picking a single category is itself a request to see all of it.
    const open = state.expanded.has(cat) || state.filter === cat
    const visible = open ? list : list.slice(0, 6)
    const rows = el("div", { class: "rows" }, visible.map(rowFor))
    if (!open && list.length > visible.length) {
      rows.append(el("button", {
        class: "more", type: "button",
        textContent: `Show all ${list.length} — ${CATEGORY_LABEL[cat] ?? cat}`,
        onclick: () => { state.expanded.add(cat); renderCatalogue() },
      }))
    }
    groups.append(el("section", {}, [
      el("h3", { class: "group-head" }, [CATEGORY_LABEL[cat] ?? cat, el("span", {}, String(list.length))]),
      rows,
    ]))
  }
}

function rowFor(c) {
  const price = money(c.priceUsd)
  return el("div", { class: "row", onclick: () => showSightings(c) }, [
    el("div", { class: "row-name" }, [
      c.title,
      c.corroboration > 1 ? el("em", {}, `${c.corroboration} sources`) : null,
    ]),
    el("div", { class: "row-facts" }, [
      c.rating !== null ? el("span", { class: "r" }, `${c.rating}★`) : null,
      c.reviewCount ? el("span", {}, c.reviewCount.toLocaleString()) : null,
      price ? el("span", { class: c.priceUsd === 0 ? "p" : "" }, price) : null,
      el("span", {}, c.source),
    ]),
  ])
}

// ── the rig ──────────────────────────────────────────────────────────────

function renderRig() {
  const g = state.gathered
  const s = state.screened
  if (!g) return

  $("rigSummary").textContent = `${g.ok} of ${g.of} sources · ${secs(g.elapsedMs)}`

  const stats = $("rigStats")
  clear(stats)
  const stat = (v, k, note, hero) => el("div", { class: `stat ${hero ? "stat--hero" : ""}` }, [
    el("div", { class: "stat-v" }, v),
    el("div", { class: "stat-k" }, k),
    note ? el("div", { class: "stat-note" }, note) : null,
  ])
  stats.append(
    stat(secs(g.elapsedMs), "wall clock", `${g.ok} of ${g.of} sources answered inside the deadline`, true),
    stat(secs(g.sequentialMs), "one at a time", "the same work, run in sequence"),
    stat(String(g.total), "listings read", "before screening and ranking"),
  )

  if (s) {
    const gate = $("rigGate")
    clear(gate)
    gate.append(
      el("div", {}, [el("b", {}, `${s.admitted} admitted`), `, ${s.rejected} rejected of ${s.total}.`]),
      el("div", {}, [
        "place — ", el("span", { class: "ok" }, `${s.byDimension.place.ok} confirmed`), ", ",
        el("span", { class: "bad" }, `${s.byDimension.place.fail} elsewhere`),
        `, ${s.byDimension.place.unknown} published no location at all.`,
      ]),
      el("div", {}, [
        "dates — ", el("span", { class: "ok" }, `${s.byDimension.time.ok} on your days`), ", ",
        el("span", { class: "bad" }, `${s.byDimension.time.fail} on other dates`), ".",
      ]),
      el("div", {}, [
        "kind — ", el("span", { class: "bad" }, `${s.byDimension.kind.fail} filtered`),
        " as business listings, admin, or a broken scrape.",
      ]),
    )
  }

  // The same lanes, no longer live. Cloned rather than re-rendered so the
  // finished timing is exactly what was on screen while you waited.
  const target = $("lanesStatic")
  clear(target)
  for (const node of $("lanes").children) target.append(node.cloneNode(true))
}

// ── taste ────────────────────────────────────────────────────────────────

function renderTaste(weights) {
  const host = $("taste")
  clear(host)
  const cats = Object.entries(weights ?? {})
    .filter(([k]) => k.startsWith("cat:"))
    .map(([k, v]) => [k.slice(4), v])
    .filter(([, v]) => Math.abs(v - 1) > 0.02)
    .sort((a, b) => b[1] - a[1])

  if (cats.length === 0) {
    host.append(el("p", { class: "taste-empty" },
      "Nothing yet. Keep or skip anything above and the next weekend in this town comes back different — same browsers, ranked by what you actually liked."))
    return
  }
  // The learner clamps weights to [0.4, 1.8] with 1.0 neutral, so the bar is
  // drawn against that fixed scale rather than the visible range — otherwise
  // a tiny preference would look like a strong one.
  const MIN = 0.4, MAX = 1.8, mid = (1 - MIN) / (MAX - MIN)
  for (const [name, v] of cats) {
    const at = (v - MIN) / (MAX - MIN)
    const up = v > 1
    host.append(el("div", { class: "weight" }, [
      el("span", { class: "weight-name" }, CATEGORY_LABEL[name] ?? name),
      el("span", { class: "weight-bar" }, el("span", {
        class: `weight-fill ${up ? "up" : "down"}`,
        style: up
          ? `left:${mid * 100}%;width:${(at - mid) * 100}%`
          : `left:${at * 100}%;width:${(mid - at) * 100}%`,
      })),
      el("span", { class: "weight-val" }, v.toFixed(2)),
    ]))
  }
}

async function sendFeedback(c, kind, value, undo) {
  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateId: c.id, kind, value, undo }),
    })
    const out = await res.json()
    if (!res.ok) return
    if (undo) state.feedback.delete(c.id)
    else if (kind === "rated") state.ratings.set(c.id, value)
    else state.feedback.set(c.id, kind)
    state.weights = out.weights
    renderTaste(out.weights)
    if (state.itinerary) renderPlan(state.itinerary)
  } catch { /* the plan is on screen; a failed thumb is not worth an alarm */ }
}

// ── map ──────────────────────────────────────────────────────────────────

const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

/**
 * A slippy map in about eighty lines.
 *
 * Not a mapping library: the job is "put six dots on a street grid and join
 * them up", and Leaflet is 140KB to do it. Tiles are plain <img> elements,
 * CSS-filtered onto the warm dark ground; if they fail to load, the dots and
 * the route are still readable, which is most of the information anyway.
 */
function renderMap(points) {
  const host = $("map")
  clear(host)
  const note = $("mapNote")

  if (points.length === 0) {
    host.append(el("div", { class: "map-empty" },
      "No coordinates on this plan yet. Google Maps is the only source that publishes them, so the map fills in as it contributes places."))
    note.textContent = ""
    return
  }

  const W = host.clientWidth || 820
  const H = host.clientHeight || 380
  const PAD = 54
  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  const b = { n: Math.max(...lats), s: Math.min(...lats), e: Math.max(...lngs), w: Math.min(...lngs) }

  let z = 16
  for (; z > 2; z--) {
    const dx = (lonToX(b.e, z) - lonToX(b.w, z)) * 256
    const dy = (latToY(b.s, z) - latToY(b.n, z)) * 256
    if (dx <= W - PAD * 2 && dy <= H - PAD * 2) break
  }
  const cx = lonToX((b.e + b.w) / 2, z)
  const cy = latToY((b.n + b.s) / 2, z)
  const px = (p) => (lonToX(p.lng, z) - cx) * 256 + W / 2
  const py = (p) => (latToY(p.lat, z) - cy) * 256 + H / 2

  const tiles = el("div", { class: "map-tiles" })
  const max = 2 ** z
  for (let tx = Math.floor(cx - W / 512); tx <= Math.floor(cx + W / 512); tx++) {
    for (let ty = Math.floor(cy - H / 512); ty <= Math.floor(cy + H / 512); ty++) {
      if (ty < 0 || ty >= max) continue
      const wrapped = ((tx % max) + max) % max
      tiles.append(el("img", {
        src: `https://tile.openstreetmap.org/${z}/${wrapped}/${ty}.png`,
        alt: "", loading: "lazy", referrerPolicy: "no-referrer-when-downgrade",
        style: `left:${(tx - cx) * 256 + W / 2}px;top:${(ty - cy) * 256 + H / 2}px`,
        onerror: (e) => e.currentTarget.remove(),
      }))
    }
  }
  host.append(tiles)

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const day of [...new Set(points.map((p) => p.day))]) {
    const dp = points.filter((p) => p.day === day)
    if (dp.length < 2) continue
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", dp.map((p, i) => `${i ? "L" : "M"}${px(p).toFixed(1)},${py(p).toFixed(1)}`).join(" "))
    path.setAttribute("fill", "none")
    path.setAttribute("stroke", day === 1 ? "var(--gold)" : "var(--ember)")
    path.setAttribute("stroke-width", "2")
    path.setAttribute("stroke-dasharray", "6 5")
    path.setAttribute("opacity", "0.8")
    svg.append(path)
  }
  host.append(svg)

  for (const p of points) {
    host.append(el("div", {
      class: `map-pin ${p.day === 1 ? "d2" : ""}`,
      style: `left:${px(p).toFixed(1)}px;top:${py(p).toFixed(1)}px`,
      title: `${p.slot} · ${p.title}`,
      textContent: String(p.pin),
      onclick: () => showSightings(p),
    }))
  }
  host.append(el("a", {
    class: "map-attr", href: "https://www.openstreetmap.org/copyright",
    target: "_blank", rel: "noreferrer", textContent: "© OpenStreetMap",
  }))

  const total = state.itinerary?.days.flatMap((d) => d.items).length ?? points.length
  note.textContent = total > points.length
    ? `${points.length} of ${total} stops have coordinates — the rest came from sources that don't publish any. Day two is gold.`
    : "In order, day one then day two. Day two is gold."
}

// ── modal ────────────────────────────────────────────────────────────────

function openModal(title, body) {
  $("modalTitle").textContent = title
  const host = $("modalBody")
  clear(host)
  host.append(body)
  $("modal").hidden = false
}

function closeModal() {
  $("modal").hidden = true
  clear($("modalBody"))
}

function showAbout() {
  openModal("How this works", el("div", {}, [
    el("p", {}, "What's on near you is spread across a dozen sites, and none of them will sell you an API. Every attempt to unify local listings has died on exactly that — you'd have to convince every platform to cooperate."),
    el("p", {}, "So WeekendFun doesn't ask. It opens real browsers in the cloud, stands them at your coordinates, and reads every source at the same time. A browser is a permissionless interface: if a site has a page, it can be read."),
    el("h4", {}, "Why standing there matters"),
    el("p", {}, "The web personalises on where your traffic comes from and what you've clicked before. If you've just moved, both of those are wrong, so it keeps showing you your old life. Every browser here proves where it is before it's allowed to search — which is also why you can plan a weekend in a city you haven't moved to yet."),
    el("h4", {}, "What decides the plan"),
    el("p", {}, "Ordinary code, not a model. Independent sources agreeing on a place counts for a lot; so do ratings weighted by how many people left them, whether something is actually on the days you asked about, and the forecast. Open “How this was found” under the plan to see the arithmetic behind every card."),
    el("h4", {}, "What it remembers"),
    el("p", {}, "Only what you tell it. Keep or skip anything and the next weekend in that town comes back ranked differently."),
  ]))
}

async function showSightings(c) {
  const body = el("div", {}, el("p", {}, "Loading…"))
  openModal(c.title, body)
  try {
    const data = await (await fetch(`/api/candidate/${encodeURIComponent(c.id)}`)).json()
    clear(body)
    if (!data.sightings?.length) {
      body.append(el("p", {}, "No stored record for this one."))
      return
    }
    const n = new Set(data.sightings.map((s) => s.source)).size
    body.append(el("p", {},
      `Found by ${n} independent source${n === 1 ? "" : "s"}. Here's what each one actually said:`))
    for (const s of data.sightings) {
      body.append(el("div", { class: "sighting" }, [
        el("div", { class: "sighting-head" }, [
          el("span", { class: "sighting-src" }, s.source),
          s.runs > 1 ? el("span", { class: "tag" }, `seen on ${s.runs} runs`) : null,
          s.sessionId
            ? el("button", {
                class: "act act--ghost", type: "button", textContent: "Watch it get found",
                onclick: () => showReplay(s.sessionId, `${c.title} — ${s.source}`),
              })
            : null,
        ]),
        el("div", { class: "sighting-ev" }, s.evidence),
      ]))
    }
  } catch (err) {
    clear(body)
    body.append(el("p", {}, String(err)))
  }
}

function loadOnce(tag, attrs) {
  const key = attrs.src ?? attrs.href
  if (document.querySelector(`${tag}[data-cdn="${key}"]`)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    document.head.append(el(tag, { ...attrs, dataset: { cdn: key }, onload: resolve, onerror: reject }))
  })
}

/**
 * Play back the browser session that found a venue.
 *
 * The rrweb player loads from a CDN on first use rather than being vendored:
 * it's only reachable from a page already open in a browser, and nothing else
 * in the repo needs it. If the CDN is unreachable, fall back to what can be
 * read straight out of the event stream — which URLs it visited, and for how
 * long. That's still an honest answer to "where did this come from".
 */
async function showReplay(sessionId, title) {
  const host = el("div", { class: "replay-host" }, el("div", { class: "replay-msg" }, "Fetching the recording…"))
  openModal(`Replay — ${title}`, host)

  let events
  try {
    const res = await fetch(`/api/replay/${encodeURIComponent(sessionId)}`)
    const text = await res.text()
    if (!res.ok) {
      let hint = text
      try { const j = JSON.parse(text); hint = `${j.error}${j.hint ? ` — ${j.hint}` : ""}` } catch { /* raw text is fine */ }
      clear(host)
      host.append(el("div", { class: "replay-msg" }, hint))
      return
    }
    events = text.split("\n").filter(Boolean).map((line) => {
      const o = JSON.parse(line)
      if (typeof o.type === "number" && typeof o.timestamp === "number") return o
      // Tolerate a wrapper without mistaking rrweb's own `data` field for one:
      // a real event always carries a numeric type and timestamp.
      for (const v of Object.values(o)) {
        if (v && typeof v.type === "number" && typeof v.timestamp === "number") return v
      }
      return null
    }).filter(Boolean)
  } catch (err) {
    clear(host)
    host.append(el("div", { class: "replay-msg" }, `Could not read the recording: ${err}`))
    return
  }

  if (events.length < 2) {
    clear(host)
    host.append(el("div", { class: "replay-msg" },
      "Too few events to play. Sessions are only recorded when a run asks for it."))
    return
  }

  try {
    await Promise.all([
      loadOnce("link", { rel: "stylesheet", href: "https://cdn.jsdelivr.net/npm/rrweb-player@2.1.1/dist/style.min.css" }),
      loadOnce("script", { src: "https://cdn.jsdelivr.net/npm/rrweb-player@2.1.1/umd/rrweb-player.min.js" }),
    ])
    const Player = window.rrwebPlayer?.default ?? window.rrwebPlayer
    if (typeof Player !== "function") throw new Error("player did not load")
    clear(host)
    const width = Math.min(1000, $("modalBody").clientWidth - 4)
    new Player({ target: host, props: { events, width, height: Math.round(width * 0.56), autoPlay: true, showController: true } })
  } catch {
    const urls = [...new Set(events.map((e) => e.data?.href).filter(Boolean))]
    const ms = events[events.length - 1].timestamp - events[0].timestamp
    clear(host)
    host.append(el("div", { class: "replay-msg" }, [
      el("p", {}, "The player couldn't load, so here's what the recording holds:"),
      el("p", {}, el("code", {}, `${events.length.toLocaleString()} events over ${secs(ms)}`)),
      ...urls.slice(0, 6).map((u) => el("p", {}, el("code", {}, u))),
    ]))
  }
}

boot()
