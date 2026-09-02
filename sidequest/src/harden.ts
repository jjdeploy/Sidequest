/**
 * Cross-city reliability check.
 *
 *   npm run harden
 *   npm run harden -- "Boise, ID" "Reykjavik, IS"
 *
 * Every source in this repo was written against Tampa, and a scraper that
 * works in exactly one city is a demo, not a feature. This runs the real
 * fan-out across several places and prints a source x city yield matrix, so
 * the ones that quietly return nothing outside their home town are visible
 * before someone else finds them.
 *
 * It deliberately does NOT assert or exit non-zero on a thin source: several
 * are legitimately empty in small towns (Time Out has no Boise edition). The
 * output is for reading, and the distinction that matters is "empty because
 * there is nothing there" versus "empty because the selector broke".
 */
import { BrowserPool } from "./solari/pool.js"
import { buildKeywords } from "./engine/keywords.js"
import { geocode } from "./place.js"
import { ALL_SOURCES } from "./sources/index.js"
import { fetchWeather } from "./sources/weather.js"
import type { PlanRequest, SourceId } from "./types.js"

/** A deliberate spread: two big metros, two small cities where the long-tail
 *  sources matter most, and one non-US to check graceful degradation. */
const DEFAULT_CITIES = ["Austin, TX", "Boise, ID", "Seattle, WA", "Asheville, NC"]

interface Cell {
  found: number
  ms: number
  error?: string
}

async function main(): Promise<void> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set")

  const cities = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_CITIES
  const matrix = new Map<string, Map<SourceId, Cell>>()
  const weatherOk = new Map<string, boolean>()

  for (const cityName of cities) {
    process.stdout.write(`\n${cityName}\n`)
    let place
    try {
      place = (await geocode(cityName)).best
    } catch (err) {
      console.log(`  geocode failed: ${err instanceof Error ? err.message : err}`)
      continue
    }
    console.log(`  -> ${place.label}  ${place.lat.toFixed(3)},${place.lng.toFixed(3)}  ${place.timezone}`)

    const req: PlanRequest = {
      place,
      days: ["2026-09-05", "2026-09-06"],
      party: { adults: 2, kids: 0 },
      budgetUsd: 200,
      vibes: ["chill", "live music"],
      mobility: "car",
      avoid: [],
    }

    const pool = new BrowserPool({
      apiKey,
      maxConcurrent: 12,
      retries: 0, // one honest attempt per source; retries hide flakiness
      sourceTimeoutMs: 90_000,
      onEvent: (e) => {
        if (e.type === "fail") console.log(`  ! ${e.source}: ${e.reason.slice(0, 70)}`)
      },
    })

    try {
      const [results, weather] = await Promise.all([
        pool.fanOut(ALL_SOURCES, place, buildKeywords(req, 8), req),
        fetchWeather(place, req.days).catch(() => []),
      ])
      weatherOk.set(cityName, weather.length > 0)

      const row = new Map<SourceId, Cell>()
      for (const r of results) {
        row.set(r.source, { found: r.candidates.length, ms: r.elapsedMs, error: r.error })
      }
      matrix.set(cityName, row)

      const total = results.reduce((n, r) => n + r.candidates.length, 0)
      const live = results.filter((r) => r.candidates.length > 0).length
      console.log(`  ${total} candidates, ${live}/${results.length} sources produced something`)
    } finally {
      await pool.close()
    }
  }

  // ── matrix ────────────────────────────────────────────────────────────────
  const sources = ALL_SOURCES.map((s) => s.id)
  const w = 14
  console.log(`\n${"=".repeat(20 + sources.length * w)}`)
  console.log("yield by source and city".toUpperCase())
  console.log("=".repeat(20 + sources.length * w))
  console.log("city".padEnd(20) + sources.map((s) => s.slice(0, 12).padEnd(w)).join(""))

  for (const [city, row] of matrix) {
    const cells = sources.map((s) => {
      const cell = row.get(s)
      if (!cell) return "-".padEnd(w)
      if (cell.error) return "TIMEOUT/ERR".padEnd(w)
      return `${cell.found}`.padEnd(w)
    })
    console.log(city.slice(0, 19).padEnd(20) + cells.join(""))
  }

  // ── what needs attention ─────────────────────────────────────────────────
  console.log(`\n${"-".repeat(60)}`)
  const cityCount = matrix.size
  let problems = 0
  for (const s of sources) {
    const cells = [...matrix.values()].map((r) => r.get(s))
    const empty = cells.filter((c) => c && !c.error && c.found === 0).length
    const errored = cells.filter((c) => c?.error).length
    const worked = cells.filter((c) => c && !c.error && c.found > 0).length

    if (errored > 0 || empty === cityCount) {
      problems++
      console.log(
        `${s.padEnd(14)} worked in ${worked}/${cityCount}` +
          (errored ? `, errored in ${errored}` : "") +
          (empty === cityCount ? "  <- EMPTY EVERYWHERE, likely broken" : "  <- check these"),
      )
    } else if (empty > 0) {
      console.log(`${s.padEnd(14)} worked in ${worked}/${cityCount}, empty in ${empty} (may be genuine)`)
    } else {
      console.log(`${s.padEnd(14)} worked in ${worked}/${cityCount}`)
    }
  }
  const noWeather = [...weatherOk.entries()].filter(([, ok]) => !ok).map(([c]) => c)
  if (noWeather.length) console.log(`weather        missing for: ${noWeather.join(", ")}`)
  console.log(problems === 0 ? "\nNo source failed outright." : `\n${problems} source(s) need a look.`)
}

main().catch((err) => {
  console.error(`\nharden failed: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
