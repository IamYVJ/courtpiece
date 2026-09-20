// ============================================================================
// guards.js — Bounds on anything that arrived from another device.
//
// WHY A PEER-TO-PEER GAME NEEDS THESE AT ALL
//   The tempting reasoning is that a server is exposed to the internet while a
//   browser host only ever hears from people on the same Wi-Fi. The second half
//   is false: PeerJS signalling goes through a broker on the public internet and
//   the data channel falls back to a relay, so the host tab is reachable from
//   anywhere by anyone who has — or guesses — the room code. The host here is
//   somebody's phone, which is the weaker of the two machines and the one with a
//   battery, so if anything it deserves the tighter bounds.
//
// WHAT THESE ARE FOR, AND WHAT THEY ARE NOT
//   Not rule enforcement. The engine is already defensive on its own account:
//   playCard() runs canPlay() against the hand it holds, declareTrump() checks
//   the suit against SUITS, swapSeats() checks both seats, and normalizeConfig()
//   rebuilds the config from a fixed key list so a hostile KEY is dropped rather
//   than stored. These bound *work and memory* instead — a 60 KiB string would
//   be compared against all thirteen cards in a hand, and a patch with ten
//   thousand keys would be spread into an object before normalizeConfig() ever
//   saw it.
//
//   Neither are they authentication. Nothing in here decides who you are; that
//   is the clientId rule in state.js. A clientId that passes validClientId() is
//   well-formed, not trusted.
//
//   The ceiling on how MANY connections a host accepts is not here either — it
//   belongs with the connection lifecycle in js/net.js. This file only ever sees
//   one message at a time.
//
// WHY THIS IMPORTS rules.js, WHERE SEQUENCE'S EQUIVALENT IMPORTS NOTHING
//   sequence shuffles two decks and gives every card an `id` distinct from its
//   printed code, so the only honest check its guard can make is a length cap.
//   Court Piece uses one deck and a card IS its two-character code, so the check
//   can be exact — and an exact check written out by hand would be a second copy
//   of RANKS and SUITS, free to drift from the first. rules.js imports nothing
//   from anywhere, so taking it as a dependency keeps this file a leaf in every
//   way that matters: `node` can still exercise it alone and the browser still
//   loads it with no build step.
// ============================================================================

import { RANKS, SUITS, SEAT_COUNT } from './rules.js';

// A type is a short verb like 'playCard'. Anything longer is not a type,
// whatever else it might be.
export const MAX_TYPE_LEN = 40;

/**
 * The shape every wire message must have, checked after parsing and before any
 * dispatch. Shared so the two transports cannot disagree about what counts as a
 * message at all.
 *
 * An ARRAY parses fine as JSON and would sail past a `typeof === 'object'`
 * check while having no `.type`, so it is excluded by name.
 */
export function validEnvelope(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.type !== 'string' || msg.type.length > MAX_TYPE_LEN) return null;
  return msg;
}

// ---------------------------------------------------------------------------
// Per-connection message rate limit.
//
// The point is not to stop one client from being annoying to itself — it is
// that every accepted message fans out into a broadcast to the whole room.
// Without a limit, one peer sending in a loop multiplies its own flood by three
// before it leaves the host's phone. So the bucket sits in front of the
// dispatch, not behind it.
//
// A refill rate rather than a fixed window, because real play is bursty: the
// last card of a trick and the first of the next arrive a heartbeat apart, and
// a host nudging the deals stepper sends one message per tap.
// ---------------------------------------------------------------------------
export class TokenBucket {
  constructor({ capacity = 40, refillPerSec = 15, now = Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.stamp = now;
  }

  /** True if this message may proceed. Costs one token. */
  take(now = Date.now()) {
    const elapsed = Math.max(0, now - this.stamp) / 1000;
    this.stamp = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Input validation. Every one of these returns a usable value or null — never
// throws, and never hands back something half-cleaned.
// ---------------------------------------------------------------------------

// Long enough that collisions across a friend group are impossible, short
// enough to be obviously not a payload. The character class rules out anything
// that could confuse a log line or a JSON key.
//
// The lower bound is 8 rather than 22 (what a real 128-bit id base64url-encodes
// to) because this must keep accepting ids minted by older builds of this app,
// and a length check is not what stops anyone guessing someone else's id.
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function validClientId(raw) {
  return typeof raw === 'string' && CLIENT_ID_RE.test(raw) ? raw : null;
}

/** A PeerJS connection id, or the host's own. Not checked against a character
 *  class: the id is minted by the broker, not by us, and guessing at its format
 *  would break the day PeerJS changes it. */
export function validPlayerId(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null;
}

// Rank then suit, exactly two characters. Built from the arrays in rules.js so
// the two cannot drift; every character in both is alphanumeric, so none of
// them needs escaping inside a character class.
const CARD_CODE_RE = new RegExp(`^[${RANKS.join('')}][${SUITS.join('')}]$`);

/** A card code as this app writes them: 'AS', 'TH', '2C'. */
export function validCardCode(raw) {
  return typeof raw === 'string' && CARD_CODE_RE.test(raw) ? raw : null;
}

/** One of 'S', 'H', 'D', 'C'. */
export function validSuit(raw) {
  return typeof raw === 'string' && SUITS.includes(raw) ? raw : null;
}

/**
 * A seat index, 0 to 3.
 *
 * Integer-only on purpose. A float like 1.5, or the string '1', would index
 * nothing in `seats` and read as a missing player, which is a confusing way to
 * fail; and '__proto__' would index Array.prototype, which is a much worse one.
 * Returning null here means the caller decides what an unusable seat means —
 * see addBot in js/intents.js, where it means "any free seat" rather than "no".
 */
export function validSeat(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw < SEAT_COUNT ? raw : null;
}

// A display name is capped at 16 characters by cleanName() in rules.js, but
// that function walks the whole string one codepoint at a time before it caps
// anything, so it must not be handed a megabyte. This is the bound; cleanName
// is the cleaning. Generous relative to the 16 that survive, because a name
// typed in an alphabet with combining marks can be several times its own
// rendered length and should be truncated, not rejected outright.
export const MAX_RAW_NAME_LEN = 256;

export function validName(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_RAW_NAME_LEN ? raw : null;
}

// A config patch as the lobby UI sends it: one key per tap, or the whole set at
// once when a client is brought into line with the host.
//
// This is the one guard in the file that is load-bearing rather than
// belt-and-braces. setConfig() spreads the patch into an object BEFORE
// normalizeConfig() throws the unknown keys away, so the cap is what stops ten
// thousand keys from being allocated at all. There are only four real keys —
// the cap is 16 to leave room for a future one without a second thought, and
// because the number is about bounding the spread, not describing the shape.
const MAX_PATCH_KEYS = 16;

export function validConfigPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.length > MAX_PATCH_KEYS) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// The other direction: what a CLIENT accepts from its host.
//
// Easy to forget, because "the host" sounds trustworthy. It is not, necessarily.
// A room code is four characters on a public broker (see js/net.js), so a code
// typed one character wrong resolves to whoever else holds that id — and the
// client then renders whatever that stranger sends. The renderer does no
// checking at all: it reads pub.seats[3].name and pub.trick.length directly,
// because on the host's own device those always exist. A `seats: 4` instead of
// an array is a thrown TypeError inside render(), which is a blank page with no
// way back.
//
// So these are shape checks, and deliberately only shape checks. Whether the
// trick makes sense, whether the scores add up, whether the host is cheating —
// none of that is knowable from here, and a client that tried to referee its
// own host would need a second copy of the engine. What this buys is that a
// malformed payload is a refused frame instead of a dead tab.
// ---------------------------------------------------------------------------

/** The public table, as far as anything can be checked without a game engine. */
export function validPublicState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.phase !== 'string' || raw.phase.length > MAX_TYPE_LEN) return null;
  // Fixed at four, and every screen in the app indexes it by seat.
  if (!Array.isArray(raw.seats) || raw.seats.length !== SEAT_COUNT) return null;
  // The three arrays the play screen walks unconditionally.
  if (!Array.isArray(raw.trick) || !Array.isArray(raw.tricks) || !Array.isArray(raw.log)) return null;
  return raw;
}

/** One device's own hand. Null is a legitimate value — a device that has
 *  connected but is not seated yet has no private state — so the caller has to
 *  distinguish "absent" from "malformed", and does so by checking for null
 *  before calling this. */
export function validPrivateState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.hand)) return null;
  if (!Number.isInteger(raw.seat) || raw.seat < 0 || raw.seat >= SEAT_COUNT) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Frame decoding for the PeerJS transport.
//
// A DataConnection hands back whatever the sender's serializer produced. This
// app sends JSON.stringify()'d text, so a string is the normal case, but
// PeerJS's own BinaryPack serializer would deliver an already-decoded object
// and a custom client could send binary.
//
// The size cap can only be applied to the text case, and that is not a gap
// worth pretending away: by the time an object arrives, PeerJS has already
// allocated it, so the cap would be closing the door on an empty room. The cap
// that matters for the object path is the connection ceiling in js/net.js,
// which stops the flood rather than each frame in it.
// ---------------------------------------------------------------------------
export const MAX_FRAME_BYTES = 65536;

export function decodePeerFrame(raw, { maxBytes = MAX_FRAME_BYTES } = {}) {
  if (typeof raw === 'string') {
    // Compared against the character count rather than the encoded byte length:
    // multi-byte characters make this stricter than the stated cap, never
    // looser, and it avoids allocating a TextEncoder for every frame of every
    // game.
    if (raw.length > maxBytes) return null;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return null; }
    return validEnvelope(msg);
  }
  // ArrayBuffer, Blob, TypedArray: something no version of this client sends.
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return null;
  return validEnvelope(raw);
}
