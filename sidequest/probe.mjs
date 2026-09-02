/**
 * Look at the page with a real browser.
 *
 * Everything else in this repo can be checked headless on the CPU or by
 * rendering pixels through Dawn. The one thing that cannot is the browser
 * path — the canvas, the swapchain, the module graph as Chrome resolves it —
 * and that is exactly where the hero graphic has been failing.
 */
import { chromium } from "playwright"
import { writeFileSync } from "node:fs"

const browser = await chromium.launch({
  // Headed: headless Chromium here cannot open dxil.dll and falls back to no
  // device at all, which tells us nothing about the machine the page runs on.
  headless: false,
  args: [
    // Headless Chromium will not expose WebGPU without being told to, and
    // will fall back to a software adapter rather than failing outright.
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan,UseSkiaRenderer",
    "--use-angle=default",
    "--ignore-gpu-blocklist",
  ],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const logs = []
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`))
page.on("requestfailed", (r) => logs.push(`REQFAIL: ${r.url()} ${r.failure()?.errorText}`))

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" })
// Long enough for the device request, the module graph, and a few frames.
await page.waitForTimeout(4000)

const report = await page.evaluate(() => {
  const r = typeof window.sidequestGpu === "function" ? window.sidequestGpu() : "sidequestGpu missing"
  return { report: r, adapter: Boolean(navigator.gpu) }
})

console.log("── navigator.gpu:", report.adapter)
console.log("── sidequestGpu():", JSON.stringify(report.report, null, 2))
console.log("── console ─────────────────────────────")
console.log(logs.length ? logs.slice(0, 25).join("\n") : "(silent)")

// The hero card, cropped to itself, and the whole page for context.
const art = await page.$("#heroArt")
const box = art ? await art.boundingBox() : null
console.log("── #heroArt box:", JSON.stringify(box))
if (box) writeFileSync("docs/probe-heroart.png", await page.screenshot({ clip: box }))
writeFileSync("docs/probe-page.png", await page.screenshot())
console.log("── wrote docs/probe-heroart.png and docs/probe-page.png")

await browser.close()
