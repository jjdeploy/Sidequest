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

${NOISE}

const TAU = 6.283185307;

fn glow(d: f32, r: f32, soft: f32) -> f32 {
  return 1.0 - smoothstep(r, r + soft, d);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.time;
  // y is 0 at the top. A high horizon leaves most of the card as ground.
  let horizon = 0.30;

  // ── the sky ────────────────────────────────────────────────────────
  let skyT = clamp(uv.y / horizon, 0.0, 1.0);
  var col = mix(vec3f(0.075, 0.052, 0.055), vec3f(0.155, 0.075, 0.055), skyT);
  // The glow a town throws up onto its own sky.
  col = col + ${MANGO} * pow(clamp(1.0 - abs(uv.x - 0.5) * 1.6, 0.0, 1.0), 2.2)
            * pow(skyT, 3.0) * 0.30;

  // ── the ground ─────────────────────────────────────────────────────
  // Depth: 0 at the horizon, 1 at the viewer. Dividing the plane by it is
  // the whole perspective — no camera, no matrices, two lines.
  let depth = clamp((uv.y - horizon) / (1.0 - horizon), 0.0, 1.0);
  let z = 1.0 / (depth + 0.09);
  let plane = vec2f((uv.x - 0.5) * params.aspect * z * 2.6, z * 2.2 - t * 0.35);
  let near = smoothstep(0.0, 0.42, depth);

  var town = vec3f(0.035, 0.026, 0.024);

  // Streets. Thinner with distance, or the far side of town turns into a
  // moire; brightest in the middle distance and fading toward the viewer,
  // which is how a road actually looks and stops the near grid shouting over
  // the lights it is supposed to sit behind.
  let cell = fract(plane);
  let width = mix(0.055, 0.018, near);
  let street = max(glow(min(cell.x, 1.0 - cell.x), 0.0, width),
                   glow(min(cell.y, 1.0 - cell.y), 0.0, width));
  let road = mix(0.34, 0.13, smoothstep(0.35, 1.0, depth));
  town = town + mix(${CORAL}, ${MANGO}, 0.35) * street * road;

  // Windows. Four to a block, each on its own schedule, most of them out —
  // a town with every light on is a stadium, not a Friday.
  let block = floor(plane);
  for (var k = 0; k < 4; k = k + 1) {
    let fk = f32(k);
    let seed = hash2(block + vec2f(fk * 17.3, fk * 5.1));
    if (seed < 0.64) { continue; }
    let seed2 = fract(seed * 71.7);
    let spot = cell - vec2f(0.22 + 0.56 * seed2, 0.22 + 0.56 * fract(seed * 13.1));
    let flicker = 0.45 + 0.55 * sin(t * (0.7 + seed) + seed * 40.0);
    let win = glow(length(spot), 0.0, mix(0.075, 0.030, near));
    town = town + mix(${MANGO}, ${ROSE}, seed2) * win * (0.35 + 0.65 * flicker) * 2.1;
  }

  // Distance haze, so the grid dissolves into the horizon instead of
  // stopping at it.
  town = mix(vec3f(0.135, 0.075, 0.060), town, near);

  // Blend across the horizon rather than cutting at it. A hard line here is
  // the one thing that makes the whole picture look like two rectangles.
  col = mix(col, town, smoothstep(horizon - 0.035, horizon + 0.045, uv.y));

  // ── the browsers ───────────────────────────────────────────────────
  // Thirteen points circling the middle, arriving in turn. They sit in screen
  // space, above the city rather than in it: they are not places, they are the
  // things reading the places.
  let c = (uv - vec2f(0.5, 0.52)) * vec2f(params.aspect, 1.0);
  var ring = 0.0;
  for (var i = 0; i < 13; i = i + 1) {
    let fi = f32(i);
    let a = (fi / 13.0) * TAU + t * 0.07;
    let pos = vec2f(cos(a), sin(a) * 0.42) * 0.33;
    let on = clamp(params.lit * 13.0 - fi, 0.0, 1.0);
    let pulse = 0.75 + 0.25 * sin(t * 1.6 - fi * 0.9);
    let dl = length(c - pos);
    // Three terms: a hard centre, a tight halo, a wide bloom. Without the
    // first they are fog; without the last they are stickers.
    ring = ring + glow(dl, 0.0055, 0.006) * on * 1.15;
    ring = ring + glow(dl, 0.004, 0.026) * on * pulse * 0.75;
    ring = ring + glow(dl, 0.0, 0.10) * on * pulse * 0.18;
  }
  col = col + mix(${MANGO}, ${CORAL}, 0.35) * ring;

  // Vignette, with a warm lift where the ring sits.
  let vig = 1.0 - smoothstep(0.30, 0.95, length(uv - vec2f(0.5)));
  col = col * (0.55 + 0.45 * vig);

  return vec4f(col, 1.0);
}
`

/** A handle that does nothing, for every path where the GPU is unavailable. */
const NOOP = { ok: false, set() {}, stop() {} }

let vgpu = null
/**
 * Load vgpu once, and only when something actually asks to draw.
 *
 * A dynamic import so a browser without WebGPU never fetches 47 modules it
 * cannot use, and so a failure here is a caught rejection rather than a script
 * error that takes the rest of app.js down with it.
 */
async function load() {
  if (!navigator.gpu) return null
  if (!vgpu) {
    try {
      vgpu = await import("/vendor/vgpu/index.js")
    } catch (err) {
      console.warn("[sidequest] vgpu did not load; keeping the CSS background", err)
      return null
    }
  }
  return vgpu
}

/**
 * Mount a shader on a canvas.
 *
 * Returns `{ ok, set, stop }` in every case, so callers never branch on
 * whether the GPU was there.
 */
async function mount(canvas, source, initial) {
  const lib = await load()
  if (!lib || !canvas) return NOOP

  try {
    const gpu = await lib.init()
    // dpr is capped at 2: this is a full-bleed background, and a 3x retina
    // canvas costs three times the fragments to draw the same picture.
    const view = lib.surface(gpu, canvas, { dpr: [1, 2] })
    const uniforms = { ...initial, aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight) }
    const shader = lib.effect(gpu, source, { set: { params: uniforms } })

    view.onResize(() => {
      uniforms.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight)
      shader.set({ params: { aspect: uniforms.aspect } })
    })

    const time = lib.clock(gpu)
    let live = true
    lib.frameLoop(gpu, (frame) => {
      if (!live) return false
      shader.set({ params: { time: time.time } })
      frame.pass(view, shader)
    })

    return {
      ok: true,
      set(next) {
        if (!live) return
        Object.assign(uniforms, next)
        shader.set({ params: next })
      },
      stop() {
        live = false
        try { gpu.dispose() } catch { /* already gone */ }
      },
    }
  } catch (err) {
    console.warn("[sidequest] WebGPU init failed; keeping the CSS background", err)
    return NOOP
  }
}

export function mountHero(canvas) {
  return mount(canvas, HERO_WGSL, { time: 0, fade: 1 })
}

export function mountArt(canvas) {
  return mount(canvas, ART_WGSL, { time: 0, lit: 0 })
}

export function mountWait(canvas) {
  return mount(canvas, WAIT_WGSL, { time: 0, lit: 0, sending: 0, count: 13, energy: 0 })
}
