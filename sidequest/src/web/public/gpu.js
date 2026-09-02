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

/** A handle that does nothing, for every path where the GPU is unavailable. */
const NOOP = { ok: false, set() {}, stop() {} }

let vgpu = null
let device = null
let clock = null
let booting = null
/** Every live canvas. One loop draws all of them. */
const mounted = new Set()

/**
 * The one GPU context, and the one frame loop over it.
 *
 * Three canvases, one device. The first version called init() per canvas,
 * which is against the grain of a library whose first line is that a program
 * has one context.
 *
 * The second version cached the device in a variable and still made two,
 * because two canvases mount concurrently and both got past `if (device)`
 * before either had finished awaiting. Chrome was explicit about the result:
 *
 *   TextureView ... is associated with [Device], and cannot be used with
 *   [Device]. While validating colorAttachments[0].
 *
 * A surface built on the first device, a frame encoded on the second, every
 * command buffer rejected, nothing ever presented — and a canvas showing its
 * own CSS background, which is to say a black box.
 *
 * So what is cached is the PROMISE, not what it resolves to. Everyone who
 * asks during the boot gets the same one, and there is exactly one device no
 * matter how many canvases ask for it at once.
 */
function context() {
  if (!navigator.gpu) return Promise.resolve(null)
  booting ??= (async () => {
    try {
      vgpu = await import("vgpu")
      device = await vgpu.init()
      clock = vgpu.clock(device)
      return device
    } catch (err) {
      console.warn("[sidequest] no WebGPU; keeping the CSS background", err)
      device = null
      return null
    }
  })()
  return booting
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
    canvases: ["heroGpu", "waitGpu"].map((id) => {
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

export function mountWait(canvas) {
  return mount(canvas, WAIT_WGSL, { time: 0, lit: 0, sending: 0, count: 13, energy: 0 })
}
