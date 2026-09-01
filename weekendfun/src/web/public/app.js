/**
 * WeekendFun dashboard — client.
 *
 * No framework and no build step, for the same reason the server has no
 * dependencies: the repo's whole promise is `npm install` and go. This is one
 * page that renders a stream of events, which is about the least justified
 * place in software to reach for a virtual DOM.
 *
 * Everything scraped off the web (titles, evidence snippets, addresses) is
 * written with `textContent`, never `innerHTML`. It is untrusted text from
 * six sites we don't control, and it goes on screen next to a form.
 */

// ───────────────────────────────────────────────────────────────── helpers

const $ = (id) => document.getElementById(id)

/** Minimal element builder. `props` sets properties; `kids` accepts strings,
 *  nodes, or nested arrays, and strings become text nodes (never markup). */
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

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild) }
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`
const money = (n) => (n === null ? "—" : n === 0 ? "free" : `$${Math.round(n)}`)

const SOURCE_COLORS = {
  "google-maps": "var(--s-google-maps)",
  eventbrite: "var(--s-eventbrite)",
  allevents: "var(--s-allevents)",
  groupon: "var(--s-groupon)",
  tripadvisor: "var(--s-tripadvisor)",
  timeout: "var(--s-timeout)",
  reddit: "var(--s-reddit)",
}
const srcVar = (id) => `--src:${SOURCE_COLORS[id] ?? "var(--muted)"}`

const VIBE_PRESETS = [
  "chill", "live music", "outdoorsy", "date night", "cheap",
  "family", "foodie", "artsy", "nightlife", "rainy day",
]

// ───────────────────────────────────────────────────────────────── state

const state = {
  running: false,
  t0: 0,
  lanes: new Map(),      // sourceId -> lane record
  laneEls: new Map(),    // sourceId -> { row, bar, gate, work, out }
  span: 20_000,          // gantt time axis, ms
  recording: false,
  sources: [],
  pickedSources: new Set(),
  itinerary: null,
  weights: {},
  feedback: new Map(),   // candidateId -> kind currently set
  ratings: new Map(),    // candidateId -> 1..5
  explain: false,
  stream: null,
}

// ───────────────────────────────────────────────────────────── boot / state

async function boot() {
  buildVibeChips()
  wireForm()

  try {
    const s = await (await fetch("/api/state")).json()
    state.sources = s.sources
    state.pickedSources = new Set(s.sources)
    state.weights = s.weights
    buildSourceChips()
    renderStats(s.counts)
    renderTaste(s.weights, {})
    renderSignals(s.signals)
    renderRuns(s.runs)
    updateGoSub()
    const hint = $("askHint")
    hint.textContent = s.claude ? "claude CLI found" : "needs the claude CLI"
    hint.classList.toggle("ok", Boolean(s.claude))
    $("ask").disabled = !s.claude
    $("writeup").disabled = !s.claude
    if (!s.claude) $("writeup").checked = false
    if (s.lastPlan) $("empty").append(el("p", { class: "map-legend" },
      `Last plan: ${s.lastPlan.title} · rate anything from a new run and the next one changes.`))
  } catch {
    setStatus("err", "server unreachable")
  }
}

function renderStats(c) {
  const stats = $("stats")
  clear(stats)
  const pairs = [["runs", c.runs], ["places", c.candidates], ["sightings", c.sightings], ["signals", c.signals]]
  for (const [k, v] of pairs) {
    stats.append(el("div", {}, [el("dt", {}, k), el("dd", {}, String(v))]))
  }
}

function setStatus(kind, text) {
  const s = $("status")
  s.className = `status status--${kind}`
  s.textContent = text
}

// ───────────────────────────────────────────────────────────────── the form

function buildVibeChips() {
  const box = $("vibeChips")
  for (const v of VIBE_PRESETS) {
    box.append(el("button", {
      type: "button", class: "chip", textContent: v, "aria-pressed": "false",
      onclick: (e) => toggleVibe(e.currentTarget, v),
    }))
  }
}

function toggleVibe(chip, vibe) {
  const input = $("vibes")
  const have = input.value.split(",").map((s) => s.trim()).filter(Boolean)
  const at = have.indexOf(vibe)
  if (at === -1) have.push(vibe)
  else have.splice(at, 1)
  input.value = have.join(", ")
  chip.setAttribute("aria-pressed", at === -1 ? "true" : "false")
}

function buildSourceChips() {
  const box = $("sourceChips")
  clear(box)
  for (const id of state.sources) {
    box.append(el("button", {
      type: "button", class: "chip", textContent: id, style: srcVar(id),
      "aria-pressed": "true",
      onclick: (e) => {
        const on = e.currentTarget.getAttribute("aria-pressed") === "true"
        // Never let the last source be switched off — an empty fan-out is a
        // confusing way to say "you unchecked everything".
        if (on && state.pickedSources.size === 1) return
        if (on) state.pickedSources.delete(id)
        else state.pickedSources.add(id)
        e.currentTarget.setAttribute("aria-pressed", on ? "false" : "true")
        updateGoSub()
      },
    }))
  }
}

function updateGoSub() {
  const n = state.pickedSources.size
  $("goSub").textContent = `${n} browser${n === 1 ? "" : "s"} in parallel`
}

function wireForm() {
  $("planForm").addEventListener("submit", (e) => {
    e.preventDefault()
    if (state.running) return
    startRun()
  })
  $("explainToggle").addEventListener("change", (e) => {
    state.explain = e.currentTarget.checked
    if (state.itinerary) renderItinerary(state.itinerary)
  })
  $("modalClose").addEventListener("click", closeModal)
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal() })
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal() })
}

// ─────────────────────────────────────────────────────────────── running

function startRun() {
  const q = new URLSearchParams({
    city: $("city").value.trim(),
    vibes: $("vibes").value.trim(),
    budget: $("budget").value,
    adults: $("adults").value,
    kids: $("kids").value,
    mobility: $("mobility").value,
    concurrency: $("concurrency").value,
    retries: $("retries").value,
    sources: [...state.pickedSources].join(","),
    record: $("record").checked ? "1" : "0",
    writeup: $("writeup").checked ? "1" : "0",
  })
  const ask = $("ask").value.trim()
  if (ask) q.set("ask", ask)

  resetStage()
  state.running = true
  state.recording = $("record").checked
  state.t0 = performance.now()
  $("go").disabled = true
  $("formError").hidden = true
  setStatus("live", "geocoding")

  const stream = new EventSource(`/api/plan?${q}`)
  state.stream = stream
  stream.onmessage = (msg) => {
    let event
    try { event = JSON.parse(msg.data) } catch { return }
    handle(event)
  }
  stream.onerror = () => {
    // EventSource retries by default; the run is not resumable, so stop.
    stream.close()
    if (state.running) finishRun("err", "connection lost")
  }
  tick()
}

function resetStage() {
  $("empty").hidden = true
  for (const id of ["stepKeywords", "stepFanout", "stepPlan", "stepWriteup"]) $(id).hidden = true
  $("geo").hidden = true
  $("fanoutStats").hidden = true
  clear($("lanes")); clear($("axis")); clear($("keywords"))
  clear($("planDays")); clear($("planFoot")); clear($("writeup"))
  state.lanes.clear(); state.laneEls.clear()
  state.itinerary = null
  state.span = 20_000
}

function finishRun(kind, text) {
  state.running = false
  $("go").disabled = false
  setStatus(kind, text)
  state.stream?.close()
  drawGantt()
}

function handle(e) {
  switch (e.type) {
    case "place": onPlace(e); break
    case "keywords": onKeywords(e.keywords); break
    case "launching": onLaunching(e); break
    case "pool": onPool(e.at, e.event); break
    case "reddit": onReddit(e); break
    case "gathered": onGathered(e); break
    case "screened": onScreened(e.summary); break
    case "itinerary": state.itinerary = e.itinerary; renderItinerary(e.itinerary); break
    case "taste": renderTaste(e.weights, state.weights); state.weights = e.weights; break
    case "writeup": $("stepWriteup").hidden = false; $("writeup").textContent = e.text; break
    case "error": showError(e.message); finishRun("err", "failed"); break
    case "done": finishRun("done", "done"); refreshState(); break
    default: break
  }
}

function showError(message) {
  const box = $("formError")
  box.textContent = message
  box.hidden = false
}

async function refreshState() {
  try {
    const s = await (await fetch("/api/state")).json()
    renderStats(s.counts)
    renderRuns(s.runs)
    renderSignals(s.signals)
  } catch { /* the plan is already on screen; a stale counter is not worth an alarm */ }
}

// ────────────────────────────────────────────────────────── stage 1: place

function onPlace(e) {
  setStatus("live", "launching")
  const geo = $("geo")
  clear(geo)
  geo.hidden = false
  geo.append(
    el("span", { class: "label" }, "target"),
    el("span", {}, e.place.label),
    el("span", { class: "sep" }, "│"),
    el("span", { class: "label" }, "coords"),
    el("span", {}, `${e.place.lat.toFixed(4)}, ${e.place.lng.toFixed(4)}`),
    el("span", { class: "sep" }, "│"),
    el("span", { class: "label" }, "tz"),
    el("span", {}, e.place.timezone),
    el("span", { class: "sep" }, "│"),
    el("span", { id: "geoCount" }, "0 browsers verified in position"),
  )
  if (e.alternates?.length) {
    geo.append(el("span", { class: "sep" }, "│"),
      el("span", { style: "color:var(--dim)" }, `also matched ${e.alternates.map((a) => a.label).join(", ")}`))
  }
  if (e.askNote) {
    geo.append(el("span", { class: "sep" }, "│"), el("span", { class: "label" }, "read as"), el("span", {}, e.askNote))
  }
  $("stepFanout").hidden = false
}

// ──────────────────────────────────────────────────────── stage 1: keywords

function onKeywords(keywords) {
  const list = $("keywords")
  clear(list)
  keywords.forEach((k, i) => {
    list.append(el("li", { style: `animation-delay:${i * 28}ms` }, [
      el("span", { class: "term" }, k.term),
      el("span", { class: "because" }, k.because),
    ]))
  })
  $("stepKeywords").hidden = false
}

// ───────────────────────────────────────────────────────── stage 2: fan-out

function onLaunching(e) {
  state.recording = e.recording
  const lanes = $("lanes")
  clear(lanes)
  for (const id of e.sources) {
    state.lanes.set(id, { id, at: null, gatedAt: null, endAt: null, found: null, status: "queued", retries: 0 })
    const gate = el("div", { class: "bar-gate" })
    const work = el("div", { class: "bar-work" })
    const bar = el("div", { class: "lane-bar", style: "left:0;width:0" }, [gate, work])
    const out = el("div", { class: "lane-out" }, "queued")
    const row = el("div", { class: "lane", style: srcVar(id) }, [
      el("div", { class: "lane-name" }, [el("span", { class: "lane-dot" }), id]),
      el("div", { class: "lane-track" }, bar),
      out,
    ])
    lanes.append(row)
    state.laneEls.set(id, { row, bar, gate, work, out })
  }
  $("stepFanout").hidden = false
}

function onPool(at, ev) {
  const lane = state.lanes.get(ev.source)
  if (!lane) return
  switch (ev.type) {
    case "launch":
      lane.at = at; lane.gatedAt = null; lane.endAt = null; lane.status = "launching"
      break
    case "gated":
      lane.gatedAt = at; lane.status = "running"; lane.sessionId = ev.sessionId
      break
    case "done":
      lane.endAt = at; lane.found = ev.found; lane.status = "done"
      break
    case "retry":
      lane.retries++; lane.status = "retry"; lane.reason = ev.reason
      break
    case "fail":
      lane.endAt = at; lane.status = "failed"; lane.reason = ev.reason
      break
    default:
      return
  }
  const verified = [...state.lanes.values()].filter((l) => l.gatedAt !== null).length
  const counter = $("geoCount")
  if (counter) {
    counter.textContent = `${verified}/${state.lanes.size} browsers verified in position`
  }

  // Keep the header honest about which phase we're in. It used to say
  // "launching" for the whole fan-out, including the ninety seconds a slow
  // source can spend reading.
  const finished = [...state.lanes.values()].filter((l) => l.endAt !== null).length
  if (state.running) {
    setStatus("live", finished > 0
      ? `${finished}/${state.lanes.size} sources in`
      : verified === state.lanes.size ? "reading" : "taking position")
  }
  drawGantt()
}

function onReddit(e) {
  if (e.found === 0 && !e.configured) return
  const lanes = $("lanes")
  const note = e.found > 0
    ? `reddit — ${e.found} found via the official API (no browser)`
    : "reddit — skipped, no REDDIT_CLIENT_ID"
  lanes.append(el("div", { class: "lane", style: srcVar("reddit") }, [
    el("div", { class: "lane-name" }, [el("span", { class: "lane-dot" }), "reddit"]),
    el("div", { style: "font-size:12px;color:var(--dim)" }, note),
    el("div", {}),
  ]))
}

/** Pick a round time axis that only ever grows, so bars never jump backwards. */
function niceSpan(ms) {
  for (const s of [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300]) {
    if (ms <= s * 1000) return s * 1000
  }
  return Math.ceil(ms / 60_000) * 60_000
}

function drawGantt() {
  const now = state.running ? performance.now() - state.t0 : 0
  let maxEnd = now
  for (const l of state.lanes.values()) maxEnd = Math.max(maxEnd, l.endAt ?? 0)
  state.span = Math.max(state.span, niceSpan(maxEnd * 1.04 || 5000))

  for (const [id, lane] of state.lanes) {
    const dom = state.laneEls.get(id)
    if (!dom) continue
    const pct = (ms) => `${Math.max(0, Math.min(100, (ms / state.span) * 100))}%`

    if (lane.at === null) {
      dom.bar.style.width = "0"
      dom.out.textContent = "queued"
      continue
    }
    const end = lane.endAt ?? (state.running ? now : lane.at)
    dom.bar.style.left = pct(lane.at)
    dom.bar.style.width = pct(Math.max(0, end - lane.at))
    // The striped head of the bar is "getting into position" — launch plus the
    // geolocation gate. The solid remainder is the source actually reading.
    const gateMs = (lane.gatedAt ?? end) - lane.at
    const totalMs = Math.max(1, end - lane.at)
    dom.gate.style.width = `${Math.min(100, (gateMs / totalMs) * 100)}%`

    dom.row.classList.toggle("running", lane.status === "running" || lane.status === "launching")
    dom.row.classList.toggle("failed", lane.status === "failed")

    clear(dom.out)
    if (lane.status === "done") {
      dom.out.append(
        el("span", { class: "n" }, String(lane.found)),
        " found ",
        el("span", { class: "t" }, secs(lane.endAt)),
      )
    } else if (lane.status === "failed") {
      dom.out.append(el("span", { class: "err" }, "failed "), el("span", { class: "t" }, secs(lane.endAt)))
      dom.out.title = lane.reason ?? ""
    } else if (lane.status === "retry") {
      dom.out.append(el("span", { class: "t" }, `retry ${lane.retries}`))
      dom.out.title = lane.reason ?? ""
    } else if (lane.gatedAt !== null) {
      dom.out.append(el("span", { class: "verified" }, "✓ in position"))
    } else {
      dom.out.append(el("span", { class: "t" }, "launching…"))
    }
  }

  const axis = $("axis")
  clear(axis)
  for (let i = 0; i <= 4; i++) {
    axis.append(el("span", { style: `left:${(i / 4) * 100}%` }, `${((state.span / 4) * i / 1000).toFixed(0)}s`))
  }
}

function tick() {
  if (!state.running) return
  drawGantt()
  requestAnimationFrame(tick)
}

function onGathered(e) {
  setStatus("live", "ranking")
  const box = $("fanoutStats")
  clear(box)
  box.hidden = false

  const saved = e.sequentialMs - e.elapsedMs
  const stat = (v, k, cls, note) => el("div", { class: `stat ${cls ?? ""}` }, [
    el("div", { class: "stat-v" }, v),
    el("div", { class: "stat-k" }, k),
    note ? el("div", { class: "stat-note" }, note) : null,
  ])

  box.append(
    stat(secs(e.elapsedMs), "wall clock", "stat--hero", `${e.ok} of ${e.of} sources answered`),
    stat(secs(e.sequentialMs), "same work, one at a time", null,
      saved > 0 ? `${secs(saved)} of waiting the fan-out removes` : "no measurable saving on this run"),
    stat(String(e.total), "candidates", null, "before dedupe and ranking"),
    stat(`${e.of}×`, "browsers", null, state.recording ? "recording on — replays available" : "recording off"),
  )
}

/**
 * What the admission gate did.
 *
 * Rendered next to the fan-out numbers on purpose: "110 candidates" means
 * very little on its own, and the interesting figure is how many of them
 * turned out to be about the right city on the right days.
 */
function onScreened(s) {
  const box = $("fanoutStats")
  const d = s.byDimension
  const cell = (label, ok, bad, unknown, badWord) =>
    el("div", { class: "stat" }, [
      el("div", { class: "stat-v", style: bad > 0 ? "color:var(--red)" : "" }, `${bad}`),
      el("div", { class: "stat-k" }, `${label} — ${badWord}`),
      el("div", { class: "stat-note" }, `${ok} confirmed · ${unknown} unknown`),
    ])

  box.append(
    el("div", { class: "stat", style: "flex-basis:100%;border-color:var(--line-2)" }, [
      el("div", { class: "stat-v" }, `${s.admitted} admitted`),
      el("div", { class: "stat-k" }, `relevance gate — ${s.rejected} rejected of ${s.total}`),
      el("div", { class: "stat-note" },
        "every candidate, every source: is it near this city, on these days, and a thing you'd go and do?"),
    ]),
    cell("place", d.place.ok, d.place.fail, d.place.unknown, "elsewhere"),
    cell("time", d.time.ok, d.time.fail, d.time.unknown, "other dates"),
    cell("kind", d.kind.ok, d.kind.fail, d.kind.unknown, "filtered out"),
  )
}

// ──────────────────────────────────────────────────────── stage 3: the plan

function renderItinerary(it) {
  const host = $("planDays")
  clear(host)
  $("stepPlan").hidden = false
  setStatus(state.running ? "live" : "done", state.running ? "writing up" : "done")

  let pin = 0
  const pins = []

  it.days.forEach((day, dayIdx) => {
    const date = new Date(`${day.date}T12:00:00`)
    const name = date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
    const w = day.weather
    const wet = w ? w.precipChance >= 60 : false

    const head = el("div", { class: "day-head" }, [
      el("span", { class: "day-name" }, name),
      w ? el("span", { class: `day-wx ${wet ? "wet" : ""}` },
        `${w.highF}°/${w.lowF}°F · ${w.summary} · ${w.precipChance}% rain`) : null,
      el("span", { class: "day-cost" }, `$${Math.round(day.costUsd)}`),
    ])

    const items = el("div", { class: "items" })
    if (day.items.length === 0) {
      items.append(el("div", { class: "item-why", style: "padding:10px" },
        "Nothing left that fit the budget — try raising it or widening the vibes."))
    }
    for (const item of day.items) {
      pin++
      const c = item.candidate
      if (c.lat !== null && c.lng !== null) pins.push({ ...c, pin, day: dayIdx, slot: item.slot })
      items.append(renderItem(item, pin, dayIdx))
    }

    host.append(el("section", {}, [head, items]))
  })

  const foot = $("planFoot")
  clear(foot)
  foot.append(
    el("span", { class: "plan-total" }, `$${Math.round(it.totalUsd)}`),
    el("span", {}, `of $${it.budgetUsd} budget`),
    ...it.notes.map((n) => el("span", { class: "plan-note" }, n)),
  )

  renderMap(pins)
}

function renderItem(item, pin, dayIdx) {
  const c = item.candidate
  const meta = el("div", { class: "item-meta" }, [
    el("span", { class: `tag tag--price ${c.priceUsd === 0 ? "tag--free" : ""}` }, money(c.priceUsd)),
    el("span", { class: "tag" }, c.category),
    el("span", { class: "tag tag--src", style: srcVar(c.source) }, c.source),
    c.corroboration > 1
      ? el("button", {
          class: "tag tag--corr", type: "button",
          title: "which sources found this, and what each one said",
          onclick: () => showSightings(c),
        }, `${c.corroboration} sources agree`)
      : null,
    c.rating !== null
      ? el("span", { class: "tag" }, `${c.rating}★${c.reviewCount ? ` · ${c.reviewCount.toLocaleString()}` : ""}`)
      : null,
    item.hopMiles !== null ? el("span", { class: "tag tag--hop" }, `${item.hopMiles.toFixed(1)} mi hop`) : null,
  ])

  const body = el("div", {}, [
    el("div", { class: "item-title" }, c.url ? el("a", { href: c.url, target: "_blank", rel: "noreferrer" }, c.title) : c.title),
    meta,
    el("div", { class: "item-why" }, item.why),
    state.explain ? renderComponents(c.components) : null,
    renderActions(c),
  ])

  return el("div", { class: "item" }, [
    el("div", { class: "item-slot" }, [
      el("span", { class: `item-pin ${dayIdx === 1 ? "day2" : ""}`, style: dayIdx === 1 ? "background:var(--blue)" : "" }, String(pin)),
      item.slot,
    ]),
    body,
  ])
}

function renderComponents(components) {
  const box = el("div", { class: "components" })
  for (const comp of components) {
    box.append(el("div", {}, [
      el("span", { class: `pts ${comp.points > 0 ? "pos" : "neg"}` }, `${comp.points > 0 ? "+" : ""}${comp.points.toFixed(1)}`),
      el("span", { class: "nm" }, comp.name),
      el("span", {}, comp.why),
    ]))
  }
  return box
}

function renderActions(c) {
  const current = state.feedback.get(c.id)
  const box = el("div", { class: "item-actions" })

  const thumb = (kind, label, cls) =>
    el("button", {
      type: "button",
      class: `act ${cls} ${current === kind ? "on" : ""}`,
      textContent: label,
      onclick: () => sendFeedback(c, kind, undefined, current === kind),
    })

  box.append(
    thumb("kept", "👍 keep", "act--good"),
    thumb("skipped", "👎 not this", "act--bad"),
    thumb("did", "✓ we went", "act--good"),
  )

  const stars = el("span", { class: "stars" })
  const rated = state.ratings.get(c.id) ?? 0
  for (let n = 1; n <= 5; n++) {
    stars.append(el("button", {
      type: "button", class: `star ${n <= rated ? "lit" : ""}`, textContent: "★", title: `rate ${n}/5`,
      onclick: () => sendFeedback(c, "rated", n, false),
    }))
  }
  box.append(stars)

  if (state.recording && c.sessionId) {
    box.append(el("button", {
      type: "button", class: "act act--ghost", textContent: "▶ replay how it was found",
      onclick: () => showReplay(c.sessionId, c.title),
    }))
  }
  return box
}

async function sendFeedback(c, kind, value, undo) {
  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateId: c.id, kind, value, undo }),
    })
    const out = await res.json()
    if (!res.ok) { showError(out.error ?? "feedback failed"); return }

    if (undo) state.feedback.delete(c.id)
    else if (kind === "rated") state.ratings.set(c.id, value)
    else state.feedback.set(c.id, kind)

    renderTaste(out.weights, state.weights)
    state.weights = out.weights
    renderSignals(out.signals)
    if (state.itinerary) renderItinerary(state.itinerary)
    refreshState()
  } catch (err) {
    showError(String(err))
  }
}

// ─────────────────────────────────────────────────────────────────── taste

function renderTaste(weights, previous) {
  const host = $("taste")
  clear(host)

  const cats = Object.entries(weights)
    .filter(([k]) => k.startsWith("cat:"))
    .map(([k, v]) => [k.slice(4), v])
    .filter(([, v]) => Math.abs(v - 1) > 0.02)
    .sort((a, b) => b[1] - a[1])

  if (cats.length === 0) {
    host.append(el("div", { class: "taste-empty" },
      "Nothing learned yet. Rate anything in a plan and the weights move — then run the same city again and watch the order change."))
    return
  }

  // The learner clamps weights to [0.4, 1.8] with 1.0 neutral, so the bar is
  // drawn against that fixed scale rather than against the visible range —
  // otherwise a tiny preference would look like a strong one.
  const MIN = 0.4, MAX = 1.8, mid = (1 - MIN) / (MAX - MIN)
  for (const [name, v] of cats) {
    const at = (v - MIN) / (MAX - MIN)
    const up = v > 1
    const changed = previous && previous[`cat:${name}`] !== undefined && Math.abs(previous[`cat:${name}`] - v) > 0.001
    host.append(el("div", { class: `weight ${changed ? "changed" : ""}` }, [
      el("span", { class: "weight-name" }, name),
      el("span", { class: "weight-bar" },
        el("span", {
          class: `weight-fill ${up ? "up" : "down"}`,
          style: up
            ? `left:${mid * 100}%;width:${(at - mid) * 100}%`
            : `left:${at * 100}%;width:${(mid - at) * 100}%`,
        })),
      el("span", { class: "weight-val" }, v.toFixed(2)),
    ]))
  }

  const free = weights["w:free"]
  if (free !== undefined && Math.abs(free - 1) > 0.05) {
    host.append(el("div", { class: "taste-empty", style: "margin-top:4px" },
      free > 1 ? `Values free things (${free.toFixed(2)})` : `Doesn't mind paying (${free.toFixed(2)})`))
  }
}

function renderSignals(signals) {
  const host = $("signalLog")
  clear(host)
  for (const s of signals ?? []) {
    const good = s.kind === "did" || s.kind === "kept" || (s.kind === "rated" && s.value >= 4)
    const bad = s.kind === "skipped" || (s.kind === "rated" && s.value <= 2)
    host.append(el("li", {}, [
      el("span", { class: `kind ${good ? "good" : bad ? "bad" : ""}` }, s.kind === "rated" ? `${s.value}★` : s.kind),
      el("span", { class: "what", title: s.title }, s.title),
    ]))
  }
}

function renderRuns(runs) {
  const host = $("runs")
  clear(host)
  for (const r of runs ?? []) {
    host.append(el("li", {}, [
      el("span", { class: "when" }, r.created_at.slice(5, 10)),
      el("span", { class: "where", title: r.place_label }, r.place_label),
      el("span", { class: "ms" }, secs(r.elapsed_ms)),
    ]))
  }
}

// ────────────────────────────────────────────────────────────────────── map

/** Web Mercator, in tile units at a given zoom. */
const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

/**
 * A slippy map in about eighty lines.
 *
 * Deliberately not a mapping library: the whole job is "put six dots on a
 * street grid and join them up", and Leaflet is 140KB to do it. Tiles are
 * plain `<img>` elements, CSS-inverted to sit in a dark page, and if they
 * fail to load the dots and the routes are still readable on the panel
 * background — which is most of the information anyway.
 */
function renderMap(points) {
  const host = $("map")
  clear(host)

  const legend = $("mapLegend")
  clear(legend)

  if (points.length === 0) {
    host.append(el("div", { class: "map-empty" },
      "No coordinates on this plan. Google Maps is the only source that publishes them, so the map fills in as it contributes venues."))
    return
  }

  const W = host.clientWidth || 380
  const H = host.clientHeight || 430
  const PAD = 46

  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  const bounds = { n: Math.max(...lats), s: Math.min(...lats), e: Math.max(...lngs), w: Math.min(...lngs) }

  // Largest zoom whose bounding box still fits inside the viewport.
  let z = 16
  for (; z > 2; z--) {
    const dx = (lonToX(bounds.e, z) - lonToX(bounds.w, z)) * 256
    const dy = (latToY(bounds.s, z) - latToY(bounds.n, z)) * 256
    if (dx <= W - PAD * 2 && dy <= H - PAD * 2) break
  }

  const cx = lonToX((bounds.e + bounds.w) / 2, z)
  const cy = latToY((bounds.n + bounds.s) / 2, z)
  const px = (p) => (lonToX(p.lng, z) - cx) * 256 + W / 2
  const py = (p) => (latToY(p.lat, z) - cy) * 256 + H / 2

  // Tiles.
  const tiles = el("div", { class: "map-tiles" })
  const x0 = Math.floor(cx - W / 512), x1 = Math.floor(cx + W / 512)
  const y0 = Math.floor(cy - H / 512), y1 = Math.floor(cy + H / 512)
  const max = 2 ** z
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
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

  // Routes, one path per day.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const day of [...new Set(points.map((p) => p.day))]) {
    const dayPoints = points.filter((p) => p.day === day)
    if (dayPoints.length < 2) continue
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", dayPoints.map((p, i) => `${i ? "L" : "M"}${px(p).toFixed(1)},${py(p).toFixed(1)}`).join(" "))
    path.setAttribute("fill", "none")
    path.setAttribute("stroke", day === 1 ? "var(--blue)" : "var(--accent)")
    path.setAttribute("stroke-width", "2")
    path.setAttribute("stroke-dasharray", "5 4")
    path.setAttribute("opacity", "0.75")
    svg.append(path)
  }
  host.append(svg)

  // Pins.
  for (const p of points) {
    host.append(el("div", {
      class: `map-pin ${p.day === 1 ? "day2" : ""}`,
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

  const missing = (state.itinerary?.days.flatMap((d) => d.items).length ?? 0) - points.length
  legend.textContent = missing > 0
    ? `${points.length} of ${points.length + missing} stops have coordinates — the rest came from sources that don't publish any.`
    : `Dashed line is the route, in order. Day two is blue.`
}

// ──────────────────────────────────────────────────────────────────  modal

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

async function showSightings(c) {
  const body = el("div", {}, el("div", { class: "replay-msg" }, "Loading…"))
  openModal(c.title, body)
  try {
    const data = await (await fetch(`/api/candidate/${encodeURIComponent(c.id)}`)).json()
    clear(body)
    if (!data.sightings?.length) {
      body.append(el("div", { class: "replay-msg" }, "No stored sightings for this one."))
      return
    }
    body.append(el("p", { class: "step-why", style: "margin:0 0 12px" },
      `Corroboration is just this list: ${new Set(data.sightings.map((s) => s.source)).size} independent sources, and what each one actually said.`))
    for (const s of data.sightings) {
      body.append(el("div", { class: "sighting", style: srcVar(s.source) }, [
        el("div", { class: "sighting-head" }, [
          el("span", { class: "sighting-src" }, s.source),
          s.runs > 1 ? el("span", { class: "tag" }, `found on ${s.runs} runs`) : null,
          s.sessionId
            ? el("button", { class: "act act--ghost", type: "button", textContent: "▶ replay this session",
                onclick: () => showReplay(s.sessionId, `${c.title} — ${s.source}`) })
            : null,
        ]),
        el("div", { class: "sighting-ev" }, s.evidence),
      ]))
    }
  } catch (err) {
    clear(body)
    body.append(el("div", { class: "replay-msg" }, String(err)))
  }
}

function loadOnce(tag, attrs) {
  const key = attrs.src ?? attrs.href
  if (document.querySelector(`${tag}[data-cdn="${key}"]`)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const node = el(tag, { ...attrs, dataset: { cdn: key }, onload: resolve, onerror: reject })
    document.head.append(node)
  })
}

/**
 * Play back the actual browser session that found a venue.
 *
 * The rrweb player is loaded from a CDN on first use rather than vendored,
 * because it's only reachable from a page you already opened in a browser and
 * nothing else in the repo needs it. If the CDN is unreachable, the panel
 * falls back to what can be read straight out of the event stream — which
 * URLs the session visited, and how long it ran.
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
      const obj = JSON.parse(line)
      if (typeof obj.type === "number" && typeof obj.timestamp === "number") return obj
      // Tolerate a wrapper object without mistaking rrweb's own `data` field
      // for one: a real event always carries a numeric type and timestamp.
      for (const v of Object.values(obj)) {
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
      "The recording has too few events to play. Sessions are only recorded when a run is launched with recording on."))
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
    // Honest degradation: say what the recording contains rather than
    // pretending the feature is broken.
    const urls = [...new Set(events.map((e) => e.data?.href).filter(Boolean))]
    const ms = events[events.length - 1].timestamp - events[0].timestamp
    clear(host)
    host.append(el("div", { class: "replay-msg" }, [
      el("p", {}, "The rrweb player couldn't be loaded, so here is what the recording holds:"),
      el("p", {}, el("code", {}, `${events.length.toLocaleString()} events over ${secs(ms)}`)),
      ...urls.slice(0, 6).map((u) => el("p", {}, el("code", {}, u))),
    ]))
  }
}

boot()
