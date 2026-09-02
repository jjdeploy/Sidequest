/**
 * Sidequest — the two things drawn on the GPU.
 *
 * A landing background and a waiting screen, both WebGPU via vgpu, served out
 * of node_modules by src/web/server.ts so the page keeps its no-build-step
 * promise.
 *
 * ── Why any of this is on the GPU ─────────────────────────────────────────
 *
 * The waiting screen is the one that earns it. A run takes twenty seconds of
 * real browsers doing real work in another city, and for most of that there is
 * nothing to show but counters. Thirteen lights coming on one at a time —
 * each one a browser that has just proved where it is standing — is the same
 * information, and it is the actual mechanism rather than a decoration of it.
 *
 * ── Everything here is optional ───────────────────────────────────────────
 *
 * `navigator.gpu` is absent in Safari and in Firefox's default build, `init()`
 * can reject on a machine with no adapter, and a lost device fires at any
 * time. Every entry point below returns a no-op handle when that happens and
 * the page keeps the CSS it already had. Nothing about the plan depends on a
 * pixel of this.
 */

/** Brand palette, linear-ish. Kept here so the shaders and app.css agree. */
const CORAL = "vec3f(0.957, 0.333, 0.173)"
const MANGO = "vec3f(1.000, 0.624, 0.110)"
const ROSE = "vec3f(1.000, 0.435, 0.569)"
const CREAM = "vec3f(1.000, 0.980, 0.957)"
const SEA = "vec3f(0.051, 0.580, 0.533)"

/**
 * Value noise and fBm.
 *
 * Written out rather than imported from @vgpu/wgsl-std so the shader stays one
 * self-contained string: the moment a shader has an `import`, a plain
 * `effect(gpu, source)` is no longer enough and the whole file needs the
 * resolver and a build step to go with it.
 */
const NOISE = `
fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  // Smoothstep the cell interpolation, or the lattice shows as a grid.
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i + vec2f(0.0, 0.0)), hash2(i + vec2f(1.0, 0.0)), u.x),
    mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x),
    u.y,
  );
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var sum = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 5; i = i + 1) {
    sum = sum + amp * vnoise(p);
    p = p * 2.02;
    amp = amp * 0.5;
  }
  return sum;
}
`

/**
 * The landing background.
 *
 * Domain-warped fBm in the brand colours over cream. The warp is what stops it
 * reading as a gradient with noise on top — the field is sampled at a position
 * that is itself displaced by another sample, so the bands fold into each
 * other and drift instead of sliding.
 *
 * Deliberately slow. It sits underneath a search box somebody is trying to
 * type in, and anything faster than this competes with them.
 */
export const HERO_WGSL = `
struct Params {
  time: f32,
  aspect: f32,
  fade: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

${NOISE}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var p = vec2f(uv.x * params.aspect, uv.y) * 1.6;
  let t = params.time * 0.045;

  // Two levels of warp. One is a wobble; two is weather.
  let q = vec2f(fbm(p + vec2f(0.0, t)), fbm(p + vec2f(4.7, 2.3 - t)));
  let r = vec2f(
    fbm(p + 2.4 * q + vec2f(1.7, 9.2) + 0.15 * t),
    fbm(p + 2.4 * q + vec2f(8.3, 2.8) - 0.12 * t),
  );
  let f = fbm(p + 2.6 * r);

  // Cream is the floor, not a colour in the mix: the page behind this is
  // cream, so the shader has to land exactly on it where the light runs out
  // or the canvas edge becomes visible.
  // Very restrained. A first pass at these numbers produced a gorgeous
  // marbled coral field that a headline and a search box could not survive
  // sitting on: high thresholds and low mixes leave most of the frame cream,
  // so the colour only shows where the field peaks.
  var col = ${CREAM};
  col = mix(col, ${MANGO}, smoothstep(0.62, 1.05, f) * 0.20);
  col = mix(col, ${CORAL}, smoothstep(0.74, 1.20, f + 0.30 * r.x) * 0.16);
  col = mix(col, ${ROSE}, smoothstep(0.80, 1.25, f + 0.26 * q.y) * 0.10);

  // A cool counterweight in the low corner, so the whole field is not one
  // temperature.
  col = mix(col, ${SEA}, smoothstep(0.24, 0.02, f) * 0.035);

  // Vignette to cream at the top, where the header sits over it.
  let top = smoothstep(0.0, 0.45, uv.y);
  col = mix(${CREAM}, col, top * params.fade);

  return vec4f(col, 1.0);
}
`

/**
 * The waiting screen.
 *
 * Thirteen points on a circle, one per browser. A point is dark until its lane
 * confirms its coordinates, then it ignites and sends a pulse inward; the core
 * brightens as candidates arrive. `lit`, `sending` and `energy` are counts, not
 * per-lane state, which keeps the uniform to five floats and loses nothing —
 * at this size nobody is tracking which light is Eventbrite.
 */
export const WAIT_WGSL = `
struct Params {
  time: f32,
  aspect: f32,
  lit: f32,      // lanes standing in the right city, 0..count
  sending: f32,  // lanes that have reported back
  count: f32,
  energy: f32,   // 0..1, how much of the catalogue has arrived
}
@group(0) @binding(0) var<uniform> params: Params;

${NOISE}

const TAU = 6.283185307;

fn glow(d: f32, r: f32, softness: f32) -> f32 {
  return 1.0 - smoothstep(r, r + softness, d);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Centred and aspect-corrected, so the ring is a circle at any window size.
  let p = (uv - vec2f(0.5)) * vec2f(params.aspect, 1.0) * 2.0;
  let d = length(p);
  let t = params.time;

  var col = ${CREAM};

  // A very slow warm haze, so the field is never flat white.
  let haze = fbm(p * 0.9 + vec2f(0.0, t * 0.03));
  col = mix(col, ${MANGO}, smoothstep(0.40, 1.05, haze) * 0.07);

  let n = max(params.count, 1.0);
  // Wide enough to frame the progress ring rather than collide with it: the
  // count and the ring are the thing being read, and this is behind them.
  let radius = 0.82;

  var light = 0.0;

  for (var i = 0; i < 16; i = i + 1) {
    let fi = f32(i);
    if (fi >= n) { break; }

    let a = (fi / n) * TAU - 1.5707963;
    let dir = vec2f(cos(a), sin(a));
    let pos = dir * radius;

    // Each light comes on when the count passes it, smoothly, so lanes
    // landing together still read as separate arrivals.
    let on = clamp(params.lit - fi, 0.0, 1.0);
    let reported = clamp(params.sending - fi, 0.0, 1.0);
    let breathe = 0.82 + 0.18 * sin(t * 1.5 + fi * 1.9);

    let dl = length(p - pos);
    // Hard centre, tight halo, wide bloom — a light rather than a smudge.
    light = light + glow(dl, 0.012, 0.010) * on * 0.85;
    light = light + glow(dl, 0.010, 0.055) * on * breathe * 0.45;
    light = light + glow(dl, 0.0, 0.20) * on * breathe * 0.10;

    // What a lane sends back, once it has something: a mote that leaves the
    // light and runs inward, fading out well before the middle so it never
    // arrives on top of the number being read there.
    if (reported > 0.01) {
      let trip = fract(t * 0.42 + fi * 0.31);
      let mote = pos * (1.0 - trip * 0.72);
      let fade = smoothstep(0.0, 0.12, trip) * (1.0 - smoothstep(0.55, 1.0, trip));
      light = light + glow(length(p - mote), 0.006, 0.028) * reported * fade * 0.55;
    }
  }

  // The ring the lights sit on, so the shape is legible before any are lit.
  light = light + glow(abs(d - radius), 0.0, 0.004) * 0.09;

  // A wide, soft lift under the middle that grows with what has been found.
  // Not a disc: the count sits here, and anything with an edge competes with
  // it. This is only ever a warming of the paper.
  col = mix(col, ${MANGO}, (1.0 - smoothstep(0.0, 0.95, d)) * params.energy * 0.16);

  col = mix(col, ${MANGO}, clamp(light, 0.0, 1.0) * 0.60);
  col = mix(col, ${CORAL}, clamp(light - 0.45, 0.0, 1.0) * 0.85);

  return vec4f(col, 1.0);
}
`

/**
 * The hero graphic: a town at night, seen from above.
 *
 * The one picture that says what this is. A dark card on a cream page —
 * deliberately the only dark surface in the product, because the thing being
 * sold is a Friday evening. Streets recede toward a horizon, lights come on
 * across the grid, and thirteen brighter points circle the middle: the
 * browsers, standing in the city, arriving one after another.
 *
 * The perspective is a cheap trick and the right one — dividing the plane by
 * depth before sampling the grid gives a receding surface in two lines, where
 * a real camera would need matrices, a vertex stage, and geometry to push
 * through it.
 */
export const ART_WGSL = `
struct Params {
  time: f32,
  aspect: f32,
  lit: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

const SPACING = 7.0;
const TAU = 6.283185307;

fn h21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

/** How tall the block on this plot is. Zero means an empty one. */
fn towerHeight(cell: vec2f) -> f32 {
  let r = h21(cell);
  // A quarter of the grid left empty: a city with something on every plot
  // reads as a wall, and the gaps are what make the streets legible.
  if (r < 0.26) { return 0.0; }
  // Squared, so most of town is low and a few towers stand out of it.
  let k = (r - 0.26) / 0.74;
  return 2.0 + k * k * 22.0;
}

/**
 * The city, as a distance field.
 *
 * One box per grid cell, plus the ground plane. Only the cell the sample is
 * standing in is evaluated, not its neighbours — nine lookups a step is the
 * correct version and three times the cost, and the shortened steps in the
 * march below hide the overshoot that buys.
 */
fn map(p: vec3f) -> f32 {
  let cell = floor(p.xz / SPACING);
  let h = towerHeight(cell);
  if (h <= 0.0) { return p.y; }
  let c = (cell + vec2f(0.5)) * SPACING;
  let w = SPACING * 0.5 * (0.40 + 0.26 * h21(cell + vec2f(7.7, 3.1)));
  let local = vec3f(p.x - c.x, p.y - h * 0.5, p.z - c.y);
  return min(p.y, sdBox(local, vec3f(w, h * 0.5, w)));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.time;
  // -1..1 with y up.
  let screen = vec2f((uv.x - 0.5) * 2.0 * params.aspect, (0.5 - uv.y) * 2.0);

  // A slow drift down one avenue, drifting sideways, looking a little down.
  let ro = vec3f(sin(t * 0.05) * 6.0, 54.0 + sin(t * 0.08) * 2.5, -t * 3.6);
  // Not named "target": that is a reserved word in WGSL.
  let look = ro + vec3f(sin(t * 0.04) * 0.10, -0.82, 0.86);
  let fwd = normalize(look - ro);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), fwd));
  let up = cross(fwd, right);
  let rd = normalize(fwd * 1.35 + right * screen.x + up * screen.y);

  // Sky: warm at the horizon, deep above. A town under cloud at nine.
  let up01 = clamp(rd.y * 2.2 + 0.15, 0.0, 1.0);
  var col = mix(vec3f(0.34, 0.14, 0.09), vec3f(0.026, 0.024, 0.058), pow(up01, 0.55));
  col = col + ${MANGO} * pow(clamp(1.0 - abs(rd.y) * 3.4, 0.0, 1.0), 3.0) * 0.22;

  var dist = 0.0;
  var hit = false;
  for (var i = 0; i < 92; i = i + 1) {
    let pos = ro + rd * dist;
    let d = map(pos);
    // Tolerance grows with distance, so the far city costs no more steps
    // than the near one.
    if (d < 0.0025 * dist + 0.01) { hit = true; break; }
    dist = dist + max(d * 0.72, 0.03);
    if (dist > 190.0) { break; }
  }

  if (hit) {
    let pos = ro + rd * dist;
    let cell = floor(pos.xz / SPACING);
    let h = towerHeight(cell);

    if (pos.y < 0.35 || h <= 0.0) {
      // Ground. Wet asphalt, with the street grid picked out on it.
      var g = vec3f(0.020, 0.017, 0.028);
      let lane = fract(pos.xz / SPACING);
      let edge = max(1.0 - smoothstep(0.0, 0.05, min(lane.x, 1.0 - lane.x)),
                     1.0 - smoothstep(0.0, 0.05, min(lane.y, 1.0 - lane.y)));
      g = g + mix(${CORAL}, ${MANGO}, 0.4) * edge * 0.16;
      // Traffic: one bright mote running each avenue.
      let run = fract(pos.z * 0.035 - t * 0.30 + h21(vec2f(cell.x, 0.0)) * 5.0);
      let inLane = 1.0 - smoothstep(0.0, 0.09, abs(lane.x - 0.5));
      g = g + ${MANGO} * inLane * (1.0 - smoothstep(0.0, 0.05, run)) * 1.6;
      col = g;
    } else {
      // A facade: dark concrete and a grid of windows, most of them out.
      var f = vec3f(0.020, 0.017, 0.030);
      let c = (cell + vec2f(0.5)) * SPACING;
      let dx = abs(pos.x - c.x);
      let dz = abs(pos.z - c.y);
      // Which face was hit decides which axis the window grid runs along.
      let acrossFace = select(pos.x, pos.z, dx > dz);
      // A roof: flat, dark, with a light on the parapet. Without this the
      // window grid is painted across the tops as well, which is the tell
      // that a shader is sampling a position rather than a surface.
      let onRoof = 1.0 - smoothstep(0.10, 0.55, abs(pos.y - h));

      let win = vec2f(fract(acrossFace * 1.9), fract(pos.y * 1.25));
      let id = vec2f(floor(acrossFace * 1.9), floor(pos.y * 1.25));
      let seed = h21(id + cell * 31.7);
      // Panes, with a mullion between them.
      let pane = (1.0 - smoothstep(0.30, 0.44, abs(win.x - 0.5)))
               * (1.0 - smoothstep(0.26, 0.40, abs(win.y - 0.5)));
      // Half of them dark, the rest on their own slow schedule.
      let on = step(0.70, seed) * (0.55 + 0.45 * sin(t * 0.6 + seed * 40.0));
      f = f + mix(${MANGO}, ${CORAL}, seed * 0.8) * pane * on * (1.0 - onRoof) * 0.62;
      // The parapet edge, so a roof still reads as a solid top.
      f = f + ${CORAL} * onRoof * 0.045;
      // A rim where the facade turns away, so the towers have edges.
      let face = normalize(vec3f(pos.x - c.x, 0.0, pos.z - c.y));
      f = f + ${CORAL} * pow(1.0 - abs(dot(rd, face)), 6.0) * 0.10;
      col = f;
    }

    // Fog, so the far city dissolves into the horizon instead of ending.
    let fog = 1.0 - exp(-max(dist - 24.0, 0.0) * 0.0125);
    col = mix(col, vec3f(0.105, 0.055, 0.062), fog);
  }

  // The browsers: thirteen lights over the city, in screen space. They are
  // not places, they are the things reading the places, so they sit above
  // the picture rather than in it.
  let c2 = vec2f((uv.x - 0.5) * params.aspect, uv.y - 0.42);
  var ring = 0.0;
  for (var i = 0; i < 13; i = i + 1) {
    let fi = f32(i);
    let a = (fi / 13.0) * TAU + t * 0.05;
    let rp = vec2f(cos(a), sin(a) * 0.30) * 0.30;
    let on = clamp(params.lit * 13.0 - fi, 0.0, 1.0);
    let pulse = 0.78 + 0.22 * sin(t * 1.6 - fi * 0.9);
    let dl = length(c2 - rp);
    ring = ring + (1.0 - smoothstep(0.004, 0.010, dl)) * on * 1.2;
    ring = ring + (1.0 - smoothstep(0.004, 0.030, dl)) * on * pulse * 0.55;
    ring = ring + (1.0 - smoothstep(0.0, 0.11, dl)) * on * pulse * 0.13;
  }
  col = col + mix(${MANGO}, ${CORAL}, 0.3) * ring;

  // Vignette, then a curve so the highlights roll off instead of clipping to
  // white where the windows and the lights overlap.
  col = col * (0.62 + 0.38 * (1.0 - smoothstep(0.35, 1.05, length(uv - vec2f(0.5)))));
  col = col / (col + vec3f(0.62));
  col = pow(col, vec3f(0.92));

  return vec4f(col, 1.0);
}
`

/** A handle that does nothing, for every path where the GPU is unavailable. */
const NOOP = { ok: false, set() {}, stop() {} }

let vgpu = null
let device = null
let clock = null
/** Every live canvas. One loop draws all of them. */
const mounted = new Set()

/**
 * The one GPU context, and the one frame loop over it.
 *
 * Three canvases, one device. The first version called init() per canvas,
 * which is against the grain of the library — "a program has one Gpu
 * context" — and gave the hero graphic a device whose frames nothing ever
 * submitted, so it rendered as a black rectangle: the canvas element sized
 * correctly, with no colour attachment ever presented to it.
 *
 * One clock, too, so the background and the graphic never drift apart.
 */
async function context() {
  if (!navigator.gpu) return null
  if (device) return device
  try {
    vgpu = vgpu ?? (await import("vgpu"))
    device = await vgpu.init()
    clock = vgpu.clock(device)
  } catch (err) {
    console.warn("[sidequest] no WebGPU; keeping the CSS background", err)
    device = null
  }
  return device
}

/**
 * Start drawing, once there is something to draw.
 *
 * Deliberately not started alongside the device: a frame that submits no
 * passes is a frame doing nothing at best, and the loop would be running
 * before the first canvas had registered.
 */
let looping = false
function startLoop() {
  if (looping) return
  looping = true
  vgpu.frameLoop(device, (frame) => {
    for (const m of mounted) {
      m.shader.set({ params: { time: clock.time } })
      frame.pass(m.view, m.shader)
    }
  })
}

/**
 * Wait until the canvas has been laid out.
 *
 * Mounting runs at boot, which can be before the first layout — and a
 * surface built against a zero-width canvas draws nothing forever, because
 * `onResize` never fires for an element that was already its final size by
 * the time anyone looked. Two frames is enough in practice; the cap is there
 * so a canvas that is display:none (the hero graphic, on a narrow window)
 * gives up instead of spinning for the life of the page.
 */
async function sized(canvas, tries = 90) {
  for (let i = 0; i < tries; i++) {
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) return true
    await new Promise((r) => requestAnimationFrame(r))
  }
  return false
}

/**
 * Mount a shader on a canvas.
 *
 * Returns `{ ok, set, stop }` in every case, so callers never branch on
 * whether the GPU was there. On success the canvas gets `.is-live`, which is
 * what the stylesheet keys its own background off — a canvas that never draws
 * must not be left showing a dark rectangle where a picture was promised.
 */
async function mount(canvas, source, initial) {
  if (!canvas) return NOOP
  const gpu = await context()
  if (!gpu) return NOOP
  if (!(await sized(canvas))) return NOOP

  try {
    // dpr capped at 2: these are backgrounds, and a 3x retina canvas costs
    // three times the fragments to draw the same picture.
    const view = vgpu.surface(gpu, canvas, { dpr: [1, 2] })
    const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight)
    const uniforms = { ...initial, aspect: aspect() }
    const shader = vgpu.effect(gpu, source, { set: { params: uniforms } })

    view.onResize(() => shader.set({ params: { aspect: aspect() } }))

    const entry = { view, shader }
    mounted.add(entry)
    startLoop()
    canvas.classList.add("is-live")

    return {
      ok: true,
      set(next) {
        if (!mounted.has(entry)) return
        Object.assign(uniforms, next)
        shader.set({ params: next })
      },
      stop() {
        mounted.delete(entry)
        canvas.classList.remove("is-live")
      },
    }
  } catch (err) {
    console.warn("[sidequest] could not draw on", canvas.id, err)
    return NOOP
  }
}

/**
 * What actually happened, for a console.
 *
 * Nothing in the app reads this. It exists because the failure mode of all
 * of the above is "a rectangle where a picture should be", which tells you
 * nothing about which of five things went wrong — whether WebGPU exists,
 * whether the device was acquired, whether the canvas had been laid out,
 * and which canvases are being drawn into right now.
 */
export function gpuReport() {
  return {
    webgpu: Boolean(navigator.gpu),
    moduleLoaded: Boolean(vgpu),
    device: Boolean(device),
    looping,
    drawing: mounted.size,
    canvases: ["heroGpu", "heroArt", "waitGpu"].map((id) => {
      const c = document.getElementById(id)
      return c
        ? `${id}: ${c.clientWidth}x${c.clientHeight}${c.classList.contains("is-live") ? " live" : " NOT live"}`
        : `${id}: missing`
    }),
  }
}

// One line to paste into a console when something looks wrong.
if (typeof window !== "undefined") window.sidequestGpu = gpuReport

export function mountHero(canvas) {
  return mount(canvas, HERO_WGSL, { time: 0, fade: 1 })
}

export function mountArt(canvas) {
  return mount(canvas, ART_WGSL, { time: 0, lit: 0 })
}

export function mountWait(canvas) {
  return mount(canvas, WAIT_WGSL, { time: 0, lit: 0, sending: 0, count: 13, energy: 0 })
}
