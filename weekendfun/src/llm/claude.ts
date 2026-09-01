/**
 * The optional Claude layer.
 *
 * ── Why a subprocess and not the API ────────────────────────────────────────
 * This shells out to the `claude` CLI in headless mode rather than calling the
 * Anthropic API, because that works on a Claude Pro/Max subscription with no
 * API key at all — the CLI already holds the user's credentials. Cloning this
 * repo therefore needs exactly one secret (SOLARI_API_KEY), which is the whole
 * point: `claude` is either installed and logged in, or this layer is skipped.
 *
 * ── Why it's optional ───────────────────────────────────────────────────────
 * Everything that decides *what goes in your weekend* — ranking, itinerary
 * assembly, learning — is deterministic code in engine/. Claude does two jobs
 * at the edges: reading a free-text request, and writing the plan up like a
 * person. Both degrade to something reasonable when it isn't there, and no
 * recommendation ever depends on it. That's deliberate: an LLM in the ranking
 * path would make the results unreproducible and the learning unmeasurable.
 */
import { spawn } from "node:child_process"

export interface ClaudeOptions {
  /** Sonnet is plenty for both jobs here and is markedly faster than Opus,
   *  which matters when it sits between the user and their plan. */
  model?: string
  timeoutMs?: number
}

let availability: boolean | null = null

/** Is the CLI installed and on PATH? Cached — this runs per plan. */
export async function claudeAvailable(): Promise<boolean> {
  if (availability !== null) return availability
  availability = await new Promise<boolean>((resolve) => {
    const proc = spawn("claude", ["--version"], { shell: process.platform === "win32" })
    proc.on("error", () => resolve(false))
    proc.on("close", (code) => resolve(code === 0))
  })
  return availability
}

/**
 * Run one headless prompt and return the text result.
 *
 * `--output-format json` puts the answer in `.result` and keeps the CLI's
 * progress chatter out of stdout, which plain text mode does not guarantee.
 */
export async function ask(prompt: string, opts: ClaudeOptions = {}): Promise<string> {
  const model = opts.model ?? "sonnet"
  const timeoutMs = opts.timeoutMs ?? 120_000

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", "--model", model, "--output-format", "json"],
      { shell: process.platform === "win32" },
    )

    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`claude timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout.on("data", (d) => (stdout += d))
    proc.stderr.on("data", (d) => (stderr += d))
    proc.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean }
        if (parsed.is_error) {
          reject(new Error(`claude reported an error: ${String(parsed.result).slice(0, 300)}`))
          return
        }
        resolve((parsed.result ?? "").trim())
      } catch {
        reject(new Error(`could not parse claude output: ${stdout.slice(0, 200)}`))
      }
    })

    // Prompt goes on stdin, not argv — a weekend description with quotes or a
    // newline in it would otherwise be mangled by the shell on Windows.
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

/** Pull the first JSON object out of a reply, tolerating markdown fences. */
function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1]! : text
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

export interface ParsedIntake {
  vibes?: string[]
  budgetUsd?: number
  adults?: number
  kids?: number
  kidAges?: number[]
  mobility?: "walk" | "transit" | "car"
  avoid?: string[]
}

/**
 * Read a free-text request into planner fields.
 *
 * Returns null on any failure, and the caller keeps its CLI defaults — a
 * garbled parse must never silently change what someone asked for.
 */
export async function parseIntake(text: string, opts: ClaudeOptions = {}): Promise<ParsedIntake | null> {
  if (!(await claudeAvailable())) return null

  const prompt = `Extract weekend-planning parameters from this request. Reply with ONLY a JSON object, no prose.

Request: ${JSON.stringify(text)}

Schema (omit any field the request does not mention — do not guess):
{
  "vibes": string[],        // short tags, e.g. ["chill","outdoorsy","date night"]
  "budgetUsd": number,      // total for the whole party, all days
  "adults": number,
  "kids": number,
  "kidAges": number[],
  "mobility": "walk" | "transit" | "car",
  "avoid": string[]         // things they explicitly do not want
}`

  try {
    return extractJson<ParsedIntake>(await ask(prompt, opts))
  } catch {
    return null
  }
}

/**
 * Write the plan up.
 *
 * The itinerary is already decided before this runs — Claude is describing a
 * finished plan, not choosing one. The prompt says so explicitly, because a
 * model invited to "improve" the plan will happily invent a restaurant.
 */
export async function writeUp(
  planSummary: string,
  opts: ClaudeOptions = {},
): Promise<string | null> {
  if (!(await claudeAvailable())) return null

  const prompt = `You are writing up a weekend plan that has ALREADY been decided. Every venue below was found by live web research and ranked by a scoring engine.

Rules:
- Use ONLY the places listed. Never add, substitute, or invent a venue, price, or time.
- If something looks like a poor fit, say so plainly rather than papering over it.
- 2-4 short paragraphs. Warm and concrete, not brochure copy. No headings, no bullet lists, no emoji.
- Mention the weather where it actually affects the plan.

${planSummary}`

  try {
    return await ask(prompt, opts)
  } catch {
    return null
  }
}
