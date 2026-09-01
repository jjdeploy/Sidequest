/**
 * The learning loop.
 *
 * Every rating you give updates a small, readable taste vector held in SQLite.
 * There is no model here and that is deliberate: the weights are inspectable
 * (`npm run history` prints them), the update rule fits on a screen, and a bad
 * weekend can't silently poison anything you can't see and correct.
 *
 * What it learns:
 *   cat:<category>  do you actually do this kind of thing
 *   w:free          how much "free" matters to you specifically
 *
 * Weights live in [0.4, 1.8] and multiply the scorer's components, so learning
 * can meaningfully reorder results but can never invert the base ranking into
 * nonsense on the strength of two clicks.
 */
import { CATEGORIES } from "../types.js"
import type { Store } from "../store/db.js"

const MIN_WEIGHT = 0.4
const MAX_WEIGHT = 1.8
const NEUTRAL = 1.0

/** How much one signal moves a weight. Small on purpose — a single bad night
 *  shouldn't delete a whole category, but five of them should. */
const LEARNING_RATE = 0.12

/** Signal -> how good it was, centred on 0. */
function valenceOf(kind: string, value: number): number | null {
  switch (kind) {
    case "did":
      // You actually went. The strongest positive available.
      return 1.0
    case "kept":
      return 0.5
    case "skipped":
      return -0.5
    case "rated":
      // 1..5 -> -1..+1, with 3 as neutral.
      return (value - 3) / 2
    default:
      return null
  }
}

function clamp(n: number): number {
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, n))
}

export interface LearnResult {
  updated: Record<string, number>
  signalsUsed: number
}

/**
 * Recompute the taste vector from the full signal history.
 *
 * Deliberately a full recompute rather than an incremental nudge: it's cheap
 * at this scale, it makes the result independent of the order signals arrived
 * in, and it means deleting a bad signal actually undoes its effect. An
 * incremental update would bake in mistakes permanently.
 */
export function relearn(store: Store): LearnResult {
  const signals = store.signalsWithCategory()

  // Start every category at neutral so a category you've never rated stays
  // exactly where the base scorer put it.
  const weights: Record<string, number> = {}
  for (const c of CATEGORIES) weights[`cat:${c}`] = NEUTRAL
  weights["w:free"] = NEUTRAL

  let used = 0
  const freeEvidence: number[] = []

  for (const s of signals) {
    const valence = valenceOf(s.kind, s.value)
    if (valence === null) continue
    used++

    const key = `cat:${s.category}`
    const current = weights[key] ?? NEUTRAL
    weights[key] = clamp(current + valence * LEARNING_RATE)

    // Did liking this thing have anything to do with it being free? Only
    // count items where the price was actually known, or "unknown price"
    // would quietly read as evidence about free things.
    if (s.priceUsd !== null) freeEvidence.push(s.priceUsd === 0 ? valence : -valence * 0.3)
  }

  if (freeEvidence.length >= 3) {
    const mean = freeEvidence.reduce((a, b) => a + b, 0) / freeEvidence.length
    weights["w:free"] = clamp(NEUTRAL + mean * 0.5)
  }

  for (const [key, value] of Object.entries(weights)) store.setWeight(key, value)
  return { updated: weights, signalsUsed: used }
}

/** Human-readable summary of what the system currently thinks you like. */
export function describeTaste(weights: Record<string, number>): string[] {
  const cats = Object.entries(weights)
    .filter(([k]) => k.startsWith("cat:"))
    .map(([k, v]) => [k.slice(4), v] as const)
    .filter(([, v]) => Math.abs(v - NEUTRAL) > 0.02)
    .sort((a, b) => b[1] - a[1])

  if (cats.length === 0) return ["No preferences learned yet — rate a plan and run it again."]

  const likes = cats.filter(([, v]) => v > NEUTRAL).map(([c, v]) => `${c} (${v.toFixed(2)})`)
  const dislikes = cats.filter(([, v]) => v < NEUTRAL).map(([c, v]) => `${c} (${v.toFixed(2)})`)

  const out: string[] = []
  if (likes.length) out.push(`leans toward: ${likes.join(", ")}`)
  if (dislikes.length) out.push(`leans away from: ${dislikes.join(", ")}`)
  const free = weights["w:free"] ?? NEUTRAL
  if (Math.abs(free - NEUTRAL) > 0.05) {
    out.push(free > NEUTRAL ? `values free things (${free.toFixed(2)})` : `doesn't mind paying (${free.toFixed(2)})`)
  }
  return out
}
