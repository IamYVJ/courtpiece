// ============================================================================
// config.js — Where an authoritative server would live, if there were one.
//
// THERE ISN'T ONE, AND THAT IS THE POINT OF THIS FILE.
//
// Both URLs below are deliberately blank. serverConfigured() therefore returns
// false, every server-shaped branch in the app is dead, and Court Piece is what
// it says on the tin: a static peer-to-peer game with no backend, no accounts
// and nothing to pay for. It runs from a file:// URL and it runs on a plane.
//
// So why does the file exist at all?
//
// Because the alternative is worse. The seam a server needs is not a URL — it
// is the discipline of never letting "who is authoritative" leak into the rest
// of the code. That discipline is cheap to keep from the first commit and
// enormously expensive to retrofit, because by then a hundred call sites have
// quietly assumed the host tab is the only thing that can be in charge. The
// engine already takes `now` as a parameter rather than reading a clock, and
// js/intents.js already routes every state change through one dispatcher for
// exactly this reason. This file is the third leg: the place where the answer
// to "is somebody else in charge?" is asked once, by name, instead of being
// assumed four hundred times by omission.
//
// To turn a server on later, fill these in and nothing else changes shape.
// See sequence's js/config.js for what a filled-in version looks like, down to
// the trailing slash that a path-stripping reverse proxy insists on.
//
// ----------------------------------------------------------------------------
// DO NOT make these read from localStorage, a query string, or anything else a
// visitor can set. A configurable endpoint is an open redirect for game state:
// anyone who can get a player to load `?server=…` gets that player's clientId,
// which is the one thing in this app that behaves like a credential (see
// js/util.js). The endpoint is a build-time constant or it is nothing.
// ----------------------------------------------------------------------------
// ============================================================================

/** WebSocket endpoint for server mode. Blank = peer-to-peer only. */
export const SERVER_URL = '';

/**
 * Cheap liveness probe, checked before any server UI is offered.
 *
 * Kept as a SEPARATE constant rather than derived from SERVER_URL, because the
 * two are different protocols on possibly different paths, and because sw.js
 * needs to recognise the health path by shape in order to refuse to cache it.
 * A cached "yes" is the worst possible answer here: it would strand the app in
 * server mode pointing at a machine that is switched off.
 */
export const SERVER_HEALTH = '';

/**
 * True when a server endpoint is configured at all.
 *
 * Every server-shaped thing in the UI asks this FIRST and the health probe
 * second. Both must pass — configured but unreachable is the normal state of a
 * self-hosted box, and it must degrade to peer-to-peer in silence rather than
 * showing an error for a feature the player never asked for.
 */
export function serverConfigured() {
  return !!(SERVER_URL && SERVER_HEALTH);
}
