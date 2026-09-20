// ============================================================================
// trick.js — Turn order, follow-suit legality, and who won the trick.
//
// ############################################################################
// # SEATS ARE NUMBERED CLOCKWISE. PLAY RUNS ANTICLOCKWISE. nextSeat() IS -1.  #
// ############################################################################
//
// This is the single most likely thing in the repo to be got wrong, so it is
// written down here rather than left implied.
//
// Picture the table from above, everyone facing the centre. Seats 0,1,2,3 are
// numbered CLOCKWISE — the direction you would read positions off a clock face.
// Court Piece deals and plays ANTICLOCKWISE, and anticlockwise (viewed from
// above, with the players facing inward) is the direction of each player's own
// RIGHT hand. So:
//
//     next in turn order  ==  the player to your right  ==  seat - 1 (mod 4)
//
// Two rules in the game lean on that directly, and both are load-bearing:
//
//   * "The player to the dealer's right cuts, and calls trump." That player is
//     nextSeat(dealer) — the very next to play — which is why the dealer and the
//     trump-caller are ALWAYS opponents (seat and seat-1 differ in parity, and
//     team is seat parity). Several later rules assume that and would quietly
//     break if the direction flipped.
//
//   * "Dealer's team wins the deal, the deal passes one seat to the right."
//     Also nextSeat(). Same helper, same direction.
//
// The alternative — numbering seats in turn order so nextSeat() is +1 — was
// rejected on purpose. It makes the helper trivially "correct" while hiding the
// anticlockwise-ness in the renderer, which is exactly where nobody would think
// to test it. Here there is one arithmetic sign, in one function, with a test
// pinned to it.
//
// The renderer's half of the same fact: with seats clockwise and the local
// player drawn at the bottom, the screen positions at offsets 0..3 from the
// viewer are [bottom, left, top, right]. Turn order then visibly sweeps
// bottom -> right -> top -> left, which is anticlockwise on screen. See
// seatPositions() in js/ui.js.
//
// Imports only rules.js, which imports nothing. Node-safe and DOM-free.
// ============================================================================

import { SEAT_COUNT, rankValue, suitOf, suitName } from './rules.js';

// ---------------------------------------------------------------------------
// Seats, teams, turn order
// ---------------------------------------------------------------------------

/** The next player to act: anticlockwise, i.e. to the current player's right. */
export function nextSeat(seat) {
  return (seat + SEAT_COUNT - 1) % SEAT_COUNT;
}

/** The player who acted before this one — clockwise, to their left. Used by the
 *  dealer/caller relationship in reverse and by nothing on the play path. */
export function prevSeat(seat) {
  return (seat + 1) % SEAT_COUNT;
}

/** Partners sit opposite, so a partner is always two seats away — and that is
 *  true whichever direction you count, which is why this one has no handedness
 *  to get wrong. */
export function partnerOf(seat) {
  return (seat + 2) % SEAT_COUNT;
}

/** Team 0 is seats 0 and 2; team 1 is seats 1 and 3. Derived from the seat
 *  rather than stored, so partnerships cannot be dealt inconsistently. */
export function teamOf(seat) {
  return seat % 2;
}

export function areOpponents(a, b) {
  return teamOf(a) !== teamOf(b);
}

/** The four seats in play order for a trick led by `leadSeat`. */
export function seatsFrom(leadSeat) {
  const order = [];
  let s = leadSeat;
  for (let i = 0; i < SEAT_COUNT; i++) { order.push(s); s = nextSeat(s); }
  return order;
}

// ---------------------------------------------------------------------------
// Follow-suit legality
// ---------------------------------------------------------------------------

/**
 * The cards in `hand` that may legally be played, given the suit led.
 *
 * Two rules, and the second is the one people get wrong:
 *
 *   1. Follow the suit led if you hold it.
 *   2. If you do not hold it, you may play ANY card. There is no obligation to
 *      trump. A player with trumps and no card of the led suit is free to
 *      discard from a third suit instead, and often should.
 *
 * `ledSuit` is null when this player is leading, in which case everything is
 * legal.
 *
 * Returns a NEW array — never the caller's hand, even in the everything-legal
 * case, so a caller that sorts the result cannot reorder somebody's hand.
 */
export function legalPlays(hand, ledSuit) {
  if (!ledSuit) return hand.slice();
  const following = hand.filter((code) => suitOf(code) === ledSuit);
  return following.length ? following : hand.slice();
}

/** Whether one specific card may be played. The host's enforcement point; the
 *  UI's greying-out is a convenience that mirrors it, never a substitute. */
export function canPlay(hand, code, ledSuit) {
  if (!hand.includes(code)) return false;
  if (!ledSuit) return true;
  if (suitOf(code) === ledSuit) return true;
  // Holding the led suit and playing something else is the one illegal move.
  return !hand.some((c) => suitOf(c) === ledSuit);
}

/** Why a card cannot be played, phrased for an aria-label. Null when it can.
 *  Spelled out, not the one-letter suit code: this string is read aloud, and a
 *  screen reader says "must follow dee". */
export function illegalReason(hand, code, ledSuit) {
  if (canPlay(hand, code, ledSuit)) return null;
  if (!hand.includes(code)) return 'not in your hand';
  return `cannot play, must follow ${suitName(ledSuit)}`;
}

// ---------------------------------------------------------------------------
// Resolving a trick
// ---------------------------------------------------------------------------

/** The suit that was led — the suit of the first card played, always. */
export function ledSuitOf(plays) {
  return plays && plays.length ? suitOf(plays[0].code) : null;
}

/**
 * Which seat took the trick.
 *
 * `plays` is [{ seat, code }] in the order the cards hit the table, first entry
 * being the lead. `trumpSuit` is the real trump — under Hidden Rung the trump is
 * secret from the PLAYERS, but it is fully in force, and the host calling this
 * always knows it. Hiding it is js/state.js's job at the publicState() boundary,
 * not this function's.
 *
 * Highest trump wins. If nobody trumped, the highest card of the suit led wins.
 * Cards of any other suit cannot win regardless of rank, which is what makes a
 * discard a discard.
 */
export function trickWinner(plays, trumpSuit) {
  if (!plays || !plays.length) return null;

  const led = ledSuitOf(plays);
  const trumped = plays.some((p) => suitOf(p.code) === trumpSuit);
  // Once anyone has trumped, the led suit stops mattering entirely — a
  // contest between trumps is the only contest left.
  const suitThatWins = trumped ? trumpSuit : led;

  let best = null;
  for (const play of plays) {
    if (suitOf(play.code) !== suitThatWins) continue;
    if (!best || rankValue(play.code) > rankValue(best.code)) best = play;
  }
  return best ? best.seat : null;
}

/**
 * Whether this player's PARTNER is currently winning the part-played trick.
 *
 * Lives here rather than in the bot because it is the same question the UI asks
 * to decide what to highlight, and two copies of it would be two chances to get
 * the trump comparison wrong. `plays` may be shorter than four.
 */
export function partnerWinning(plays, seat, trumpSuit) {
  if (!plays || !plays.length) return false;
  const leader = trickWinner(plays, trumpSuit);
  return leader !== null && leader === partnerOf(seat);
}

/** The card currently beating the others, or null on an empty trick. Handy for
 *  "you would need to beat the King of hearts" in the UI. */
export function winningCard(plays, trumpSuit) {
  const seat = trickWinner(plays, trumpSuit);
  if (seat === null) return null;
  const play = plays.find((p) => p.seat === seat);
  return play ? play.code : null;
}
