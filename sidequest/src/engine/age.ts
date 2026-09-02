/**
 * The 21+ flag.
 *
 * Every other preference in this codebase is a nudge: a vibe raises a score,
 * a budget trims a list, weather demotes a park. This one is not. If the
 * party has not said everyone is 21, a bar does not appear in the plan —
 * not low down, not greyed out, not in the catalogue underneath. Absent.
 *
 * Which makes the line it draws matter, and the line is STRICTLY 21+ — the
 * rooms that would card you at the door. Bars, nightclubs, clubs,
 * speakeasies, casinos, cigar and hookah lounges. Not restaurants, whatever
 * they are called and however good the bar in them is; not breweries,
 * taprooms, wineries or pubs, all of which let a family in and simply
 * decline to serve half of it.
 *
 * So it is enforced in the admission gate (engine/relevance.ts), where a
 * fatal verdict keeps a candidate out of the plan AND out of the store, and
 * it is enforced a second time in engine/keywords.ts — not for safety, but
 * because searching for something you have already decided to throw away
 * spends one of eight browsers on nothing.
 *
 * ── Reading a listing's age, without a field that says so ─────────────────
 *
 * No source publishes one. What they publish is a name and a snippet, and
 * those two are worth very different amounts:
 *
 *  - **The name is evidence.** "Coppertail Brewing Co." is a brewery. A
 *    place called a taproom is a taproom.
 *  - **The snippet is not.** Evidence text mentions a bar constantly —
 *    "cash bar", "full bar", "bar service available" — at weddings, food
 *    halls and street festivals that anyone can walk into. Matching venue
 *    words there would quietly delete the family end of the plan.
 *
 * An explicit age gate is the exception, and it is decisive wherever it
 * appears: a listing that says "21+" has answered the question itself.
 */
import type { Category, PlanRequest } from "../types.js"

/**
 * Is everyone in this party 21?
 *
 * Two answers, and they can contradict each other — someone ticks 21+ and
 * then says they are bringing a four-year-old. The party wins, because that
 * is the answer that names a real person. One predicate so the gate, the
 * query builder and the write-up can never drift apart on it.
 */
export function partyIsOver21(req: PlanRequest): boolean {
  return req.party.over21 === true && req.party.kids === 0
}

/**
 * An age the listing states outright.
 *
 * The currency lookbehind is load-bearing: "$18+" is how half of Eventbrite
 * writes a ticket price, and reading it as an age gate would delete the
 * cheap end of every event source.
 */
const AGE_GATE =
  /(?<![$£€.\d])\b(?:18|19|20|21)\s*\+|\b(?:18|19|20|21)\s*(?:and|&)\s*(?:over|up|older)\b|\bmust be 21\b|\b21 to enter\b|\badults?[ -]only\b|\bno minors\b/i

/**
 * Rooms that turn a twenty-year-old away at the door. The NAME only.
 *
 * The test is not "does drink get sold here" — nearly everywhere sells
 * drink. It is whether they would card you to get in. A bar would. A
 * nightclub would. A brewery taproom would not, a winery would not, and a
 * restaurant with a bar in it certainly would not: those admit anyone and
 * simply decline to serve the under-21s, which is not the same thing and is
 * not a reason to delete them from a weekend.
 */
const ADULT_VENUE =
  /\b(?:taverns?|saloons?|speakeas(?:y|ies)|cocktails?|night ?clubs?|dance clubs?|strip clubs?|hookah|cigars?|casinos?|dispensar(?:y|ies)|smoke shop)\b|\b(?:cocktail|hookah|cigar|whisk(?:e)?y|martini) lounges?\b|^\s*club\s+\w/i

/**
 * Drink you can bring a fourteen-year-old to.
 *
 * Checked before the venue list and before the category, because both used
 * to call these adult and both were wrong. A brewery taproom, a cidery, a
 * winery tasting room and an Irish pub all let minors in — the under-21s
 * just drink something else. Deleting a town's breweries from a family
 * weekend removed some of the best things in it for no reason anyone at the
 * door would recognise.
 */
const ALL_AGES_DRINK =
  /\b(?:brewer(?:y|ies)|brewing|brewpubs?|ale ?works?|\bales\b|beers?|taprooms?|tap house|winer(?:y|ies)|vineyards?|cider(?:y|ies)|meader(?:y|ies)|distiller(?:y|ies)|pubs?|gastropubs?|cantinas?)\b/i

/**
 * Clubs that are not that kind of club.
 *
 * "Club" on its own is filed under nightlife by the category guesser, which
 * is right for Club Prana and wrong for the Sunday book club at the library.
 * Since the category is one of this gate's inputs, the wrong ones have to be
 * caught here, or an under-21 party loses a reading group to a rule that was
 * written about a disco.
 */
const INNOCUOUS_CLUB =
  /\b(?:book|run(?:ning)?|walk(?:ing)?|chess|garden|hobby|youth|kids?|boys?|girls?|beach|yacht|country|golf|swim(?:ming)?|tennis|art|craft|knit\w*|photography|birding|hiking|cycling|supper|breakfast|social|wholesale|warehouse|language|italian|rotary|kiwanis) clubs?\b|\b(?:sam's|bj's|costco) club\b/i

/**
 * The bare word "bar", which is the whole difficulty.
 *
 * It is the most promiscuous token in the vocabulary — a sushi bar, a juice
 * bar and a barre studio are all somewhere a fourteen-year-old can stand.
 * The exclusion list is what everything else in the file leans on, so it is
 * written out rather than guessed at.
 */
const NOT_A_BAR =
  /(?:sushi|juice|salad|oyster|raw|coffee|espresso|snack|candy|smoothie|noodle|taco|sandwich|cereal|nail|blow[- ]dry|oxygen|ice cream|milk|tea|poke|breakfast|pasta|soup|bagel|donut|dessert|yogurt|waffle) bars?\b|\bbar(?:re)?\s+method\b|\bbarre\b/i
const A_BAR = /\bbars?\b/i

/**
 * A bar inside a restaurant is not a 21+ room.
 *
 * Half the restaurants in a small town are called "<something> Grill & Bar",
 * and an audit against 711 stored candidates had this gate quietly removing
 * Solid Grill & Bar, Nene's Restaurant & Bar, Aji Ceviche Bar and a coffee
 * shop called DI Coffee Bar. A food word in the name says the bar is an
 * amenity rather than the business, and a fourteen-year-old can eat there.
 *
 * Checked AFTER the drink venues, so a brewpub with a kitchen is still a
 * brewpub. It is the bare word "bar" this rescues, not "brewery".
 *
 * Which of the two words comes FIRST decides it. These names are written
 * primary-business-first and read that way to a human: "Solid Grill & Bar"
 * is a grill, "The Independent Bar & Cafe" is a bar, and the only thing
 * separating them is the order.
 */
const EATERY =
  /\b(?:restaurants?|grille?|kitchens?|cafes?|cafés?|coffee|steakhouse|seafood|sushi|ceviche|taqueria|pizzeria|pizza|bistro|diner|eatery|bakery|deli|barbecue|bbq|ramen|noodle|burgers?|tacos?|creamery|ice cream|dessert)\b/i

/** Things you go to for the drinking, whatever the venue is called. */
const DRINK_EVENT =
  /\b(?:bar|pub|brewery|beer|wine|cocktail) (?:crawl|tasting|tour|class)\b|\b(?:beer|wine|whisk(?:e)?y|tequila|rum) (?:fest\w*|tasting)\b|\bbrewfest\b|\boktoberfest\b|\bhappy hour\b|\bladies['’]? night\b|\bburlesque\b|\bwine (?:down|walk)\b/i

/**
 * Would a 20-year-old be turned away?
 *
 * Deliberately structural rather than a Candidate: engine/keywords.ts asks
 * the same question about a search term it is considering, before any
 * browser has launched and before a Candidate exists.
 */
export function isAdultOnly(x: { title: string; evidence?: string; category?: Category }): boolean {
  // The listing answered it itself.
  if (AGE_GATE.test(`${x.title} ${x.evidence ?? ""}`)) return true

  // ...and if it didn't, a book club is a book club whatever the category
  // guesser filed it under.
  if (INNOCUOUS_CLUB.test(x.title)) return false

  const name = x.title

  // A tasting is a tasting even when the room around it is all-ages: a
  // brewery you can walk a child into still runs a 21+ tour.
  if (DRINK_EVENT.test(name)) return true

  // ...and otherwise the brewery is just a brewery.
  if (ALL_AGES_DRINK.test(name)) return false

  if (ADULT_VENUE.test(name)) return true

  // A bar inside a restaurant is an amenity. Which word comes first is what
  // separates it from a bar that happens to have a kitchen.
  const bar = name.search(A_BAR)
  const food = name.search(EATERY)
  if (food !== -1 && (bar === -1 || food < bar)) return false

  // Our own categories, last and least. `nightlife` is a closed vocabulary —
  // night clubs, dance clubs, DJs — so it is adult by construction. `drink`
  // is not: the same bucket holds Coppertail Brewing and a steakhouse, which
  // is why it only counts once the name has had every chance to say what it
  // is. Left to itself it would take the breweries back out.
  if (x.category === "nightlife") return true
  if (x.category === "drink" && !EATERY.test(name)) return true

  return A_BAR.test(name) && !NOT_A_BAR.test(name)
}
