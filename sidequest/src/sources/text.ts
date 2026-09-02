/**
 * Text hygiene for anything scraped.
 *
 * Six sites, six sets of markup artifacts, and until this existed each source
 * was expected to clean up after itself — which meant none of them did
 * consistently. An AllEvents listing stored `"&amp; Ho... Read more"` as its
 * street address and it went all the way through ranking, into SQLite, and
 * onto the screen.
 *
 * These run inside `buildCandidate`, which every source already calls, so
 * fixing them here fixes them everywhere at once. That is the only reason
 * this is a module and not four lines in one scraper.
 */

/**
 * Named and numeric HTML entities.
 *
 * Deliberately not a full entity table: scraped `textContent` is already
 * decoded once by the browser, so what survives to here is double-encoded
 * markup — almost always `&amp;` and the quote family — plus numeric escapes.
 */
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", middot: "·", deg: "°", eacute: "é",
}

export function decodeEntities(raw: string): string {
  return raw
    // Repeat once to catch `&amp;amp;`, which is what double-encoding produces.
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, entity)
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, entity)
}

function entity(match: string, body: string): string {
  if (body.startsWith("#")) {
    const code = body[1] === "x" || body[1] === "X"
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10)
    // Reject anything outside the Unicode range rather than throwing.
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  }
  return NAMED[body.toLowerCase()] ?? match
}

/**
 * Chrome that sites append to truncated text.
 *
 * These are UI affordances, not content: they mean "the real value was cut
 * off here". Keeping them makes a field look populated when it isn't, which
 * is worse than an empty one — an empty address is honestly unknown, while
 * "Read more" is a lie the scorer can't detect.
 */
const TRAILING_CHROME = [
  /\bread more\b\.?$/i,
  /\bshow more\b\.?$/i,
  /\bsee more\b\.?$/i,
  /\bmore info\b\.?$/i,
  /\bsave this event.*$/i,
  /\bshare this event.*$/i,
  /\bpromoted event.*$/i,
  /\bsales end soon\b/i,
  /\b\d+\+?\s*interested\b/i,
  /\bview details\b\.?$/i,
]

/** Clean one scraped field. Returns undefined when nothing real is left. */
export function cleanField(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined
  let s = decodeEntities(raw).replace(/\s+/g, " ").trim()
  for (const re of TRAILING_CHROME) s = s.replace(re, "").trim()
  // Strip the ellipsis a truncation leaves behind, and any punctuation that
  // was only holding it up.
  s = s.replace(/[\s.·|,–—-]*(?:\.{3}|…)\s*$/, "").trim()
  s = s.replace(/^[\s.·|,–—-]+/, "").trim()

  // The seam where the card ended and the offer copy began.
  //
  // Groupon runs its card text together, so a merchant name arrives with the
  // start of the blurb glued to it: "Woods ATV Rentals - Brooksville,
  // FLAccess to 2,". A state code followed immediately by a capitalised word
  // is that seam, and it is specific enough not to fire on anything else.
  s = s.replace(/(,\s*[A-Z]{2})(?=[A-Z][a-z])[\s\S]*$/, "$1").trim()

  // A bracket with nothing after it was holding up text that got truncated
  // away. "AMC Theatres(" and "Brio Italian Grille(" both reached plan cards.
  // Only when unmatched: "Cantina Louie (Palm Coast, FL)" is the whole name.
  s = s.replace(/[\s([{<]+$/, "").trim()

  return isDegenerate(s) ? undefined : s
}

/**
 * Is what's left actually a value?
 *
 * A field that is punctuation, a lone conjunction, or two characters of a
 * word is an extraction failure wearing a value's clothes.
 */
export function isDegenerate(s: string): boolean {
  if (s.length < 3) return true
  if (!/[a-z0-9]/i.test(s)) return true
  // "& Ho", "at The", "· ·" — a couple of stopwords and nothing else.
  const words = s.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w))
  if (words.length === 0) return true
  const STOP = new Set(["and", "at", "the", "a", "an", "of", "in", "on", "to", "for", "by", "with", "&"])
  return words.every((w) => STOP.has(w.toLowerCase()) || w.length <= 2)
}
