/**
 * WeekendFun CLI.
 *
 *   npm run plan -- "Tampa, FL" --vibes "chill, live music" --budget 200
 *   npm run plan -- "Seattle, WA" --ask "cheap date night, no driving"
 *   npm run feedback -- <candidate-id> did
 *   npm run history
 *
 * The orchestration lives in pipeline.ts, which the dashboard also calls.
 * Everything here is argument parsing and rendering to a terminal.
 */
import { resolve } from "node:path"
import { describeTaste, relearn } from "./engine/learn.js"
import { claudeAvailable } from "./llm/claude.js"
import { NoCandidatesError, resolvePlanRequest, runPlan, type PlanEvent } from "./pipeline.js"
import type { Itinerary } from "./engine/itinerary.js"
import { ALL_SOURCES } from "./sources/index.js"
import { redditConfigured } from "./sources/reddit.js"
import { Store } from "./store/db.js"
import type { Mobility, PlanRequest } from "./types.js"
import type { PoolEvent } from "./solari/pool.js"

const DB_PATH = process.env.WEEKENDFUN_DB ?? resolve(process.cwd(), "data", "weekendfun.db")

// ─────────────────────────────────────────────────────────── arg parsing

interface Args {
  _: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) {
        out.flags[key] = next
        i++
      } else {
        out.flags[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

const str = (a: Args, k: string, d?: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : d)
const num = (a: Args, k: string, d: number) => {
  const v = a.flags[k]
  const n = typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : d
}
const bool = (a: Args, k: string) => a.flags[k] === true || a.flags[k] === "true"
const list = (a: Args, k: string) =>
  (str(a, k, "") ?? "").split(",").map((s) => s.trim()).filter(Boolean)


/**
 * Every flag this CLI takes. Only used to notice when npm has eaten them.
 */
const KNOWN_FLAGS = [
  "vibes", "budget", "adults", "kids", "mobility", "avoid", "days", "ask",
  "sources", "concurrency", "retries", "keywords", "source-timeout",
  "explain", "record", "writeup",
]

/**
 * Warn when npm swallowed the flags instead of forwarding them.
 *
 * npm 11 parses the arguments after `--` as its own config before handing
 * them on. An unrecognised `--sources timeout` becomes the npm config
 * "sources" with the value `true`, the flag NAME is dropped from argv, and
 * the value is left behind as a stray positional. So:
 *
 *   npm run plan -- "Tampa, FL" --sources timeout --budget 150
 *
 * ran a full six-source plan on the default budget and said nothing. Getting
 * the wrong answer quietly is the worst outcome available, and this is
 * precisely detectable: npm leaves `npm_config_sources` in the environment
 * for a flag that never reached our parser.
 *
 * The values themselves are gone (npm recorded "true", not "timeout"), so
 * there is nothing to recover — only something to say.
 */
function warnIfNpmAteFlags(args: Args): void {
  const eaten = KNOWN_FLAGS.filter((flag) => {
    const key = `npm_config_${flag.replace(/-/g, "_")}`
    if (process.env[key] === undefined) return false
    // `--no-writeup` arrives as npm_config_writeup="", so check both spellings.
    return args.flags[flag] === undefined && args.flags[`no-${flag}`] === undefined
  })
  if (eaten.length === 0) return

  const shown = eaten.map((f) => `--${f}`).join(", ")
  console.error(`\n\x1b[33mnpm swallowed these flags: ${shown}\x1b[0m`)
  console.error(`npm parses what follows \`--\` as its own config. Add a second \`--\`:`)
  console.error(`  npm run plan -- "${args._[0] ?? "Tampa, FL"}" -- ${shown.split(", ").join(" ")}`)
  console.error(`...or skip npm entirely:`)
  console.error(`  npx tsx src/cli.ts plan "${args._[0] ?? "Tampa, FL"}" ${shown.split(", ").join(" ")}`)
  console.error(`Continuing with defaults for those.\n`)
}

// ─────────────────────────────────────────────────────────── rendering

const BAR = "─".repeat(72)

function renderProgress(e: PoolEvent): void {
  const t = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  switch (e.type) {
    case "launch":
      console.log(`  ↗ ${e.source.padEnd(13)} launching (${e.proxy})`)
      break
    case "gated":
      console.log(`  ✓ ${e.source.padEnd(13)} in position, verified (${t(e.ms)})`)
      break
    case "done":
      console.log(`  ● ${e.source.padEnd(13)} ${String(e.found).padStart(3)} found (${t(e.ms)})`)
      break
    case "retry":
      console.log(`  ↺ ${e.source.padEnd(13)} retry ${e.attempt}: ${e.reason.slice(0, 60)}`)
      break
    case "fail":
      console.log(`  ✕ ${e.source.padEnd(13)} ${e.reason.slice(0, 60)}`)
      break
    case "note":
      if (process.env.WEEKENDFUN_VERBOSE) console.log(`      ${e.source}: ${e.msg.slice(0, 80)}`)
      break
  }
}

function renderItinerary(it: Itinerary, req: PlanRequest, verbose: boolean): void {
  for (const day of it.days) {
    const d = new Date(`${day.date}T12:00:00`)
    const name = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
    const w = day.weather
    const wx = w ? `  ${w.highF}°/${w.lowF}°F, ${w.summary}, ${w.precipChance}% rain` : ""
    console.log(`\n${name}${wx}`)
    console.log(BAR)

    if (day.items.length === 0) {
      console.log("  (nothing fit — try a bigger budget or a wider radius)")
      continue
    }

    for (const item of day.items) {
      const c = item.scored.candidate
      const price = c.priceUsd === null ? "—" : c.priceUsd === 0 ? "free" : `$${c.priceUsd}`
      const hop = item.hopMiles !== null ? `  (${item.hopMiles.toFixed(1)} mi hop)` : ""
      console.log(`\n  ${item.slot.padEnd(10)} ${c.title}`)
      console.log(`  ${" ".repeat(10)} ${price.padEnd(8)} ${c.category}${hop}`)
      console.log(`  ${" ".repeat(10)} ${item.why}`)
      console.log(`  ${" ".repeat(10)} \x1b[2m${c.id}  ${c.url.slice(0, 58)}\x1b[0m`)
      if (verbose) {
        for (const comp of item.scored.components) {
          console.log(`  ${" ".repeat(12)} \x1b[2m${comp.points > 0 ? "+" : ""}${comp.points.toFixed(1)} ${comp.name}: ${comp.why}\x1b[0m`)
        }
      }
    }
    console.log(`\n  day total: $${day.costUsd.toFixed(0)}`)
  }

  console.log(`\n${BAR}`)
  const heads = req.party.adults + req.party.kids
  console.log(`Total: $${it.totalUsd.toFixed(0)} of $${req.budgetUsd} for ${heads} ${heads === 1 ? "person" : "people"}`)
  for (const note of it.notes) console.log(`Note: ${note}`)
}

// ─────────────────────────────────────────────────────────── commands

async function cmdPlan(args: Args): Promise<void> {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) throw new Error("SOLARI_API_KEY is not set. Copy .env.example to .env and add your key.")

  warnIfNpmAteFlags(args)

  const where = args._[0]
  if (!where) throw new Error('Where to? e.g. npm run plan -- "Tampa, FL"')

  // Resolve the place first. Ambiguity is surfaced, never silently resolved.
  const days = list(args, "days")
  const { req, alternates, askNote } = await resolvePlanRequest(where, {
    days: days.length ? days : undefined,
    adults: num(args, "adults", 2),
    kids: num(args, "kids", 0),
    budgetUsd: num(args, "budget", 200),
    vibes: list(args, "vibes"),
    mobility: (str(args, "mobility", "car") as Mobility) ?? "car",
    avoid: list(args, "avoid"),
    ask: str(args, "ask"),
  })

  console.log(`\n${BAR}`)
  console.log(`WeekendFun — ${req.place.label}`)
  console.log(BAR)
  if (alternates.length > 0) {
    console.log(`(also matched ${alternates.map((a) => a.label).join(", ")} — qualify the name to pick another)`)
  }
  if (askNote) console.log(`Read your request as: ${askNote}`)
  console.log(
    `${req.days.join(" and ")} · ${req.party.adults} adults${req.party.kids ? ` + ${req.party.kids} kids` : ""}` +
      ` · $${req.budgetUsd} · ${req.mobility}`,
  )

  // Checked up front so the "Writing it up…" line is only printed when
  // something is actually going to be written.
  const wantsWriteUp = !bool(args, "no-writeup") && (await claudeAvailable())
  const explain = bool(args, "explain")

  const render = (e: PlanEvent): void => {
    switch (e.type) {
      case "keywords":
        console.log(`\nSearching for ${e.keywords.length} things:`)
        for (const k of e.keywords.slice(0, 6)) console.log(`  · ${k.term}  \x1b[2m(${k.because})\x1b[0m`)
        if (e.keywords.length > 6) console.log(`  · …and ${e.keywords.length - 6} more`)
        break
      case "launching":
        console.log(
          `\nLaunching ${e.browsers} cloud browsers across ${e.sources.length} sources, in parallel:`,
        )
        break
      case "pool":
        renderProgress(e.event)
        break
      case "reddit":
        if (e.found > 0) console.log(`  ● ${"reddit".padEnd(13)} ${String(e.found).padStart(3)} found (official API)`)
        else if (!e.configured) console.log(`  ○ ${"reddit".padEnd(13)} skipped (no REDDIT_CLIENT_ID — see sources/reddit.ts)`)
        break
      case "gathered":
        console.log(`\n${e.total} candidates from ${e.ok}/${e.of} sources in ${(e.elapsedMs / 1000).toFixed(1)}s`)
        break
      case "screened": {
        const s = e.summary
        console.log(`${s.admitted} admitted, ${s.rejected} rejected by the relevance gate`)
        const d = s.byDimension
        // The unknown counts are the honest part: most candidates carry no
        // location at all, and saying so beats implying they were checked.
        console.log(
          `  place ${d.place.ok} ok / ${d.place.fail} elsewhere / ${d.place.unknown} unknown` +
            `   ·   time ${d.time.ok} ok / ${d.time.fail} other dates / ${d.time.unknown} undated` +
            `   ·   kind ${d.kind.fail} filtered`,
        )
        break
      }
      case "taste":
        // Fires immediately before the write-up starts, which is the only
        // part of a plan run that makes the user wait after the answer.
        if (wantsWriteUp) console.log("\nWriting it up…")
        break
      default:
        break
    }
  }

  const store = new Store(DB_PATH)
  try {
    const outcome = await runPlan(
      req,
      store,
      {
        apiKey,
        sources: list(args, "sources"),
        concurrency: num(args, "concurrency", 12),
        // Zero: a retry cannot land inside the global deadline, it just burns
        // the slot twice. The deadline is the resilience mechanism now.
        retries: num(args, "retries", 0),
        sourceTimeoutMs: num(args, "source-timeout", 90) * 1000,
        keywordLimit: num(args, "keywords", 8),
        record: bool(args, "record"),
        writeup: wantsWriteUp,
        verbose: Boolean(process.env.WEEKENDFUN_VERBOSE),
      },
      render,
    )

    renderItinerary(outcome.itinerary, req, explain)

    if (outcome.writeup) {
      console.log(`\n${BAR}`)
      console.log(outcome.writeup)
      console.log(BAR)
    }

    console.log(`\nWhat I know about you so far: ${describeTaste(outcome.weights).join(" · ")}`)
    console.log(`\nTell me how it went and the next plan gets better:`)
    const first = outcome.itinerary.days[0]?.items[0]
    if (first) {
      console.log(`  npm run feedback -- ${first.scored.candidate.id.slice(0, 8)} did`)
      console.log(`  npm run feedback -- ${first.scored.candidate.id.slice(0, 8)} rated 5`)
    }
  } catch (err) {
    if (err instanceof NoCandidatesError) {
      console.log(`\n${err.message}`)
      process.exitCode = 1
      return
    }
    throw err
  } finally {
    store.close()
  }
}

async function cmdFeedback(args: Args): Promise<void> {
  const [idPrefix, kind, rawValue] = args._
  if (!idPrefix || !kind) {
    throw new Error("Usage: npm run feedback -- <candidate-id> <kept|skipped|did|rated> [1-5]")
  }
  const valid = ["kept", "skipped", "did", "rated"]
  if (!valid.includes(kind)) throw new Error(`kind must be one of: ${valid.join(", ")}`)

  const store = new Store(DB_PATH)
  try {
    const found = store.resolveCandidate(idPrefix)
    if (!found) {
      // Ambiguous or missing — never guess, because rating the wrong venue
      // corrupts the learner in a way that's very hard to spot later.
      throw new Error(`No single candidate matches "${idPrefix}". Use a longer id prefix.`)
    }
    const value = kind === "rated" ? Number(rawValue) : 1
    if (kind === "rated" && !(value >= 1 && value <= 5)) {
      throw new Error("rated needs a value from 1 to 5")
    }

    store.addSignal(found.id, kind, value)
    const { updated, signalsUsed } = relearn(store)
    console.log(`Recorded: ${found.title} — ${kind}${kind === "rated" ? ` ${value}/5` : ""}`)
    console.log(`Relearned from ${signalsUsed} signal(s).`)
    console.log(describeTaste(updated).map((s) => `  ${s}`).join("\n"))
  } finally {
    store.close()
  }
}

async function cmdHistory(): Promise<void> {
  const store = new Store(DB_PATH)
  try {
    const c = store.counts()
    console.log(`\n${BAR}`)
    console.log(`${c.runs} runs · ${c.candidates} known places · ${c.sightings} sightings · ${c.signals} signals`)
    console.log(BAR)
    for (const run of store.recentRuns(10)) {
      console.log(`  ${run.created_at.slice(0, 16).replace("T", " ")}  ${run.place_label.padEnd(22)} ${(run.elapsed_ms / 1000).toFixed(1)}s`)
    }
    console.log(`\nLearned preferences:`)
    console.log(describeTaste(store.getWeights()).map((s) => `  ${s}`).join("\n"))
  } finally {
    store.close()
  }
}

function cmdSources(): void {
  console.log("\nBrowser sources (run in parallel on Solari):")
  for (const s of ALL_SOURCES) console.log(`  ${s.id}`)
  console.log("\nDirect API sources (no browser needed):")
  console.log("  weather   Open-Meteo, keyless")
  console.log(`  reddit    official API — ${redditConfigured() ? "configured" : "not configured, will be skipped"}`)
}

// ─────────────────────────────────────────────────────────── entry

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const args = parseArgs(argv.slice(1))

  switch (command) {
    case "plan":
      await cmdPlan(args)
      break
    case "feedback":
      await cmdFeedback(args)
      break
    case "history":
      await cmdHistory()
      break
    case "sources":
      cmdSources()
      break
    default:
      console.log(`WeekendFun — parallel cloud browsers that plan your weekend.

  npm run plan -- "Tampa, FL"
  npm run plan -- "Seattle, WA" -- --vibes "outdoorsy, cheap" --budget 150
  npm run plan -- "Austin, TX" -- --ask "date night, no driving, under \\$100"
  npm run feedback -- <candidate-id> did
  npm run history
  npm run sources
  npm run dashboard              the browser UI: live fan-out, map, replays
  npm run geo-proof              prove the location targeting actually works

Flags: --vibes --budget --adults --kids --mobility --avoid --days
       --sources --concurrency --retries --explain --record --no-writeup

Note the SECOND \`--\` before any flag. npm parses the first batch after
\`--\` as its own config and drops the flag names, so one dash silently
runs with defaults. Without npm in the way, one is enough:
  npx tsx src/cli.ts plan "Seattle, WA" --vibes "outdoorsy" --explain`)
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
