/**
 * The two shaders, rendered.
 *
 * I cannot see the dashboard from here, and "the WGSL looked right" is not
 * evidence — a shader that fails to compile, or compiles and paints black,
 * fails in the browser as a blank rectangle where a background should be. So
 * these render both shaders headless on the same WebGPU that Chrome uses and
 * assert on the bytes that come back.
 *
 * The shader source is imported from the page's own module rather than copied,
 * so a change to what ships is a change to what is tested.
 *
 * Skipped, not failed, when no adapter is available: CI without a GPU should
 * not turn red over a decoration, and `npx vgpu doctor` is the tool that
 * answers "why is there no adapter here".
 */
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { HERO_WGSL, WAIT_WGSL } from "../src/web/public/gpu.js"

const W = 96
const H = 96

type Px = { r: number; g: number; b: number }

/** vgpu/node, or null when this machine cannot render. */
let lib: typeof import("vgpu/node") | null = null
let gpu: Awaited<ReturnType<typeof import("vgpu/node").init>> | null = null

before(async () => {
  try {
    lib = await import("vgpu/node")
    gpu = await lib.init()
  } catch {
    lib = null
    gpu = null
  }
})

after(() => {
  // Dawn keeps polling until it is told not to, and the test process will not
  // exit while it does.
  try { gpu?.dispose() } catch { /* never initialised */ }
})

/** Render one frame and hand back the pixels. */
async function render(source: string, params: Record<string, number>): Promise<Uint8Array | null> {
  if (!lib || !gpu) return null
  const colour = lib.target(gpu, { size: [W, H] })
  lib.effect(gpu, source, { set: { params: { aspect: 1, time: 0.7, ...params } } }).draw(colour)
  return new Uint8Array(await colour.read())
}

const at = (px: Uint8Array, x: number, y: number): Px => {
  const i = (y * W + x) * 4
  return { r: px[i]!, g: px[i + 1]!, b: px[i + 2]! }
}

/** Mean luminance, 0..255. The single number that says "is anything lit". */
const luma = (px: Uint8Array): number => {
  let sum = 0
  for (let i = 0; i < px.length; i += 4) {
    sum += 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!
  }
  return sum / (px.length / 4)
}

/** How much colour there is, as mean |r-b|. Cream is neutral; coral is not. */
const warmth = (px: Uint8Array): number => {
  let sum = 0
  for (let i = 0; i < px.length; i += 4) sum += px[i]! - px[i + 2]!
  return sum / (px.length / 4)
}

describe("the landing background", () => {
  test("compiles and paints something that is not black", async (t) => {
    const px = await render(HERO_WGSL, { fade: 1 })
    if (!px) return t.skip("no WebGPU adapter on this machine")
    // A shader that fails at runtime leaves the target cleared. Cream is 250+
    // across the board, so anything dark means nothing drew.
    assert.ok(luma(px) > 200, `mean luminance ${luma(px).toFixed(1)} — this is not a cream page`)
  })

  test("is warm, and never leaves the palette", async (t) => {
    const px = await render(HERO_WGSL, { fade: 1 })
    if (!px) return t.skip("no WebGPU adapter on this machine")
    assert.ok(warmth(px) > 2, `warmth ${warmth(px).toFixed(1)} — the brand colours are not reaching it`)
    // Red is the dominant channel everywhere in this palette. A pixel where
    // blue leads means the mix has gone somewhere the design never asked for.
    for (const [x, y] of [[8, 8], [48, 48], [88, 88], [8, 88], [88, 8]] as const) {
      const p = at(px, x, y)
      assert.ok(p.r >= p.b, `(${x},${y}) is bluer than it is red: ${JSON.stringify(p)}`)
    }
  })

  test("fades to the page colour at the top, where the header sits", async (t) => {
    const px = await render(HERO_WGSL, { fade: 1 })
    if (!px) return t.skip("no WebGPU adapter on this machine")
    // uv.y is 0 at the top of the frame, and the shader mixes to cream there.
    const top = at(px, W / 2, 1)
    assert.ok(top.r > 248 && top.g > 240 && top.b > 235, `top row is ${JSON.stringify(top)}, not cream`)
  })
})

describe("the waiting screen", () => {
  test("compiles, and is nearly bare before any browser reports in", async (t) => {
    const px = await render(WAIT_WGSL, { lit: 0, sending: 0, count: 13, energy: 0 })
    if (!px) return t.skip("no WebGPU adapter on this machine")
    assert.ok(luma(px) > 200, "the waiting screen is not a dark screen")
  })

  test("lighting the lanes actually changes the picture", async (t) => {
    const dark = await render(WAIT_WGSL, { lit: 0, sending: 0, count: 13, energy: 0 })
    const lit = await render(WAIT_WGSL, { lit: 13, sending: 13, count: 13, energy: 1 })
    if (!dark || !lit) return t.skip("no WebGPU adapter on this machine")

    // Thirteen lights and a full core are more colour than an empty ring. The
    // page is cream either way, so luminance barely moves — warmth is the
    // measure that catches it.
    assert.ok(
      warmth(lit) > warmth(dark) + 3,
      `warmth only went ${warmth(dark).toFixed(1)} -> ${warmth(lit).toFixed(1)}; the lanes are not lighting`,
    )
  })

  test("the core brightens with what has been found", async (t) => {
    const empty = await render(WAIT_WGSL, { lit: 13, sending: 13, count: 13, energy: 0 })
    const full = await render(WAIT_WGSL, { lit: 13, sending: 13, count: 13, energy: 1 })
    if (!empty || !full) return t.skip("no WebGPU adapter on this machine")

    // Sampled at the centre, which is exactly where the core is drawn.
    const a = at(empty, W / 2, H / 2)
    const b = at(full, W / 2, H / 2)
    assert.ok(
      a.r - a.b < b.r - b.b,
      `centre did not warm with energy: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
    )
  })
})

describe("one device, two shaders", () => {
  test("both live on a single context", async (t) => {
    // The page draws two canvases. An early version gave each its own
    // init(), which is against the grain of a library whose first line is
    // "everything starts from one call", and a later one cached the device
    // rather than the promise and still made two. One device, two effects,
    // both drawable.
    if (!lib || !gpu) return t.skip("no WebGPU adapter on this machine")

    const shaders = [HERO_WGSL, WAIT_WGSL].map((src) =>
      lib!.effect(gpu!, src, {
        set: { params: { time: 1, aspect: 1, fade: 1, lit: 1, sending: 4, count: 13, energy: 0.5 } },
      }))

    for (const shader of shaders) {
      const t2 = lib!.target(gpu!, { size: [32, 32] })
      shader.draw(t2)
      const px = new Uint8Array(await t2.read())
      // Anything at all, rather than an untouched target.
      assert.ok(px.some((b, i) => i % 4 !== 3 && b !== 0), "a shader drew nothing")
    }
  })
})
