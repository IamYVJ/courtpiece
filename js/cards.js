// ============================================================================
// cards.js — The deck, the shuffle, and how a Court Piece hand is dealt out.
//
// Dealing is PACKETS, not round-the-table singles: each player is handed five
// cards at once, then four, then four. That is how the physical game is dealt
// and it is not cosmetic — the five-card packet is what the trump-caller looks
// at before naming a suit, so the boundary between packets is a real moment in
// the game rather than a loop that happens to pause.
//
// Every function here is pure except shuffle(), which reads the platform CSPRNG
// through the same crypto.getRandomValues indirection sequence uses, so the
// headless harness can swap in a seeded stream and reproduce a failing deal.
//
// Imports only rules.js and trick.js, neither of which touches the DOM.
// ============================================================================

import { SUITS, RANKS, DECK_SIZE, HAND_SIZE, DEAL_BATCHES, SEAT_COUNT, suitOf, rankValue } from './rules.js';
import { seatsFrom } from './trick.js';

// A wrong constant here deals a game that is subtly not Court Piece — four
// players short a card each, or a packet that overruns the deck — and the
// symptom would surface much later as a strange trick. Cheap to check once at
// module load, and it runs in the browser and in `node` alike.
if (DEAL_BATCHES.reduce((a, b) => a + b, 0) !== HAND_SIZE) {
  throw new Error('DEAL_BATCHES must sum to HAND_SIZE');
}
if (SEAT_COUNT * HAND_SIZE !== DECK_SIZE) {
  throw new Error('SEAT_COUNT * HAND_SIZE must consume the whole deck');
}

/** A fresh, ordered 52-card deck. One deck, so a code is unique and is also the
 *  card's identity — see the note on codes in rules.js. */
export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit);
  }
  return deck;
}

/** Fisher-Yates, returning a new array. */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Read at call time, not captured at module load, so a test can replace
// globalThis.crypto before constructing anything and still be obeyed.
function randomBelow(n) {
  try {
    const source = typeof crypto !== 'undefined' ? crypto : globalThis.crypto;
    if (source && source.getRandomValues) {
      const buf = new Uint32Array(1);
      source.getRandomValues(buf);
      return buf[0] % n;
    }
  } catch (_) { /* fall through */ }
  return Math.floor(Math.random() * n);
}

/**
 * Deal one packet of `count` cards to every seat.
 *
 * Pure: takes the stock and the hands so far, hands back new ones. The engine
 * calls this three times across two phases (five, declare trump, four, four),
 * so it cannot be a single loop that deals the whole hand — the pause in the
 * middle is where DECLARE_TRUMP happens.
 *
 * `startSeat` is who receives first, and the packet then travels in turn order,
 * which is anticlockwise. The dealer deals to their right first and themselves
 * last, so the engine passes nextSeat(dealer) — who is also the trump-caller.
 *
 * Throws if the stock is short. That is unreachable given the assertions above,
 * and it is a throw rather than a silent short hand because a player quietly
 * holding twelve cards is a bug that would not surface until the last trick.
 */
export function dealPacket(stock, hands, count, startSeat) {
  if (stock.length < count * SEAT_COUNT) {
    throw new Error(`dealPacket: stock has ${stock.length}, needs ${count * SEAT_COUNT}`);
  }
  const rest = stock.slice();
  const out = hands.map((h) => h.slice());
  for (const seat of seatsFrom(startSeat)) {
    out[seat] = out[seat].concat(rest.splice(0, count));
  }
  return { hands: out, stock: rest };
}

/** Four empty hands, indexed by seat. */
export function emptyHands() {
  return Array.from({ length: SEAT_COUNT }, () => []);
}

/**
 * Deal the whole thing in one go. Used by the tests and the bot's own
 * simulations; the engine deals packet by packet instead, because it has to
 * stop in the middle and ask for a trump.
 */
export function dealAll(deck, dealerSeat) {
  let hands = emptyHands();
  let stock = deck.slice();
  const first = (dealerSeat + SEAT_COUNT - 1) % SEAT_COUNT;
  for (const count of DEAL_BATCHES) {
    ({ hands, stock } = dealPacket(stock, hands, count, first));
  }
  return { hands, stock };
}

// ---------------------------------------------------------------------------
// Sorting a hand for display
// ---------------------------------------------------------------------------

// Black, red, black, red. Adjacent suits differ in colour, which is what stops
// a fan of thirteen cards reading as one undifferentiated block on a phone.
const DISPLAY_ORDER = Object.freeze(['S', 'H', 'C', 'D']);

/**
 * Group by suit, ranks descending within a suit.
 *
 * The trump suit is pulled to the front when it is known, because the one
 * question you ask of your own hand most often is "how many trumps have I
 * left". Under Hidden Rung, before the reveal, `trumpSuit` is null here even on
 * the caller's own device — the sort order is public information (a partner can
 * watch which end of your fan you play from), so leaking it there would leak it
 * everywhere.
 *
 * Pulling trump to the front can break the colour alternation. That is the
 * lesser cost: a misread suit is recoverable, a miscounted trump is not.
 */
export function sortHand(hand, trumpSuit = null) {
  const order = trumpSuit && DISPLAY_ORDER.includes(trumpSuit)
    ? [trumpSuit, ...DISPLAY_ORDER.filter((s) => s !== trumpSuit)]
    : DISPLAY_ORDER;
  return hand.slice().sort((a, b) => {
    const suitDiff = order.indexOf(suitOf(a)) - order.indexOf(suitOf(b));
    if (suitDiff !== 0) return suitDiff;
    return rankValue(b) - rankValue(a);
  });
}

/** How many of each suit a hand holds. The trump-caller's whole decision, and
 *  the bot's void tracking, are both counting exercises over this. */
export function suitCounts(hand) {
  const counts = { S: 0, H: 0, D: 0, C: 0 };
  for (const code of hand) counts[suitOf(code)] += 1;
  return counts;
}
