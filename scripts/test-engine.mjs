// Headless test of the Court Piece engine. No browser, no network.
//   node scripts/test-engine.mjs
//
// The first half is the pure layer: the card vocabulary, the ANTICLOCKWISE turn
// order, follow-suit legality (including the "may play anything, need not
// trump" case), and the trick winner with and without trumps.
//
// The second half drives the real GameEngine through whole deals and whole
// matches, and closes with a soak of two hundred deals in each of the two match
// modes, played by a random legal mover — harsher than a sensible bot, because
// it reaches positions no sensible player would.

import {
  SUITS, RANKS, SEAT_COUNT, DECK_SIZE, HAND_SIZE, TRICKS_TO_WIN, TRICKS_PER_DEAL,
  DEAL_BATCHES, MATCH_TARGET_DEFAULT, DEAL_TARGET_DEFAULT, DEFAULTS,
  rankOf, suitOf, rankValue, rankLabel, cardName, suitName, courtTeam, decideMatch,
  normalizeConfig, cleanName,
} from '../js/rules.js';
import {
  nextSeat, prevSeat, partnerOf, teamOf, areOpponents, seatsFrom,
  legalPlays, canPlay, illegalReason, ledSuitOf, trickWinner, partnerWinning,
  winningCard,
} from '../js/trick.js';
import {
  buildDeck, shuffle, dealPacket, dealAll, emptyHands, sortHand, suitCounts,
} from '../js/cards.js';
import { GameEngine, PHASES, DEAL_PAUSE_MS, TRICK_PAUSE_MS } from '../js/state.js';
import {
  MAX_TYPE_LEN, MAX_FRAME_BYTES, MAX_RAW_NAME_LEN, TokenBucket,
  validEnvelope, validClientId, validPlayerId, validCardCode, validSuit,
  validSeat, validName, validConfigPatch, decodePeerFrame,
  validPublicState, validPrivateState,
} from '../js/guards.js';
import {
  PLAYER_INTENTS, OWNER_INTENTS, GAME_INTENTS, applyGameIntent,
} from '../js/intents.js';
import {
  BOT_THINK_MS, OFFLINE_GRACE_MS, chooseCard, chooseTrump, chooseIntent, createBotDriver,
} from '../js/bot.js';
// The transport's pure half. net.js is importable in node because it touches
// `window` only INSIDE peerAvailable() and newPeer(), never at module load —
// which is also what makes the graceful "PeerJS did not load" path possible in
// the browser. Nothing below opens a connection or needs a broker.
import {
  PEER_PREFIX, CONN_ID_PREFIX, MAX_HOST_CONNS, MAX_REFUSED_FRAMES,
  peerIdForCode, codeFromPeerId, playerIdForConn, connIdForPlayer,
  stateFrameFor, isFatalPeerError, describePeerError, peerAvailable,
} from '../js/net.js';
// The renderer's seat geometry and its selection rule — the two pieces of
// js/ui.js that are pure. It is importable here because ui.js touches no DOM at
// module load — see the note at the top of that file. The screen layout is where
// the anticlockwise rule is most likely to break unnoticed, so it gets tested
// like everything else rather than eyeballed on a phone.
import { SCREEN_SLOTS, seatPositions, slotOf, playableSelection, teamLabel } from '../js/ui.js';
// The stylesheet, the service worker and the manifest are all checked as TEXT
// rather than parsed or executed — see the log-kind and PWA-shell sections for
// why that is the right level of effort in each case.
import {
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
  existsSync as fsExistsSync,
} from 'node:fs';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function same(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log('\n— ' + t); }

// ---------------------------------------------------------------------------
// Deterministic RNG.
//
// cards.js shuffles through crypto.getRandomValues, so an unseeded run deals a
// different game every time and a failure cannot be reproduced. cards.js reads
// `crypto` at call time, so replacing the global here — before anything is
// dealt — is enough. seed(n) restarts the stream.
// ---------------------------------------------------------------------------
let prng = 0;
function seed(n) { prng = n >>> 0; }
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    getRandomValues(buf) {
      for (let i = 0; i < buf.length; i++) {
        prng = (prng + 0x6D2B79F5) >>> 0;
        let t = prng;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        buf[i] = (t ^ (t >>> 14)) >>> 0;
      }
      return buf;
    },
  },
});
seed(1);

// ===========================================================================
section('Card vocabulary');
// ===========================================================================

eq(SUITS.length, 4, 'four suits');
eq(RANKS.length, 13, 'thirteen ranks');
eq(rankOf('TH'), 'T', 'rankOf reads the first character');
eq(suitOf('TH'), 'H', 'suitOf reads the second character');

// Ace high is the whole point; a silent off-by-one here inverts every trick.
ok(rankValue('AS') > rankValue('KS'), 'ace beats king');
ok(rankValue('KS') > rankValue('QS'), 'king beats queen');
ok(rankValue('TS') > rankValue('9S'), 'ten beats nine');
ok(rankValue('3S') > rankValue('2S'), 'three beats deuce');
eq(rankValue('2S'), 2, 'deuce is 2');
eq(rankValue('AS'), 14, 'ace is 14');

// RANKS is descending, so strength must fall monotonically across it.
let monotonic = true;
for (let i = 1; i < RANKS.length; i++) {
  if (rankValue(RANKS[i] + 'S') >= rankValue(RANKS[i - 1] + 'S')) monotonic = false;
}
ok(monotonic, 'rankValue falls monotonically across RANKS');

eq(rankLabel('TH'), '10', 'the ten displays as 10, not T');
eq(rankLabel('AH'), 'A', 'other ranks display as stored');
eq(cardName('QH'), 'Queen of hearts', 'spoken card name');
eq(cardName('TS'), '10 of spades', 'spoken ten');
eq(suitName('C'), 'clubs', 'spoken suit name');

// ===========================================================================
section('Deck');
// ===========================================================================

const deck = buildDeck();
eq(deck.length, DECK_SIZE, 'deck is 52 cards');
eq(new Set(deck).size, DECK_SIZE, 'every card in the deck is distinct');
ok(deck.every((c) => c.length === 2), 'every code is two characters');
for (const suit of SUITS) {
  eq(deck.filter((c) => suitOf(c) === suit).length, 13, `thirteen cards in ${suit}`);
}
for (const rank of RANKS) {
  eq(deck.filter((c) => rankOf(c) === rank).length, 4, `four cards of rank ${rank}`);
}

const shuffled = shuffle(deck);
eq(shuffled.length, DECK_SIZE, 'shuffle preserves the count');
same([...shuffled].sort(), [...deck].sort(), 'shuffle is a permutation, loses nothing');
ok(shuffled.join() !== deck.join(), 'shuffle actually reorders');
same(deck, buildDeck(), 'shuffle does not mutate its argument');

// ===========================================================================
section('Turn order — ANTICLOCKWISE');
// ===========================================================================

// Seats are numbered clockwise, so the next player in turn order is seat - 1.
// These four are the pin: if the sign in nextSeat() ever flips, this fails.
eq(nextSeat(0), 3, 'after seat 0 comes seat 3, not seat 1');
eq(nextSeat(3), 2, 'after seat 3 comes seat 2');
eq(nextSeat(2), 1, 'after seat 2 comes seat 1');
eq(nextSeat(1), 0, 'after seat 1 comes seat 0');

same(seatsFrom(0), [0, 3, 2, 1], 'play order from seat 0 is anticlockwise');
same(seatsFrom(2), [2, 1, 0, 3], 'play order from seat 2 is anticlockwise');

// Four steps must return to the start, from every seat.
for (let s = 0; s < SEAT_COUNT; s++) {
  eq(nextSeat(nextSeat(nextSeat(nextSeat(s)))), s, `four steps from seat ${s} return home`);
  eq(prevSeat(nextSeat(s)), s, `prevSeat undoes nextSeat at seat ${s}`);
  eq(new Set(seatsFrom(s)).size, SEAT_COUNT, `play order from seat ${s} visits every seat once`);
}

// Partnerships.
for (let s = 0; s < SEAT_COUNT; s++) {
  eq(partnerOf(partnerOf(s)), s, `partnership is symmetric at seat ${s}`);
  eq(teamOf(s), teamOf(partnerOf(s)), `seat ${s} shares a team with its partner`);
  ok(partnerOf(s) !== s, `seat ${s} is not its own partner`);
  ok(areOpponents(s, nextSeat(s)), `seat ${s} and the next to play are opponents`);
}
eq(partnerOf(0), 2, 'seat 0 partners seat 2 (opposite)');
eq(partnerOf(1), 3, 'seat 1 partners seat 3 (opposite)');
eq(teamOf(0), teamOf(2), 'seats 0 and 2 are one team');
eq(teamOf(1), teamOf(3), 'seats 1 and 3 are the other');
ok(teamOf(0) !== teamOf(1), 'adjacent seats are on opposing teams');

// The rule that several later rules depend on: because play is anticlockwise,
// the trump-caller is nextSeat(dealer), and a dealer is never partnered with
// the player to their right.
for (let dealer = 0; dealer < SEAT_COUNT; dealer++) {
  const caller = nextSeat(dealer);
  ok(areOpponents(dealer, caller), `dealer ${dealer} and trump-caller ${caller} are opponents`);
  ok(partnerOf(dealer) !== caller, `dealer ${dealer} is not partnered with the caller`);
}

// ===========================================================================
section('Turn order — ANTICLOCKWISE ON SCREEN');
// ===========================================================================
//
// The renderer's half of the same fact, pinned here rather than left to be
// noticed by eye on a phone. js/ui.js maps a seat to one of four screen
// positions; nothing about that mapping reverses anything, so the direction
// play appears to run is a CONSEQUENCE of the seat numbering. Which means it
// can break silently from a long way away: flip the sign in nextSeat(), or
// renumber the seats anticlockwise, and the game would still be internally
// consistent while every table on every device quietly ran backwards.
//
// These assertions are what makes that impossible to do quietly.

same(SCREEN_SLOTS, ['bottom', 'left', 'top', 'right'],
  'screen positions run CLOCKWISE from the viewer — the same direction seats are numbered');

for (let me = 0; me < SEAT_COUNT; me++) {
  const at = seatPositions(me);
  eq(at.bottom, me, `viewed from seat ${me}, you are at the bottom`);
  eq(at.top, partnerOf(me), `viewed from seat ${me}, your partner is opposite you`);
  ok(areOpponents(me, at.left), `viewed from seat ${me}, the left-hand seat is an opponent`);
  ok(areOpponents(me, at.right), `viewed from seat ${me}, the right-hand seat is an opponent`);
  eq(new Set(Object.values(at)).size, SEAT_COUNT, `viewed from seat ${me}, all four seats are drawn once`);

  // The two helpers are inverses; ui.js uses both and they must not drift.
  for (const slot of SCREEN_SLOTS) {
    eq(slotOf(at[slot], me), slot, `seat ${at[slot]} draws at ${slot} from seat ${me}`);
  }

  // THE ONE THAT MATTERS. A trick led by you sweeps bottom, right, top, left
  // — which is anticlockwise as drawn.
  same(seatsFrom(me).map((s) => slotOf(s, me)), ['bottom', 'right', 'top', 'left'],
    `a trick you lead sweeps anticlockwise on your screen (from seat ${me})`);
}

// And it stays anticlockwise whoever leads and whoever is watching: sixteen
// viewer/leader pairs, every one of them a rotation of the same cycle. A
// mapping that was right only when you happened to lead would look correct in
// casual testing and be wrong three turns in four.
const CYCLE = ['bottom', 'right', 'top', 'left'];
let allAnticlockwise = true;
for (let viewer = 0; viewer < SEAT_COUNT; viewer++) {
  for (let leader = 0; leader < SEAT_COUNT; leader++) {
    const drawn = seatsFrom(leader).map((s) => slotOf(s, viewer));
    const start = CYCLE.indexOf(drawn[0]);
    const expected = CYCLE.slice(start).concat(CYCLE.slice(0, start));
    if (JSON.stringify(drawn) !== JSON.stringify(expected)) allAnticlockwise = false;
  }
}
ok(allAnticlockwise, 'every leader, seen from every seat, sweeps anticlockwise on screen');

// ===========================================================================
section('Selection — the UI never offers a play the host will refuse');
// ===========================================================================
//
// Tapping a card off-turn is allowed on purpose: picking one up to look at it
// is not a move. So a selection outlives the moment it was made, and by the
// time your turn arrives the card may be unplayable — the trick opened in a
// suit you hold, and the diamond you were eyeing is a renege.
//
// The card greys out and disables on its own. The SELECTION behind it did not:
// it kept `PLAY J♦` on screen, and pressing it earned a red rejection from the
// host. The host was right — it is the only thing that adjudicates legality,
// and that never changes. But a refusal must not be reachable from a button
// this app drew, because greying out illegal cards is a convenience and players
// learn to trust it.
//
// js/ui.js and main.js's draw() both run this one function so they cannot drift.
{
  const hand = (...cards) => cards.map(([code, legal]) => ({ code, legal }));
  const mine = hand(['JD', false], ['7H', true], ['6H', true]);

  eq(playableSelection('7H', { hand: mine, isTurn: true }), '7H',
    'a legal card on your turn is a selection');
  eq(playableSelection('JD', { hand: mine, isTurn: true }), null,
    'AN ILLEGAL CARD ON YOUR TURN IS NOT — no PLAY button, no rejection to read');

  // Off-turn nothing is illegal yet, and picking a card up has to keep working:
  // it is how you plan the trick while three bots think.
  eq(playableSelection('JD', { hand: mine, isTurn: false }), 'JD',
    'off-turn the same card IS a selection — looking at a card is not a move');

  // The card left the hand. This is what drops the lift after a play lands.
  eq(playableSelection('AS', { hand: mine, isTurn: false }), null,
    'a card not in the hand is never a selection');
  eq(playableSelection(null, { hand: mine, isTurn: true }), null, 'no tap, no selection');
  eq(playableSelection('7H', null), null, 'and a spectator, with no hand at all, has none');

  // The trap this is really guarding: a card refused on trick 2 must not
  // silently re-arm on trick 3 when its suit is led. draw() writes the result
  // back, so the stale pick is gone rather than merely unrendered.
  const laterHand = hand(['JD', true], ['7H', true]);
  eq(playableSelection(playableSelection('JD', { hand: mine, isTurn: true }), { hand: laterHand, isTurn: true }),
    null, 'once cleared it stays cleared — a stale pick cannot re-arm itself next trick');
}

// A watching screen has no seat, so it has no "we" and no "they" — it names a
// team by the two people on it. That is the one piece of the TV view that is
// about the GAME rather than the pixels: get the pairing wrong and the screen
// the whole room is reading credits a deal to the wrong side.
{
  const seat = (name) => ({ name });
  const pub = { seats: [seat('Asha'), seat('Bilal'), seat('Chitra'), seat('Dev')] };
  eq(teamLabel(pub, 0), 'Asha & Chitra', 'team 0 is seats 0 and 2 — the two sitting opposite');
  eq(teamLabel(pub, 1), 'Bilal & Dev', 'team 1 is seats 1 and 3');
  for (const s of [0, 1, 2, 3]) {
    ok(teamLabel(pub, teamOf(s)).includes(pub.seats[s].name) &&
       teamLabel(pub, teamOf(s)).includes(pub.seats[partnerOf(s)].name),
    `seat ${s} is named alongside its partner, never an opponent`);
  }
  eq(teamLabel({ seats: [seat('Asha'), null, null, null] }, 0), 'Asha',
    'a half-filled lobby names whoever is there');
  eq(teamLabel({ seats: [null, null, null, null] }, 1), 'Team 2',
    'and an empty side falls back to a number rather than an empty string');
  eq(teamLabel(pub, null), 'Nobody', 'no team is nobody — a drawn match has no winner to name');
}

// ===========================================================================
section('Stylesheet — a log kind is a class name');
// ===========================================================================
//
// js/ui.js puts each log line's event kind on the <li> as a class, so a line
// about a trick is `.log-line.trick`. That means every log kind is a live
// class name in the document, and any BARE selector in the stylesheet sharing
// that name applies to it.
//
// This is not hypothetical. `.trick` styled the 3x3 grid of played cards on
// the play screen, and quietly gave every trick line in the log a 190px
// min-height and an ↺ from its ::before. Nothing failed; the log just looked
// wrong, in a way you only catch by scrolling to the bottom of a finished
// deal. The layout rule is now `.trick-grid`.
//
// So: read both files, and assert the two namespaces do not overlap.
{
  const readFile = (p) => fsReadFileSync(new URL(p, import.meta.url), 'utf8');
  const engineSrc = readFile('../js/state.js');
  const cssSrc = readFile('../css/styles.css');

  // Every kind the engine can stamp on a log entry.
  const kinds = [...new Set(
    [...engineSrc.matchAll(/_say\([\s\S]*?,\s*'([a-z]+)'/g)].map((m) => m[1]),
  )].sort();
  ok(kinds.length >= 4, `the engine stamps several log kinds (${kinds.join(', ')})`);
  ok(kinds.includes('trick'), "including 'trick', the one that caused this");

  // Every selector in the stylesheet that is a bare class at the start of a
  // rule — `.foo {`, `.foo.bar`, `.foo, .baz`, `.foo::before`, `.foo .child`.
  // Those are exactly the ones that match an element on class alone.
  const bare = new Set(
    [...cssSrc.matchAll(/^\.([a-z][a-z0-9-]*)(?=[\s,:.{])/gm)].map((m) => m[1]),
  );
  const clashes = kinds.filter((k) => bare.has(k));
  same(clashes, [],
    'NO BARE CSS SELECTOR SHARES A NAME WITH A LOG KIND — it would style the log line too');

  // The other half of the same coin. `.log-line .kind` renders the tag in
  // --muted, and the loud events are supposed to override it — that is the
  // entire reason _say() takes a kind. `reveal` shipped without a rule and
  // nobody noticed, because a missing colour is not a broken page: the rung
  // turning face up, the loudest line in a Hidden Rung deal, was drawn in
  // exactly the same grey as "Ali takes trick 4".
  //
  // Only the four that END or TURN something are required. `trick` and `info`
  // are the background hum of the log and are meant to stay grey.
  for (const loud of ['trump', 'reveal', 'court', 'match']) {
    ok(kinds.includes(loud), `the engine stamps '${loud}' on a log line`);
    ok(new RegExp(`\\.log-line\\.${loud} \\.kind`).test(cssSrc),
      `and .log-line.${loud} .kind is coloured, so the loud line looks loud`);
  }
}

// ===========================================================================
section('Dealing — 5 / 4 / 4');
// ===========================================================================

same(DEAL_BATCHES, [5, 4, 4], 'packets are five then four then four');
eq(DEAL_BATCHES.reduce((a, b) => a + b, 0), HAND_SIZE, 'packets sum to thirteen');

{
  // Packet by packet, the way the engine does it, with the pause for the trump
  // declaration after the first five.
  let hands = emptyHands();
  let stock = buildDeck();
  const dealer = 2;
  const first = nextSeat(dealer);
  eq(first, 1, 'dealing starts to the dealer\'s right');

  ({ hands, stock } = dealPacket(stock, hands, 5, first));
  ok(hands.every((h) => h.length === 5), 'after the first packet everyone holds five');
  eq(stock.length, DECK_SIZE - 20, 'thirty-two cards left before the trump call');

  ({ hands, stock } = dealPacket(stock, hands, 4, first));
  ({ hands, stock } = dealPacket(stock, hands, 4, first));
  ok(hands.every((h) => h.length === HAND_SIZE), 'everyone ends on thirteen');
  eq(stock.length, 0, 'the deck is exhausted');

  const all = hands.flat();
  eq(all.length, DECK_SIZE, 'every card was dealt');
  eq(new Set(all).size, DECK_SIZE, 'no card was dealt twice');

  // The first five are a contiguous packet off the top, handed to the caller
  // whole — not five singles collected round the table.
  same(hands[first].slice(0, 5), buildDeck().slice(0, 5), 'the first packet is contiguous');
}

{
  // dealAll agrees with the packet-by-packet path.
  const d = shuffle(buildDeck());
  const { hands, stock } = dealAll(d, 0);
  eq(stock.length, 0, 'dealAll exhausts the deck');
  ok(hands.every((h) => h.length === HAND_SIZE), 'dealAll gives everyone thirteen');
  eq(new Set(hands.flat()).size, DECK_SIZE, 'dealAll deals each card once');
}

{
  const hands = emptyHands();
  const before = JSON.stringify(hands);
  dealPacket(buildDeck(), hands, 5, 0);
  eq(JSON.stringify(hands), before, 'dealPacket does not mutate the hands it is given');
}

// ===========================================================================
section('Sorting and counting a hand');
// ===========================================================================

{
  const hand = ['2S', 'AH', '7C', 'AS', 'TD', 'KH'];
  const sorted = sortHand(hand);
  same([...sorted].sort(), [...hand].sort(), 'sortHand keeps every card');
  eq(sorted.length, hand.length, 'sortHand keeps the count');
  eq(sorted[0], 'AS', 'spades lead the default display order, ace first');
  eq(sorted[1], '2S', 'ranks descend within a suit');

  const trumpFirst = sortHand(hand, 'D');
  eq(suitOf(trumpFirst[0]), 'D', 'the trump suit is pulled to the front when known');

  const counts = suitCounts(hand);
  eq(counts.S, 2, 'two spades');
  eq(counts.H, 2, 'two hearts');
  eq(counts.D, 1, 'one diamond');
  eq(counts.C, 1, 'one club');
  eq(Object.values(counts).reduce((a, b) => a + b, 0), hand.length, 'counts sum to the hand');
}

// ===========================================================================
section('Follow-suit legality');
// ===========================================================================

{
  const hand = ['AS', '4S', 'KH', '2C', '9D'];

  // Leading: everything is legal.
  same(legalPlays(hand, null), hand, 'leading, every card is legal');
  ok(hand.every((c) => canPlay(hand, c, null)), 'leading, canPlay allows everything');

  // Holding the led suit: only that suit.
  same(legalPlays(hand, 'S'), ['AS', '4S'], 'holding spades, only spades are legal');
  ok(canPlay(hand, 'AS', 'S'), 'may play a held spade');
  ok(!canPlay(hand, 'KH', 'S'), 'may not renege on spades');
  // Spelled out, not the suit code: this string is an aria-label, and a screen
  // reader reads "must follow S" aloud as "must follow ess".
  eq(illegalReason(hand, 'KH', 'S'), 'cannot play, must follow spades', 'reneging has a stated reason');
  eq(illegalReason(hand, 'AS', 'S'), null, 'a legal card has no reason');

  // Not holding the led suit: ANYTHING is legal. This is the rule most
  // implementations get wrong — there is no obligation to trump.
  const noClubs = ['AS', '4S', 'KH', '9D'];
  same(legalPlays(noClubs, 'C'), noClubs, 'void in the led suit, every card is legal');
  ok(noClubs.every((c) => canPlay(noClubs, c, 'C')), 'void, canPlay allows everything');
}

{
  // Void in the led suit while HOLDING TRUMPS: discarding from a third suit is
  // legal. The trump is not mentioned anywhere in legalPlays() on purpose.
  const hand = ['AS', 'KS', '3H'];   // spades are trump in this scenario
  same(legalPlays(hand, 'C'), hand, 'holding trumps and void, a discard is still legal');
  ok(canPlay(hand, '3H', 'C'), 'may discard a heart rather than trump in');
  ok(canPlay(hand, 'AS', 'C'), 'may also choose to trump in');
}

{
  const hand = ['AS'];
  ok(!canPlay(hand, 'KD', 'S'), 'a card not in hand can never be played');
  eq(illegalReason(hand, 'KD', 'S'), 'not in your hand', 'a card not held says so');
  const returned = legalPlays(hand, null);
  returned.push('XX');
  eq(hand.length, 1, 'legalPlays returns a copy, not the caller\'s hand');
}

// ===========================================================================
section('Trick winner');
// ===========================================================================

{
  // No trump played: highest of the led suit.
  const plays = [
    { seat: 0, code: '5S' },
    { seat: 3, code: 'KS' },
    { seat: 2, code: '9S' },
    { seat: 1, code: '2S' },
  ];
  eq(ledSuitOf(plays), 'S', 'the led suit is the first card\'s suit');
  eq(trickWinner(plays, 'H'), 3, 'highest of the led suit wins when nobody trumps');
  eq(winningCard(plays, 'H'), 'KS', 'and the winning card is reported');
}

{
  // Off-suit cards cannot win however high, when they are not trumps.
  const plays = [
    { seat: 0, code: '5S' },
    { seat: 3, code: 'AH' },   // ace, but hearts are neither led nor trump
    { seat: 2, code: 'AD' },   // ditto
    { seat: 1, code: '6S' },
  ];
  eq(trickWinner(plays, 'C'), 1, 'a discarded ace loses to the six of the led suit');
}

{
  // One trump beats every card of the led suit, however low.
  const plays = [
    { seat: 0, code: 'AS' },
    { seat: 3, code: '2H' },   // hearts are trump
    { seat: 2, code: 'KS' },
    { seat: 1, code: 'QS' },
  ];
  eq(trickWinner(plays, 'H'), 3, 'the deuce of trumps beats the ace of the led suit');
}

{
  // Several trumps: the highest trump, and the led suit stops mattering.
  const plays = [
    { seat: 0, code: 'AS' },
    { seat: 3, code: '2H' },
    { seat: 2, code: 'TH' },
    { seat: 1, code: '5H' },
  ];
  eq(trickWinner(plays, 'H'), 2, 'highest trump wins among several');
}

{
  // A trump LED is just the led suit and the trump suit at once.
  const plays = [
    { seat: 1, code: '7H' },
    { seat: 0, code: 'AH' },
    { seat: 3, code: '3H' },
    { seat: 2, code: '2S' },
  ];
  eq(trickWinner(plays, 'H'), 0, 'leading trumps, the highest trump still wins');
}

{
  // Part-played tricks resolve too — the UI and the bot both ask mid-trick.
  const plays = [{ seat: 0, code: '5S' }, { seat: 3, code: 'KS' }];
  eq(trickWinner(plays, 'H'), 3, 'a two-card trick has a current winner');
  eq(trickWinner([{ seat: 2, code: '4D' }], 'H'), 2, 'a one-card trick is won by its leader');
  eq(trickWinner([], 'H'), null, 'an empty trick has no winner');
  eq(ledSuitOf([]), null, 'an empty trick has no led suit');
}

{
  // The Hidden Rung consequence the brief calls out: with trump hidden, a lower
  // card beats a higher one in a way nobody at the table could have predicted.
  // Correct behaviour, so it gets a test rather than a workaround.
  const plays = [
    { seat: 0, code: 'AS' },
    { seat: 3, code: '3D' },
    { seat: 2, code: 'KS' },
    { seat: 1, code: 'QS' },
  ];
  eq(trickWinner(plays, 'D'), 3, 'a concealed trump still wins the trick');
  eq(trickWinner(plays, 'S'), 0, 'and the same cards resolve differently under another trump');
}

// ===========================================================================
section('Partner awareness');
// ===========================================================================

{
  const plays = [
    { seat: 0, code: '5S' },
    { seat: 3, code: 'KS' },
  ];
  // Seat 1 is about to play. Its partner is seat 3, who is currently winning.
  ok(partnerWinning(plays, 1, 'H'), 'seat 1 sees its partner (seat 3) winning');
  ok(!partnerWinning(plays, 0, 'H'), 'seat 0\'s partner (seat 2) has not played');
  ok(!partnerWinning(plays, 3, 'H'), 'the current winner is not its own partner');
  ok(!partnerWinning([], 1, 'H'), 'nobody is winning an empty trick');

  // And it tracks the trump, rather than just the highest card.
  const trumped = [
    { seat: 0, code: 'AS' },
    { seat: 3, code: '2H' },
  ];
  ok(partnerWinning(trumped, 1, 'H'), 'partner winning by a trump is still winning');
  ok(!partnerWinning(trumped, 1, 'S'), 'and not winning when that suit is not trump');
}

// ===========================================================================
section('Court definition');
// ===========================================================================

eq(TRICKS_TO_WIN, 7, 'seven tricks decide a deal');

eq(courtTeam([0, 0, 0, 0, 0, 0, 0]), 0, 'team 0 taking the opening seven is a court');
eq(courtTeam([1, 1, 1, 1, 1, 1, 1]), 1, 'team 1 taking the opening seven is a court');
eq(courtTeam([0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]), 0,
  'losing later tricks does not undo a court already scored');

// The near-misses. This is where a wrong implementation passes the happy path.
eq(courtTeam([1, 0, 0, 0, 0, 0, 0, 0]), null,
  'losing trick one then taking seven is a deal win but NOT a court');
eq(courtTeam([0, 0, 0, 1, 0, 0, 0, 0]), null, 'one trick dropped in the middle is not a court');
eq(courtTeam([0, 0, 0, 0, 0, 0, 1]), null, 'dropping the seventh is not a court');
eq(courtTeam([0, 0, 0, 0, 0, 0]), null, 'six tricks is not yet a court');
eq(courtTeam([]), null, 'no tricks is not a court');
eq(courtTeam(null), null, 'a missing trick list is not a court');

// ===========================================================================
section('Config');
// ===========================================================================

eq(DEFAULTS.hiddenRung, false, 'classic by default — the trump is announced');
eq(DEFAULTS.courtsToWin, MATCH_TARGET_DEFAULT, 'match target defaults');

eq(DEFAULTS.matchMode, 'race', 'and a race to a court target rather than a fixed deal count');
eq(DEFAULTS.dealsToPlay, DEAL_TARGET_DEFAULT, 'with a deal target ready for the other mode');

{
  const c = normalizeConfig({ hiddenRung: true, matchMode: 'deals', courtsToWin: 5, dealsToPlay: 12 });
  eq(c.hiddenRung, true, 'hiddenRung is taken');
  eq(c.matchMode, 'deals', 'the match mode is taken');
  eq(c.courtsToWin, 5, 'a valid court target is taken');
  eq(c.dealsToPlay, 12, 'a valid deal target is taken');

  // Both targets survive a mode switch — a single reinterpreted field would
  // clamp 8 deals into 8 courts on the way past.
  const swapped = normalizeConfig({ ...c, matchMode: 'race' });
  eq(swapped.dealsToPlay, 12, 'switching mode does not discard the other target');

  const hostile = normalizeConfig({
    courtsToWin: 9999, dealsToPlay: 1e9, matchMode: 'forever', evil: 'payload', __proto__: {},
  });
  eq(hostile.courtsToWin, MATCH_TARGET_DEFAULT, 'an out-of-range court target falls back');
  eq(hostile.dealsToPlay, DEAL_TARGET_DEFAULT,
    'and so does a deal target that would mean a match with no end');
  eq(hostile.matchMode, 'race', 'an unknown mode falls back');
  eq('evil' in hostile, false, 'an unknown key is dropped, not stored');
  same(Object.keys(hostile).sort(), ['courtsToWin', 'dealsToPlay', 'hiddenRung', 'matchMode'],
    'only the known keys survive');

  eq(normalizeConfig(null).courtsToWin, MATCH_TARGET_DEFAULT, 'a missing patch is the defaults');
  eq(normalizeConfig([1, 2]).hiddenRung, false, 'an array patch is the defaults');
}

{
  // The chain: deals won, then courts, then an honest draw. Arguments are
  // (courts, dealsWon) — the parameter order is NOT the priority order, which
  // is exactly the sort of thing a reader assumes and gets wrong, so the first
  // two cases below pin the priority with the two arrays disagreeing.
  eq(decideMatch([2, 1], [3, 5]), 1, 'more deals wins, even against twice the courts');
  eq(decideMatch([0, 1], [8, 0]), 0, 'and a clean sweep of deals beats a lone court');
  eq(decideMatch([1, 1], [5, 3]), 0, 'more deals still wins when courts are level');
  eq(decideMatch([0, 0], [3, 5]), 1, 'and when there were no courts at all — the common case');
  eq(decideMatch([1, 0], [4, 4]), 0, 'dead level on deals, the court separates them');
  eq(decideMatch([1, 1], [4, 4]), null, 'level on both is a DRAW, not a coin toss');
  eq(decideMatch([0, 0], [0, 0]), null, 'and so is a match nobody won anything in');
}

eq(cleanName('  Yash  '), 'Yash', 'names are trimmed');
eq(cleanName('a'.repeat(50)).length, 16, 'names are capped');
eq(cleanName('A\u0000B'), 'AB', 'control characters are dropped from names');
eq(cleanName('A   B'), 'A B', 'runs of whitespace collapse');
eq(cleanName(null), '', 'a missing name is empty');

// ===========================================================================
// CHECKPOINT 2 — the engine.
//
// Everything above is a pure function of its arguments. Everything below drives
// the real GameEngine through whole deals and whole matches.
// ===========================================================================

// --- table helpers ---------------------------------------------------------

/** Four humans, seated 0..3 in order, p0 holding the room's controls. */
function table(config = null) {
  const e = new GameEngine();
  e.addPlayer('p0', 'North', { clientId: 'c0', isOwner: true });
  e.addPlayer('p1', 'East',  { clientId: 'c1' });
  e.addPlayer('p2', 'South', { clientId: 'c2' });
  e.addPlayer('p3', 'West',  { clientId: 'c3' });
  if (config) e.setConfig(config);
  return e;
}

const idAt = (e, seat) => e.seats[seat].id;
const allOf = (suit) => RANKS.map((r) => r + suit);

/**
 * Start a match, force a specific dealer, declare a specific trump, and
 * optionally replace the four hands with a rigged deal.
 *
 * Forcing the dealer matters because callerSeat is derived from it, and a test
 * about dealer succession that cannot choose the dealer is testing the shuffle.
 */
function toPlay(e, { dealer, trump, hands = null }) {
  e.startMatch('p0', 0);
  e.dealerSeat = dealer;
  e._beginDeal(0);
  e.tick(DEAL_PAUSE_MS);
  const res = e.declareTrump(idAt(e, e.callerSeat), trump, DEAL_PAUSE_MS);
  if (!res.ok) throw new Error(res.error);
  e.tick(DEAL_PAUSE_MS * 2);
  if (hands) e.hands = hands.map((h) => h.slice());
  return e;
}

/**
 * Let a completed trick be gathered in.
 *
 * A full trick is held on the table for TRICK_PAUSE_MS before it is scored, so
 * anything that plays cards back to back has to let that time pass — exactly
 * as it does for the two dealing phases. A no-op mid-trick, so it is safe to
 * call after every card.
 */
function gather(e) {
  if (e.trickComplete) e.tick(e.trickAt + TRICK_PAUSE_MS);
}

/** Play the deal out. `pick` chooses from the legal cards; the default takes
 *  the first, which is deterministic and enough for a rigged deal. */
function playOut(e, pick = null) {
  let guard = 0;
  while (e.phase === PHASES.PLAY) {
    if (++guard > TRICKS_PER_DEAL * SEAT_COUNT + 1) throw new Error('play did not terminate');
    const seat = e.turnSeat;
    const legal = legalPlays(e.hands[seat], ledSuitOf(e.trick));
    const code = pick ? pick(e, seat, legal) : legal[0];
    const res = e.playCard(idAt(e, seat), code);
    if (!res.ok) throw new Error(`refused a legal play: ${res.error}`);
    gather(e);
  }
}

/** Does `key` appear anywhere in this payload, at any depth? Used to prove a
 *  secret is absent rather than merely not looked at. */
function findKey(obj, key, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return false;
  seen.add(obj);
  if (!Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key)) return true;
  for (const v of Object.values(obj)) if (findKey(v, key, seen)) return true;
  return false;
}

// ===========================================================================
section('Seating');
// ===========================================================================

{
  const e = new GameEngine();
  eq(e.phase, PHASES.LOBBY, 'a new engine is in the lobby');

  const r0 = e.addPlayer('p0', 'North', { clientId: 'c0', isOwner: true });
  ok(r0.ok, 'the first player is seated');
  eq(r0.seat, 0, 'and takes seat 0');
  eq(e.ownerId, 'p0', 'ownerId lives on the GAME — isHost is a runtime flag elsewhere');

  e.addPlayer('p1', 'East',  { clientId: 'c1' });
  e.addPlayer('p2', 'South', { clientId: 'c2' });
  e.addPlayer('p3', 'West',  { clientId: 'c3' });
  eq(e.addPlayer('p4', 'Extra', { clientId: 'c4' }).ok, false, 'a fifth player is turned away');

  eq(e.seatOf('p2'), 2, 'seatOf finds a seated player');
  eq(e.seatOf('nobody'), -1, 'and returns -1 for a stranger');
  eq(teamOf(e.seatOf('p0')), teamOf(e.seatOf('p2')), 'seats 0 and 2 partner each other');
  ok(teamOf(e.seatOf('p0')) !== teamOf(e.seatOf('p1')), 'seats 0 and 1 are opponents');

  // Swapping seats is the one seating control that matters: it re-partners.
  ok(e.swapSeats(1, 2).ok, 'two seats may be swapped in the lobby');
  eq(e.seatOf('p1'), 2, 'p1 moved to seat 2');
  eq(e.seatOf('p2'), 1, 'p2 moved to seat 1');
  ok(e.swapSeats(1, 2).ok, 'and swapped back');
}

{
  // Bots fill what is left, and a human beats a bot to a chair.
  const e = new GameEngine();
  e.addPlayer('p0', 'North', { clientId: 'c0', isOwner: true });
  ok(e.addBot().ok, 'a bot can be seated');
  ok(e.addBot().ok, 'and another');
  ok(e.addBot().ok, 'and a third');
  eq(e.addBot().ok, false, 'a fifth bot has nowhere to sit');
  eq(e.seats.filter((p) => p && p.isBot).length, 3, 'three bots at the table');

  const late = e.addPlayer('p1', 'East', { clientId: 'c1' });
  ok(late.ok, 'a human arriving to a full table is still seated');
  ok(!e.seats[late.seat].isBot, 'by taking a bot\'s chair, not by being refused');
  eq(e.seats.filter((p) => p && p.isBot).length, 2, 'one bot gave up its seat');
  eq(new Set(e.seats.filter(Boolean).map((p) => p.name)).size, 4, 'no two players share a name');
  ok(e.seats.every((p) => !p.isBot || p.clientId === null),
    'a bot has no clientId, so it can never be reclaimed as a seat');
}

// ===========================================================================
section('Seat reclaim');
// ===========================================================================

{
  const e = table();
  e.startMatch('p0', 0);
  ok(e.phase !== PHASES.LOBBY, 'the match is under way');

  // The dropout. The seat is KEPT: emptying it would end the deal for everybody.
  e.disconnect('p1');
  eq(e.seatOf('p1'), 1, 'a disconnected player keeps their seat');
  eq(e.seats[1].online, false, 'and is marked offline');

  // Reconnecting brings a NEW peer id — the clientId is what carries the claim.
  const back = e.addPlayer('p1-new', 'East', { clientId: 'c1' });
  ok(back.ok, 'the device reclaims its seat');
  eq(back.seat, 1, 'the same seat');
  eq(back.reconnected, true, 'reported as a reconnect, not a join');
  eq(back.prevId, 'p1', 'the old peer id is handed back so the caller can remap');
  eq(e.seats[1].online, true, 'and is online again');

  // Renaming on the way back in is fine, the seat follows the clientId.
  const renamed = e.addPlayer('p1-new2', 'Eastish', { clientId: 'c1' });
  eq(renamed.seat, 1, 'a reclaim under a new name still finds the seat by clientId');
  eq(e.seats[1].name, 'Eastish', 'and the table shows the name actually in use');

  // The attack this exists to stop. PeerJS signalling is a public broker, so
  // anyone who guesses the room code can reach the host and type any name.
  e.disconnect('p1-new2');
  const impostor = e.addPlayer('evil', 'Eastish', { clientId: 'attacker' });
  eq(impostor.ok, false, 'mid-deal, a name alone does not take a seat');
  eq(e.seats[1].clientId, 'c1', 'the real device still owns it');
  eq(impostor.error, 'Someone in this game is already using that name.',
    'and the refusal says nothing an attacker could learn from');

  eq(e.addPlayer('evil2', 'Brand New', { clientId: 'attacker' }).ok, false,
    'and a stranger cannot join a game in progress at all');
}

{
  // In the LOBBY a name reclaim is still allowed: nothing has been dealt, so a
  // device that genuinely lost its clientId can get back in before the deal.
  const e = table();
  const again = e.addPlayer('p1-new', 'East', { clientId: null });
  ok(again.ok, 'in the lobby, a name is enough');
  eq(again.seat, 1, 'and finds the same seat');

  e.disconnect('p0');
  eq(e.seats[0], null, 'a lobby disconnect frees the seat entirely');
}

// ===========================================================================
section('Starting a match');
// ===========================================================================

{
  const e = new GameEngine();
  e.addPlayer('p0', 'North', { clientId: 'c0', isOwner: true });
  e.addPlayer('p1', 'East',  { clientId: 'c1' });

  eq(e.startMatch('p1', 0).ok, false, 'only the owner can start the match');
  eq(e.phase, PHASES.LOBBY, 'and a refused start changes nothing');

  ok(e.startMatch('p0', 0).ok, 'the owner starts it');
  eq(e.seats.filter(Boolean).length, SEAT_COUNT, 'the empty seats were filled');
  eq(e.seats.filter((p) => p.isBot).length, 2, 'by bots — four seats is not negotiable');
  eq(e.startMatch('p0', 0).ok, false, 'starting twice is refused');
}

{
  const botsOnly = new GameEngine();
  botsOnly.ownerId = 'p0';
  botsOnly.addBot(); botsOnly.addBot(); botsOnly.addBot(); botsOnly.addBot();
  eq(botsOnly.startMatch('p0', 0).ok, false, 'a table of nothing but bots will not start');
  eq(botsOnly.publicState().startCheck.ok, false, 'and the lobby says so before the button is pressed');
}

// ===========================================================================
section('The deal — 5, call, then 4 and 4');
// ===========================================================================

{
  const e = table();
  e.startMatch('p0', 0);

  eq(e.phase, PHASES.DEAL_FIVE, 'the deal opens with five cards each');
  ok(e.hands.every((h) => h.length === 5), 'everyone holds five');
  eq(e.stock.length, DECK_SIZE - SEAT_COUNT * 5, 'thirty-two cards are still undealt');
  eq(e.callerSeat, nextSeat(e.dealerSeat), 'the caller is the player to the dealer\'s right');
  ok(areOpponents(e.dealerSeat, e.callerSeat), 'so the dealer and the caller are always opponents');

  // The pause is a duration compared against a `now`, never a setTimeout.
  eq(e.tick(DEAL_PAUSE_MS - 1), false, 'the deal phase holds until the pause has elapsed');
  eq(e.phase, PHASES.DEAL_FIVE, 'still dealing');
  eq(e.tick(DEAL_PAUSE_MS), true, 'and then advances itself');
  eq(e.phase, PHASES.DECLARE_TRUMP, 'to the trump call');

  // Nobody may play before the trump is named.
  eq(e.playCard(idAt(e, e.callerSeat), e.hands[e.callerSeat][0]).ok, false,
    'no card can be played before trump is called');

  // The call is checked by SEAT, so a partner sending the message is refused
  // whatever their own UI happens to be showing. No consulting.
  const partner = partnerOf(e.callerSeat);
  eq(e.declareTrump(idAt(e, partner), 'H', DEAL_PAUSE_MS).ok, false,
    'the caller\'s partner cannot call trump for them');
  eq(e.declareTrump(idAt(e, e.dealerSeat), 'H', DEAL_PAUSE_MS).ok, false,
    'nor can the dealer');
  eq(e.declareTrump(idAt(e, e.callerSeat), 'X', DEAL_PAUSE_MS).ok, false,
    'and it has to be a real suit');
  eq(e.trumpSuit, null, 'none of which named a trump');

  ok(e.declareTrump(idAt(e, e.callerSeat), 'H', DEAL_PAUSE_MS).ok, 'the caller calls hearts');
  eq(e.trumpSuit, 'H', 'the trump is recorded');
  eq(e.phase, PHASES.DEAL_REST, 'and the rest of the deal follows');
  ok(e.hands.every((h) => h.length === HAND_SIZE), 'everyone now holds thirteen');
  eq(e.stock.length, 0, 'the deck is exhausted');
  eq(new Set(e.hands.flat()).size, DECK_SIZE, 'and every card was dealt exactly once');

  e.tick(DEAL_PAUSE_MS * 2);
  eq(e.phase, PHASES.PLAY, 'play begins');
  eq(e.turnSeat, e.callerSeat, 'THE TRUMP-CALLER LEADS THE FIRST TRICK');
}

// ===========================================================================
section('Trick play through the engine');
// ===========================================================================

{
  const e = table();
  toPlay(e, { dealer: 1, trump: 'H' });
  eq(e.callerSeat, 0, 'dealer at seat 1 puts the caller at seat 0');

  const lead = e.hands[0][0];
  eq(e.playCard('p1', e.hands[1][0]).ok, false, 'a player out of turn is refused');
  eq(e.playCard('stranger', lead).ok, false, 'so is somebody not at the table');

  ok(e.playCard('p0', lead).ok, 'the leader plays');
  eq(e.turnSeat, 3, 'and the turn passes ANTICLOCKWISE, to seat 3');
  eq(e.publicState().ledSuit, suitOf(lead), 'the led suit is public the instant it lands');

  // The enforcement point. The client greys illegal cards out as a courtesy;
  // this is what actually decides, and it is all a hostile peer meets.
  const led = suitOf(lead);
  const renege = e.hands[3].find((c) => suitOf(c) !== led);
  const mustFollow = e.hands[3].some((c) => suitOf(c) === led);
  if (mustFollow && renege) {
    const res = e.playCard('p3', renege);
    eq(res.ok, false, 'the host refuses a renege even though no client sent it');
    ok(/must follow/.test(res.error), 'and says why');
  } else {
    ok(true, '(seat 3 was void in the led suit this deal)');
  }
}

{
  // A whole trick, and who leads the next one.
  const e = table();
  toPlay(e, {
    dealer: 1,
    trump: 'H',
    hands: [
      ['5S', ...allOf('C').slice(1)],          // seat 0 leads the five of spades
      ['KS', ...allOf('D').slice(1)],          // seat 1 takes it with the king
      ['9S', ...allOf('H').slice(1)],          // seat 2
      ['2S', ...allOf('S').slice(1)],          // seat 3
    ],
  });

  e.playCard('p0', '5S');
  e.playCard('p3', '2S');
  e.playCard('p2', '9S');
  eq(e.trick.length, 3, 'three cards down');
  e.playCard('p1', 'KS', 5000);

  // THE HOLD. The fourth card stays face up for TRICK_PAUSE_MS, and nothing
  // about the trick is settled until tick() gathers it in — otherwise the card
  // that decided it is cleared in the same broadcast that delivered it, and
  // nobody at the table ever sees it.
  eq(e.trick.length, SEAT_COUNT, 'the fourth card STAYS ON THE TABLE when it lands');
  eq(e.publicState().trick.length, SEAT_COUNT, 'and all four are in the broadcast');
  eq(e.lastTrick, null, 'the trick is not yet anybody\'s');
  same(e.publicState().tricksWon, [0, 0], 'and the count has not moved');
  eq(e.publicState().turnSeat, null, 'nobody is on turn while it is held');
  eq(e.currentPlayer, null, 'so the bot driver has nobody to move for');
  ok([0, 1, 2, 3].every((s) => !e.privateStateFor(idAt(e, s)).isTurn),
    'and no device is told it may play');
  eq(e.playCard('p1', e.hands[1][0], 5000).ok, false, 'the winner-to-be cannot lead into a held trick');
  eq(e.trick.length, SEAT_COUNT, 'and a refused card does not land on it');
  eq(e.tick(5000 + TRICK_PAUSE_MS - 1), false, 'the hold is not cut a millisecond short');
  eq(e.trick.length, SEAT_COUNT, 'still on the table');
  eq(e.tick(5000 + TRICK_PAUSE_MS), true, 'and then the trick is gathered in');

  eq(e.trick.length, 0, 'the table is cleared');
  eq(e.lastTrick.winnerSeat, 1, 'highest of the led suit takes it');
  eq(e.turnSeat, 1, 'and the winner leads the next trick');
  same(e.trickWinners, [teamOf(1)], 'the winning TEAM is recorded, in trick order');
  same(e.publicState().tricksWon, [0, 1], 'the running count is derived from that list');
  eq(e.publicState().trickNumber, 2, 'and the table is on trick two');
}

// ===========================================================================
section('Winning a deal — seven of thirteen');
// ===========================================================================

{
  // Seat 0 holds every spade, spades are trump, and the other three are void in
  // it — so seat 0 leads a trump to every trick and team 0 takes all of them.
  //
  // The race target is set past 1 explicitly. This block is about what a COURT
  // does to a deal — the scoreboard, the dealer, the next hand — and at the
  // default of first-to-one the match would end underneath it and every
  // assertion after the court would be about MATCH_OVER instead.
  const e = table({ matchMode: 'race', courtsToWin: 2 });
  toPlay(e, {
    dealer: 1,
    trump: 'S',
    hands: [allOf('S'), allOf('D'), allOf('H'), allOf('C')],
  });
  playOut(e);

  eq(e.phase, PHASES.DEAL_OVER, 'the deal ends the moment seven tricks are in');
  eq(e.trickWinners.length, TRICKS_TO_WIN,
    'PLAY STOPS AT SEVEN — the remaining tricks cannot change who won');
  ok(e.hands.some((h) => h.length > 0), 'so cards are left in hand, undealt-with, on purpose');
  eq(e.dealResult.winnerTeam, 0, 'team 0 won the deal');
  same(e.dealResult.tricksWon, [7, 0], 'seven to nil');
  eq(e.dealResult.court, 0, 'and taking the opening seven is a COURT');
  same(e.courts, [1, 0], 'which is the only thing that scores');
  eq(e.dealsPlayed, 1, 'one deal played');

  // The dealer sat at seat 1, on team 1, and lost.
  eq(e.dealResult.dealerSeat, 1, 'seat 1 dealt');
  eq(e.dealResult.dealerWon, false, 'the dealer\'s team lost the deal');
  eq(e.dealResult.nextDealerSeat, 1, 'SO THE SAME DEALER DEALS AGAIN');
  eq(e.dealerSeat, 1, 'and the engine has already moved to them');

  eq(e.playCard('p0', e.hands[0][0]).ok, false, 'no more cards can be played once the deal is over');
  eq(e.nextDeal('p1', 0).ok, false, 'and only the owner deals again');
  ok(e.nextDeal('p0', 0).ok, 'the owner deals again');
  eq(e.phase, PHASES.DEAL_FIVE, 'a fresh deal begins');
  eq(e.callerSeat, 0, 'with the caller still to the dealer\'s right');
}

{
  // What the SHIPPED defaults do, which is the thing a player meets and which
  // the block above deliberately opts out of. Worth its own test because the
  // default was chosen from a measurement — the bot soak courts about 6.6% of
  // deals, which makes first-to-two a median of 39 deals — and a silent edit
  // back to 2 would restore a match nobody finishes without failing anything.
  eq(MATCH_TARGET_DEFAULT, 1, 'out of the box, one court takes the match');
  eq(DEFAULTS.matchMode, 'race', 'in race mode');

  const e = table();
  toPlay(e, { dealer: 1, trump: 'S', hands: [allOf('S'), allOf('D'), allOf('H'), allOf('C')] });
  playOut(e);

  eq(e.dealResult.court, 0, 'so a court on the very first deal...');
  eq(e.matchOver, true, '...ends the match there and then');
  eq(e.matchWinner, 0, 'to the team that courted');
  eq(e.publicState().matchDrawn, false, 'and a race is never a draw');
  eq(e.nextDeal('p0', 0).ok, true, 'the owner advances past the last deal');
  eq(e.phase, PHASES.MATCH_OVER, 'to the match result, not another hand');
}

{
  // A deal won WITHOUT a court, which is also the dealer-succession case the
  // court test above cannot reach.
  //
  // Seat 0 leads the ace of trumps and takes trick one. Seat 1 then takes the
  // next seven: the ace of spades on trick two, and the remaining trumps after
  // that. Team 1 reaches seven at trick EIGHT, so the opening seven are not all
  // theirs and no court is scored.
  const e = table();
  toPlay(e, {
    dealer: 1,
    trump: 'D',
    hands: [
      ['AD', ...allOf('S').slice(1)],   // ace of trumps + twelve spades
      [...allOf('D').slice(1), 'AS'],   // twelve trumps + the ace of spades
      allOf('H'),
      allOf('C'),
    ],
  });
  playOut(e);

  eq(e.phase, PHASES.DEAL_OVER, 'the deal ended');
  eq(e.trickWinners.length, 8, 'at trick eight');
  same(e.dealResult.tricksWon, [1, 7], 'one trick to team 0, seven to team 1');
  eq(e.dealResult.winnerTeam, 1, 'team 1 wins the deal');
  eq(e.dealResult.court, null,
    'but dropping trick one means NO COURT, however many they took afterwards');
  same(e.courts, [0, 0], 'so nothing goes on the board');
  eq(e.matchWinner, null, 'and nobody has won the match');

  eq(e.dealResult.dealerWon, true, 'the dealer (seat 1) is on the winning team');
  eq(e.dealResult.nextDealerSeat, nextSeat(1),
    'SO THE DEAL PASSES ONE SEAT TO THE RIGHT — anticlockwise, like everything else');
  eq(e.dealResult.nextDealerSeat, 0, 'which from seat 1 is seat 0');
}

// ---------------------------------------------------------------------------
// The log names a side with a TOKEN, never a team number.
//
// One log goes to four devices, but every other surface in the app says "us"
// and "them" from the reading device's own seat — that is what the whole
// two-colour palette is built on. A log line that said "Team 2 wins the deal"
// would be the one sentence on screen the player has to translate. So the
// engine emits "{team} win the deal" plus the team index, and js/ui.js fills
// the token in against the seat the reader holds.
//
// This is easy to undo by accident: `Team ${n + 1}` is the obvious thing to
// write, reads fine in a console, and breaks nothing that is tested elsewhere.
// ---------------------------------------------------------------------------
{
  const e = table({ matchMode: 'race', courtsToWin: 2 });
  toPlay(e, { dealer: 1, trump: 'S', hands: [allOf('S'), allOf('D'), allOf('H'), allOf('C')] });
  playOut(e);

  const named = e.log.filter((l) => l.team !== undefined);
  ok(named.length > 0, 'a finished deal logs at least one line that names a side');
  ok(named.every((l) => l.text.includes('{team}')),
    'every line carrying a team index leaves a {team} token for the renderer');
  ok(named.every((l) => Number.isInteger(l.team) && l.team >= 0 && l.team < 2),
    'and the index is a real team');
  ok(!e.log.some((l) => /\bTeam \d/.test(l.text)),
    'NO LOG LINE HARDCODES A TEAM NUMBER — the reader would have to translate it');
  ok(!e.log.some((l) => /\{team\}/.test(l.text) && l.team === undefined),
    'and no line leaves a token with nothing to fill it from');

  // The court line is the loud one, and the one most likely to be rewritten.
  const court = e.log.find((l) => l.kind === 'court');
  ok(court && court.team === 0, 'the court line says WHICH side courted');
  ok(court && /^COURT! \{team\} took/.test(court.text), 'in the token form');
}

// ===========================================================================
section('The match tally — RACE mode');
// ===========================================================================

/** Play out a deal already sitting at DEAL_FIVE, with a rigged hand. */
function runDeal(e, { trump, hands }) {
  e.tick(e.phaseAt + DEAL_PAUSE_MS);
  const r = e.declareTrump(idAt(e, e.callerSeat), trump, e.phaseAt);
  if (!r.ok) throw new Error(r.error);
  e.tick(e.phaseAt + DEAL_PAUSE_MS);
  e.hands = hands.map((h) => h.slice());
  playOut(e);
}

// Three rigged deals, written as functions of the seats involved. A match runs
// several deals and the dealer moves between them, so a rig pinned to literal
// seat numbers only works for the one deal it was written for.

/** `seat` holds every spade, spades are trump, and the other three are void in
 *  it — so that seat takes every trick and its team scores a COURT, whoever is
 *  dealing and whoever leads. */
function sweep(seat) {
  const fillers = ['D', 'H', 'C'];
  let i = 0;
  return {
    trump: 'S',
    hands: [0, 1, 2, 3].map((s) => (s === seat ? allOf('S') : allOf(fillers[i++]))),
  };
}

/** The caller takes the first two tricks with the top spades; the player on
 *  their right runs out of spades on trick three, trumps in, and runs the
 *  hearts. The caller's OPPONENTS reach seven at trick nine — a deal won with
 *  no court, which is the case a sweep can never produce. */
function lateTurnaround(caller) {
  const o = nextSeat(caller), p = nextSeat(o), q = nextSeat(p);
  const hands = [];
  hands[caller] = ['AS', 'KS', '6S', '5S', '4S', '3S', '2S', '3H', '2H', '3C', '2C', '3D', '2D'];
  hands[o] = ['QS', 'JS', ...allOf('H').slice(0, 11)];
  hands[p] = ['TS', '9S', ...allOf('C').slice(0, 11)];
  hands[q] = ['8S', '7S', ...allOf('D').slice(0, 11)];
  return { trump: 'H', hands, winner: teamOf(o) };
}

/** The mirror image: the caller leads into the top spades and drops the first
 *  two tricks, then their PARTNER trumps in and runs the hearts. The caller's
 *  own team wins at trick nine, again with no court. */
function earlyDrop(caller) {
  const o = nextSeat(caller), p = nextSeat(o), q = nextSeat(p);
  const hands = [];
  hands[caller] = ['QS', 'JS', ...allOf('D').slice(0, 11)];
  hands[o] = ['AS', 'KS', '6S', '5S', '4S', '3S', '2S', '3H', '2H', '3C', '2C', '3D', '2D'];
  hands[p] = ['TS', '9S', ...allOf('H').slice(0, 11)];
  hands[q] = ['8S', '7S', ...allOf('C').slice(0, 11)];
  return { trump: 'H', hands, winner: teamOf(caller) };
}

for (const rig of [sweep(0), sweep(2), lateTurnaround(0), lateTurnaround(3), earlyDrop(2)]) {
  eq(new Set(rig.hands.flat()).size, DECK_SIZE, '(every rigged deal is a whole deck)');
}

{
  const e = table({ matchMode: 'race', courtsToWin: 2 });

  toPlay(e, { dealer: 1, ...sweep(0) });
  playOut(e);
  same(e.courts, [1, 0], 'one court to team 0');
  eq(e.matchOver, false, 'not enough for a race to two');
  eq(e.matchWinner, null, 'and no winner yet');
  ok(e.nextDeal('p0', 0).ok, 'so the game plays on');
  eq(e.phase, PHASES.DEAL_FIVE, 'straight into the next deal');

  eq(e.callerSeat, 0, 'the caller is unchanged — the dealer\'s team lost, so they redeal');
  runDeal(e, sweep(0));

  same(e.courts, [2, 0], 'a second court');
  eq(e.matchOver, true, 'reaches the target');
  eq(e.matchWinner, 0, 'and decides the match');
  eq(e.phase, PHASES.DEAL_OVER, 'the deal-over screen still shows first');
  ok(e.nextDeal('p0', 0).ok, 'and then the owner moves on');
  eq(e.phase, PHASES.MATCH_OVER, 'to the match result, not another deal');
  eq(e.publicState().matchDrawn, false, 'a race cannot be drawn');

  eq(e.newMatch('p1', 0).ok, false, 'only the owner starts a new match');
  ok(e.newMatch('p0', 0).ok, 'the owner starts one');
  same(e.courts, [0, 0], 'courts are back to zero');
  same(e.dealsWon, [0, 0], 'and so are deals won');
  eq(e.matchOver, false, 'the match is live again');
  eq(e.matchWinner, null, 'with nobody having won it');
  eq(e.seats.filter(Boolean).length, SEAT_COUNT, 'and the same four people still seated');
}

// ===========================================================================
section('The match tally — DEALS mode');
// ===========================================================================

/**
 * Open a four-deal match and play the first deal as a court to team 0.
 *
 * courtsToWin is set to 1 deliberately: in DEALS mode it must be ignored
 * outright, and a match that stopped after deal one would prove it is not.
 */
function dealsMatch() {
  const e = table({ matchMode: 'deals', dealsToPlay: 4, courtsToWin: 1 });
  toPlay(e, { dealer: 1, ...sweep(0) });
  playOut(e);
  return e;
}

{
  // Four sweeps, two each way: level on courts AND level on deals.
  const e = dealsMatch();
  same(e.courts, [1, 0], 'deal one is a court to team 0');
  eq(e.matchOver, false,
    'WHICH WOULD HAVE WON A RACE TO ONE — but this mode counts deals, not courts');
  eq(e.publicState().dealsLeft, 3, 'three deals still to play');

  e.nextDeal('p0', 0);
  eq(e.callerSeat, 0, 'the dealer\'s team lost, so the same dealer redeals');
  runDeal(e, sweep(0));
  same(e.courts, [2, 0], 'deal two, another court to team 0');
  eq(e.matchOver, false, 'still not over — two deals left, however lopsided it looks');

  e.nextDeal('p0', 0);
  runDeal(e, sweep(1));
  same(e.courts, [2, 1], 'deal three goes the other way');
  eq(e.dealerSeat, 0, 'and the deal moves on, because that dealer\'s team won');

  e.nextDeal('p0', 0);
  eq(e.callerSeat, 3, 'so the caller moves with it');
  runDeal(e, sweep(1));

  same(e.courts, [2, 2], 'four deals, two courts each');
  same(e.dealsWon, [2, 2], 'and two deals each');
  eq(e.dealsPlayed, 4, 'the agreed number of deals has been played');
  eq(e.matchOver, true, 'so the match is over');
  eq(e.matchWinner, null, 'level on courts and level on deals is a DRAW');
  eq(e.publicState().matchDrawn, true, 'which the public state says outright');
  eq(e.publicState().dealsLeft, 0, 'with no deals left');
  ok(e.log.some((l) => l.kind === 'match' && /drawn/.test(l.text)), 'and the table is told');

  ok(e.nextDeal('p0', 0).ok, 'a drawn match still advances');
  eq(e.phase, PHASES.MATCH_OVER, 'to the match result — a draw is an ending, not a stall');
}

{
  // Level on courts, but not on deals. Two of the four deals are won without a
  // court, which is the only way the tie-break can ever be reached.
  const e = dealsMatch();

  e.nextDeal('p0', 0);
  runDeal(e, sweep(1));
  same(e.courts, [1, 1], 'level on courts after two deals');
  eq(e.dealerSeat, 0, '(the deal has moved on)');

  e.nextDeal('p0', 0);
  eq(e.callerSeat, 3, '(and the caller with it)');
  const third = lateTurnaround(e.callerSeat);
  eq(third.winner, 0, '(deal three is rigged for team 0)');
  runDeal(e, third);
  eq(e.trickWinners.length, 9, 'it runs to trick nine');
  eq(e.dealResult.court, null, 'and is won WITHOUT a court');
  same(e.courts, [1, 1], 'so the courts stay level');
  same(e.dealsWon, [2, 1], 'while the deals do not');
  eq(e.matchOver, false, 'one deal left');

  e.nextDeal('p0', 0);
  const fourth = earlyDrop(e.callerSeat);
  eq(fourth.winner, 0, '(deal four is rigged for team 0 as well)');
  runDeal(e, fourth);
  eq(e.dealResult.court, null, 'also without a court');

  same(e.courts, [1, 1], 'the match ends level on courts, which is the whole point');
  same(e.dealsWon, [3, 1], 'but team 0 took three of the four deals');
  eq(e.matchOver, true, 'the match is over');
  eq(e.matchWinner, 0, 'AND THE TIE-BREAK IS DEALS WON');
  eq(e.publicState().matchDrawn, false, 'so it is not a draw');
}

// ===========================================================================
section('Hidden Rung — the trump is not in the public state');
// ===========================================================================

{
  // Hearts are trump and seat 2 holds almost all of them. Everyone can follow
  // spades twice; on trick three seat 2 is the first player void in the suit
  // led, which is the moment the rung has to come face-up.
  const e = table({ hiddenRung: true });
  toPlay(e, {
    dealer: 1,
    trump: 'H',
    hands: [
      ['AS', 'KS', '3H', ...allOf('D').slice(2, 12)],           // seat 0 — caller
      ['QS', 'JS', '2H', '2D', '5C', '4C', '3C', '2C', '6S', '5S', '4S', '3S', '2S'],
      ['TS', '9S', ...allOf('H').slice(0, 11)],                 // seat 2 — the trumps
      ['8S', '7S', 'AD', 'KD', ...allOf('C').slice(0, 9)],
    ],
  });
  eq(new Set(e.hands.flat()).size, DECK_SIZE, '(the rigged deal is a whole deck)');

  eq(e.trumpSuit, 'H', 'the host knows the trump from the moment it was chosen');
  eq(e.trumpHidden, true, 'but it is flagged hidden');

  // THE TEST THE BRIEF ASKS FOR. A player with devtools open reads the
  // broadcast payload, so the secret has to be absent from it, not merely
  // unrendered.
  const pub = e.publicState();
  eq(pub.trump, null, 'the public state carries no trump while it is hidden');
  eq(pub.trumpHidden, true, 'only the fact that there is one');
  eq(findKey(pub, 'trumpSuit'), false, 'and no trumpSuit key anywhere in the payload, at any depth');
  ok(!JSON.stringify(pub).includes('"trump":"H"'), 'nothing serialises the suit');

  // The same discipline applied to hands, which is the model it is copied from.
  eq(findKey(pub, 'hands'), false, 'no hands in the public state');
  eq(findKey(pub, 'stock'), false, 'no undealt stock either');
  eq(findKey(pub, 'clientId'), false, 'and no clientId — a seat secret is never broadcast');
  eq(pub.seats[2].handCount, HAND_SIZE, 'only how many cards each player holds');

  // Not even the caller's own device sorts by the hidden trump: sort order is
  // visible information, and a partner can watch which end of the fan you play
  // from. They get a private reminder of what they called instead.
  const callerPriv = e.privateStateFor(idAt(e, 0));
  eq(callerPriv.isCaller, true, 'seat 0 called it');
  eq(callerPriv.trumpYouCalled, 'H', 'and is privately reminded which suit');
  eq(e.privateStateFor(idAt(e, 2)).trumpYouCalled, null,
    'nobody else is told, not even the partner');
  ok(e.hands[0].includes('3H'), '(the caller does hold a trump, so this test has teeth)');
  ok(suitOf(callerPriv.hand[0].code) !== 'H',
    'and the caller\'s own hand is NOT sorted trump-first, which would leak it');
  same(callerPriv.hand.map((c) => c.code), sortHand(e.hands[0], null),
    'it is sorted exactly as if the trump were unknown to them too');

  // Tricks one and two: everybody follows spades, so nothing is revealed.
  e.playCard('p0', 'AS'); e.playCard('p3', '8S'); e.playCard('p2', 'TS'); e.playCard('p1', 'QS');
  gather(e);
  eq(e.trumpHidden, true, 'following suit reveals nothing');
  eq(e.publicState().trump, null, 'so the trump is still concealed');
  eq(e.lastTrick.winnerSeat, 0, 'and the ace of spades took the trick normally');

  e.playCard('p0', 'KS'); e.playCard('p3', '7S'); e.playCard('p2', '9S'); e.playCard('p1', 'JS');
  gather(e);
  eq(e.trumpHidden, true, 'still concealed after trick two');

  // Trick three: seat 0 leads a diamond. Seat 3 can follow; seat 2 cannot, and
  // an off-suit card is only legal when void — so it IS the proof the engine
  // waits for.
  e.playCard('p0', 'QD');
  e.playCard('p3', 'AD');
  eq(e.trumpHidden, true, 'a player who could still follow has not triggered it');
  e.playCard('p2', 'AH');
  eq(e.trumpHidden, false, 'THE FIRST PLAYER WHO CANNOT FOLLOW SUIT REVEALS THE TRUMP');
  eq(e.publicState().trump, 'H', 'and it is public from that moment on');
  ok(e.log.some((l) => l.kind === 'reveal'), 'the reveal is logged as its own kind of event, loudly');

  // And the concealed trump was in force all along: seat 2's ace of hearts,
  // played as a discard, takes the trick off the ace of diamonds.
  e.playCard('p1', '2D');
  gather(e);
  eq(e.lastTrick.winnerSeat, 2, 'the hidden trump won the trick it was played on');
  eq(e.turnSeat, 2, 'and its holder leads the next one');
}

{
  // Classic: the trump is announced, so it is public immediately.
  const e = table({ hiddenRung: false });
  toPlay(e, { dealer: 1, trump: 'C' });
  eq(e.trumpHidden, false, 'classic hides nothing');
  eq(e.publicState().trump, 'C', 'the trump is announced with the call');
  ok(e.log.some((l) => l.kind === 'trump'), 'and said out loud');
}

// ===========================================================================
section('Private state');
// ===========================================================================

{
  const e = table();
  toPlay(e, {
    dealer: 1,
    trump: 'H',
    hands: [['AS', '4S', 'KH', '2C', '9D'], allOf('D').slice(0, 5), allOf('H').slice(0, 5), allOf('C').slice(0, 5)],
  });

  const mine = e.privateStateFor('p0');
  eq(mine.seat, 0, 'a player is told their own seat');
  eq(mine.partnerSeat, 2, 'and who their partner is');
  eq(mine.team, teamOf(0), 'and their team');
  eq(mine.isTurn, true, 'seat 0 leads');
  eq(mine.hand.length, 5, 'and sees its own five cards');
  ok(mine.hand.every((c) => c.legal), 'leading, every card is playable');
  eq(suitOf(mine.hand[0].code), 'H', 'the known trump is pulled to the front of the fan');
  eq(e.privateStateFor('nobody'), null, 'a stranger gets nothing at all');

  e.playCard('p0', 'AS');
  const theirs = e.privateStateFor('p3');
  eq(theirs.isTurn, true, 'seat 3 is next — anticlockwise');
  // Seat 3 holds only clubs, so it is void in spades and may play anything.
  ok(theirs.hand.every((c) => c.legal), 'void in the led suit, every card is legal');

  e.playCard('p3', theirs.hand[0].code);
  e.playCard('p2', e.hands[2][0]);
  const follower = e.privateStateFor('p1');
  eq(follower.isTurn, true, 'seat 1 plays last');
  ok(follower.hand.every((c) => !c.legal || suitOf(c.code) === 'S') || !e.hands[1].some((c) => suitOf(c) === 'S'),
    'and may only play spades if it holds any');

  const waiting = e.privateStateFor('p2');
  eq(waiting.isTurn, false, 'a player who is not on turn is told so');
  ok(waiting.hand.every((c) => !c.legal), 'and has nothing marked legal to click');
  ok(waiting.hand.every((c) => c.reason === null), 'with no misleading reasons attached');
}

// ===========================================================================
section('Surviving a reload');
// ===========================================================================

{
  const e = table({ hiddenRung: true });
  toPlay(e, { dealer: 2, trump: 'D' });
  e.playCard(idAt(e, e.callerSeat), e.hands[e.callerSeat][0]);

  const snap = JSON.parse(JSON.stringify(e.serialize()));
  // The snapshot is host-private and goes to the host's own localStorage, so
  // unlike the broadcast it DOES carry the secrets — that is the point of it.
  eq(snap.trumpSuit, 'D', 'the snapshot keeps the hidden trump');
  eq(snap.hands.length, SEAT_COUNT, 'and all four hands');

  const fresh = new GameEngine();
  fresh.restore(snap);
  eq(fresh.phase, e.phase, 'the phase came back');
  eq(fresh.trumpSuit, 'D', 'the trump came back');
  eq(fresh.trumpHidden, true, 'still hidden');
  eq(fresh.turnSeat, e.turnSeat, 'the turn came back');
  same(fresh.hands, e.hands, 'the hands came back');
  same(fresh.publicState(), e.publicState(), 'and it broadcasts exactly what the original did');

  // The reload destroyed every peer connection, so the online flags all point
  // at dead ids. Leaving them set makes every genuine rejoin look like an
  // impostor and locks the table out of the game just restored.
  fresh.resumeAsOwner('p0');
  eq(fresh.seats[0].online, true, 'the host is online');
  eq(fresh.seats[1].online, false, 'everybody else must reconnect');
  ok(fresh.addPlayer('p1-new', 'East', { clientId: 'c1' }).ok,
    'and can, because the seat is still theirs');

  const bots = table();
  bots.seats[3] = { id: 'bot:3:x', name: 'Kot Bot', clientId: null, online: true, isBot: true };
  bots.resumeAsOwner('p0');
  eq(bots.seats[3].online, true, 'a bot stays online through a reload — it had nothing to lose');
}

// ===========================================================================
// CHECKPOINT 3 — the front door.
//
// Everything above trusts its arguments, because everything above is called by
// code in this repo. Everything below is called by whatever a stranger sends
// down a data channel.
// ===========================================================================

// ===========================================================================
section('Guards — envelopes, rate limit, frames');
// ===========================================================================

{
  const good = { type: 'playCard', code: 'AS' };
  ok(validEnvelope(good) === good, 'a valid envelope comes back unchanged, not copied');
  eq(validEnvelope(null), null, 'null is not an envelope');
  eq(validEnvelope(undefined), null, 'undefined is not an envelope');
  eq(validEnvelope('playCard'), null, 'a bare string is not an envelope');
  eq(validEnvelope(7), null, 'a number is not an envelope');
  // An array is the one that slips through a naive typeof check.
  eq(validEnvelope([]), null, 'an array is not an envelope, however well it parses');
  eq(validEnvelope({}), null, 'an envelope needs a type');
  eq(validEnvelope({ type: 123 }), null, 'a type must be a string');
  ok(validEnvelope({ type: 'x'.repeat(MAX_TYPE_LEN) }) !== null, 'a type may be exactly the cap');
  eq(validEnvelope({ type: 'x'.repeat(MAX_TYPE_LEN + 1) }), null, 'one character past the cap is out');
}

{
  // Capacity first: a burst of exactly `capacity` gets through, the next does not.
  const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1, now: 0 });
  eq(bucket.take(0), true, 'first message passes');
  eq(bucket.take(0), true, 'second passes');
  eq(bucket.take(0), true, 'third passes — the bucket holds three');
  eq(bucket.take(0), false, 'the fourth in the same instant is refused');

  // Then refill: one token per second, so a second later exactly one gets through.
  eq(bucket.take(1000), true, 'a second later, one token has refilled');
  eq(bucket.take(1000), false, 'but only one');

  // And the ceiling holds: an idle hour does not bank an hour of messages.
  eq(bucket.take(3600_000), true, 'after an idle hour the bucket is full again');
  eq(bucket.take(3600_000), true, 'second of the refilled burst');
  eq(bucket.take(3600_000), true, 'third');
  eq(bucket.take(3600_000), false, 'and no more than capacity — idling does not bank credit');

  // A clock that jumps backwards must not refund tokens. Date.now() can go
  // backwards across an NTP correction, and a peer's timestamp is not ours to
  // trust in the first place.
  const back = new TokenBucket({ capacity: 2, refillPerSec: 100, now: 10_000 });
  back.take(10_000); back.take(10_000);
  eq(back.take(0), false, 'a backwards clock refills nothing');
}

{
  ok(validClientId('abcd1234') !== null, 'eight characters is a client id');
  eq(validClientId('abcd123'), null, 'seven is not');
  ok(validClientId('a'.repeat(64)) !== null, 'sixty-four is');
  eq(validClientId('a'.repeat(65)), null, 'sixty-five is not');
  ok(validClientId('A-b_9') === null, 'the class is right but it is too short');
  eq(validClientId('abcd 1234'), null, 'no spaces in a client id');
  eq(validClientId('abcd"1234'), null, 'no quotes in a client id');
  eq(validClientId(null), null, 'a missing client id is null, not a crash');
  eq(validClientId(12345678), null, 'a number is not a client id');

  ok(validPlayerId('peer-abc') !== null, 'a peer id passes');
  eq(validPlayerId(''), null, 'an empty peer id does not');
  eq(validPlayerId('x'.repeat(65)), null, 'nor an over-long one');
}

{
  // Every card the game can actually produce must pass, or the guard is a bug
  // rather than a bound.
  let allPass = true;
  for (const code of buildDeck()) if (validCardCode(code) !== code) allPass = false;
  ok(allPass, 'every one of the fifty-two cards passes validCardCode');

  eq(validCardCode('10H'), null, 'the ten is written TH, so 10H is not a card');
  eq(validCardCode('as'), null, 'codes are upper case');
  eq(validCardCode('AS '), null, 'no trailing space');
  eq(validCardCode('ZZ'), null, 'nonsense is not a card');
  eq(validCardCode('AH,KH'), null, 'two cards is not a card');
  eq(validCardCode(''), null, 'nothing is not a card');
  eq(validCardCode('A'), null, 'a rank alone is not a card');
  eq(validCardCode(null), null, 'a missing code is null, not a crash');
  eq(validCardCode('AS'.repeat(30000)), null, 'and a sixty-kilobyte code never reaches a hand');

  for (const suit of SUITS) eq(validSuit(suit), suit, `${suit} is a suit`);
  eq(validSuit('h'), null, 'suits are upper case');
  eq(validSuit('X'), null, 'X is not a suit');
  eq(validSuit(null), null, 'a missing suit is null');
}

{
  eq(validSeat(0), 0, 'seat 0 is a seat — and comes back as 0, not as falsy nothing');
  eq(validSeat(3), 3, 'seat 3 is a seat');
  eq(validSeat(-1), null, 'minus one is not a seat, whatever addBot does with it');
  eq(validSeat(SEAT_COUNT), null, 'there is no fifth seat');
  eq(validSeat(1.5), null, 'seats are integers');
  eq(validSeat('1'), null, 'a stringy seat is not a seat');
  // The one that matters: seats[key] on a prototype name is not undefined.
  eq(validSeat('__proto__'), null, 'and neither is __proto__');
  eq(validSeat(NaN), null, 'nor NaN');
  eq(validSeat(null), null, 'nor nothing at all');
}

{
  ok(validName('Yash') !== null, 'a name passes through to cleanName');
  eq(validName(''), null, 'an empty name is refused before cleaning');
  ok(validName('a'.repeat(MAX_RAW_NAME_LEN)) !== null, 'a long-but-sane name is allowed through');
  eq(validName('a'.repeat(MAX_RAW_NAME_LEN + 1)), null, 'cleanName is never handed a megabyte');
  eq(cleanName(validName('a'.repeat(MAX_RAW_NAME_LEN))).length, 16,
    'and what survives the pair is still sixteen characters');
}

{
  const patch = { hiddenRung: true };
  ok(validConfigPatch(patch) === patch, 'a patch comes back unchanged');
  eq(validConfigPatch({}), null, 'an empty patch is not a change');
  eq(validConfigPatch([]), null, 'an array is not a patch');
  eq(validConfigPatch(null), null, 'nothing is not a patch');
  eq(validConfigPatch('hiddenRung'), null, 'a string is not a patch');

  const wide = {};
  for (let i = 0; i < 17; i++) wide['k' + i] = i;
  eq(validConfigPatch(wide), null, 'seventeen keys is a payload, not a setting');
}

{
  const frame = JSON.stringify({ type: 'playCard', code: 'AS' });
  const decoded = decodePeerFrame(frame);
  ok(decoded !== null && decoded.code === 'AS', 'a normal text frame decodes');

  eq(decodePeerFrame('{'), null, 'malformed JSON is dropped, not thrown');
  eq(decodePeerFrame('[1,2,3]'), null, 'a JSON array is dropped');
  eq(decodePeerFrame('"hello"'), null, 'a JSON string is dropped');
  eq(decodePeerFrame('x'.repeat(MAX_FRAME_BYTES + 1)), null,
    'an oversized frame is dropped before JSON.parse ever sees it');
  eq(decodePeerFrame(new ArrayBuffer(8)), null, 'binary is not something this app sends');
  eq(decodePeerFrame(new Uint8Array(8)), null, 'nor a typed array');

  // PeerJS's own serializer would hand back an already-decoded object.
  const obj = { type: 'playCard', code: 'AS' };
  ok(decodePeerFrame(obj) === obj, 'an already-decoded object is checked and passed');
  eq(decodePeerFrame({ code: 'AS' }), null, 'even then it still needs a type');
}

// ===========================================================================
section('Intents — the dispatcher');
// ===========================================================================

{
  same([...GAME_INTENTS], [...PLAYER_INTENTS, ...OWNER_INTENTS],
    'GAME_INTENTS is exactly the two lists');
  eq(new Set(GAME_INTENTS).size, GAME_INTENTS.length, 'and nothing appears twice');
  ok(!PLAYER_INTENTS.some((t) => OWNER_INTENTS.includes(t)),
    'no intent is both a player move and an owner control');

  // Nothing in the declared list may fall through to the default arm — a name
  // in GAME_INTENTS that the switch does not handle is a control the UI would
  // offer and the host would silently ignore.
  let unhandled = [];
  for (const type of GAME_INTENTS) {
    const e = table();
    const res = applyGameIntent(e, 'p0', { type }, 0);
    if (!res.handled) unhandled.push(type);
  }
  same(unhandled, [], 'every declared intent is handled by the switch');
}

{
  const e = table();
  eq(applyGameIntent(e, 'p0', { type: 'lobbyQuery' }, 0).handled, false,
    'an unknown type is not handled — the transport keeps looking');
  eq(applyGameIntent(e, 'p0', { type: 'join' }, 0).handled, false,
    'join belongs to the transport, not here');
  eq(applyGameIntent(e, 'p0', { type: 123 }, 0).handled, false, 'a non-string type is not handled');
  eq(applyGameIntent(e, 'p0', null, 0).handled, false, 'a missing message is not handled');
  eq(applyGameIntent(e, 'p0', undefined, 0).handled, false, 'nor an absent one');
}

// ---------------------------------------------------------------------------
// The owner gate.
//
// Half these intents are gated in intents.js and half inside the engine (see
// NEEDS_OWNER_GUARD). This test does not care which: it sets each one up so it
// WOULD succeed, then sends it from a seated player who is not the owner, and
// requires a refusal with nothing changed. That is the property worth having,
// and it stays true if the split ever moves.
// ---------------------------------------------------------------------------
{
  const dealtOut = () => {
    const e = table();
    toPlay(e, { dealer: 0, trump: 'S' });
    playOut(e);
    return e;
  };

  const cases = [
    {
      type: 'setConfig',
      make: () => table(),
      msg: { type: 'setConfig', config: { hiddenRung: true } },
      check: (e) => e.config.hiddenRung === true,
    },
    {
      type: 'addBot',
      make: () => { const e = table(); e.seats[3] = null; return e; },
      msg: { type: 'addBot', seat: 3 },
      check: (e) => !!(e.seats[3] && e.seats[3].isBot),
    },
    {
      type: 'removeBot',
      make: () => { const e = table(); e.seats[3] = null; e.addBot(3); return e; },
      msg: { type: 'removeBot', seat: 3 },
      check: (e) => e.seats[3] === null,
    },
    {
      type: 'swapSeats',
      make: () => table(),
      msg: { type: 'swapSeats', a: 0, b: 1 },
      check: (e) => e.seats[0].id === 'p1',
    },
    {
      type: 'startMatch',
      make: () => table(),
      msg: { type: 'startMatch' },
      check: (e) => e.phase !== PHASES.LOBBY,
    },
    {
      type: 'nextDeal',
      make: dealtOut,
      msg: { type: 'nextDeal' },
      check: (e) => e.phase !== PHASES.DEAL_OVER,
    },
    {
      // Forced over rather than played to a court: reaching MATCH_OVER honestly
      // is tested in the match sections, and this one is about the gate.
      type: 'newMatch',
      make: () => { const e = dealtOut(); e.matchOver = true; e.nextDeal('p0', 0); return e; },
      msg: { type: 'newMatch' },
      check: (e) => e.phase === PHASES.DEAL_FIVE,
    },
    {
      type: 'endMatch',
      make: () => { const e = table(); toPlay(e, { dealer: 0, trump: 'S' }); return e; },
      msg: { type: 'endMatch' },
      check: (e) => e.phase === PHASES.LOBBY,
    },
  ];

  eq(cases.length, OWNER_INTENTS.length, 'every owner intent has a gate test');
  same(cases.map((c) => c.type).sort(), [...OWNER_INTENTS].sort(),
    'and they are the same eight');

  for (const c of cases) {
    // p1 is a real player at the table, not a stranger — the gate is about
    // holding the controls, not about being in the room.
    const denied = c.make();
    ok(!c.check(denied), `${c.type}: the setup has not already happened`);
    const res = applyGameIntent(denied, 'p1', c.msg, 0);
    eq(res.handled, true, `${c.type}: refused by us, not passed along`);
    eq(res.result.ok, false, `${c.type}: a seated non-owner is refused`);
    ok(!c.check(denied), `${c.type}: and nothing changed`);

    const allowed = c.make();
    const okRes = applyGameIntent(allowed, 'p0', c.msg, 0);
    eq(okRes.result.ok, true, `${c.type}: the owner is allowed`);
    ok(c.check(allowed), `${c.type}: and it took effect`);
  }
}

{
  // isHost versus isOwner. The engine is running in this process either way;
  // what moves is who holds the controls. Gating on the wrong one would make
  // this pass for p0 forever.
  const e = table();
  e.ownerId = 'p2';
  eq(applyGameIntent(e, 'p0', { type: 'setConfig', config: { hiddenRung: true } }, 0).result.ok,
    false, 'after a handover the old owner is refused');
  eq(e.config.hiddenRung, false, 'and the setting did not move');
  eq(applyGameIntent(e, 'p2', { type: 'setConfig', config: { hiddenRung: true } }, 0).result.ok,
    true, 'the new owner is allowed');
  eq(e.config.hiddenRung, true, 'and the setting moved');
}

// ---------------------------------------------------------------------------
// Argument handling.
// ---------------------------------------------------------------------------
{
  const e = table();
  toPlay(e, { dealer: 0, trump: 'S' });
  const turn = idAt(e, e.turnSeat);
  const held = e.hands[e.turnSeat][0];

  eq(applyGameIntent(e, turn, { type: 'playCard', code: 'ZZ' }, 0).result.error,
    'That is not a card.', 'a malformed code is refused by the guard, before the hand is searched');
  eq(applyGameIntent(e, turn, { type: 'playCard' }, 0).result.ok, false, 'so is a missing code');
  eq(applyGameIntent(e, turn, { type: 'playCard', code: 'AS'.repeat(30000) }, 0).result.ok,
    false, 'so is a sixty-kilobyte one');
  eq(e.trick.length, 0, 'none of which put anything on the table');

  // A well-formed card the player does not hold is the ENGINE's refusal, not
  // the guard's — the guard cannot know what is in a hand and must not guess.
  const notHeld = buildDeck().find((c) => !e.hands[e.turnSeat].includes(c));
  const missRes = applyGameIntent(e, turn, { type: 'playCard', code: notHeld }, 0);
  eq(missRes.result.ok, false, 'a card the player does not hold is refused');
  ok(missRes.result.error !== 'That is not a card.', 'and refused by the engine, which knows why');

  eq(applyGameIntent(e, idAt(e, nextSeat(e.turnSeat)), { type: 'playCard', code: held }, 0).result.ok,
    false, 'playing out of turn is refused');

  eq(applyGameIntent(e, turn, { type: 'playCard', code: held }, 0).result.ok, true,
    'and the real play goes through');
  eq(e.trick.length, 1, 'one card on the table');
}

{
  // addBot and removeBot disagree on purpose about what a bad seat means.
  const e = table();
  e.seats[2] = null;
  e.seats[3] = null;
  eq(applyGameIntent(e, 'p0', { type: 'addBot', seat: 1e9 }, 0).result.ok, true,
    'addBot with an impossible seat still seats a bot');
  ok(e.seats[2] && e.seats[2].isBot, 'in the first free seat, as if no seat had been named');
  eq(applyGameIntent(e, 'p0', { type: 'addBot' }, 0).result.ok, true, 'and with no seat at all');

  eq(applyGameIntent(e, 'p0', { type: 'removeBot', seat: 1e9 }, 0).result.error,
    'That is not a seat.', 'removeBot refuses rather than guessing which bot was meant');
  eq(applyGameIntent(e, 'p0', { type: 'removeBot', seat: '__proto__' }, 0).result.ok, false,
    'and is not reachable through a prototype name');
  eq(applyGameIntent(e, 'p0', { type: 'removeBot', seat: 0 }, 0).result.ok, false,
    'a human is not a bot');
  eq(applyGameIntent(e, 'p0', { type: 'removeBot', seat: 2 }, 0).result.ok, true, 'a bot is');

  eq(applyGameIntent(e, 'p0', { type: 'swapSeats', a: '0', b: 1 }, 0).result.ok, false,
    'swapSeats needs two real seats');
  eq(applyGameIntent(e, 'p0', { type: 'swapSeats', a: 1, b: 1 }, 0).result.ok, false,
    'and two different ones');
}

{
  const e = table();
  eq(applyGameIntent(e, 'p0', { type: 'setConfig', config: { dealsToPlay: 1e9 } }, 0).result.ok,
    true, 'a hostile target is accepted as a message');
  eq(e.config.dealsToPlay, DEAL_TARGET_DEFAULT, 'and normalised back to the default, not stored');

  const wide = {};
  for (let i = 0; i < 40; i++) wide['k' + i] = i;
  eq(applyGameIntent(e, 'p0', { type: 'setConfig', config: wide }, 0).result.ok, false,
    'a forty-key patch is refused before it is spread into anything');

  // JSON.parse makes __proto__ an ordinary own key, so this is a real payload a
  // peer can send. normalizeConfig rebuilds from a fixed list, so it goes
  // nowhere — but the assertion is worth having in writing.
  applyGameIntent(e, 'p0',
    { type: 'setConfig', config: JSON.parse('{"__proto__":{"polluted":true}}') }, 0);
  eq({}.polluted, undefined, 'and a __proto__ patch pollutes nothing');
  same(Object.keys(e.config).sort(), ['courtsToWin', 'dealsToPlay', 'hiddenRung', 'matchMode'],
    'the config still has exactly its four keys');
}

{
  // The clock is a parameter all the way down. If the dispatcher ever reaches
  // for Date.now() this fails, because the stamp would not be the number handed
  // in — and with it goes every replayable test in this file.
  const e = table();
  applyGameIntent(e, 'p0', { type: 'startMatch' }, 7000);
  eq(e.phaseAt, 7000, 'startMatch stamps the phase with the time it was given');
  e.tick(7000 + DEAL_PAUSE_MS);
  applyGameIntent(e, idAt(e, e.callerSeat), { type: 'declareTrump', suit: 'H' }, 9500);
  eq(e.phaseAt, 9500, 'declareTrump too');
  eq(e.trumpSuit, 'H', 'and the suit arrived');

  eq(applyGameIntent(e, idAt(e, e.callerSeat), { type: 'declareTrump', suit: 'X' }, 0).result.ok,
    false, 'a bogus suit is refused by the engine');
}

// ---------------------------------------------------------------------------
// A whole deal driven through nothing but applyGameIntent, which is how a
// remote player's deal actually runs.
// ---------------------------------------------------------------------------
{
  seed(31337);
  const e = table({ hiddenRung: true });
  let now = 0;
  let refused = 0;
  const send = (actor, msg) => {
    const res = applyGameIntent(e, actor, msg, now);
    if (!res.handled || !res.result.ok) refused++;
    return res;
  };

  send('p0', { type: 'startMatch' });
  eq(e.phase, PHASES.DEAL_FIVE, 'the dispatcher started the match');
  now += DEAL_PAUSE_MS; e.tick(now);

  send(idAt(e, e.callerSeat), { type: 'declareTrump', suit: 'C' });
  eq(e.phase, PHASES.DEAL_REST, 'the dispatcher called trump');
  eq(e.publicState().trump, null, 'and under Hidden Rung it is still nobody else\'s business');
  now += DEAL_PAUSE_MS; e.tick(now);

  let plays = 0, guard = 0;
  while (e.phase === PHASES.PLAY) {
    if (++guard > TRICKS_PER_DEAL * SEAT_COUNT + 1) throw new Error('play did not terminate');
    const seat = e.turnSeat;
    const legal = legalPlays(e.hands[seat], ledSuitOf(e.trick));
    send(idAt(e, seat), { type: 'playCard', code: legal[0] });
    plays++;
    // The dispatcher hands playCard the clock, so the hold is timed from the
    // moment the fourth card arrived rather than from zero.
    if (e.trickComplete) {
      eq(e.trickAt, now, 'the dispatcher stamps a completed trick with the time it was given');
      now += TRICK_PAUSE_MS; e.tick(now);
    }
  }

  eq(refused, 0, 'not one legal message was refused along the way');
  ok(plays >= TRICKS_TO_WIN * SEAT_COUNT, 'a full deal was played through the dispatcher');
  eq(e.phase, PHASES.DEAL_OVER, 'and it ended in DEAL_OVER');
  ok(e.dealResult !== null, 'with a result to show');

  send('p0', { type: 'nextDeal' });
  eq(refused, 0, 'and the owner dealt again');
  ok(e.phase === PHASES.DEAL_FIVE || e.phase === PHASES.MATCH_OVER, 'moving the table on');
}

// ---------------------------------------------------------------------------
// Junk. The host is somebody's phone and a refusal must never be a crash.
// ---------------------------------------------------------------------------
{
  const junk = [
    null, undefined, 0, false, 'playCard', [], [1, 2, 3], {},
    { type: 123 }, { type: null }, { type: 'x'.repeat(MAX_TYPE_LEN + 1) },
    { type: 'playCard' }, { type: 'playCard', code: null }, { type: 'playCard', code: {} },
    { type: 'playCard', code: ['AS'] }, { type: 'declareTrump' }, { type: 'declareTrump', suit: 9 },
    { type: 'setConfig' }, { type: 'setConfig', config: null }, { type: 'setConfig', config: [] },
    { type: 'addBot', seat: -1 }, { type: 'removeBot' }, { type: 'removeBot', seat: 'constructor' },
    { type: 'swapSeats' }, { type: 'swapSeats', a: null, b: null },
    { type: 'swapSeats', a: 0, b: 99 }, { type: 'nextDeal' }, { type: 'newMatch' },
    { type: 'endMatch' }, { type: '__proto__' }, { type: 'constructor' }, { type: 'toString' },
  ];

  let threw = 0, badShape = 0, accepted = 0;
  for (const msg of junk) {
    // Sent as the OWNER, which is the worst case: a stranger would be stopped by
    // the gate before any of this is reached.
    const e = table();
    let res;
    try { res = applyGameIntent(e, 'p0', msg, 0); } catch (_) { threw++; continue; }
    if (!res || typeof res.handled !== 'boolean') { badShape++; continue; }
    if (res.handled && res.result && res.result.ok) accepted++;
    if (e.phase !== PHASES.LOBBY) accepted++;
    if (e.config.hiddenRung !== DEFAULTS.hiddenRung) accepted++;
  }
  eq(threw, 0, `nothing in ${junk.length} junk messages threw`);
  eq(badShape, 0, 'and every one came back as a { handled, result } pair');
  eq(accepted, 0, 'and not one of them was accepted or moved the game');

  // 'toString' and '__proto__' are the ones to watch: a switch is safe, but an
  // object-literal dispatch table would have matched them against
  // Object.prototype and called something.
  eq(applyGameIntent(table(), 'p0', { type: 'toString' }, 0).handled, false,
    'a prototype method name is not an intent');
  eq(applyGameIntent(table(), 'p0', { type: '__proto__' }, 0).handled, false,
    'and neither is __proto__');
}

// ===========================================================================
// CHECKPOINT 4 — the bot.
//
// Two kinds of test here, answering different questions.
//
// The RIGGED positions put one decision on the table and nothing else, so that
// when one fails it names the thing that broke — "it ruffed its own partner",
// not "deal 431 went wrong". Every one of them asks the bot through exactly the
// two views a real client gets, publicState() and one privateStateFor(),
// because that interface IS the anti-cheat: a test that reached past it would
// be exercising something the real game never runs.
//
// The SOAK then plays a thousand deals bot against bot and asserts the
// properties that must hold in every position there is rather than in the
// interesting ones: never an illegal card, never a trump over its own partner.
// ===========================================================================

// --- rigging helpers -------------------------------------------------------

/** { S: 'AKQ', H: '432' } -> ['AS','KS','QS','4H','3H','2H'].
 *
 *  One string of ranks per suit is the only way a thirteen-card holding fits on
 *  a line and can be checked by eye, which matters because every deal below was
 *  built by hand so that one decision is the only interesting thing on it. */
function hand(spec) {
  const out = [];
  for (const suit of SUITS) for (const r of (spec[suit] || '')) out.push(r + suit);
  return out;
}

/**
 * Four hands that are between them exactly one deck.
 *
 * Checked rather than trusted. A rigged deal with a card missing or a rank
 * repeated still plays perfectly well, and the test built on it then passes or
 * fails for a reason nobody intended — the worst kind of test there is. Every
 * deal in this section goes through here.
 */
function deal(...specs) {
  const hands = specs.map(hand);
  const flat = hands.flat();
  ok(hands.length === SEAT_COUNT && hands.every((h) => h.length === HAND_SIZE),
    'rigged deal: four hands of thirteen');
  ok(flat.length === DECK_SIZE && new Set(flat).size === DECK_SIZE,
    'rigged deal: exactly one deck, nothing missing or doubled');
  return hands;
}

/** Play these cards in turn order, starting from whoever is on lead. Throws
 *  rather than reporting: a rigged position that will not set up is a broken
 *  test, and a broken test must never be allowed to look like a failing bot. */
function lay(e, ...codes) {
  for (const code of codes) {
    const res = e.playCard(idAt(e, e.turnSeat), code);
    if (!res.ok) throw new Error(`rigged play refused: ${code} — ${res.error}`);
    gather(e);
  }
}

/** What the bot in this seat would do — through the two views and nothing
 *  else. Every rigged test goes through this one line, so no single test can
 *  quietly hand the bot something extra. */
const ask = (e, seat) => chooseCard(e.publicState(), e.privateStateFor(idAt(e, seat)));
const askCard = (e, seat) => { const i = ask(e, seat); return i && i.code; };

// ===========================================================================
section('Bot — calling the trump');
// ===========================================================================

// The rule, stated once: longest suit, high cards only as the tie-break. See
// LENGTH_WEIGHT in js/bot.js for why that ordering and not the other one.
eq(chooseTrump(hand({ S: 'AK', D: '432' })), 'D',
  'three rags outrank a doubleton ace-king — length is what takes tricks');
eq(chooseTrump(hand({ S: 'AK', H: '32', C: 'Q' })), 'S',
  'between two doubletons the high cards decide');
eq(chooseTrump(hand({ H: '5432', C: 'A' })), 'H', 'and a four-card suit beats a bare ace');
eq(chooseTrump(hand({ D: 'AKQJT' })), 'D', 'five of one suit calls that suit');

// Pins LENGTH_WEIGHT at exactly 10. Seven cards, so no real declaring hand can
// reach it — but chooseTrump is a plain function and this is the boundary its
// comment claims, so it is worth holding it there. Raising the weight keeps
// this passing; dropping it below 10 breaks it.
eq(chooseTrump(hand({ H: 'AKQ', S: '5432' })), 'S',
  'ace-king-queen (39) still loses to four rags (40)');

// A tie goes to SUITS order, which makes a bot's call reproducible. Nothing
// leaks: the hand it is looking at is secret, so there is no pattern to read.
eq(chooseTrump(hand({ S: 'AK', H: 'AK', C: '2' })), 'S', 'an exact tie breaks by suit order');

// Both shapes a caller might pass: plain codes, and the { code, legal } objects
// privateStateFor() actually hands out. Getting this wrong fails SILENTLY — the
// hand reads as empty and every suit scores zero — so it is checked directly.
eq(
  chooseTrump(['2D', '3D', '4D', 'AS', 'KS']),
  chooseTrump([{ code: '2D' }, { code: '3D' }, { code: '4D' }, { code: 'AS' }, { code: 'KS' }]),
  'codes and { code } objects are read the same way',
);

// Nothing sensible to say, but it must still say something: chooseIntent()
// feeds this straight into declareTrump(), which only accepts a real suit.
ok(SUITS.includes(chooseTrump([])), 'an empty hand still yields a suit rather than undefined');
ok(SUITS.includes(chooseTrump(null)), 'and so does no hand at all');

// The whole specification, checked against every hand rather than five of them.
// The four examples above are the readable version of this.
{
  seed(31337);
  const HCP = { A: 4, K: 3, Q: 2, J: 1 };
  let notHeld = 0, notLongest = 0, notStrongest = 0, notFirst = 0;
  const pool = buildDeck();
  for (let i = 0; i < 4000; i++) {
    const five = shuffle(pool).slice(0, DEAL_BATCHES[0]);
    const pick = chooseTrump(five);
    const len = (s) => five.filter((c) => suitOf(c) === s).length;
    const hcp = (s) => five.filter((c) => suitOf(c) === s)
      .reduce((n, c) => n + (HCP[rankOf(c)] || 0), 0);

    if (!len(pick)) notHeld++;
    const maxLen = Math.max(...SUITS.map(len));
    if (len(pick) !== maxLen) notLongest++;
    const longest = SUITS.filter((s) => len(s) === maxLen);
    if (hcp(pick) !== Math.max(...longest.map(hcp))) notStrongest++;
    if (pick !== longest.filter((s) => hcp(s) === hcp(pick))[0]) notFirst++;
  }
  eq(notHeld, 0, 'over 4000 five-card hands it never called a suit it does not hold');
  eq(notLongest, 0, 'it always called its longest suit');
  eq(notStrongest, 0, 'and the strongest of its longest suits');
  eq(notFirst, 0, 'breaking any remaining tie by suit order');
}

// ===========================================================================
section('Bot — the rigged deals');
// ===========================================================================

// Written out together rather than inline, so the partition check in deal()
// runs once each and so the three PAIRS that differ by a single card can be
// read against each other — that one card is the whole experiment.

// Seat 1 is the bot: void in clubs, holding all four top trumps and nothing
// else worth keeping. Dealer 1, so seat 0 cuts, calls and leads, and the play
// order is 0, 3, 2, 1 — which puts the bot LAST with its partner (seat 3)
// second. That is the only arrangement in which a partner can be in front when
// the bot plays last: from leader L the order is L, L+3, L+2, L+1, so a bot
// playing last sits at L+1 and its partner at L+3, which is second.
const D_PARTNER = deal(
  { S: 'T',      H: 'AK',   D: 'AKQ',   C: 'AKQJT98' },
  { S: 'AKQJ',   H: 'QJT9', D: 'JT987', C: '' },
  { S: '98',     H: '876',  D: '65',    C: '765432' },
  { S: '765432', H: '5432', D: '432',   C: '' },
);

// Dealer 0, so seat 3 leads and the bot at seat 1 plays THIRD — not last, which
// is what makes this the dangerous one. Its partner leads a king that the ace
// can still beat, the bot is void, and it holds every top trump.
const D_RUFF = deal(
  { S: 'T98',  H: 'AK87', D: 'AKQ',   C: 'A32' },
  { S: 'AKQJ', H: 'QJT9', D: 'JT987', C: '' },
  { S: '765',  H: '654',  D: '654',   C: '8765' },
  { S: '432',  H: '32',   D: '32',    C: 'KQJT94' },
);

// Everyone can follow clubs except the bot, which matters under Hidden Rung:
// an off-suit card is what triggers the reveal, so the bot's own discard being
// the FIRST one is what lets it decide while the trump is still secret.
const D_HIDDEN = deal(
  { S: 'T98',  H: 'AK87', D: 'AKQ',   C: 'AKQ' },
  { S: 'AKQJ', H: 'QJT9', D: 'JT987', C: '' },
  { S: '765',  H: '654',  D: '654',   C: 'JT98' },
  { S: '432',  H: '32',   D: '32',    C: '765432' },
);

// Dealer 1 again, bot last, but this time following suit: its partner holds the
// ace of hearts and the bot holds the king.
const D_LAST = deal(
  { S: 'A2',   H: 'Q98765', D: 'AKQ',  C: 'AK' },
  { S: 'KQJT', H: 'KJ',     D: 'JT98', C: 'QJT' },
  { S: '9876', H: 'T2',     D: '765',  C: '9876' },
  { S: '543',  H: 'A43',    D: '432',  C: '5432' },
);

// Dealer 0, bot third with one opponent still to come. The pair differ only in
// which of seats 1 and 3 holds the ace of hearts, which is exactly what turns
// "overtake your partner" into "do not".
const overDeal = (h1, h3) => deal(
  { S: 'A2',   H: 'KT987653', D: 'AK',   C: 'A' },
  { S: 'KQJT', H: h1,         D: 'QJT9', C: 'KQJ' },
  { S: '9876', H: '2',        D: '8765', C: 'T987' },
  { S: '543',  H: h3,         D: '432',  C: '65432' },
);
const D_OVERTAKE = overDeal('AJ', 'Q4');   // the partner's queen can be topped
const D_DUCK     = overDeal('Q4', 'AJ');   // the partner's ace cannot

// Seat 0 is the bot, on lead, with no boss card anywhere. The pair differ by one
// trump — either side of DRAW_TRUMPS_AT — with a heart moved across to keep both
// hands at thirteen.
const drawDeal = (s0, s1, h0, h1) => deal(
  { S: s0,    H: h0,    D: 'Q98',  C: 'Q98' },
  { S: s1,    H: h1,    D: 'AKJ',  C: 'AKJ' },
  { S: '765', H: '765', D: '765',  C: 'T765' },
  { S: '432', H: '432', D: 'T432', C: '432' },
);
const D_DRAW4 = drawDeal('KQJT', 'A98',  'Q98',  'AKJT');
const D_DRAW3 = drawDeal('QJT',  'AK98', 'QJ98', 'AKT');

// The memory pair. Dealer 1; seat 0 leads a low heart and the bot at seat 1 wins
// with the king while keeping the ace. The two deals differ by ONE CARD — seat 2
// holds either the three of hearts or the nine of clubs — so in one of them seat
// 2 shows out on trick one and in the other it follows. The bot's own hand, and
// everything else about its position on trick two, is identical.
const voidDeal = (h0, h2, c0, c2) => deal(
  { S: 'A98',  H: h0,     D: 'AK',   C: c0 },
  { S: 'KQJ',  H: 'AKQ',  D: 'QJT9', C: 'QJT' },
  { S: 'T765', H: h2,     D: '8765', C: c2 },
  { S: '432',  H: 'JT98', D: '432',  C: '432' },
);
const D_VOID    = voidDeal('765432', '',  'AK',  '98765');
const D_NO_VOID = voidDeal('76542',  '3', 'AK9', '8765');

// ===========================================================================
section('Bot — it plays a card, or it plays nothing');
// ===========================================================================

{
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_PARTNER });

  // Seat 0 is on lead, so nobody else has a decision to make. privateStateFor()
  // marks no card legal when it is not your turn, so this falls out rather than
  // needing a check of its own — but a bot that moved out of turn would be a
  // disaster, so it is asserted rather than assumed.
  eq(ask(e, 1), null, 'it returns nothing at all when it is not its turn');
  eq(ask(e, 2), null, 'for any seat that is not on lead');
  ok(ask(e, 0) !== null, 'and something when it is');

  eq(chooseCard(null, null), null, 'no views, no move');
  eq(chooseCard(e.publicState(), null), null, 'and a missing private view is not guessed at');
  eq(chooseCard(e.publicState(), { seat: 1, isTurn: true, hand: [] }), null,
    'an empty hand yields nothing rather than an undefined card');

  const intent = ask(e, 0);
  eq(intent.type, 'playCard', 'the answer is a wire message, not a card');
  ok(validCardCode(intent.code) !== null, 'carrying a code the guards accept');
  ok(e.hands[0].includes(intent.code), 'and one the bot is actually holding');
}

{
  // Thirteen tricks means the last one is always forced, and the short-circuit
  // for it runs before readTable() — so it has to be right on its own.
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_PARTNER });
  lay(e, '8C', '2S', '7C');
  e.hands[1] = ['9H'];
  eq(askCard(e, 1), '9H', 'with one card left it plays it');
}

// ===========================================================================
section('Bot — following suit is not optional');
// ===========================================================================

// The engine refuses an illegal card anyway, so this is not about whether a
// revoke could reach the table. It is about whether the bot ever TRIES: a bot
// whose move is refused does not then play a worse card, it falls through to
// panic() and plays an arbitrary one, and the table watches a player behave at
// random. The soak counts these across a thousand deals; these two name the
// positions where a careless ranking would produce one.
{
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_LAST });
  lay(e, 'QH');
  // Seat 3 holds the ace of hearts AND three trumps. Following is the rule even
  // when trumping would also win, which is the half people get wrong.
  eq(suitOf(askCard(e, 3)), 'H', 'holding both a heart and a trump on a heart lead, it follows');
}
{
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_PARTNER });
  lay(e, '8C', '2S', '7C');
  // The mirror image, and the other half people get wrong: void in the suit
  // led, so there is NO obligation to trump and every card is legal. The engine
  // says so; the bot must not invent an obligation the rules do not have.
  const legal = legalPlays(e.hands[1], 'C');
  eq(legal.length, HAND_SIZE, 'void in the led suit, every card is legal');
  ok(legal.includes(askCard(e, 1)), 'and it picks one of them');
}

// ===========================================================================
section('Bot — it knows whether its partner is winning');
// ===========================================================================

// The single thing that separates a bot that feels like a player from one that
// feels broken, so it gets four positions rather than one.

{
  // Partner in front with the ace, bot last, following suit. Nothing to gain,
  // so pay the least it can — and specifically do not put the king on it.
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_LAST });
  lay(e, 'QH', 'AH', '2H');
  ok(partnerWinning(e.trick, 1, 'S'), "setup: the bot's partner is in front");
  eq(e.trick.length, SEAT_COUNT - 1, 'setup: the bot is last to play');
  eq(askCard(e, 1), 'JH', 'partner winning and nothing to gain: it plays its cheapest heart');
}

{
  // THE REGRESSION THAT PROMPTED THE isBoss/unbeatable SPLIT IN follow().
  //
  // The partner leads the king of clubs with the ace still out, so it is NOT
  // safe. The bot is void in clubs and holds the ace, king, queen and jack of
  // trumps — every one of which beats what is on the table and none of which
  // can be beaten back. It is third, so the last-to-play shortcut does not
  // save it. An overtake rule that asks only "can this card be topped?" plays
  // one of them and takes the trick off its own partner.
  const e = toPlay(table(), { dealer: 0, trump: 'S', hands: D_RUFF });
  lay(e, 'KC', '5C');
  ok(partnerWinning(e.trick, 1, 'S'), 'setup: the partner is in front');
  eq(e.trick.length, SEAT_COUNT - 2, 'setup: the bot is third, with an opponent still to come');
  ok(e.hands[0].includes('AC'), 'setup: the ace of clubs is out, so the partner is not yet safe');
  ok(e.hands[1].includes('AS') && !e.hands[1].some((c) => suitOf(c) === 'C'),
    'setup: the bot is void in clubs and holds the top trump');
  const pick = askCard(e, 1);
  ok(suitOf(pick) !== 'S', 'IT DOES NOT RUFF ITS OWN PARTNER');
  eq(pick, '7D', 'it discards its cheapest side card instead');
}

{
  // The same refusal one step further on: here the partner has already RUFFED,
  // and over-ruffing it would be just as wasteful. cheapest() prices trumps
  // above every ordinary card, so this needs no branch of its own — which is
  // the thing being checked.
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_PARTNER });
  lay(e, '8C', '2S', '7C');
  ok(partnerWinning(e.trick, 1, 'S'), 'setup: the partner ruffed and is in front');
  eq(e.hands[1].filter((c) => suitOf(c) === 'S').length, 4, 'setup: the bot holds four trumps');
  eq(askCard(e, 1), '7D', 'it discards rather than over-ruffing its own partner');
}

{
  // Partner's queen is in front, the king is still out, and one opponent has yet
  // to play. The bot holds the ace: overtaking settles the argument, so it does.
  const e = toPlay(table(), { dealer: 0, trump: 'S', hands: D_OVERTAKE });
  lay(e, 'QH', '2H');
  ok(partnerWinning(e.trick, 1, 'S'), 'setup: the partner leads and is in front');
  eq(askCard(e, 1), 'AH', 'it overtakes a toppable partner with the card that settles it');
}

{
  // The same shape with the two heart holdings swapped: the partner now has the
  // ace and there is nothing to improve on, so the bot keeps its queen. The
  // opponent behind could still ruff — which is precisely why "could this be
  // ruffed?" must not enter this decision. A ruff would beat the queen too.
  const e = toPlay(table(), { dealer: 0, trump: 'S', hands: D_DUCK });
  lay(e, 'AH', '2H');
  ok(partnerWinning(e.trick, 1, 'S'), 'setup: the partner is in front with the ace');
  eq(askCard(e, 1), '4H', 'it does not waste the queen on a partner who has already won it');
}

// ===========================================================================
section('Bot — taking a trick off an opponent');
// ===========================================================================

{
  // Opponent in front, bot last, two cards that would win. Every trick is worth
  // the same in this game — there are no card points — so the smaller is always
  // the right one.
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_LAST });
  lay(e, '5H', '3H', '2H');
  ok(!partnerWinning(e.trick, 1, 'S'), 'setup: an opponent is in front');
  eq(askCard(e, 1), 'JH', 'it takes the trick with the smaller of two winners');
}

{
  // Void in the suit led with an opponent in front: ruff, and with the cheapest
  // trump that does the job. The bot holds the top four trumps, so a ranking
  // that reached for the highest would be spending an ace to beat a club.
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_PARTNER });
  lay(e, '8C', '2H', '7C');
  ok(!partnerWinning(e.trick, 1, 'S'), 'setup: an opponent is in front');
  eq(askCard(e, 1), 'JS', 'it ruffs with the lowest trump that wins');
}

// ===========================================================================
section('Bot — managing trumps');
// ===========================================================================

{
  // Four of thirteen is more than a fair share, which is the point at which
  // pulling the opponents' trumps stops helping them and starts helping you.
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_DRAW4 });
  eq(e.turnSeat, 0, 'setup: the bot is on lead');
  eq(e.hands[0].filter((c) => suitOf(c) === 'S').length, 4, 'setup: it holds four trumps');
  eq(askCard(e, 0), 'KS', 'with four trumps it leads its highest to draw theirs');
}

{
  // One card's difference. From three, every round of trumps spends one of ours
  // to remove one of theirs, which is their plan rather than ours.
  const e = toPlay(table(), { dealer: 1, trump: 'S', hands: D_DRAW3 });
  eq(e.hands[0].filter((c) => suitOf(c) === 'S').length, 3, 'setup: it holds three trumps');
  const pick = askCard(e, 0);
  ok(suitOf(pick) !== 'S', 'with three it does not start pulling them');
  eq(pick, '8D', 'it opens low from a short side suit instead, playing for a void');
}

// ===========================================================================
section('Bot — remembering who showed out');
// ===========================================================================

// Two deals differing by ONE CARD, played identically up to the same decision.
// In one an opponent discarded on the first trick and is therefore known to be
// void; in the other it followed. If the bot's memory works, that fact — and
// nothing else — changes what it leads next.
{
  const trickOne = (hands, third) => {
    const e = toPlay(table(), { dealer: 1, trump: 'S', hands });
    lay(e, '2H', '8H', third, 'KH');
    eq(e.turnSeat, 1, 'setup: the bot won the first trick and is on lead');
    return e;
  };

  const shown = trickOne(D_VOID, '5C');     // seat 2 shows out in hearts
  const quiet = trickOne(D_NO_VOID, '3H');  // seat 2 follows

  // The bot's own cards are the same in both. Asserted, because if the two
  // deals drifted apart the comparison below would mean nothing at all.
  same(
    shown.hands[1].slice().sort(), quiet.hands[1].slice().sort(),
    'setup: the bot holds exactly the same cards in both deals',
  );
  ok(shown.hands[1].includes('AH'), 'setup: including the ace of hearts');
  same(shown.publicState().tricks[0].plays.map((p) => p.seat), [0, 3, 2, 1],
    'setup: and the completed trick is public, in play order');

  eq(askCard(quiet, 1), 'AH',
    'with nothing known about the opponents it cashes the ace of hearts');
  ok(askCard(shown, 1) !== 'AH',
    'having watched an opponent discard on hearts, it does NOT lead the ace into the ruff');

  // Reconstructed from pub.tricks on every call, not carried between them.
  // That is what lets a bot take over a seat mid-deal after a host reload and
  // know exactly what the seat's previous occupant knew.
  eq(askCard(shown, 1), askCard(shown, 1), 'asked twice, it answers the same way');
  eq(shown.publicState().tricks.length, 1, 'and the whole of its memory is one public trick');
}

// ===========================================================================
section('Bot — Hidden Rung: the secret does not reach it');
// ===========================================================================

// The bots run on the host, and the host knows the trump. The only thing
// keeping a non-caller honest is the shape of chooseCard(), so this asserts the
// SHAPE rather than an outcome: the same deal is set up four times with four
// different trumps, and a bot that did not call must not be able to tell which.
{
  const setUp = (trump, hiddenRung) => {
    // Re-seeded per run because startMatch() picks the opening dealer at random
    // and writes that seat's name into the log before toPlay() overrides it.
    // That line is public, so without this the four runs differ in the payload
    // for a reason that has nothing to do with the trump — and the comparison
    // below would be failing for the wrong reason rather than catching a leak.
    seed(4242);
    const e = toPlay(table({ hiddenRung }), { dealer: 1, trump, hands: D_HIDDEN });
    // Everyone follows clubs, so nothing has revealed the trump. The bot at
    // seat 1 is void and is about to be the first player to show out — it
    // decides while the suit is still secret.
    lay(e, 'QC', '2C', '8C');
    return e;
  };

  const runs = SUITS.map((s) => setUp(s, true));
  ok(runs.every((e) => e.trumpHidden), 'setup: the trump is still hidden in all four');

  const views = runs.map((e) => ({ pub: e.publicState(), priv: e.privateStateFor(idAt(e, 1)) }));
  for (let i = 1; i < views.length; i++) {
    same(views[i].pub, views[0].pub,
      `the public state is identical whether ${SUITS[i]} or ${SUITS[0]} is trump`);
    same(views[i].priv, views[0].priv,
      `and so is a non-caller's private view (${SUITS[i]} vs ${SUITS[0]})`);
  }
  // Including the log, which is where a leak would most easily hide: the engine
  // says "called trump face-down" rather than naming the suit.
  ok(!views[0].pub.log.some((l) => SUITS.some((s) => l.text.includes(suitName(s)))),
    'and no log line names a suit while the trump is face-down');

  const picks = runs.map((e) => askCard(e, 1));
  eq(new Set(picks).size, 1, 'so the bot plays the same card whatever the trump really is');

  // Non-vacuity. The same position in Classic, where the bot CAN see the trump,
  // must produce a different card — otherwise everything above would also pass
  // on a bot that had been handed the secret and merely ignored it.
  const open = setUp('S', false);
  eq(open.publicState().trump, 'S', 'setup: in Classic the trump is public');
  eq(askCard(open, 1), 'JS', 'knowing spades are trumps, it ruffs');
  eq(picks[0], '7D', 'not knowing, it discards — so the four runs above are not vacuous');

  // The caller is the exception, and is meant to be: they chose the suit, they
  // already know it, and trumpYouCalled is how their device remembers it across
  // a reload. Proving they DO get it is what proves the other three seats are
  // being denied it deliberately rather than by accident.
  const r = runs[0];
  eq(r.privateStateFor(idAt(r, r.callerSeat)).trumpYouCalled, 'S',
    'the caller is told back the suit they called');
  eq(r.privateStateFor(idAt(r, 1)).trumpYouCalled, null, 'and nobody else is');
}

// ===========================================================================
section('Bot — the driver: one move, at a human pace');
// ===========================================================================

/** A table the driver can run unaided.
 *
 *  startMatch() insists on somebody real being at the table — four seats is the
 *  game, and a room of nothing but bots is not a game anybody asked for — so a
 *  human starts it and is then marked as a bot, which is a thing only this
 *  harness ever does. */
function botTable(config = null) {
  const e = table(config);
  e.startMatch('p0', 0);
  for (const p of e.seats) p.isBot = true;
  return e;
}

{
  const e = botTable();
  const d = createBotDriver();
  e.tick(DEAL_PAUSE_MS);
  eq(e.phase, PHASES.DECLARE_TRUMP, 'setup: a bot has to call the trump');

  eq(d.tick(e, 0), false, 'it does not move the instant the turn arrives');
  eq(d.tick(e, BOT_THINK_MS - 1), false, 'nor a millisecond early');
  eq(e.trumpSuit, null, 'and nothing has happened to the engine meanwhile');
  eq(d.tick(e, BOT_THINK_MS), true, 'it moves on the beat');
  ok(SUITS.includes(e.trumpSuit), 'and the trump is called');

  eq(d.tick(e, BOT_THINK_MS), false, 'a second tick on the same turn does nothing');
  eq(d.tick(e, BOT_THINK_MS * 10), false, 'however long it is left there');
}

{
  // The pause runs from the tick that noticed the turn, not from zero, so a host
  // that has just taken over an engine does not fire every bot at once.
  const e = botTable();
  const d = createBotDriver();
  e.tick(DEAL_PAUSE_MS);
  d.tick(e, 0);
  d.reset();
  eq(d.tick(e, BOT_THINK_MS), false, 'after reset() the old deadline is forgotten');
  eq(d.tick(e, BOT_THINK_MS * 2), true, 'and the wait is served again from scratch');
}

{
  const e = botTable();
  const d = createBotDriver({ thinkMs: 10 });
  e.tick(DEAL_PAUSE_MS);
  // The clock starts at the tick that NOTICED the turn, per the block above, so
  // the wait is measured from this first call and not from zero.
  eq(d.tick(e, 0), false, 'the pause is configurable');
  eq(d.tick(e, 9), false, 'and is not served a millisecond early');
  eq(d.tick(e, 10), true, 'and honoured');
}

{
  // Phases nobody is being waited on in. DEAL_FIVE and DEAL_REST are the
  // engine's own pauses; DEAL_OVER and MATCH_OVER wait on the owner, who may
  // well be a human even when every seat at the table is a bot.
  const e = botTable();
  const d = createBotDriver();
  eq(e.phase, PHASES.DEAL_FIVE, 'setup: mid-deal');
  eq(d.tick(e, BOT_THINK_MS * 10), false, 'it does not act while the cards are going out');
  eq(d.tick(new GameEngine(), BOT_THINK_MS * 10), false, 'nor in the lobby');
  eq(d.tick(null, 0), false, 'and no engine at all is not a crash');
}

{
  // A human who is THERE is never played for, however long they think. Court
  // Piece has no clock and no pass, so this is the whole of the rule: the table
  // waits on a present player indefinitely.
  const e = table();
  e.startMatch('p0', 0);
  const d = createBotDriver();
  e.tick(DEAL_PAUSE_MS);
  eq(d.tick(e, BOT_THINK_MS * 10), false, 'it never moves for a human who is connected');
  eq(e.trumpSuit, null, 'and the table simply waits');
}

{
  // A human who is GONE is covered, after a longer wait. The alternative is not
  // "the table waits politely" — it is "the match is over", because there is no
  // pass, no skip and no timer, so one locked phone stops three other people
  // permanently. See the note above coverage() in js/bot.js.
  const e = table();
  e.startMatch('p0', 0);
  const d = createBotDriver();
  e.tick(DEAL_PAUSE_MS);
  const caller = e.seats[e.callerSeat];
  eq(caller.isBot, false, 'setup: a human has to call the trump');

  e.disconnect(caller.id);
  eq(e.seats[e.callerSeat].online, false, 'and their phone has gone');
  // Not converted. The seat is still theirs to walk back into, which is the
  // whole point of the clientId reclaim — a bot that took the seat over would
  // have nothing to hand back.
  eq(e.seats[e.callerSeat].isBot, false, 'the seat is covered, never converted to a bot');
  eq(e.seats[e.callerSeat].clientId, 'c' + e.callerSeat, 'and it keeps the clientId it is held by');

  eq(d.tick(e, 0), false, 'it does not pounce the moment somebody drops');
  eq(d.tick(e, BOT_THINK_MS), false, 'nor at the pace it moves for its own seats');
  eq(d.tick(e, OFFLINE_GRACE_MS - 1), false, 'nor a millisecond inside the grace period');
  eq(e.trumpSuit, null, 'the table has waited the whole time');
  eq(d.tick(e, OFFLINE_GRACE_MS), true, 'and it covers the seat once the grace is spent');
  ok(SUITS.includes(e.trumpSuit), 'the trump is called and the deal goes on');
}

{
  // Coming back mid-wait cancels the cover. The reconnect ladder in main.js
  // usually lands well inside ten seconds, so this is the COMMON path, not the
  // corner case — a player whose train went through a tunnel must find their
  // own hand still waiting for them.
  const e = table();
  e.startMatch('p0', 0);
  const d = createBotDriver();
  e.tick(DEAL_PAUSE_MS);
  const seat = e.callerSeat;
  const gone = e.seats[seat].id;

  e.disconnect(gone);
  eq(d.tick(e, 0), false, 'setup: the wait has started');
  e.addPlayer(gone + '-new', 'Back', { clientId: 'c' + seat });
  eq(e.seats[seat].online, true, 'setup: and they are back');

  eq(d.tick(e, OFFLINE_GRACE_MS * 10), false, 'the cover is abandoned the moment they return');
  eq(e.trumpSuit, null, 'and the hand is still theirs to call');
}

{
  // A bot seat and a covered seat are paced differently on purpose: a bot's
  // pause is theatre, so the table does not feel like a spreadsheet, while a
  // covered seat's is a real grace period somebody might use. Getting these the
  // same way round is the difference between "the game is alive" and "the game
  // played my hand for me while I was reading the rules".
  ok(OFFLINE_GRACE_MS > BOT_THINK_MS,
    `a dropped player gets longer than a bot takes to think: ${OFFLINE_GRACE_MS}ms vs ${BOT_THINK_MS}ms`);
}

{
  // End to end: a whole match with nothing but the driver and a clock. Proves
  // both waiting phases get served, that the key changes on every distinct
  // decision, and that nothing deadlocks between one trick and the next.
  seed(4242);
  const e = botTable({ matchMode: 'race', courtsToWin: 1 });
  const d = createBotDriver();
  let now = 0, guard = 0, moves = 0, deals = 0, cards = 0;
  while (e.phase !== PHASES.MATCH_OVER && ++guard < 100000) {
    now += 250;
    e.tick(now);
    const held = e.hands.reduce((a, h) => a + h.length, 0);
    if (d.tick(e, now)) moves++;
    if (e.hands.reduce((a, h) => a + h.length, 0) < held) cards++;
    if (e.phase === PHASES.DEAL_OVER) { deals++; e.nextDeal('p0', now); }
  }
  eq(e.phase, PHASES.MATCH_OVER, 'a match played entirely by the driver reaches its end');
  ok(deals >= 1 && cards >= TRICKS_TO_WIN * SEAT_COUNT, `over ${deals} deal(s), ${cards} cards`);
  // One trump call per deal and one tick per card, and not a single tick that
  // returned true without doing either.
  eq(moves, cards + deals, 'every move it made was a card played or a trump called');
}

// ===========================================================================
// CHECKPOINT 6 — the wire.
//
// Nothing here opens a connection. What is testable about a transport without
// a browser is its NAMING — the two id spaces it maps between — and the one
// function that decides what leaves the host's device. Those happen to be the
// two places a mistake is unrecoverable: a name collision hands a stranger the
// owner's controls, and a bad frame hands them somebody's hand.
// ===========================================================================
section('Transport — the two id spaces');
// ===========================================================================

{
  // Room code to broker id. The uppercasing is not cosmetic: the join screen
  // accepts whatever the keyboard produced, and a phone that autocapitalised
  // half a code must still reach the same table.
  eq(peerIdForCode('AB12'), PEER_PREFIX + 'AB12', 'a code becomes a namespaced broker id');
  eq(peerIdForCode('ab12'), peerIdForCode('AB12'), 'typed in lower case it reaches the same table');
  eq(codeFromPeerId(peerIdForCode('XY9Z')), 'XY9Z', 'and comes back out again');

  // The namespace exists because the broker is shared with every other PeerJS
  // app on the internet. Without the prefix, 'AB12' would collide with anyone
  // who ever picked that id for anything.
  ok(peerIdForCode('AB12').startsWith(PEER_PREFIX), 'every id this app claims is namespaced');
  eq(codeFromPeerId('AB12'), null, 'a bare code is not one of ours');
  eq(codeFromPeerId('someotherapp-AB12'), null, 'nor is another app\'s id');
  eq(codeFromPeerId(null), null, 'and a non-string is not a crash');
  eq(codeFromPeerId(undefined), null, 'either way round');
  eq(peerIdForCode(null), PEER_PREFIX, 'a missing code produces a bare prefix, not "null"');
}

{
  // ---------------------------------------------------------------------
  // THE IMPERSONATION BOUNDARY. The most important thing in this file.
  //
  // A joiner picks its own broker id: `new Peer('host')` is a legal thing for
  // anybody to run. The host reads conn.peer to know who is talking. If that
  // string reached the engine raw, a peer that registered itself as 'host'
  // would arrive as HOST_ID — which is also engine.ownerId — and could start
  // the match, swap the seats, end the match, and play out of the host's own
  // hand, because seatOf() matches on id.
  //
  // The prefix is what closes it: every id the engine ever sees from the wire
  // is in a namespace the host's own id cannot be in. js/main.js asserts the
  // other half of this at module load.
  // ---------------------------------------------------------------------
  eq(playerIdForConn('abc'), CONN_ID_PREFIX + 'abc', 'a connection id is namespaced before the engine sees it');
  eq(connIdForPlayer(playerIdForConn('abc')), 'abc', 'and maps back for sending');

  const HOST_ID = 'host';   // the constant in js/main.js
  ok(!HOST_ID.startsWith(CONN_ID_PREFIX), 'the host id is outside the peer namespace');
  for (const hostile of ['host', 'HOST', '', 'peer', 'bot:1:x', '__proto__', 'constructor']) {
    ok(playerIdForConn(hostile) !== HOST_ID,
      `a peer calling itself ${JSON.stringify(hostile)} cannot become the host`);
  }
  // Stated the other way round, so it holds for any host id anyone ever picks:
  // there is no connection id at all whose mapped form escapes the namespace.
  ok(['host', 'x', 'peer:host', PEER_PREFIX + 'AB12']
    .every((s) => playerIdForConn(s).startsWith(CONN_ID_PREFIX)),
    'no connection id maps outside the namespace, whatever it contains');
  // Including one that has already been prefixed — the double prefix is ugly
  // and harmless, and crucially is NOT the same id as the singly-prefixed one,
  // so a peer cannot spoof another peer by pre-prefixing itself either.
  ok(playerIdForConn('peer:abc') !== playerIdForConn('abc'),
    'and a peer cannot spoof another peer by pre-prefixing its own id');

  // The inverse says "not from the wire", which is how sendTo() and
  // dropConnection() tell a socket from a bot or from the host itself.
  eq(connIdForPlayer('host'), null, 'the host has no connection to itself');
  eq(connIdForPlayer('bot:2:kq'), null, 'and neither does a bot');
  eq(connIdForPlayer(null), null, 'a non-string is not a crash here either');
  eq(connIdForPlayer(42), null, 'nor a number');
}

{
  // Ceilings. Not asserting the exact numbers — those are judgement calls that
  // may move — but the relationships that make them mean anything.
  ok(MAX_HOST_CONNS > SEAT_COUNT,
    `the connection ceiling leaves room for churn above a full table: ${MAX_HOST_CONNS} > ${SEAT_COUNT}`);
  ok(MAX_REFUSED_FRAMES > 0, 'a flooding peer is eventually dropped, not throttled forever');
}

{
  // Fatal means "retrying will produce the identical error", so the UI stops
  // and says something. Everything else gets the reconnect ladder.
  ok(isFatalPeerError({ type: 'unavailable-id' }), 'a taken room code is fatal — the code must change');
  ok(isFatalPeerError({ type: 'browser-incompatible' }), 'a browser without WebRTC is fatal');
  ok(isFatalPeerError({ type: 'peer-missing' }), 'PeerJS never loading is fatal');
  eq(isFatalPeerError({ type: 'network' }), false, 'a broker hiccup is NOT — that is the common case');
  eq(isFatalPeerError({ type: 'peer-unavailable' }), false, 'nor is a host who has not opened yet');
  eq(isFatalPeerError({ type: 'disconnected' }), false, 'nor a dropped broker socket');
  eq(isFatalPeerError(null), false, 'and no error at all is not fatal');
  eq(isFatalPeerError({}), false, 'nor is an error with no type');

  // Every message a player can be shown has to be a sentence they can act on.
  // A bare PeerJS type code in the UI is a bug report, not an explanation.
  for (const type of [
    'browser-incompatible', 'invalid-id', 'invalid-key', 'unavailable-id',
    'ssl-unavailable', 'peer-missing', 'peer-unavailable', 'network',
    'disconnected', 'server-error', 'socket-error', 'socket-closed', 'webrtc',
    'something-peerjs-adds-in-2027', undefined,
  ]) {
    const msg = describePeerError(type === undefined ? null : { type });
    ok(typeof msg === 'string' && msg.length > 12, `${type}: says something`);
    ok(!msg.includes(String(type)), `${type}: and does not just print the error code`);
  }
}

// ===========================================================================
section('Transport — what a host may never send');
// ===========================================================================

/** The same four-handed table as everywhere else, but with the ids the wire
 *  actually produces: the host under its own constant, the other three under
 *  peer-derived ids. Only this section needs them, because only this section
 *  is about what goes down a socket. */
const WIRE_CONNS = ['conn-east', 'conn-south', 'conn-west'];
function wiredTable(config = null) {
  const e = new GameEngine();
  e.addPlayer('host', 'Hosty', { clientId: 'chost', isOwner: true });
  WIRE_CONNS.forEach((c, i) => {
    e.addPlayer(playerIdForConn(c), ['Eastly', 'Southy', 'Westly'][i], { clientId: 'c' + (i + 1) });
  });
  if (config) e.setConfig(config);
  return e;
}

{
  seed(31415);
  const e = wiredTable({ hiddenRung: true });
  e.startMatch('host', 0);
  e.tick(DEAL_PAUSE_MS);
  eq(e.phase, PHASES.DECLARE_TRUMP, 'setup: five cards out, trump to be called');
  const callerId = e.seats[e.callerSeat].id;
  ok(e.declareTrump(callerId, 'H', DEAL_PAUSE_MS).ok, 'setup: hearts called');
  e.tick(DEAL_PAUSE_MS * 3);
  eq(e.phase, PHASES.PLAY, 'setup: the rest are dealt and play is under way');
  eq(e.trumpHidden, true, 'setup: and the rung is hidden');

  const pub = e.publicState();
  const privateFor = (id) => e.privateStateFor(id);

  // THE INVARIANT, EXECUTED. Every frame the host is about to put on the wire,
  // checked against every card it must not contain. A review can miss this;
  // a test cannot.
  let leakedCards = 0, framesChecked = 0;
  for (const connId of WIRE_CONNS) {
    const frame = stateFrameFor(connId, pub, privateFor);
    const seat = e.seatOf(playerIdForConn(connId));
    ok(seat >= 0, `${connId}: is seated, so this frame has teeth`);
    eq(frame.type, 'state', `${connId}: is a state frame`);
    eq(frame.priv.seat, seat, `${connId}: gets its own seat`);

    const text = JSON.stringify(frame);
    same(frame.priv.hand.map((c) => c.code).slice().sort(), e.hands[seat].slice().sort(),
      `${connId}: holds exactly its own thirteen cards`);
    for (let other = 0; other < SEAT_COUNT; other++) {
      if (other === seat) continue;
      for (const code of e.hands[other]) if (text.includes(`"${code}"`)) leakedCards++;
    }
    framesChecked++;
  }
  eq(framesChecked, 3, 'three remote frames were built');
  eq(leakedCards, 0, 'AND NOT ONE CARD FROM ANOTHER PLAYER\'S HAND APPEARS IN ANY OF THEM');

  // The hidden rung, on the wire this time rather than in publicState() alone.
  // The section above proves the public payload is clean; this proves the
  // thing actually sent is, which is a different object.
  let leakedTrump = 0;
  for (const connId of WIRE_CONNS) {
    const frame = stateFrameFor(connId, pub, privateFor);
    if (frame.pub.trump !== null) leakedTrump++;
    if (findKey(frame.pub, 'trumpSuit')) leakedTrump++;
    if (findKey(frame.pub, 'hands')) leakedTrump++;
    if (findKey(frame.pub, 'clientId')) leakedTrump++;
    // Only the caller is reminded what they called, and only privately.
    const isCaller = e.seatOf(playerIdForConn(connId)) === e.callerSeat;
    if (!isCaller && frame.priv.trumpYouCalled !== null) leakedTrump++;
    if (isCaller && frame.priv.trumpYouCalled !== 'H') leakedTrump++;
  }
  eq(leakedTrump, 0, 'no frame carries the hidden trump to anyone but the player who called it');

  // A connection with no seat. Real: a fifth device that dialled in and was
  // turned away still holds an open socket and still gets state frames, so
  // `priv` has to be a legitimate null rather than a crash — which is exactly
  // why validPrivateState() in guards.js is only called after a null check.
  const spectator = stateFrameFor('conn-nobody', pub, privateFor);
  eq(spectator.priv, null, 'an unseated connection gets a frame with no private half');
  eq(spectator.pub, pub, 'but still sees the table');

  // THE WATCHING SCREEN'S WHOLE PRIVACY MODEL IS THAT FRAME. A TV that dials in
  // with WATCH is exactly this: a connection with no seat. It is put where all
  // four players can see it, so what it must not carry is anything a player
  // could use — and the frame is checked as the text that actually goes down
  // the socket, because that is what a watcher with devtools open is reading.
  const tvText = JSON.stringify(spectator);
  eq(findKey(spectator, 'hand'), false, 'a watcher\'s frame has no hand in it, at any depth');
  eq(findKey(spectator, 'trumpYouCalled'), false, 'nor the caller\'s private reminder of the rung');
  ok(!tvText.includes('"trump":"H"'), 'nor the hidden rung under its public name');
  let tvCards = 0;
  for (const hand of e.hands) for (const code of hand) if (tvText.includes(`"${code}"`)) tvCards++;
  eq(tvCards, 0, 'AND NOT ONE CARD STILL IN ANYBODY\'S HAND IS ON A WATCHING SCREEN');

  // Seeing is all it can do. A watcher's id holds no seat and is not the
  // owner, so every message that could change the game is refused by the same
  // checks that refuse a stranger — there is no "spectator" branch in the
  // engine to get wrong, which is the point of not having one.
  const tvId = playerIdForConn('conn-nobody');
  const before = JSON.stringify(e.serialize());
  const attempts = {
    playCard: { code: e.hands[e.turnSeat][0] },
    declareTrump: { suit: 'S' },
    setConfig: { config: { hiddenRung: false } },
    addBot: { seat: 0 },
    removeBot: { seat: 0 },
    swapSeats: { a: 0, b: 1 },
  };
  let tvAccepted = 0;
  for (const type of GAME_INTENTS) {
    const { handled, result } = applyGameIntent(e, tvId, { type, ...(attempts[type] || {}) }, 0);
    if (!handled || result.ok) tvAccepted++;
  }
  eq(tvAccepted, 0, `all ${GAME_INTENTS.length} game intents are refused from a watching screen`);
  eq(JSON.stringify(e.serialize()), before, 'and not one of them moved the game');

  // And the frame is small enough to actually go down the wire. LOG_CAP in
  // state.js exists for this; if a frame ever exceeded the cap, decodePeerFrame
  // on the far side would silently drop every update and the game would freeze
  // with no error anywhere.
  const biggest = Math.max(...WIRE_CONNS.map(
    (c) => JSON.stringify(stateFrameFor(c, pub, privateFor)).length));
  ok(biggest < MAX_FRAME_BYTES / 2,
    `a full state frame leaves the receiver's cap plenty of headroom: ${biggest} of ${MAX_FRAME_BYTES}`);

  // Round trip: what the host sends is what a client will accept. The two ends
  // are written in different files and nothing else checks they agree.
  const wire = JSON.stringify(stateFrameFor(WIRE_CONNS[0], pub, privateFor));
  const back = decodePeerFrame(wire);
  ok(back !== null, 'a real state frame survives the client\'s frame decoder');
  ok(validPublicState(back.pub) !== null, 'and its public half passes the client\'s shape check');
  ok(validPrivateState(back.priv) !== null, 'as does its private half');
}

{
  // The end of a deal is the worst case for frame size: every trick is in the
  // log and every one of the thirteen tricks is in `tricks`.
  seed(2718);
  const e = wiredTable();
  e.startMatch('host', 0);
  e.tick(DEAL_PAUSE_MS);
  e.declareTrump(e.seats[e.callerSeat].id, 'S', DEAL_PAUSE_MS);
  e.tick(DEAL_PAUSE_MS * 3);
  let guard = 0;
  while (e.phase === PHASES.PLAY && ++guard < 100) {
    const seat = e.turnSeat;
    const legal = legalPlays(e.hands[seat], ledSuitOf(e.trick));
    e.playCard(e.seats[seat].id, legal[0]);
    gather(e);
  }
  eq(e.phase, PHASES.DEAL_OVER, 'setup: a whole deal is in the log');
  const pub = e.publicState();
  const size = JSON.stringify(
    stateFrameFor(WIRE_CONNS[0], pub, (id) => e.privateStateFor(id))).length;
  ok(size < MAX_FRAME_BYTES / 2,
    `even a fully-played deal stays well inside the cap: ${size} of ${MAX_FRAME_BYTES}`);
}

{
  // Node has no window, which is the whole reason this file can import net.js.
  // If that ever stopped being true the import would throw and every test above
  // would vanish rather than fail — so it is asserted rather than assumed.
  eq(typeof globalThis.window, 'undefined', 'no DOM here');
  eq(peerAvailable(), false, 'so the transport reports itself unavailable instead of throwing');
}

// ===========================================================================
section('PWA shell — the precache list against the real import graph');
// ===========================================================================
//
// sw.js carries a comment saying SHELL must list EVERY module. That comment is
// worth nothing on its own: the failure it describes is invisible in every
// situation a developer is ever in. Online, the missing module is fetched from
// the network and the app works; the service worker is the last thing anybody
// tests; and the symptom offline is a blank page with a console error on a
// phone, which is where nobody is looking. A new js/ file can therefore ship
// un-precached and stay that way for months.
//
// So the comment gets a test. Read the list as TEXT rather than importing
// sw.js — it is a worker script, it calls self.addEventListener at module
// scope, and node has no ServiceWorkerGlobalScope. A regex over an array
// literal is the honest tool for a file that cannot be loaded.
{
  const readFile = (p) => fsReadFileSync(new URL(p, import.meta.url), 'utf8');
  const exists = (p) => fsExistsSync(new URL(p, import.meta.url));
  const swSrc = readFile('../sw.js');
  const htmlSrc = readFile('../index.html');

  const arrayOf = (name) => {
    const m = swSrc.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };
  const shell = arrayOf('SHELL');
  const external = arrayOf('EXTERNAL');
  ok(shell.length > 10, `SHELL parsed out of sw.js: ${shell.length} entries`);

  // THE ONE THAT MATTERS. Every module on disk, against every module listed.
  const modules = fsReaddirSync(new URL('../js/', import.meta.url))
    .filter((f) => f.endsWith('.js')).sort();
  ok(modules.length >= 12, `js/ holds ${modules.length} modules`);
  const missing = modules.filter((f) => !shell.includes(`./js/${f}`));
  same(missing, [], 'EVERY MODULE IN js/ IS PRECACHED — one missing is a blank page offline');

  // And the other direction: a renamed or deleted file left behind in SHELL.
  // This one fails loudly rather than quietly — cache.addAll() rejects on a
  // 404 and the whole install fails, so the app never gets an offline shell at
  // all. Still worth catching here, where the message says which entry it was.
  for (const entry of shell) {
    if (entry === './') continue; // the directory index, i.e. index.html
    ok(exists(`../${entry.slice(2)}`), `SHELL entry exists on disk: ${entry}`);
  }

  // The test harness and the icon generator are node scripts that import
  // node:fs and node:zlib. Precaching them would be dead weight in every
  // visitor's cache; worse, it would suggest they are part of the app.
  same(shell.filter((e) => e.startsWith('./scripts/')), [],
    'nothing under scripts/ is precached — those are build tools, not the app');

  // Relative imports, resolved. Cheap, and it catches a typo in an import path
  // that node would only hit if that particular branch ever ran.
  let badImports = 0;
  for (const f of modules) {
    const src = readFile(`../js/${f}`);
    for (const m of src.matchAll(/from\s+'(\.\/[^']+)'/g)) {
      if (!exists(`../js/${m[1].slice(2)}`)) { badImports++; console.log(`  js/${f} -> ${m[1]}`); }
    }
  }
  eq(badImports, 0, 'every relative import in js/ resolves to a file that exists');

  // The pinned PeerJS URL appears in two files that never see each other:
  // the <script> tag the browser actually loads, and the EXTERNAL list the
  // worker warms the cache with. If they drift, the worker caches a URL nobody
  // requests and the page requests a URL that was never cached — which looks
  // like nothing at all until somebody opens the app on a plane.
  const pinned = [...htmlSrc.matchAll(/https:\/\/unpkg\.com\/[^"']+/g)].map((m) => m[0]);
  eq(pinned.length, 1, 'index.html pins exactly one CDN script');
  ok(/peerjs@\d+\.\d+\.\d+\//.test(pinned[0]), `and pins it to an exact version: ${pinned[0]}`);
  same(external, pinned, 'sw.js precaches THAT EXACT URL — a version bump must change both');

  // The analytics beacon must stay off the worker entirely: precached, routed
  // or allow-listed, an answer from cache records nothing while looking like
  // it worked. See the note at the foot of sw.js.
  //
  // Comments are stripped first, and that is the point rather than a dodge —
  // sw.js SHOULD name the beacon in prose, because "this falls through
  // untouched, deliberately" is the single most deletable-looking line in the
  // file and the comment is what stops someone tidying it away. What must not
  // happen is the host appearing in a list or a branch. So the test reads the
  // code and lets the prose alone.
  const swCode = swSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(htmlSrc.includes('gc.zgo.at'), 'index.html carries the visitor beacon');
  ok(swSrc.includes('gc.zgo.at'), 'sw.js explains in prose why it leaves the beacon alone');
  ok(!/gc\.zgo\.at|goatcounter/.test(swCode),
    'and no CODE in sw.js touches it — no precache, no route, no cached hit');

  // Cache-first is only safe for URLs whose bytes cannot change. Anything
  // added to that branch later needs the same property.
  const cacheFirst = [...swSrc.matchAll(/url\.hostname === '([^']+)'/g)].map((m) => m[1]).sort();
  same(cacheFirst, ['fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com'],
    'only immutable hosts are served cache-first with no revalidation');
}

// ===========================================================================
section('PWA shell — manifest, icons and paths');
// ===========================================================================
{
  const readFile = (p) => fsReadFileSync(new URL(p, import.meta.url), 'utf8');
  const exists = (p) => fsExistsSync(new URL(p, import.meta.url));
  const htmlSrc = readFile('../index.html');
  const cssSrc = readFile('../css/styles.css');

  let manifest = null;
  try { manifest = JSON.parse(readFile('../manifest.webmanifest')); } catch (_) { /* below */ }
  ok(manifest !== null, 'manifest.webmanifest is valid JSON — a browser drops the whole file if not');

  // EVERY path in this app is relative, because it is served from a GitHub
  // Pages subpath. An absolute start_url would send the installed app to the
  // root of the whole account, which is somebody else's project.
  eq(manifest.start_url, './', 'start_url is relative');
  eq(manifest.scope, './', 'scope is relative');
  for (const icon of manifest.icons) {
    ok(icon.src.startsWith('./'), `icon path is relative: ${icon.src}`);
    ok(exists(`../${icon.src.slice(2)}`), `and the file is there: ${icon.src}`);
  }
  ok(manifest.icons.some((i) => i.purpose === 'maskable'),
    'a maskable icon is declared — without one Android puts the square in a white circle');

  // Three places name the background colour: the manifest's splash, the
  // theme-color meta the browser paints the address bar with, and --bg. All
  // three are the same surface as far as anyone looking at the phone is
  // concerned, and two of them being right is worse than none, because the
  // mismatch shows as a flash of the wrong colour on every cold start.
  const bg = (cssSrc.match(/--bg:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
  ok(!!bg, `--bg found in the stylesheet: ${bg}`);
  eq(manifest.background_color.toLowerCase(), bg.toLowerCase(), 'manifest background_color matches --bg');
  eq(manifest.theme_color.toLowerCase(), bg.toLowerCase(), 'manifest theme_color matches --bg');
  const meta = (htmlSrc.match(/name="theme-color" content="(#[0-9A-Fa-f]{6})"/) || [])[1];
  eq((meta || '').toLowerCase(), bg.toLowerCase(), 'and so does the theme-color meta tag');

  // index.html has to link the manifest and name an apple-touch-icon: iOS
  // reads neither the manifest's icon list nor an SVG.
  ok(/rel="manifest" href="\.\/manifest\.webmanifest"/.test(htmlSrc), 'index.html links the manifest');
  const touch = (htmlSrc.match(/rel="apple-touch-icon" href="(\.\/[^"]+)"/) || [])[1];
  ok(!!touch && exists(`../${touch.slice(2)}`), `apple-touch-icon points at a real PNG: ${touch}`);
  const favicon = (htmlSrc.match(/rel="icon" href="(\.\/[^"]+)"/) || [])[1];
  ok(!!favicon && exists(`../${favicon.slice(2)}`), `favicon points at a real file: ${favicon}`);

  // No absolute same-origin paths anywhere in the document. A leading slash
  // works perfectly on localhost and 404s for every visitor on Pages, which is
  // the most expensive way for a path to be wrong.
  const absolute = [...htmlSrc.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]);
  same(absolute, [], 'no absolute same-origin paths in index.html');
}

// ===========================================================================
section('Storage keys are namespaced');
// ===========================================================================
//
// These games are siblings served from paths on ONE origin, so they share one
// localStorage. An unprefixed 'clientId' would be read and overwritten by
// whichever of them the player opened last — and clientId is the only thing a
// seat is bound to, so the symptom is being refused your own seat in a game
// you are in the middle of, on a device that has not changed.
{
  const readFile = (p) => fsReadFileSync(new URL(p, import.meta.url), 'utf8');
  const modules = fsReaddirSync(new URL('../js/', import.meta.url)).filter((f) => f.endsWith('.js'));
  const keys = new Set();
  for (const f of modules) {
    const src = readFile(`../js/${f}`);
    for (const m of src.matchAll(/localStorage\.\w+\(\s*'([^']+)'/g)) keys.add(m[1]);
    // The constants they are usually held in, so a key defined once and used
    // by name everywhere after that is still seen here. Whitespace is loose on
    // purpose: `const ENGINE_KEY  = …` is aligned with its neighbour and a
    // single-space pattern silently missed it, which is the failure mode this
    // whole section exists to avoid.
    for (const m of src.matchAll(/^(?:export )?const \w*KEY\w*\s*=\s*'([^']+)'/gm)) keys.add(m[1]);
  }
  ok(keys.size >= 5, `localStorage keys found: ${[...keys].sort().join(', ')}`);
  ok(keys.has('courtpiece.clientId'),
    'including the clientId — the one key a cache reset must never clear');
  same([...keys].filter((k) => !k.startsWith('courtpiece.')).sort(), [],
    'EVERY localStorage key is prefixed courtpiece. — siblings share one origin');
}

// ===========================================================================
section('Soak — a thousand deals, bot against bot');
// ===========================================================================

// The rigged positions above each say something about one decision. This says
// the two things that must be true in EVERY position, across more of them than
// anybody could write out: it never offers an illegal card, and it never takes
// a trick off its own partner with a trump.
//
// Run twice. Classic exercises the trump reasoning fully; Hidden Rung puts
// three of the four bots in the dark for the opening tricks, which is a
// different path through readTable() and the one most likely to produce a card
// nobody expected.
for (const hiddenRung of [false, true]) {
  seed(hiddenRung ? 90210 : 1234);

  const DEALS = 500;
  let deals = 0, tricks = 0, decisions = 0, declares = 0;
  let illegal = 0, refused = 0, silent = 0, notInHand = 0, badTrumpCall = 0;
  let ruffedPartner = 0, forcedRuffs = 0, partnerAhead = 0, ruffs = 0;
  let courts = 0, lostCards = false, sevenTrickDeals = 0, notDeclaring = 0;

  const e = table({ hiddenRung, matchMode: 'deals' });
  e.startMatch('p0', 0);
  for (const p of e.seats) p.isBot = true;

  let now = 0, guard = 0;
  while (deals < DEALS && ++guard < 400000) {
    now += 1;

    if (e.phase === PHASES.DEAL_FIVE || e.phase === PHASES.DEAL_REST) {
      e.tick(now + DEAL_PAUSE_MS);
      continue;
    }

    if (e.phase === PHASES.DECLARE_TRUMP) {
      const seat = e.callerSeat;
      const priv = e.privateStateFor(idAt(e, seat));
      declares++;
      if (!priv.mustDeclare) notDeclaring++;
      // Called from five cards and no more — the whole point of the batching.
      if (e.hands[seat].length !== DEAL_BATCHES[0]) badTrumpCall++;
      const intent = chooseIntent(e.publicState(), priv);
      if (!intent || intent.type !== 'declareTrump') badTrumpCall++;
      else if (!e.hands[seat].some((c) => suitOf(c) === intent.suit)) badTrumpCall++;
      if (!applyGameIntent(e, idAt(e, seat), intent, now).result.ok) badTrumpCall++;
      continue;
    }

    if (e.phase === PHASES.PLAY) {
      const seat = e.turnSeat;
      const led = ledSuitOf(e.trick);
      const legal = legalPlays(e.hands[seat], led);
      const before = e.trickWinners.length;

      const intent = chooseIntent(e.publicState(), e.privateStateFor(idAt(e, seat)));
      decisions++;

      // THE HARD FAILURE. A bot that offers a card it may not play is not
      // merely refused — under the driver it falls through to panic() and plays
      // something arbitrary, and the table watches a player behave at random.
      // Counted three ways because they break differently: no answer at all, a
      // card from nowhere, and a card it holds but may not play.
      if (!intent || !intent.code) { silent++; break; }
      if (!e.hands[seat].includes(intent.code)) { notInHand++; break; }
      if (!legal.includes(intent.code)) { illegal++; break; }

      // Was this a trump, thrown off-suit, over a partner who already had the
      // trick? Judged against the REAL trump rather than the bot's view of it,
      // and only while that trump is public: under Hidden Rung a bot in the dark
      // may ruff its partner by accident, which is the game working as designed
      // rather than the bot misbehaving.
      //
      // Split by whether there was any alternative, because the two are
      // different facts. A bot void in the suit led and down to nothing but
      // trumps HAS to put one on its partner's trick — every legal card is a
      // ruff, and refusing would mean refusing to play. Counting that as a
      // failure would make the assertion below impossible to satisfy and
      // therefore worthless. What must be zero is the ruff it had a discard for
      // and played anyway.
      if (led && e.trick.length && !e.trumpHidden) {
        const ours = partnerWinning(e.trick, seat, e.trumpSuit);
        if (ours) partnerAhead++;
        if (suitOf(intent.code) === e.trumpSuit && suitOf(intent.code) !== led) {
          ruffs++;
          if (ours) {
            if (legal.every((c) => suitOf(c) === e.trumpSuit)) forcedRuffs++;
            else ruffedPartner++;
          }
        }
      }

      if (!applyGameIntent(e, idAt(e, seat), intent, now).result.ok) { refused++; break; }

      const held = e.hands.reduce((a, h) => a + h.length, 0);
      if (held + e.trick.length + SEAT_COUNT * e.trickWinners.length !== DECK_SIZE) lostCards = true;
      gather(e);
      if (e.trickWinners.length > before) tricks++;
      continue;
    }

    if (e.phase === PHASES.DEAL_OVER) {
      deals++;
      if (e.dealResult.court !== null) courts++;
      if (e.trickWinners.length === TRICKS_TO_WIN) sevenTrickDeals++;
      e.nextDeal('p0', now);
      continue;
    }

    if (e.phase === PHASES.MATCH_OVER) { e.newMatch('p0', now); continue; }
    break;
  }

  const tag = hiddenRung ? 'hidden' : 'classic';
  eq(deals, DEALS, `${tag}: ${DEALS} deals played out bot against bot`);
  eq(silent, 0, `${tag}: the bot always had an answer when it was its turn`);
  eq(notInHand, 0, `${tag}: it never named a card it was not holding`);
  eq(illegal, 0, `${tag}: IT NEVER OFFERED AN ILLEGAL CARD — ${decisions} decisions`);
  eq(refused, 0, `${tag}: and the engine refused none of them`);
  eq(notDeclaring, 0, `${tag}: the caller was always the seat told to declare`);
  eq(badTrumpCall, 0, `${tag}: ${declares} trumps, each called from five cards in a suit held`);
  eq(lostCards, false, `${tag}: no card was created, duplicated or dropped`);
  eq(ruffedPartner, 0,
    `${tag}: IT NEVER RUFFED ITS OWN PARTNER WITH A DISCARD IN HAND`);
  ok(partnerAhead > 500,
    `${tag}: and it had plenty of chances to: ${partnerAhead} plays with its side in front`);
  ok(ruffs > 50, `${tag}: it does ruff when the trick is not already its own: ${ruffs}`);
  ok(tricks >= DEALS * TRICKS_TO_WIN, `${tag}: ${tricks} tricks`);

  console.log(`  ${tag}: ${tricks} tricks, ${decisions} decisions, ${courts} courts `
    + `(${(100 * courts / DEALS).toFixed(1)}%), `
    + `${sevenTrickDeals} deals decided on the seventh trick, ${ruffs} ruffs `
    + `(${forcedRuffs} of them onto a partner with no other legal card)`);
}

// ===========================================================================
section('Soak — two hundred deals per match mode, random legal play');
// ===========================================================================

// Run twice, once per match mode, because the two modes end a match by
// different questions and only the mode in force is ever asked. RACE is set to
// a one-court target rather than five: a court is rare enough under random play
// (see the count printed below) that a five-court race would not finish a single
// match in two hundred deals, and the MATCH_OVER path would go unvisited.
for (const matchMode of ['race', 'deals']) {
  // Not the bot yet (that is checkpoint 4); this is a random legal mover, which
  // is a harsher test of the RULES because it reaches positions no sensible
  // player would. Hidden Rung is on throughout, so every deal also re-tests the
  // privacy boundary.
  //
  // BOTH generators are reset per mode — the deck's (seed()) and the mover's
  // (soakSeed) — so the two runs are dealt the same two hundred deals and play
  // them the same way. Any difference in the counts below is therefore caused
  // by the mode, which is what makes a divergence worth looking at. Resetting
  // only soakSeed is not enough: the deck stream is global and the first run
  // leaves it somewhere else.
  seed(773);
  let soakSeed = 20250920;
  const rnd = (n) => { soakSeed = (Math.imul(soakSeed, 1664525) + 1013904223) >>> 0; return soakSeed % n; };

  const TARGET = 200;
  const COURTS_TO_WIN = 1, DEALS_TO_PLAY = 4;
  let deals = 0, courtsSeen = 0, revealsSeen = 0, tricksPlayed = 0;
  let leaked = false, illegalAccepted = 0, illegalOffered = 0, lostCards = false, badSuccession = 0;
  let badCourt = 0, shortDeal = 0, hiddenLoseSeen = 0;
  let matchesSeen = 0, drawsSeen = 0, badMatchEnd = 0, dealsThisMatch = 0;

  const e = table({
    hiddenRung: true, matchMode, courtsToWin: COURTS_TO_WIN, dealsToPlay: DEALS_TO_PLAY,
  });
  e.startMatch('p0', 0);

  let now = 0, guard = 0;
  while (deals < TARGET && ++guard < 500000) {
    now += DEAL_PAUSE_MS;

    if (e.phase === PHASES.DEAL_FIVE || e.phase === PHASES.DEAL_REST) { e.tick(now); continue; }

    if (e.phase === PHASES.DECLARE_TRUMP) {
      ok(e.hands.every((h) => h.length === 5) || (shortDeal++, false) === true,
        'the caller decides on five cards and no more');
      e.declareTrump(idAt(e, e.callerSeat), SUITS[rnd(SUITS.length)], now);
      if (e.publicState().trump !== null) leaked = true;
      continue;
    }

    if (e.phase === PHASES.PLAY) {
      const seat = e.turnSeat;
      const led = ledSuitOf(e.trick);
      const legal = legalPlays(e.hands[seat], led);
      const before = e.trickWinners.length;

      // Every so often, try something illegal. A hostile peer is the normal
      // case to design for, not the exceptional one.
      if (led && rnd(11) === 0) {
        const bad = e.hands[seat].find((c) => !legal.includes(c));
        if (bad) { illegalOffered++; if (e.playCard(idAt(e, seat), bad).ok) illegalAccepted++; }
        illegalOffered++;
        if (e.playCard(idAt(e, seat), 'ZZ').ok) illegalAccepted++;
      }
      if (rnd(23) === 0) {
        illegalOffered++;
        const other = nextSeat(seat);
        if (e.hands[other].length && e.playCard(idAt(e, other), e.hands[other][0]).ok) illegalAccepted++;
      }

      if (e.trumpHidden && e.publicState().trump !== null) leaked = true;
      const wasHidden = e.trumpHidden;

      const res = e.playCard(idAt(e, seat), legal[rnd(legal.length)]);
      if (!res.ok) { illegalAccepted++; break; }
      if (wasHidden && !e.trumpHidden) revealsSeen++;

      // Conservation: nothing is created and nothing is dropped.
      const held = e.hands.reduce((a, h) => a + h.length, 0);
      if (held + e.trick.length + SEAT_COUNT * e.trickWinners.length !== DECK_SIZE) lostCards = true;
      gather(e);
      if (e.trickWinners.length > before) tricksPlayed++;
      continue;
    }

    if (e.phase === PHASES.DEAL_OVER) {
      deals++;
      dealsThisMatch++;
      const r = e.dealResult;
      if (r.tricksWon[r.winnerTeam] < TRICKS_TO_WIN) shortDeal++;
      if (r.tricksWon[1 - r.winnerTeam] >= TRICKS_TO_WIN) shortDeal++;
      if (courtTeam(e.trickWinners) !== r.court) badCourt++;
      if (r.court !== null) courtsSeen++;
      const expected = r.dealerWon ? nextSeat(r.dealerSeat) : r.dealerSeat;
      if (r.nextDealerSeat !== expected || e.dealerSeat !== expected) badSuccession++;
      // A deal decided by the seventh trick, or later; never sooner, never after
      // the thirteenth.
      if (e.trickWinners.length < TRICKS_TO_WIN || e.trickWinners.length > TRICKS_PER_DEAL) shortDeal++;
      // The trump is public by the end of any deal in which somebody went void.
      if (!e.trumpHidden) hiddenLoseSeen++;

      // The match must end on exactly the condition its mode names — no sooner,
      // and never one deal late. Checked from the OUTSIDE, against the running
      // tallies, rather than by re-calling _scoreMatch().
      const shouldBeOver = matchMode === 'deals'
        ? dealsThisMatch === DEALS_TO_PLAY
        : (e.courts[0] >= COURTS_TO_WIN || e.courts[1] >= COURTS_TO_WIN);
      if (e.matchOver !== shouldBeOver) badMatchEnd++;
      if (e.matchOver && matchMode === 'race' && e.matchWinner === null) badMatchEnd++;

      e.nextDeal('p0', now);
      continue;
    }

    if (e.phase === PHASES.MATCH_OVER) {
      matchesSeen++;
      if (e.matchWinner === null) drawsSeen++;
      dealsThisMatch = 0;
      e.newMatch('p0', now);
      continue;
    }
    break;
  }

  eq(deals, TARGET, `${matchMode}: two hundred deals completed`);
  ok(illegalOffered > 250, `${matchMode}: illegal plays were actually attempted: ${illegalOffered}`);
  eq(illegalAccepted, 0, `${matchMode}: and ZERO of them were accepted`);
  eq(leaked, false, `${matchMode}: the hidden trump never appeared in a broadcast before its reveal`);
  eq(lostCards, false, `${matchMode}: no card was ever created, duplicated or dropped`);
  eq(badCourt, 0, `${matchMode}: every court matched the opening-seven definition`);
  eq(badSuccession, 0, `${matchMode}: dealer succession followed the rule in every deal`);
  eq(shortDeal, 0, `${matchMode}: every deal ended between the seventh and thirteenth trick, with a winner`);
  eq(badMatchEnd, 0, `${matchMode}: the match ended exactly when the mode says it should`);
  ok(tricksPlayed > TARGET * TRICKS_TO_WIN, `${matchMode}: tricks played: ${tricksPlayed}`);
  ok(courtsSeen > 0, `${matchMode}: courts do occur under random play: ${courtsSeen} in ${TARGET} deals`);
  ok(revealsSeen > 0, `${matchMode}: hidden trumps were revealed by a void: ${revealsSeen} times`);
  ok(matchesSeen > 0, `${matchMode}: complete matches played out: ${matchesSeen}`);
  if (matchMode === 'deals') {
    // Over four deals with courts almost always level at nil-nil, the tie-break
    // is deals won — and four deals split two-two is common, so a genuine draw
    // is not a corner case here. It is the outcome the mode produces most often.
    ok(drawsSeen > 0, `drawn matches occur and are reported as draws: ${drawsSeen} of ${matchesSeen}`);
  } else {
    eq(drawsSeen, 0, 'race: a race can never be drawn');
  }
  console.log(`  ${matchMode}: ${tricksPlayed} tricks, ${courtsSeen} courts, ${revealsSeen} reveals, `
    + `${illegalOffered} illegal plays refused, ${matchesSeen} matches (${drawsSeen} drawn)`);
}

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
