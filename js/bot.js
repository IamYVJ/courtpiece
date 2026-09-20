// ============================================================================
// bot.js — A computer player, and the paced driver that lets it take a turn.
//
// WHY A BOT EXISTS AT ALL
//   Court Piece is exactly four players. Not "four is best" — four is the game,
//   because fixed partnerships sitting opposite each other is what the whole
//   thing is built on. So three friends in a room cannot start, and a fourth
//   player walking out does not degrade the game, it stops it. Bots fill the
//   empty chairs and cover the seat of somebody whose phone died. Playing solo
//   against three of them works too, but it is the side effect rather than the
//   point.
//
// THE SHAPE, AND WHY IT IS THIS SHAPE
//   chooseCard() and chooseTrump() are PURE FUNCTIONS of the two views the
//   engine already hands out: publicState() and privateStateFor(). They read no
//   engine internals, hold nothing between calls, and return a wire message —
//   the same message a phone would have sent.
//
//   That buys three things:
//     1. No second copy of the rules. privateStateFor() has already run
//        canPlay() over every card in hand, so `card.legal` IS the follow-suit
//        rule. This file never decides what is legal; it only ranks what it was
//        given, so it cannot produce an illegal play even if the ranking is
//        wrong. The soak asserts that.
//     2. The move goes through applyGameIntent() like everyone else's, so the
//        engine validates it exactly as it validates a human's. A bug in here
//        gets an { ok:false } and cannot corrupt a game.
//     3. It is testable without a table, a socket or a clock: hand it two plain
//        objects, get an intent back.
//
// THE BOT DOES NOT CHEAT, AND THE SHAPE IS WHAT STOPS IT
//   The bots run on the host, and the host knows every hand and the hidden
//   trump. The only thing keeping them honest is that chooseCard() is handed
//   publicState() and ONE player's private view — nothing else, ever. Under
//   Hidden Rung a bot that did not call the trump plays the early tricks in the
//   same fog a human does, and gets the suit at the same moment everybody else
//   does. Do not add a third parameter to these functions. There is a test that
//   fails if the trump leaks into a non-caller's decision.
//
// NO TIMERS IN THE THINKING, AND NO THINKING IN THE TIMER
//   The pause before a bot moves is the driver's business, at the bottom of
//   this file, and it follows the same no-timers-in-the-engine rule state.js
//   does: the driver is ticked by whoever owns the engine, and time arrives as
//   a parameter.
//
// Node-safe: imports rules.js, trick.js, cards.js, intents.js and state.js,
// none of which touch the DOM. That is what lets the harness play thousands of
// deals headlessly.
// ============================================================================

import { SUITS, SEAT_COUNT, rankOf, suitOf, rankValue } from './rules.js';
import { teamOf, seatsFrom, partnerWinning, trickWinner, winningCard } from './trick.js';
import { buildDeck } from './cards.js';
import { applyGameIntent } from './intents.js';
// Only for the phase names. state.js does not import this module, so there is
// no cycle — and taking the constants rather than writing 'play' here is what
// stops a renamed phase leaving the bots quietly asleep instead of failing.
import { PHASES } from './state.js';

// ---------------------------------------------------------------------------
// One difficulty level, deliberately.
//
// An easy/normal/hard selector would mean a new config key, a new lobby
// control, a new field on the wire and three times the tests, to produce two
// settings nobody picks twice. This plays like an attentive casual partner: it
// follows suit, it knows when its partner already has the trick, it does not
// ruff its own side, it remembers what has been played, and it counts trumps.
// It does not signal, count the opponents' distribution, or plan a squeeze.
// ---------------------------------------------------------------------------

/** High-card points, the usual four-three-two-one. Only ever used to break ties
 *  between suits of the same length when calling trump. */
const HCP = Object.freeze({ A: 4, K: 3, Q: 2, J: 1 });

/**
 * How much one extra card in a suit is worth against its high cards.
 *
 * Ten, which across the FIVE cards this is ever shown makes the rule exact
 * rather than approximate: length always wins, and the high cards only ever
 * break a tie between suits of the same length. Ten is the smallest number that
 * does it — the richest two cards there are (ace-king, 20 + 7) still lose to any
 * three (30), and ace-king-queen (30 + 9) still loses to any four (40).
 *
 * That is the right answer in a trump game. Length in trumps is what takes
 * tricks: the fifth card of a suit wins because everybody else has run out,
 * whereas an ace takes exactly one trick whatever suit it sits in and takes it
 * whether or not the suit is trumps. The test asserts the exactness, so raising
 * this above 10 is fine and dropping it below is not.
 */
const LENGTH_WEIGHT = 10;

/** Trumps in hand before the bot starts leading them to draw the opponents'.
 *  Four of thirteen is more than a fair share, which is the point at which
 *  pulling trumps stops helping them and starts helping you. */
const DRAW_TRUMPS_AT = 4;

/** What it costs to throw a trump away, and to throw away the best outstanding
 *  card of a suit. Both are prices in the same currency as rankValue (2..14),
 *  and both are far above it, so cheapest() will part with any ordinary card
 *  before either — but will still play one when it is the only card left. */
const TRUMP_KEEP = 100;
const BOSS_KEEP = 50;

// ===========================================================================
// Calling trump
// ===========================================================================

/**
 * Name a trump from the opening five cards.
 *
 * Longest suit, with high cards as the tie-break — see LENGTH_WEIGHT for why
 * that ordering rather than the other one.
 *
 * Ties are broken by SUITS order rather than at random, which makes a bot's
 * call reproducible. That costs nothing here: the hand it is looking at is
 * secret, so there is no pattern for an opponent to read, and a deterministic
 * call is one less source of noise in a soak that plays thousands of deals.
 *
 * Takes plain card codes, and also tolerates the `{ code }` objects that
 * privateStateFor() hands out, because both callers exist and the failure mode
 * of getting it wrong is silent.
 */
export function chooseTrump(hand) {
  const codes = codesOf(hand);
  let best = SUITS[0];
  let bestScore = -Infinity;
  for (const suit of SUITS) {
    const cards = codes.filter((code) => suitOf(code) === suit);
    const score = cards.length * LENGTH_WEIGHT
      + cards.reduce((n, code) => n + (HCP[rankOf(code)] || 0), 0);
    if (score > bestScore) { bestScore = score; best = suit; }
  }
  return best;
}

function codesOf(hand) {
  if (!Array.isArray(hand)) return [];
  return hand
    .map((c) => (typeof c === 'string' ? c : (c && c.code)))
    .filter((c) => typeof c === 'string');
}

// ===========================================================================
// Playing a card
// ===========================================================================

/**
 * Decide which card to play.
 *
 * @param pub   engine.publicState()
 * @param priv  engine.privateStateFor(botId)
 * @returns a playCard intent, or null when it is not this bot's turn.
 */
export function chooseCard(pub, priv) {
  if (!pub || !priv || !priv.isTurn || !Array.isArray(priv.hand)) return null;

  // The engine's own legality, not a second opinion. Everything below only
  // ranks this list.
  const legal = priv.hand.filter((c) => c && c.legal).map((c) => c.code);
  if (!legal.length) return null;
  if (legal.length === 1) return { type: 'playCard', code: legal[0] };

  const view = readTable(pub, priv);
  const code = view.plays.length ? follow(view, legal) : lead(view, legal);
  // The fallback is unreachable unless a ranking function returns nothing, and
  // it exists because a table waiting on a bot is a dead game.
  return { type: 'playCard', code: code || legal[0] };
}

/**
 * Everything the ranking needs, read off the two views once per turn.
 *
 * This is where the bot's memory comes from. It holds none between calls, so
 * "what has been played" and "who is void in what" are reconstructed from
 * pub.tricks every time — which is also why they can never drift out of step
 * with the real game, and why a bot taking over a seat mid-deal after a host
 * reload knows exactly what the seat's previous occupant knew.
 */
function readTable(pub, priv) {
  const plays = Array.isArray(pub.trick) ? pub.trick : [];
  const done = Array.isArray(pub.tricks) ? pub.tricks : [];
  const seat = priv.seat;
  const hand = codesOf(priv.hand);

  // What this bot is entitled to know about the trump. In Classic that is
  // pub.trump from the moment it is called. Under Hidden Rung pub.trump is null
  // for everybody and priv.trumpYouCalled is set for the one player who chose
  // it, so a bot that did not call plays with `trump: null` and reasons about
  // the trick exactly as a human in the dark would — trickWinner() with a null
  // trump simply awards the trick to the led suit, which is the same wrong
  // guess the humans are making.
  const trump = pub.trump || priv.trumpYouCalled || null;

  const played = [];
  const voids = Array.from({ length: SEAT_COUNT }, () => new Set());
  const watch = (trickPlays) => {
    const led = trickPlays.length ? suitOf(trickPlays[0].code) : null;
    for (const play of trickPlays) {
      played.push(play.code);
      // Playing off-suit is only legal when void, so an off-suit card IS the
      // proof. The same fact the engine uses to trigger the Hidden Rung reveal.
      if (led && suitOf(play.code) !== led) voids[play.seat].add(led);
    }
  };
  for (const t of done) watch(Array.isArray(t.plays) ? t.plays : []);
  watch(plays);

  const seen = new Set(played);
  const mine = new Set(hand);
  // The twenty-six cards that could be in any of the other three hands. Our
  // partner's are in here too, on purpose: we cannot see them either, so a king
  // is only "the best card left" if the ace is not out there ANYWHERE.
  const unseen = buildDeck().filter((code) => !seen.has(code) && !mine.has(code));

  const position = plays.length;
  const order = seatsFrom(plays.length ? plays[0].seat : seat);

  return {
    seat,
    trump,
    plays,
    position,
    led: plays.length ? suitOf(plays[0].code) : null,
    last: position === SEAT_COUNT - 1,
    // Only opponents still to play matter when asking whether a card is safe.
    // A partner taking the trick off us is still our trick.
    oppsToAct: order.slice(position + 1).filter((s) => teamOf(s) !== teamOf(seat)),
    voids,
    unseen,
    hand,
  };
}

// ---------------------------------------------------------------------------
// Leading
// ---------------------------------------------------------------------------

function lead(view, legal) {
  const bySuit = groupBySuit(legal);

  // 1. Cash a certain winner while the opponents still have to follow. The
  //    longest such suit first: a boss card is worth most in the suit where we
  //    have more cards behind it.
  let boss = null;
  for (const suit of SUITS) {
    const cards = bySuit[suit];
    if (!cards || !cards.length) continue;
    if (!unbeatable(cards[0], view)) continue;
    if (!boss || cards.length > boss.length) boss = { code: cards[0], length: cards.length };
  }
  if (boss) return boss.code;

  // 2. Draw trumps. Worth doing only when we hold more than our share: pulling
  //    trumps out of the opponents' hands stops them ruffing our long suit, but
  //    every round of it costs us a trump too, so from a short holding it is
  //    their plan rather than ours.
  if (view.trump) {
    const trumps = bySuit[view.trump] || [];
    const out = view.unseen.some((code) => suitOf(code) === view.trump);
    if (trumps.length >= DRAW_TRUMPS_AT && out) return trumps[0];
  }

  // 3. Otherwise lead low from the shortest side suit. This is the standard
  //    trump-game opening and it is playing for a void: three rounds of a
  //    doubleton and our trumps start taking tricks they could not otherwise
  //    take. The rank term stops it throwing a singleton ace under the table —
  //    a lone ace scores 10 + 14 and loses to a doubleton's 20 + 2.
  let pick = null;
  let cost = Infinity;
  for (const suit of SUITS) {
    if (suit === view.trump) continue;
    const cards = bySuit[suit];
    if (!cards || !cards.length) continue;
    const low = cards[cards.length - 1];
    const c = cards.length * LENGTH_WEIGHT + rankValue(low);
    if (c < cost) { cost = c; pick = low; }
  }
  if (pick) return pick;

  // 4. Nothing but trumps left, so they are all going to be played anyway.
  //    Lead the highest: it wins now, whereas the low ones may not win later.
  return (bySuit[view.trump] || legal)[0];
}

// ---------------------------------------------------------------------------
// Following
// ---------------------------------------------------------------------------

function follow(view, legal) {
  if (partnerWinning(view.plays, view.seat, view.trump)) {
    // THE SINGLE THING THAT SEPARATES A BOT THAT FEELS LIKE A PLAYER FROM ONE
    // THAT FEELS BROKEN. The trick is already going our way, so the only
    // question is how little we can pay for it. Note there is no ruffing branch
    // here and there does not need to be one: cheapest() prices trumps above
    // every ordinary card, so a bot holding trumps and void in the led suit
    // throws a rag instead of trumping its own partner's winner.
    if (view.last) return cheapest(legal, view);

    // isBoss here, NOT unbeatable, and the difference is the whole branch.
    // unbeatable() also asks "could an opponent ruff this?", which is the wrong
    // question when deciding whether to improve on our own side's card: a ruff
    // beats whatever WE put up too, so the risk is identical either way and
    // cannot be a reason to spend a card on it. Ask only the question our card
    // could actually answer — is anything outstanding higher in this suit?
    if (isBoss(winningCard(view.plays, view.trump), view)) return cheapest(legal, view);

    // Partner is in front with something that can still be topped in its own
    // suit. Stepping over them is worth it only with a card that finishes the
    // argument — overtaking with another beatable card spends two of our cards
    // on one trick and still loses it.
    //
    // Restricted to the suit led, which is what stops the one behaviour that
    // makes a bot look broken faster than any other: RUFFING ITS OWN PARTNER.
    // Off-suit, `beats` can only be satisfied by a trump, and a trump over a
    // partner's winner is a card spent to take a trick we already had. Being
    // void therefore leaves this list empty and drops us into cheapest(), which
    // discards. The same applies to over-ruffing a partner who has ruffed: the
    // suit led is not trumps, so our trumps are not candidates.
    const over = legal.filter(
      (code) => suitOf(code) === view.led && beats(code, view) && isBoss(code, view),
    );
    return over.length ? lowest(over) : cheapest(legal, view);
  }

  // An opponent is in front. Every trick is worth the same in this game — there
  // are no card points — so taking it with the smallest thing that works is
  // always right, and that includes ruffing with the lowest trump we hold.
  const winners = legal.filter((code) => beats(code, view));
  if (winners.length) {
    if (view.last) return lowest(winners);
    const safe = winners.filter((code) => unbeatable(code, view));
    // Nothing safe: play the cheapest winner anyway and accept it might be
    // overtaken. The alternative is conceding a trick we could have contested,
    // and over thirteen tricks that is the more expensive habit.
    return safe.length ? lowest(safe) : lowest(winners);
  }

  return cheapest(legal, view);
}

// ---------------------------------------------------------------------------
// The questions the ranking asks
// ---------------------------------------------------------------------------

/** Would this card be taking the trick if it were played right now? Asked of
 *  trickWinner() rather than reimplemented, so the bot's idea of who is winning
 *  and the engine's cannot come apart — including under Hidden Rung, where a
 *  null trump makes both of them equally wrong about a ruff. */
function beats(code, view) {
  if (!view.plays.length) return true;
  return trickWinner([...view.plays, { seat: view.seat, code }], view.trump) === view.seat;
}

/**
 * Can any opponent still to play beat this card?
 *
 * "As far as this bot can tell", not "certainly" — the only voids it can claim
 * to know are the ones it has watched happen, so an opponent who is void in a
 * suit nobody has led yet will beat a card this calls safe. That is the same
 * information a human at the table has, and inventing more would be cheating
 * by another route.
 */
function unbeatable(code, view) {
  if (!code) return false;
  if (!view.oppsToAct.length) return true;

  const suit = suitOf(code);
  // The obvious way to lose it: something higher in the same suit is still out.
  if (view.unseen.some((c) => suitOf(c) === suit && rankValue(c) > rankValue(code))) return false;

  // Nothing outranks it in its own suit, so the only threat left is a ruff.
  if (!view.trump) return false;                 // we do not know what could ruff it
  if (suit === view.trump) return true;          // and nothing at all beats the top trump
  if (!view.unseen.some((c) => suitOf(c) === view.trump)) return true;  // no trumps left

  return !view.oppsToAct.some((s) => view.voids[s].has(view.led || suit));
}

/** The best outstanding card of its suit — nothing unseen beats it. */
function isBoss(code, view) {
  return !view.unseen.some(
    (c) => suitOf(c) === suitOf(code) && rankValue(c) > rankValue(code),
  );
}

/**
 * The card we would least rather lose.
 *
 * Trumps and boss cards carry a price far above any rank, so an ordinary card
 * goes first — but the prices are finite, so when the only legal cards ARE
 * trumps, one of them is still played rather than the function returning
 * nothing. When we are following suit this collapses to "the lowest one", which
 * is what it should be: the penalties apply equally across a single suit.
 */
function cheapest(legal, view) {
  let best = null;
  let bestCost = Infinity;
  for (const code of legal) {
    let cost = rankValue(code);
    if (view.trump && suitOf(code) === view.trump) cost += TRUMP_KEEP;
    if (isBoss(code, view)) cost += BOSS_KEEP;
    if (cost < bestCost) { bestCost = cost; best = code; }
  }
  return best;
}

/** The lowest by rank. Only ever called on a set of cards that beat the same
 *  card, which in this game means they are all of one suit — either the suit
 *  led or the trump — so comparing ranks across them is meaningful. */
function lowest(codes) {
  return codes.reduce((m, c) => (rankValue(c) < rankValue(m) ? c : m));
}

/** Suit -> the cards we hold in it, strongest first. */
function groupBySuit(codes) {
  const out = Object.create(null);
  for (const suit of SUITS) out[suit] = [];
  for (const code of codes) if (out[suitOf(code)]) out[suitOf(code)].push(code);
  for (const suit of SUITS) out[suit].sort((a, b) => rankValue(b) - rankValue(a));
  return out;
}

// ===========================================================================
// What a bot does with a turn, whatever kind of turn it is
// ===========================================================================

/**
 * The one intent this bot owes the table right now, or null if it owes none.
 *
 * Two phases can be waiting on a bot — DECLARE_TRUMP and PLAY — and the private
 * view already says which, so the driver does not have to branch on the phase a
 * second time.
 */
export function chooseIntent(pub, priv) {
  if (!pub || !priv) return null;
  if (priv.mustDeclare) return { type: 'declareTrump', suit: chooseTrump(priv.hand) };
  return chooseCard(pub, priv);
}

// ===========================================================================
// The driver — turning "it is a bot's turn" into a move, at a human pace
// ===========================================================================

/** How long a bot appears to think. Long enough that the table sees whose turn
 *  it was and what they played before the next card lands; short enough not to
 *  drag across fifty-two of them. The same number sequence uses, because it is
 *  the same judgement about the same kind of table. */
export const BOT_THINK_MS = 1500;

/**
 * How long the table waits for an ABSENT human before a bot plays their card.
 *
 * This game has no pass, no skip and no turn timer, and it cannot be played
 * three-handed. So a player whose phone locks, or who walks into a lift, does
 * not slow the table down — they stop it, permanently, for the other three.
 * Covering the seat is the only alternative to ending the match.
 *
 * Ten seconds is the standing budget in this project for deciding anything on a
 * network is dead, and it is the right one here for two reasons that happen to
 * agree. It is long enough that a 4G handover or a screen lock is invisible —
 * the client's own retry ladder (js/main.js) has usually reconnected inside it.
 * And it is short enough that the other three do not sit staring at a table
 * that has visibly stopped, which is when people quit.
 *
 * The seat is COVERED, never converted: `isBot` stays false, the seat keeps its
 * clientId, the UI keeps showing the player as offline, and the moment they
 * reconnect they take the next turn themselves.
 */
export const OFFLINE_GRACE_MS = 10000;

/** Should the driver move for this player?
 *
 *  Two quite different situations with one answer. A bot has nobody behind it;
 *  an offline human has somebody behind it who is not there. Either way the
 *  table is waiting on a seat that cannot act for itself, and the alternative
 *  to acting is a dead game. */
function coverage(player) {
  if (!player) return null;
  if (player.isBot) return 'bot';
  if (!player.online) return 'offline';
  return null;
}

/**
 * A stateful ticker, one per game.
 *
 * Called from the interval whoever owns the engine already runs for tick() —
 * js/main.js today, a server later — rather than from a timer of its own.
 * Nothing new starts ticking to add bots, and the engine stays free of clocks.
 *
 * The state it holds is only "which turn am I waiting on, and until when". It
 * is never serialised: a host reload rebuilds it from the engine's own turn, so
 * the worst a crash mid-pause costs is that a bot thinks for a second and a
 * half again.
 */
export function createBotDriver({ thinkMs = BOT_THINK_MS, offlineMs = OFFLINE_GRACE_MS } = {}) {
  let pending = null;

  return {
    /** @returns true if the engine changed and the caller should broadcast. */
    tick(engine, now = Date.now()) {
      const player = engine ? waitingOn(engine) : null;
      const cover = coverage(player);
      if (!cover) { pending = null; return false; }

      // The key has to change on every distinct action a bot could take, or the
      // second one is mistaken for the first and never happens. Phase, then the
      // exact position in the deal: which deal, how many tricks are complete,
      // and how many cards are on the table. Two different decisions can never
      // share all four.
      //
      // `cover` is in it too, so a human who drops mid-pause restarts the clock
      // on the longer budget instead of inheriting a bot's second and a half.
      // (Their id changes on reconnect anyway, but only AFTER they are back —
      // this is about the moment they leave.)
      const key = [
        engine.phase, player.id, cover, engine.dealsPlayed,
        engine.trickWinners.length, engine.trick.length,
      ].join(':');

      const wait = cover === 'offline' ? offlineMs : thinkMs;
      if (!pending || pending.key !== key) pending = { key, dueAt: now + wait, acted: false };
      if (pending.acted || now < pending.dueAt) return false;

      // Set before acting, not after. Whatever happens below — a refusal, a
      // throw — this step gets exactly one attempt, so a bot that cannot be
      // satisfied costs one tick rather than spinning forever.
      pending.acted = true;
      return act(engine, player, now);
    },

    /** Forget the pause in progress. For a host that has just taken over an
     *  engine, where "waiting since" means nothing. */
    reset() { pending = null; },
  };
}

/** Whose move the table is waiting for, across both phases that can wait on
 *  one. Not engine.currentPlayer, which is deliberately about trick play only. */
function waitingOn(engine) {
  if (engine.phase === PHASES.DECLARE_TRUMP) return engine.seats[engine.callerSeat];
  if (engine.phase === PHASES.PLAY) return engine.currentPlayer;
  return null;
}

function act(engine, player, now) {
  const priv = engine.privateStateFor(player.id);
  let intent = null;
  try {
    intent = chooseIntent(engine.publicState(), priv);
  } catch (err) {
    // A throw in here is a bug in the ranking, and the right response is still
    // to get the turn moving — a table stuck behind a bot is a dead game, where
    // a bad card is something somebody can play on from.
    console.warn('[bot] chooseIntent threw', err);
  }

  if (intent) {
    const { result } = applyGameIntent(engine, player.id, intent, now);
    if (result && result.ok) return true;
    console.warn('[bot] move refused:', result && result.error, intent);
  }

  // Last resort, and it should be unreachable: chooseCard only ever returns a
  // card the engine itself marked legal. It exists because this game has no
  // skip — there are no turn timers and no way to pass — so the alternative to
  // a bad move is no move at all, and no move at all stops the table
  // permanently.
  const fallback = panic(priv);
  if (!fallback) return false;
  const { result } = applyGameIntent(engine, player.id, fallback, now);
  return !!(result && result.ok);
}

function panic(priv) {
  if (!priv) return null;
  if (priv.mustDeclare) return { type: 'declareTrump', suit: SUITS[0] };
  const card = Array.isArray(priv.hand) ? priv.hand.find((c) => c && c.legal) : null;
  return card ? { type: 'playCard', code: card.code } : null;
}
