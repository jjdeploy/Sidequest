/**
 * The memory. This is what makes Sidequest a planner rather than a scraper.
 *
 * Uses `node:sqlite`, which is built into Node 22 — no native module, no
 * build step, nothing for a reviewer to install before the repo runs.
 *
 * The schema separates two things that are easy to conflate:
 *
 *   candidates  the venue itself, deduped by name across every source and
 *               every run. One row per real-world place, ever.
 *   sightings   one source seeing that venue on one run. Many per candidate.
 *
 * Keeping them apart is what buys corroboration ("three sources found this")
 * and history ("you have been shown this four weekends running and never once
 * picked it") — both of which are just counts over `sightings` and `signals`.
 */
import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Candidate, PlanRequest, SourceResult } from "../types.js"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  place_label  TEXT NOT NULL,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  request_json TEXT NOT NULL,
  elapsed_ms   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  category     TEXT NOT NULL,
  price_usd    REAL,
  rating       REAL,
  review_count INTEGER,
  lat          REAL,
  lng          REAL,
  indoor       INTEGER,
  kind         TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sightings (
  run_id       TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  source       TEXT NOT NULL,
  evidence     TEXT NOT NULL,
  price_usd    REAL,
  session_id   TEXT,
  scraped_at   TEXT NOT NULL,
  PRIMARY KEY (run_id, candidate_id, source)
);
CREATE INDEX IF NOT EXISTS idx_sightings_candidate ON sightings(candidate_id);

CREATE TABLE IF NOT EXISTS plans (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  title      TEXT NOT NULL,
  items_json TEXT NOT NULL
);

-- What the user actually thought. The whole learning loop reads from here.
CREATE TABLE IF NOT EXISTS signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  run_id       TEXT,
  kind         TEXT NOT NULL,   -- kept | skipped | did | rated
  value        REAL NOT NULL,   -- rated: 1..5. others: 1.
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_candidate ON signals(candidate_id);

-- Locality name -> coordinates, so the admission gate can ask "is this
-- actually near the city" without re-geocoding "Ormond Beach" every run.
-- Negative answers are cached too: most misses are not places at all, and
-- re-asking about them every weekend is the expensive half.
CREATE TABLE IF NOT EXISTS localities (
  name       TEXT PRIMARY KEY,
  lat        REAL,
  lng        REAL,
  resolved   INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- The learned taste vector: category weights, price tolerance, and so on.
-- Deliberately a flat key/value table so adding a learned dimension never
-- needs a migration.
CREATE TABLE IF NOT EXISTS weights (
  key        TEXT PRIMARY KEY,
  value      REAL NOT NULL,
  updated_at TEXT NOT NULL
);
`

export interface SightingRow {
  source: string
  evidence: string
  sessionId: string | null
  /** How many separate runs this source has found the venue on. */
  runs: number
}

export class Store {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    // WAL keeps the CLI readable from a second process (the dashboard, later)
    // while a plan run is mid-write.
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec(SCHEMA)

    // The one migration this schema has needed.
    //
    // `CREATE TABLE IF NOT EXISTS` does nothing to a table that already
    // exists, so a column added to the DDL above is invisible to every
    // database created before it. Additive, idempotent, and cheap enough to
    // run on every open — but if this list ever grows past two or three,
    // it wants a real version counter rather than another entry.
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(candidates)").all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has("kind")) this.db.exec("ALTER TABLE candidates ADD COLUMN kind TEXT")
  }

  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------- writing

  recordRun(runId: string, req: PlanRequest, elapsedMs: number): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, created_at, place_label, lat, lng, request_json, elapsed_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        new Date().toISOString(),
        req.place.label,
        req.place.lat,
        req.place.lng,
        JSON.stringify(req),
        elapsedMs,
      )
  }

  /**
   * Persist everything a fan-out found.
   *
   * Candidates upsert: a venue seen again keeps its original `first_seen` (so
   * "how long have we known about this" survives) but takes the newer facts,
   * because ratings and prices move. `COALESCE` on the incoming side means a
   * source that doesn't report a price can never blank out one we already had.
   */
  saveResults(runId: string, results: SourceResult[]): void {
    const upsertCandidate = this.db.prepare(
      `INSERT INTO candidates
         (id, title, url, category, price_usd, rating, review_count, lat, lng, indoor, kind, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title        = excluded.title,
         url          = excluded.url,
         -- Category is deliberately NOT overwritten.
         --
         -- The in-memory merge in score.ts keeps the FIRST source's category,
         -- so taking the last one here made the stored category disagree with
         -- the one the user was shown. Skipping the Florida Aquarium (shown as
         -- "family") taught the learner about "culture", because Time Out
         -- happened to write last. Whatever the ranking displays is what the
         -- feedback has to be attributed to, or the taste vector learns
         -- something the user never said.
         category     = candidates.category,
         price_usd    = COALESCE(excluded.price_usd, candidates.price_usd),
         -- Keep the better-evidenced numbers rather than the last-written
         -- ones. Sources disagree (Maps counted 5,606 reviews for the Tampa
         -- Riverwalk, TripAdvisor 1,906) and whichever source happened to run
         -- last was silently overwriting the richer answer.
         review_count = MAX(COALESCE(excluded.review_count, 0), COALESCE(candidates.review_count, 0)),
         rating       = CASE
                          WHEN COALESCE(excluded.review_count, 0) >= COALESCE(candidates.review_count, 0)
                            THEN COALESCE(excluded.rating, candidates.rating)
                          ELSE COALESCE(candidates.rating, excluded.rating)
                        END,
         lat          = COALESCE(excluded.lat, candidates.lat),
         lng          = COALESCE(excluded.lng, candidates.lng),
         indoor       = COALESCE(excluded.indoor, candidates.indoor),
         -- Only Maps publishes one, so a later source without a descriptor
         -- must not erase the one we have.
         kind         = COALESCE(excluded.kind, candidates.kind),
         last_seen    = excluded.last_seen`,
    )
    const insertSighting = this.db.prepare(
      `INSERT OR REPLACE INTO sightings
         (run_id, candidate_id, source, evidence, price_usd, session_id, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )

    // One transaction for the whole fan-out: a hundred candidates is a hundred
    // fsyncs otherwise, which dwarfs the time the scraping took.
    this.db.exec("BEGIN")
    try {
      for (const result of results) {
        for (const c of result.candidates) {
          upsertCandidate.run(
            c.id,
            c.title,
            c.url,
            c.category,
            c.priceUsd,
            c.rating,
            c.reviewCount ?? null,
            c.lat ?? null,
            c.lng ?? null,
            c.indoor === null ? null : c.indoor ? 1 : 0,
            c.kind ?? null,
            c.scrapedAt,
            c.scrapedAt,
          )
          insertSighting.run(
            runId,
            c.id,
            c.source,
            c.evidence,
            c.priceUsd,
            c.sessionId ?? null,
            c.scrapedAt,
          )
        }
      }
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  savePlan(planId: string, runId: string, title: string, items: unknown): void {
    this.db
      .prepare(`INSERT INTO plans (id, run_id, created_at, title, items_json) VALUES (?, ?, ?, ?, ?)`)
      .run(planId, runId, new Date().toISOString(), title, JSON.stringify(items))
  }

  addSignal(candidateId: string, kind: string, value = 1, runId?: string): void {
    this.db
      .prepare(
        `INSERT INTO signals (candidate_id, run_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(candidateId, runId ?? null, kind, value, new Date().toISOString())
  }

  setWeight(key: string, value: number): void {
    this.db
      .prepare(
        `INSERT INTO weights (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString())
  }

  // ---------------------------------------------------------------- reading

  getWeights(): Record<string, number> {
    const rows = this.db.prepare(`SELECT key, value FROM weights`).all() as Array<{
      key: string
      value: number
    }>
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }

  /** How many DISTINCT sources saw this venue on this run. The corroboration
   *  signal — the single most useful thing the store computes. */
  corroborationFor(runId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT candidate_id, COUNT(DISTINCT source) AS n
         FROM sightings WHERE run_id = ? GROUP BY candidate_id`,
      )
      .all(runId) as Array<{ candidate_id: string; n: number }>
    return new Map(rows.map((r) => [r.candidate_id, r.n]))
  }

  /** Aggregate history per candidate, across all previous runs. */
  historyFor(candidateIds: string[]): Map<string, { shown: number; kept: number; skipped: number; did: number; rating: number | null }> {
    const out = new Map<string, { shown: number; kept: number; skipped: number; did: number; rating: number | null }>()
    if (candidateIds.length === 0) return out

    const placeholders = candidateIds.map(() => "?").join(",")
    const shown = this.db
      .prepare(
        `SELECT candidate_id, COUNT(DISTINCT run_id) AS n FROM sightings
         WHERE candidate_id IN (${placeholders}) GROUP BY candidate_id`,
      )
      .all(...candidateIds) as Array<{ candidate_id: string; n: number }>
    const sig = this.db
      .prepare(
        `SELECT candidate_id, kind, COUNT(*) AS n, AVG(value) AS avg_value FROM signals
         WHERE candidate_id IN (${placeholders}) GROUP BY candidate_id, kind`,
      )
      .all(...candidateIds) as Array<{ candidate_id: string; kind: string; n: number; avg_value: number }>

    for (const id of candidateIds) {
      out.set(id, { shown: 0, kept: 0, skipped: 0, did: 0, rating: null })
    }
    for (const r of shown) {
      const e = out.get(r.candidate_id)
      if (e) e.shown = r.n
    }
    for (const r of sig) {
      const e = out.get(r.candidate_id)
      if (!e) continue
      if (r.kind === "kept") e.kept = r.n
      else if (r.kind === "skipped") e.skipped = r.n
      else if (r.kind === "did") e.did = r.n
      else if (r.kind === "rated") e.rating = r.avg_value
    }
    return out
  }

  /** Signals joined to the category they were about — the learner's input. */
  signalsWithCategory(): Array<{ category: string; kind: string; value: number; priceUsd: number | null }> {
    return this.db
      .prepare(
        `SELECT c.category AS category, s.kind AS kind, s.value AS value, c.price_usd AS priceUsd
         FROM signals s JOIN candidates c ON c.id = s.candidate_id`,
      )
      .all() as Array<{ category: string; kind: string; value: number; priceUsd: number | null }>
  }

  /** Look up a candidate by an id prefix, so the CLI can take short ids. */
  resolveCandidate(prefix: string): { id: string; title: string; category: string } | null {
    const rows = this.db
      .prepare(`SELECT id, title, category FROM candidates WHERE id LIKE ? LIMIT 2`)
      .all(`${prefix}%`) as Array<{ id: string; title: string; category: string }>
    // Ambiguous prefixes must fail loudly — silently rating the wrong venue
    // corrupts the learner in a way that is very hard to notice later.
    return rows.length === 1 ? rows[0]! : null
  }

  recentRuns(limit = 10): Array<{ id: string; created_at: string; place_label: string; elapsed_ms: number }> {
    return this.db
      .prepare(
        `SELECT id, created_at, place_label, elapsed_ms FROM runs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; created_at: string; place_label: string; elapsed_ms: number }>
  }

  /**
   * Which sources have seen this venue, newest sighting first — one row per
   * SOURCE, not one per sighting.
   *
   * The raw table has a row per source per run, so a venue found by three
   * sources across three weekends returns nine rows, and the dashboard listed
   * "google-maps" three times under a heading that said "3 independent
   * sources". Corroboration counts DISTINCT sources, so the evidence list has
   * to be collapsed the same way or it contradicts the number above it.
   *
   * Deduped here rather than in SQL: the grouping needs the newest row's
   * evidence AND session id together, which is a window function or a
   * self-join for what is a handful of rows.
   */
  sightingsFor(candidateId: string): SightingRow[] {
    const rows = this.db
      .prepare(
        `SELECT source, evidence, session_id AS sessionId, run_id AS runId
         FROM sightings WHERE candidate_id = ?
         ORDER BY scraped_at DESC`,
      )
      .all(candidateId) as unknown as Array<SightingRow & { runId: string }>

    const bySource = new Map<string, SightingRow>()
    const runs = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!bySource.has(r.source)) {
        bySource.set(r.source, { source: r.source, evidence: r.evidence, sessionId: r.sessionId, runs: 0 })
      }
      const seen = runs.get(r.source) ?? new Set<string>()
      seen.add(r.runId)
      runs.set(r.source, seen)
    }
    for (const [source, row] of bySource) row.runs = runs.get(source)?.size ?? 1
    return [...bySource.values()]
  }

  /** The most recent plan, so the dashboard can show something on a cold
   *  load instead of an empty page with a form on it. */
  latestPlan(): { id: string; runId: string; createdAt: string; title: string; items: unknown } | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id AS runId, created_at AS createdAt, title, items_json AS itemsJson
         FROM plans ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { id: string; runId: string; createdAt: string; title: string; itemsJson: string } | undefined
    if (!row) return null
    return { id: row.id, runId: row.runId, createdAt: row.createdAt, title: row.title, items: JSON.parse(row.itemsJson) }
  }

  /** Recent feedback, with the venue it was about. The dashboard shows this
   *  next to the taste vector so a weight change has a visible cause. */
  recentSignals(limit = 12): Array<{ candidateId: string; title: string; category: string; kind: string; value: number; createdAt: string }> {
    return this.db
      .prepare(
        `SELECT s.candidate_id AS candidateId, c.title AS title, c.category AS category,
                s.kind AS kind, s.value AS value, s.created_at AS createdAt
         FROM signals s JOIN candidates c ON c.id = s.candidate_id
         ORDER BY s.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ candidateId: string; title: string; category: string; kind: string; value: number; createdAt: string }>
  }

  /** Undo. The learner is a full recompute from signal history, so deleting a
   *  signal genuinely removes its effect — which is only true because nothing
   *  incremental is cached anywhere. */
  deleteSignal(candidateId: string, kind: string): number {
    const before = (this.db.prepare(`SELECT COUNT(*) AS n FROM signals`).get() as { n: number }).n
    this.db.prepare(`DELETE FROM signals WHERE candidate_id = ? AND kind = ?`).run(candidateId, kind)
    const after = (this.db.prepare(`SELECT COUNT(*) AS n FROM signals`).get() as { n: number }).n
    return before - after
  }

  /** Cached locality lookup. `undefined` means never asked, `null` means
   *  asked and it isn't a place. */
  getLocality(name: string): { lat: number; lng: number } | null | undefined {
    const row = this.db
      .prepare(`SELECT lat, lng, resolved FROM localities WHERE name = ?`)
      .get(name.toLowerCase()) as { lat: number | null; lng: number | null; resolved: number } | undefined
    if (!row) return undefined
    return row.resolved && row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null
  }

  putLocality(name: string, hit: { lat: number; lng: number } | null): void {
    this.db
      .prepare(
        `INSERT INTO localities (name, lat, lng, resolved, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           lat = excluded.lat, lng = excluded.lng,
           resolved = excluded.resolved, updated_at = excluded.updated_at`,
      )
      .run(name.toLowerCase(), hit?.lat ?? null, hit?.lng ?? null, hit ? 1 : 0, new Date().toISOString())
  }

  counts(): { candidates: number; sightings: number; signals: number; runs: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n
    return {
      candidates: one("SELECT COUNT(*) AS n FROM candidates"),
      sightings: one("SELECT COUNT(*) AS n FROM sightings"),
      signals: one("SELECT COUNT(*) AS n FROM signals"),
      runs: one("SELECT COUNT(*) AS n FROM runs"),
    }
  }
}
