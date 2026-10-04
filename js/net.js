// ============================================================================
// net.js — The peer-to-peer transport. WebRTC via PeerJS, host-authoritative.
//
// SHAPE: A STAR, NEVER A MESH.
//   The host creates a Peer whose id is derived from the four-character room
//   code, so a joiner can reconstruct the host's address from the code alone and
//   no lookup service is needed. Every joiner opens exactly one DataConnection
//   to the host; joiners never talk to each other. The host runs the only
//   GameEngine that exists, validates everything, and sends each device the
//   public state plus only that device's own hand.
//
//   Three clients, one host, and that is the whole topology. Court Piece is four
//   players, so there is nothing here about rooms, lobbies or a player list —
//   see WHAT IS DELIBERATELY NOT HERE at the bottom of this header.
//
//   A watching screen (a TV) is not a fifth kind of thing. It is one more
//   connection to the host that never asks for a seat, and this file already
//   sends such a connection the public table with a null private half — see
//   stateFrameFor(). Who counts as watching is js/main.js's business.
//
// ----------------------------------------------------------------------------
// SIGNALING, AND WHY A CACHED PWA STILL NEEDS THE INTERNET.
//   PeerJS needs a "broker" (a signalling server) ONCE, to carry the WebRTC
//   handshake. After that, game traffic goes device to device. The default
//   broker is PeerJS's free public cloud, so the initial handshake needs the
//   internet to be reachable even though the app shell itself loads from cache.
//
//   The consequence worth stating plainly: a room code is an address on a PUBLIC
//   broker, not a LAN-local one. peerIdForCode() is derivable by anybody, and
//   there are only 32^4 ≈ 1M codes. Everything in js/guards.js, and the clientId
//   rule in js/state.js, exists because of that sentence.
//
//   FOR FULLY-OFFLINE LAN PLAY: run a PeerServer on the LAN,
//       npx peer --port 9000 --key peerjs --path /courtpiece
//   and point BROKER_CONFIG at it:
//       export const BROKER_CONFIG = {
//         host: '192.168.1.50', port: 9000, path: '/courtpiece',
//         key: 'peerjs', secure: false,
//       };
//   All four devices must use the same broker config to find each other.
//
// ----------------------------------------------------------------------------
// NAT TRAVERSAL — WHAT ACTUALLY HAPPENS.
//   newPeer() passes no `config`, so PeerJS's DEFAULT iceServers apply. In the
//   pinned 1.5.4 bundle those are Google's STUN plus TWO PUBLIC TURN RELAYS
//   (turn:eu-0 / us-0.turn.peerjs.com, with the credentials 'peerjs'/'peerjsp'
//   baked into the library and shared with every PeerJS app on the internet).
//
//   So this is not LAN-only and never was. STUN hole-punching connects two
//   ordinary home routers on different ISPs, and when it fails WebRTC relays
//   through peerjs.com. Keeping the default is deliberate — four people in four
//   different houses is a normal way to play this game — with three consequences
//   the rest of the code has to be honest about:
//
//     1. A table is reachable from anywhere by anyone holding the code. That is
//        why a seat mid-deal belongs to a clientId and not to a display name
//        (js/state.js addPlayer), and why this host applies the same bounds to
//        a peer that a server would (js/guards.js).
//     2. Cross-network ICE shows each player's public IP to the others. There is
//        no way around that in a peer-to-peer game; a server transport is the
//        answer for anyone who minds, and js/config.js holds the seam for it.
//     3. A relayed game depends on somebody else's infrastructure staying up.
//        The DataChannel is DTLS-encrypted end to end, so a relay forwards
//        ciphertext it cannot read — availability is the exposure here, not
//        confidentiality.
//
//   To make this LAN-only, pass `config: { iceServers: [] }` in newPeer(): with
//   no STUN and no relay only host candidates are gathered.
//
//   Connections still fail silently. Symmetric NAT with the relay blocked,
//   "client isolation" guest Wi-Fi, and some corporate networks all produce the
//   same thing: the broker cheerfully says the host exists, and then the data
//   channel never comes up and nobody errors. That silence is why joinHost()
//   callers need a deadline of their own — see JOIN_BUDGET_MS in js/main.js.
//
// ----------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT HERE.
//   * No discovery / open-table list. PeerJS's listAllPeers() only answers on a
//     broker configured with allow_discovery, which the public cloud is not, so
//     it would be a feature that works on nobody's phone. Typing four characters
//     is the join flow.
//   * No WebSocket transport to a server. js/config.js holds blank SERVER_URL
//     and SERVER_HEALTH constants and js/intents.js is already the shared
//     dispatcher both transports would call — that is the seam, and it is the
//     part worth having in advance. A socket client that has never been run
//     against a server is not a seam, it is untested code that looks tested.
//     When a server exists it drops in beside joinHost() with the same four
//     handlers and the same three methods.
// ============================================================================

import { TokenBucket, decodePeerFrame, validPlayerId } from './guards.js';

// Set to null to use PeerJS's default public cloud broker. Replace with an
// object (see the header) to self-host signalling for offline LAN play.
export const BROKER_CONFIG = null;

// ---------------------------------------------------------------------------
// Ceilings for a host that is somebody's phone.
// ---------------------------------------------------------------------------

// A Court Piece table is four seats, so three remote players. The rest of this
// budget is for churn that is normal rather than hostile: a reconnecting
// player's new connection overlaps their dead one until PeerJS notices, and the
// client's retry ladder can have two attempts in flight across a slow blip. Three
// players at up to four connections each, and a little headroom — which is also
// where watching screens live. js/main.js admits at most four of those, so even
// a full set of them leaves the players' twelve untouched.
//
// This is NOT an anti-abuse control and should not be mistaken for one — anyone
// who has the code can open connections, and a lower number only makes it
// cheaper to fill. What it does is bound the RTCPeerConnections a phone is asked
// to hold open at once, which is the failure that actually happens.
export const MAX_HOST_CONNS = 16;

// A refused frame is dropped in silence. Replying "too fast" to a flood answers
// every packet of it, which is the amplification the bucket exists to prevent.
// Persistent refusal is not a slow client though, it is a script, so the
// connection eventually goes rather than being throttled forever.
export const MAX_REFUSED_FRAMES = 120;

// How long a connection may sit half-open before the host forgets it.
//
// Read the standing rule first: this project does not set tight network
// timeouts, and this is not one. It never interrupts a connection that has
// opened, and it never shortens a handshake — an honest ICE negotiation over a
// TURN relay on a bad phone network finishes in a few seconds, so thirty is an
// order of magnitude of slack.
//
// It exists because the ceiling above counts connections we ACCEPTED, and a
// DataConnection that never opens does not reliably fire 'close' or 'error'.
// Without a reaper those slots are held for the life of the tab, and the table
// that cannot be joined is the host's own.
const HANDSHAKE_BUDGET_MS = 30000;

// ---------------------------------------------------------------------------
// Room code <-> peer id
//
// Namespaced, because the public broker is shared with every other PeerJS app
// on the internet and a bare four-character id would collide with them.
// Versioned, because a future change to the wire protocol can then be made by
// bumping this: old and new clients simply fail to find each other, instead of
// connecting and disagreeing about what a message means.
// ---------------------------------------------------------------------------
export const PEER_PREFIX = 'courtpiece-v1-';

export function peerIdForCode(code) {
  return PEER_PREFIX + String(code || '').toUpperCase();
}

export function codeFromPeerId(id) {
  return typeof id === 'string' && id.startsWith(PEER_PREFIX) ? id.slice(PEER_PREFIX.length) : null;
}

// ---------------------------------------------------------------------------
// Connection id -> player id. THIS PREFIX IS A SECURITY BOUNDARY.
//
// A joiner chooses its own peer id: `new Peer('whatever')`. The host learns it
// as conn.peer and would otherwise hand it straight to the engine as the actor
// behind every message that connection sends.
//
// That is an impersonation vector, and not a subtle one. The host's own engine
// id is the constant HOST_ID in js/main.js, and it is also engine.ownerId — so a
// peer that simply registered itself under that name on the broker would arrive
// as the owner. It could start the match, swap the seats, end the match, and —
// because seatOf() matches on id — play out of the host's own hand.
//
// Prefixing closes the whole class of it. Every id the engine ever sees from
// this transport is 'peer:' + something, a space the host's id and the bot ids
// are not in and cannot be pushed into: a peer that registers as 'peer:host'
// arrives as 'peer:peer:host'. The prefix is added HERE, by us, to a string we
// received — never sent by the peer, and so never something a peer can skip.
//
// js/main.js asserts at module load that HOST_ID falls outside this space, so
// renaming it to something that collides fails loudly on the next page load
// rather than shipping as a hole.
// ---------------------------------------------------------------------------
export const CONN_ID_PREFIX = 'peer:';

export function playerIdForConn(connId) {
  return CONN_ID_PREFIX + connId;
}

/** The connection behind a player id, or null if that player is not a peer —
 *  the host itself, or a bot. Callers use the null to mean "there is nothing to
 *  send to", which is exactly right for both. */
export function connIdForPlayer(playerId) {
  return typeof playerId === 'string' && playerId.startsWith(CONN_ID_PREFIX)
    ? playerId.slice(CONN_ID_PREFIX.length)
    : null;
}

// ---------------------------------------------------------------------------
// Is PeerJS actually here?
//
// window.Peer comes from a CDN <script> tag in index.html, and that tag is the
// one thing in this app that can be missing while everything else works: an
// offline first load, a blocked CDN, a content blocker, a corporate proxy. The
// failure without this check is `window.Peer is not a constructor` thrown out of
// a click handler, which on a phone is a button that does nothing at all.
//
// Checked rather than imported because there is no import to make — PeerJS ships
// as a UMD bundle, and pulling it in as a module would mean either a build step
// or vendoring a minified third-party file into this repo. Both are ruled out
// by the no-dependency, no-build rule this project is built on.
// ---------------------------------------------------------------------------
export function peerAvailable() {
  return typeof window !== 'undefined' && typeof window.Peer === 'function';
}

/** The error object a missing PeerJS is reported as. Shaped like a PeerJS error
 *  so it travels the caller's existing error path, with a type of our own so
 *  describePeerError() can say something more useful than "unknown error". */
const PEER_MISSING = { type: 'peer-missing', message: 'PeerJS did not load.' };

function newPeer(id) {
  const opts = BROKER_CONFIG ? { ...BROKER_CONFIG } : {};
  return id ? new window.Peer(id, opts) : new window.Peer(opts);
}

/**
 * A transport that does nothing, for when there is no PeerJS to build one on.
 *
 * Reports the failure ASYNCHRONOUSLY, one turn later, so the caller has already
 * returned from createHost()/joinHost() and assigned the handle before its own
 * onError runs. A synchronous callback here would fire into a half-assigned
 * `net`, which is a much worse bug than the one being reported.
 */
function inertTransport(handlers, extra = {}) {
  setTimeout(() => { if (handlers.onError) handlers.onError(PEER_MISSING); }, 0);
  return {
    peer: null,
    send() {}, sendTo() {}, broadcast() {}, pushState() {}, dropConnection() {},
    isOpen() { return false; },
    destroy() {},
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Which peer errors are worth giving up over.
//
// The useful distinction is not PeerJS's own notion of fatality, it is whether
// there is still a game. Signalling failures leave existing DataConnections
// untouched, because those run directly between devices — so a host whose broker
// falls over keeps playing and only loses the ability to admit NEW players. That
// is a banner, not an ending. Only a problem with the peer identity itself, or a
// browser that cannot do WebRTC at all, is genuinely unrecoverable.
// ---------------------------------------------------------------------------
const UNRECOVERABLE = new Set([
  'browser-incompatible',
  'invalid-id',
  'invalid-key',
  'unavailable-id',
  'ssl-unavailable',
  'peer-missing',
]);

export function isFatalPeerError(err) {
  return UNRECOVERABLE.has(err && err.type);
}

// ---------------------------------------------------------------------------
// Broker socket recovery.
//
// When the socket to the signalling broker drops, PeerJS emits 'disconnected'
// and then does nothing: the event is a notification, not a recovery.
// reconnect() has to be called by hand, and until it is the peer can neither
// accept nor make new connections — permanently. So one Wi-Fi blip would
// otherwise lock the fourth player out of a game that is running perfectly well.
//
// reconnect() reuses the SAME peer id, which is what keeps the room code valid
// across the blip. Backoff doubles from a second and caps at eight, so five
// tries span roughly half a minute — comfortably past the standing "budget ~10s
// before declaring anything dead", and giving up only tells the host that no NEW
// players can arrive.
// ---------------------------------------------------------------------------
const BROKER_RETRIES = 5;

function attachBrokerRecovery(peer, handlers = {}) {
  let tries = 0;
  let timer = null;

  const retry = () => {
    if (timer || peer.destroyed) return;
    if (tries >= BROKER_RETRIES) {
      if (handlers.onBrokerLost) handlers.onBrokerLost();
      return;
    }
    const delay = Math.min(1000 * 2 ** tries, 8000);
    tries += 1;
    timer = setTimeout(() => {
      timer = null;
      // Both checks matter: destroyed means we left the game while waiting, and
      // !disconnected means the socket came back on its own in the meantime.
      if (peer.destroyed || !peer.disconnected) return;
      try { peer.reconnect(); } catch (_) { retry(); }
    }, delay);
  };

  // Fires on the first connect AND on every successful reconnect, which is what
  // resets the ladder for the next blip.
  peer.on('open', () => {
    tries = 0;
    if (handlers.onBrokerUp) handlers.onBrokerUp();
  });

  peer.on('disconnected', () => {
    if (peer.destroyed) return;
    if (handlers.onBrokerDown) handlers.onBrokerDown();
    retry();
  });

  return { cancel() { if (timer) { clearTimeout(timer); timer = null; } } };
}

// ---------------------------------------------------------------------------
// HOST side
// ---------------------------------------------------------------------------

/**
 * Listen on the address derived from `code`.
 *
 * handlers: onOpen(code), onConnect(playerId), onData(playerId, msg),
 *           onDisconnect(playerId), onError(err),
 *           onBrokerDown(), onBrokerUp(), onBrokerLost()
 *
 * Note that every id handed to a handler is already a PLAYER id — prefixed, per
 * the security note above — so a caller cannot forget to do it. The connection
 * id is an internal detail of this module and of the `connections` map.
 */
export function createHost(code, handlers = {}) {
  if (!peerAvailable()) return inertTransport(handlers, { connections: new Map() });

  const peer = newPeer(peerIdForCode(code));
  const connections = new Map();  // connId -> DataConnection, open and usable
  const attached = new Set();     // every conn accepted, open or still opening
  const recovery = attachBrokerRecovery(peer, handlers);

  peer.on('open', () => { if (handlers.onOpen) handlers.onOpen(code); });

  peer.on('connection', (conn) => {
    // Counted over connections ACCEPTED rather than connections that finished
    // opening, or a flood of half-open ones would never be counted at all.
    if (attached.size >= MAX_HOST_CONNS) {
      try { conn.close(); } catch (_) {}
      return;
    }

    // A peer chooses its own id, so its length is its choice too. Anything that
    // would not survive validPlayerId() is refused before it can be written into
    // a seat, a log line or a snapshot.
    if (!validPlayerId(playerIdForConn(conn.peer))) {
      try { conn.close(); } catch (_) {}
      return;
    }

    attached.add(conn);

    // One bucket per connection, so a flood costs the flooder its own budget and
    // nobody else's. In front of the dispatch, not behind it: every accepted
    // message fans out into a push to the whole table, so a message admitted
    // here is multiplied by three before it leaves this phone.
    const bucket = new TokenBucket();
    let refused = 0;

    // See HANDSHAKE_BUDGET_MS. Cleared the moment the connection opens, so a
    // live connection is never touched by it.
    let reaper = setTimeout(() => {
      reaper = null;
      if (connections.has(conn.peer)) return;
      attached.delete(conn);
      try { conn.close(); } catch (_) {}
    }, HANDSHAKE_BUDGET_MS);

    const stopReaper = () => { if (reaper) { clearTimeout(reaper); reaper = null; } };

    conn.on('open', () => {
      stopReaper();
      // The same remote peer can open a second DataConnection without closing
      // the first. Overwriting the map entry would leak the old one — still
      // open, still counted, never closed — so it is retired explicitly.
      const previous = connections.get(conn.peer);
      if (previous && previous !== conn) { try { previous.close(); } catch (_) {} }
      connections.set(conn.peer, conn);
      if (handlers.onConnect) handlers.onConnect(playerIdForConn(conn.peer));
    });

    conn.on('data', (raw) => {
      const msg = decodePeerFrame(raw);
      // Junk is dropped in silence. Answering it would tell a prober that
      // somebody is listening, and cost a send for every frame they can
      // generate.
      if (!msg) return;
      if (!bucket.take()) {
        // A burst is normal — the last card of a trick and the first of the next
        // arrive a heartbeat apart. A client still going after the bucket is
        // empty is not playing.
        if (++refused > MAX_REFUSED_FRAMES) { try { conn.close(); } catch (_) {} }
        return;
      }
      if (handlers.onData) handlers.onData(playerIdForConn(conn.peer), msg);
    });

    const drop = () => {
      stopReaper();
      attached.delete(conn);
      // Only if THIS connection is the one currently seated. A stale connection
      // closing after a reconnect has already taken the seat must not fire a
      // disconnect against the seat that was just handed back.
      if (connections.get(conn.peer) === conn) {
        connections.delete(conn.peer);
        if (handlers.onDisconnect) handlers.onDisconnect(playerIdForConn(conn.peer));
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  peer.on('error', (err) => { if (handlers.onError) handlers.onError(err); });

  return {
    peer,
    connections,

    /** Player ids of everyone currently connected. Not seats — a connection can
     *  exist before addPlayer() has run, and a seat can outlive its connection. */
    playerIds() {
      return [...connections.keys()].map(playerIdForConn);
    },

    sendTo(playerId, msg) {
      const connId = connIdForPlayer(playerId);
      if (connId === null) return;   // the host itself, or a bot: nothing to send to
      const conn = connections.get(connId);
      if (conn && conn.open) trySend(conn, msg);
    },

    broadcast(msg) {
      for (const conn of connections.values()) {
        if (conn.open) trySend(conn, msg);
      }
    },

    /**
     * Push the table to every connected device: everything public, plus exactly
     * one private slice per device — theirs.
     *
     * The whole privacy model of the game is that this loop asks privateFor()
     * for the id of the peer it is about to send to, and sends the answer to
     * nobody else. See stateFrameFor() below, which is the part of it the test
     * harness holds to account.
     */
    pushState(pub, privateFor) {
      for (const [connId, conn] of connections) {
        if (!conn.open) continue;
        trySend(conn, stateFrameFor(connId, pub, privateFor));
      }
    },

    /** Forget and close one connection WITHOUT firing onDisconnect — it is
     *  removed from the map first, so the conn's own close handler sees that it
     *  is no longer the seated connection and short-circuits. Used when a
     *  reconnecting device takes over a seat held by a connection that has not
     *  noticed it is dead yet. */
    dropConnection(playerId) {
      const connId = connIdForPlayer(playerId);
      if (connId === null) return;
      const conn = connections.get(connId);
      connections.delete(connId);
      if (conn) { try { conn.close(); } catch (_) {} }
    },

    destroy() { recovery.cancel(); try { peer.destroy(); } catch (_) {} },
  };
}

/**
 * One device's state frame. Pure, and exported for exactly one reason: it is
 * where "never send a player another player's cards" is actually written down,
 * and an invariant that important should be executable rather than reviewed.
 *
 * `priv` is null for a connection with no seat yet — a device mid-join, or one
 * whose seat has gone. privateStateFor() already returns null there; this only
 * makes sure `undefined` never goes on the wire, because JSON.stringify drops
 * an undefined value and the field would silently vanish from the frame.
 */
export function stateFrameFor(connId, pub, privateFor) {
  const priv = privateFor(playerIdForConn(connId));
  return { type: 'state', pub, priv: priv || null };
}

// ---------------------------------------------------------------------------
// CLIENT side
// ---------------------------------------------------------------------------

/**
 * Dial the host at the address derived from `code`.
 *
 * handlers: onOpen(), onData(msg), onClose(), onError(err),
 *           onBrokerDown(), onBrokerUp(), onBrokerLost()
 *
 * NO TIMEOUT IN HERE, on purpose. A host that cannot be reached over WebRTC
 * produces no error at all (see the header), so somebody has to impose a
 * deadline — but what a missed deadline MEANS depends on whether there was a
 * game yet, and only js/main.js knows that. A first join that times out is an
 * error screen; a reconnect that times out keeps the table on screen and tries
 * again.
 */
export function joinHost(code, handlers = {}) {
  if (!peerAvailable()) return inertTransport(handlers);

  const peer = newPeer(null);
  const recovery = attachBrokerRecovery(peer, handlers);
  let conn = null;

  peer.on('open', () => {
    // 'open' fires again after every broker reconnect. Dialling a second time
    // would leave the host holding two connections for one player, so the first
    // dial wins and a later reconnect is treated as the no-op it is for us: the
    // DataConnection runs device to device and stopped needing the broker the
    // moment the handshake finished.
    if (conn) return;
    conn = peer.connect(peerIdForCode(code), { reliable: true });

    conn.on('open', () => { if (handlers.onOpen) handlers.onOpen(); });
    conn.on('data', (raw) => {
      // Bounded on the way in even though this is "our" host. The code was typed
      // by a human and resolves to whoever holds that id on a public broker, so
      // the thing on the other end is not necessarily the table we meant to
      // join, and a client that trusts its host is one bad code away from
      // parsing a stranger's payload.
      const msg = decodePeerFrame(raw);
      if (msg && handlers.onData) handlers.onData(msg);
    });
    conn.on('close', () => { if (handlers.onClose) handlers.onClose(); });
    conn.on('error', (err) => { if (handlers.onError) handlers.onError(err); });
  });

  // A peer-level error before the connection opens almost always means the room
  // code is wrong ('peer-unavailable') or the broker is unreachable.
  peer.on('error', (err) => { if (handlers.onError) handlers.onError(err); });

  return {
    peer,
    send(msg) { if (conn && conn.open) trySend(conn, msg); },
    isOpen() { return !!(conn && conn.open); },
    destroy() { recovery.cancel(); try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// Wire helper. JSON text in both directions — see the note on decodePeerFrame in
// js/guards.js for why the receiving side still has to cope with an object.
// ---------------------------------------------------------------------------
function trySend(conn, msg) {
  try { conn.send(JSON.stringify(msg)); } catch (_) { /* torn down mid-send */ }
}

// ---------------------------------------------------------------------------
// The common PeerJS failures, in words a player can act on.
//
// Every one of these is read aloud off a phone by somebody who wants to be
// playing cards, so each says what to DO. "Network error" says nothing; "check
// the code, and that the host still has the tab open" is two things to try.
// ---------------------------------------------------------------------------
export function describePeerError(err) {
  switch (err && err.type) {
    case 'peer-unavailable':
      return 'No table found with that code. Check the four characters, and that the host still has the game open.';
    case 'unavailable-id':
      return 'That room code is already in use. Go back and host again for a new one.';
    case 'peer-missing':
      return 'The connection library did not load. This first load needs the internet — check your signal, then reload.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the connection server. Check your internet or Wi-Fi and try again.';
    case 'browser-incompatible':
      return 'This browser does not support the WebRTC features the game needs.';
    case 'webrtc':
      return 'The direct connection failed. A guest or corporate Wi-Fi network often blocks this — try mobile data.';
    default:
      return 'Connection problem: ' + ((err && err.message) || 'unknown error') + '.';
  }
}
