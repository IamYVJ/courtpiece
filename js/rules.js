// ============================================================================
// rules.js — The vocabulary of Court Piece: cards, the table, what counts as a
// win, and the two things the host is allowed to configure.
//
// No state and no engine here. Everything is a constant or a pure function of
// its arguments, so this module is safe to import from the bot, the tests, the
// UI and a future server alike.
//
// Imports nothing, from anywhere. `node` can exercise every rule in here and the
// browser can load it with no build step.
// ============================================================================

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export const SUITS = Object.freeze(['S', 'H', 'D', 'C']);

// DESCENDING, ace high. The order of this array IS the strength order — see
// rankValue() — so reversing it would silently invert every trick in the game.
export const RANKS = Object.freeze(['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']);

// A card is a two-character code: rank then suit, e.g. 'AS', 'TH', '2C'.
//
// Unlike sequence — which shuffles two decks together and therefore needs an
// `id` distinct from the printed `code` — Court Piece uses ONE deck, so a code
// is already unique across the game and doubles as the card's identity. Hands
// are plain arrays of these strings. That is worth the divergence: it halves the
// bytes on the wire and removes a whole class of "compared the id, meant the
// code" bug from the follow-suit check.
export function rankOf(code) { return code[0]; }
export function suitOf(code) { return code[1]; }

// Ace 14 down to deuce 2. Derived from RANKS rather than written out, so the two
// cannot drift apart.
const RANK_VALUE = Object.freeze(
  RANKS.reduce((acc, rank, i) => { acc[rank] = RANKS.length + 1 - i; return acc; }, Object.create(null)),
);

/** Strength of a card's rank. Only ever compared against another card of the
 *  SAME suit — across suits, whether a card wins is a question about trumps and
 *  the led suit, not about rank. See trickWinner() in js/trick.js. */
export function rankValue(code) { return RANK_VALUE[rankOf(code)] || 0; }

export function isRedSuit(suit) { return suit === 'H' || suit === 'D'; }
export function isRedCard(code) { return isRedSuit(suitOf(code)); }

const SUIT_GLYPHS = Object.freeze({ S: '♠', H: '♥', D: '♦', C: '♣' });
const SUIT_NAMES  = Object.freeze({ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' });
const RANK_NAMES  = Object.freeze({
  A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
});

export function suitGlyph(suit) { return SUIT_GLYPHS[suit] || ''; }
export function suitName(suit)  { return SUIT_NAMES[suit] || ''; }

/** Display rank — 'T' is stored for the ten so every code is two characters. */
export function rankLabel(code) { return rankOf(code) === 'T' ? '10' : rankOf(code); }

/** Spoken form, for aria-labels and the live region: "Queen of hearts". */
export function cardName(code) {
  return `${RANK_NAMES[rankOf(code)] || rankOf(code)} of ${suitName(suitOf(code))}`;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** Exactly four. Not a configurable maximum — fixed partnerships sitting
 *  opposite each other IS the game, and three or five players is a different
 *  one. */
export const SEAT_COUNT = 4;

export const TEAM_COUNT = 2;

export const DECK_SIZE = 52;
export const HAND_SIZE = 13;
export const TRICKS_PER_DEAL = 13;

/** The packet sizes, in order. Five first so the caller can see enough to name a
 *  trump, then the rest in fours. Sums to HAND_SIZE, which js/cards.js asserts
 *  at module load rather than assumes. */
export const DEAL_BATCHES = Object.freeze([5, 4, 4]);

/** Seven of thirteen. Once a team has this many the deal is decided and play may
 *  stop — the remaining tricks cannot change who won it. */
export const TRICKS_TO_WIN = 7;

// ---------------------------------------------------------------------------
// The court
// ---------------------------------------------------------------------------

/**
 * The team that scored a COURT (kot / kap / coat), or null.
 *
 * `winnerTeams` is the team that took each trick, in trick order.
 *
 * The definition has two clauses — "took the opening seven tricks" and "with the
 * opponents on zero" — but they describe the same event: if one team takes
 * tricks 1 through 7 then the opponents necessarily have none, and if the
 * opponents have none after seven tricks then one team took all seven. So this
 * checks the first clause only, and the second is a consequence rather than a
 * second test.
 *
 * Deliberately reads only the OPENING seven. A team that loses trick one and
 * then takes the next seven has won the deal but has NOT scored a court, and
 * counting that is the most likely way to get this wrong.
 */
export function courtTeam(winnerTeams) {
  if (!Array.isArray(winnerTeams) || winnerTeams.length < TRICKS_TO_WIN) return null;
  const first = winnerTeams[0];
  for (let i = 1; i < TRICKS_TO_WIN; i++) {
    if (winnerTeams[i] !== first) return null;
  }
  return first;
}

// ---------------------------------------------------------------------------
// The match
//
// A court is the only thing that scores, so how a match ends is entirely a
// question about courts. There are two defensible answers and the host picks
// between them.
//
//   RACE  — first team to N courts. Always produces a winner and never needs a
//           tie-break, but the match runs for as many deals as it takes, which
//           is not a number you can tell people in advance.
//   DEALS — play N deals; most deals won, courts breaking the tie. Predictable
//           length, which is what you want if the table has somewhere to be.
//
// Neither is the "real" rule; the sources say "most courts over an agreed
// number of deals" and tables plainly play it both ways.
//
// HOW RARE A COURT ACTUALLY IS, measured rather than guessed. The bot soak in
// scripts/test-engine.mjs plays a thousand deals of even-strength Court Piece
// and courts roughly 6.6% of them — about one deal in fifteen. Both numbers
// below are set from that measurement, and both would be wrong without it.
// ---------------------------------------------------------------------------

export const MATCH_MODES = Object.freeze(['race', 'deals']);

/**
 * Courts needed in RACE mode.
 *
 * DEFAULT 1, WHICH LOOKS TIMID AND IS NOT. At a 6.6% court rate the measured
 * match lengths are: first-to-1, median 11 deals; first-to-2, median 39;
 * first-to-3, median 62. Two courts is a three-hour sitting on a phone, which
 * is not a default — it is a way of making sure nobody ever sees MATCH_OVER.
 *
 * One court is also the more faithful reading. A court is seven straight
 * tricks against opponents on zero; it is the whole point of the game and the
 * thing the game is named around. Making it the finish line rather than a
 * point on the way to one is what gives it its weight.
 *
 * The longer targets stay on the menu for tables that want the evening.
 */
export const MATCH_TARGET_OPTIONS = Object.freeze([1, 2, 3, 5]);
export const MATCH_TARGET_DEFAULT = 1;

/** Deals played in DEALS mode. Multiples of four so the deal can pass all the
 *  way round the table at least once, which it only does if the same team keeps
 *  winning — but it makes the numbers read as whole rounds rather than arbitrary. */
export const DEAL_TARGET_OPTIONS = Object.freeze([4, 8, 12, 16]);
export const DEAL_TARGET_DEFAULT = 8;

/**
 * Who won a DEALS-mode match. Deals won first, then courts, then a draw.
 *
 * DEALS WON IS THE HEADLINE, AND THAT ORDER IS DELIBERATE — it used to be the
 * other way round. Ranking on courts first sounds better and describes almost
 * nothing: at the measured 6.6% court rate, 62% of eight-deal matches end
 * nil-nil on courts, so the "tie-break" was quietly deciding nearly two
 * matches in three. A rule that fires that often is not a tie-break, it is the
 * rule, and it should be the one written at the top.
 *
 * It is also the better match for what the table experiences. Over a fixed
 * eight deals the number everyone has been tracking is deals; a court is the
 * spectacular thing that may or may not happen. Deciding on the number people
 * were actually counting beats deciding on one that was zero all evening.
 *
 * Courts still matter, and matter more than before: they now settle 4–4, which
 * is the one place the deal count genuinely cannot separate two teams — and
 * "you were level, but we courted you once" is a satisfying way to lose.
 *
 * NOTE THIS IS DEALS-MODE ONLY. Race mode never calls it: it ends the instant a
 * team reaches courtsToWin, so there is nothing to break.
 *
 * NO SUDDEN-DEATH DEAL, whichever order the criteria run in. It would extend a
 * match whose entire selling point was a known length.
 *
 * A genuine draw is a real outcome and is returned as null rather than broken
 * by a coin toss. Level on deals AND level on courts over an even number of
 * deals is two teams that played each other to a standstill, and saying so is
 * more honest than inventing a winner. Callers must therefore distinguish
 * "no winner yet" from "no winner, ever" — see `matchOver` in js/state.js,
 * which is why that flag exists separately from `matchWinner`.
 */
export function decideMatch(courts, dealsWon) {
  if (dealsWon[0] !== dealsWon[1]) return dealsWon[0] > dealsWon[1] ? 0 : 1;
  if (courts[0] !== courts[1]) return courts[0] > courts[1] ? 0 : 1;
  return null;
}

// ---------------------------------------------------------------------------
// Host configuration
//
// Four keys, and that is the whole surface. Everything else about Court Piece
// is fixed by the rules, so there is nothing else honest to offer.
//
// Both targets are always present, not one field reinterpreted by the mode.
// Switching modes in the lobby and switching back should give you the number
// you had before, and a single `target` field would silently clamp 8 deals into
// 8 courts on the way past.
// ---------------------------------------------------------------------------

export const DEFAULTS = Object.freeze({
  // Classic: the trump is announced out loud. With this on, it is chosen
  // face-down and stays secret until the first player who cannot follow suit.
  hiddenRung: false,
  matchMode: 'race',
  courtsToWin: MATCH_TARGET_DEFAULT,
  dealsToPlay: DEAL_TARGET_DEFAULT,
});

export const RULE_KEYS = Object.freeze(Object.keys(DEFAULTS));

/**
 * Rebuild a config from the known key list.
 *
 * Rebuilt rather than merged, so an unknown or hostile key arriving over the
 * wire is dropped instead of stored — the same reasoning as sequence's
 * normalizeConfig(). js/guards.js bounds the SIZE of an inbound patch; this
 * bounds its shape.
 *
 * Every value is checked against its own allow-list rather than range-checked,
 * so a hostile `dealsToPlay: 1e9` becomes the default instead of a match that
 * never ends.
 */
export function normalizeConfig(patch) {
  const src = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch : {};
  return {
    hiddenRung: !!src.hiddenRung,
    matchMode: MATCH_MODES.includes(src.matchMode) ? src.matchMode : 'race',
    courtsToWin: MATCH_TARGET_OPTIONS.includes(src.courtsToWin)
      ? src.courtsToWin
      : MATCH_TARGET_DEFAULT,
    dealsToPlay: DEAL_TARGET_OPTIONS.includes(src.dealsToPlay)
      ? src.dealsToPlay
      : DEAL_TARGET_DEFAULT,
  };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const MAX_NAME_LEN = 16;

/**
 * Collapse whitespace, drop control characters, cap the length.
 *
 * A name is rendered at four seats and read aloud across a table; it is not a
 * credential and never stands in for one (see clientId in js/util.js).
 *
 * Written as a codepoint filter rather than a regex because the character class
 * it would need is made of literal control bytes, and a source file containing
 * a raw NUL is a hazard to every tool that later reads it.
 */
export function cleanName(raw) {
  let out = '';
  for (const ch of String(raw == null ? '' : raw)) {
    const cp = ch.codePointAt(0);
    // C0 controls, DEL, and the C1 block. Control whitespace (tab, newline) is
    // dropped here rather than collapsed, which is fine: a name has no lines.
    if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}
