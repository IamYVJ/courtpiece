// ============================================================================
// intents.js — The one place a message from a device turns into a call on the
// engine.
//
// WHY ONE DISPATCHER
//   Two things will eventually be authoritative: the host tab today, and a
//   server later (js/config.js already has the seams). If each wrote its own
//   switch statement they would drift — one would grow an owner check the other
//   never got, or accept a field the other ignores — and the bug would only
//   show up as two devices disagreeing about a trick. So the mapping from
//   message to engine call lives here once, and both transports call it.
//
//   It also means the answer to "what can a client ask for?" is a list you can
//   read, rather than something you reconstruct by grepping net.js.
//
// WHAT THIS IS NOT
//   Not a transport. Nothing here knows about PeerJS, sockets, broadcasts or
//   who else is in the room. It takes an actor id and a plain object and
//   returns a plain object.
//
//   Not the whole protocol either. Joining, leaving, room queries, state sync
//   and heartbeats stay with the transport, because they are about the
//   CONNECTION rather than the game — the engine has no opinion about them and
//   a server would answer them completely differently. This file handles the
//   messages that change the game.
//
//   Not rule enforcement. Every case below calls straight through to a method
//   that checks the phase, the seat, the turn and the card for itself. What
//   this adds is the owner check for the four setup calls the engine
//   deliberately leaves open, and the conversion of wire values into arguments
//   the engine can be handed safely.
//
// THE CLOCK IS A PARAMETER
//   The engine never reads a clock — that is a standing rule of this codebase,
//   and it is what lets the test harness run two hundred deals in a few
//   milliseconds and replay a failure exactly. So `now` is threaded through
//   here rather than resolved here, and it defaults to 0 rather than
//   Date.now(): a caller that forgets gets a phase stamped at zero, which the
//   very first tick() will step past and which any test will notice. A hidden
//   Date.now() would instead work perfectly until the day something needed to
//   be replayed.
// ============================================================================

import { validCardCode, validConfigPatch, validSeat, validSuit } from './guards.js';

/** Anything a seated player may send about their own turn. Both are checked by
 *  SEAT inside the engine — sending someone else's move is refused there, not
 *  here, because only the engine knows whose turn it is. */
export const PLAYER_INTENTS = Object.freeze(['playCard', 'declareTrump']);

/** Anything only the room's owner may send. Note this is about `ownerId` — who
 *  holds the controls — and has nothing to do with which tab is running the
 *  engine. The host tab may well not be the owner after a handover, and the
 *  owner's device may be a plain client. Never gate on isHost. */
export const OWNER_INTENTS = Object.freeze([
  'setConfig', 'addBot', 'removeBot', 'swapSeats',
  'startMatch', 'nextDeal', 'newMatch', 'endMatch',
]);

export const GAME_INTENTS = Object.freeze([...PLAYER_INTENTS, ...OWNER_INTENTS]);

// ---------------------------------------------------------------------------
// Where the owner check happens.
//
// The engine checks `actorId !== this.ownerId` itself for the four match-flow
// calls, because those change what everybody is looking at and a stray call
// from a direct caller — a test, a future server — should be refused at the
// source. It deliberately does NOT check for the four lobby calls: they are
// also how the app seats bots during startMatch() and how a future server would
// apply a saved room preset, neither of which has a player behind it.
//
// So the two lists below are that split, written down. The loop after them
// makes it impossible to add a ninth owner intent and forget to say which side
// it falls on: declaring it in both, or in neither, fails at module load rather
// than shipping as a hole.
// ---------------------------------------------------------------------------
const NEEDS_OWNER_GUARD = new Set(['setConfig', 'addBot', 'removeBot', 'swapSeats']);
const SELF_GUARDED = Object.freeze(['startMatch', 'nextDeal', 'newMatch', 'endMatch']);

for (const type of OWNER_INTENTS) {
  const here = NEEDS_OWNER_GUARD.has(type);
  const there = SELF_GUARDED.includes(type);
  if (here === there) {
    throw new Error(
      `intents.js: owner intent '${type}' is gated in ${here ? 'both places' : 'neither place'}`,
    );
  }
}

/**
 * Apply one game message.
 *
 * Returns `{ handled, result }`. `handled` false means this is not a game
 * intent at all and the transport should keep looking — a join, a sync
 * request, something from a newer client. `handled` true with a failing result
 * means it WAS a game intent and the answer is no, which the caller should show
 * to the sender and to nobody else.
 *
 * Never throws, whatever arrives. A hostile peer gets a refusal, not a dead
 * host tab.
 */
export function applyGameIntent(engine, actorId, msg, now = 0) {
  const type = msg && msg.type;
  if (typeof type !== 'string') return { handled: false, result: null };

  if (NEEDS_OWNER_GUARD.has(type) && actorId !== engine.ownerId) {
    return { handled: true, result: { ok: false, error: 'Only the host can change the setup.' } };
  }

  switch (type) {
    // --- Play -------------------------------------------------------------
    case 'playCard': {
      // Validated rather than passed through because canPlay() would otherwise
      // compare a 60 KiB string against thirteen cards. The engine still
      // decides whether a well-formed card is a legal one — this only decides
      // whether it is a card.
      const code = validCardCode(msg.code);
      if (code === null) return done({ ok: false, error: 'That is not a card.' });
      return done(engine.playCard(actorId, code));
    }

    case 'declareTrump':
      // Suit passed through unvalidated on purpose: declareTrump() checks it
      // against SUITS, and doing it twice would mean two places to change if a
      // variant ever allowed calling no-trump. Cheap to check there — the
      // engine's phase and seat checks run first and reject a stranger before
      // the suit is ever looked at.
      return done(engine.declareTrump(actorId, msg.suit, now));

    // --- Lobby (owner-gated above) ---------------------------------------
    case 'setConfig': {
      const patch = validConfigPatch(msg.config);
      if (patch === null) return done({ ok: false, error: 'That is not a setting.' });
      return done(engine.setConfig(patch));
    }

    case 'addBot': {
      // An unusable seat means "anywhere", which is what the lobby's plain
      // "Add bot" button sends. That makes a hostile `seat: 1e9` harmless
      // rather than an error worth reporting — the bot lands in the first free
      // seat, exactly as if the field had been left off.
      const seat = validSeat(msg.seat);
      return done(engine.addBot(seat === null ? -1 : seat));
    }

    case 'removeBot': {
      // Unlike addBot, a bad seat here is refused rather than defaulted:
      // guessing which bot somebody meant to remove is worse than asking again.
      const seat = validSeat(msg.seat);
      if (seat === null) return done({ ok: false, error: 'That is not a seat.' });
      return done(engine.removeBot(seat));
    }

    case 'swapSeats': {
      const a = validSeat(msg.a);
      const b = validSeat(msg.b);
      if (a === null || b === null) return done({ ok: false, error: 'Pick two different seats.' });
      return done(engine.swapSeats(a, b));
    }

    // --- Match flow (owner-checked inside the engine) ---------------------
    case 'startMatch': return done(engine.startMatch(actorId, now));
    case 'nextDeal':   return done(engine.nextDeal(actorId, now));
    case 'newMatch':   return done(engine.newMatch(actorId, now));
    case 'endMatch':   return done(engine.endMatch(actorId));

    default:
      return { handled: false, result: null };
  }
}

// Every engine method already returns `{ ok, ... }`, so the fallback is for the
// one that does not: disconnect() returns undefined, and anything added later
// might too. Treating a missing return as success rather than failure matches
// what those methods mean — they did the thing and had nothing to report.
function done(result) {
  return { handled: true, result: result || { ok: true } };
}
