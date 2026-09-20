// ============================================================================
// main.js — Boot, app state, and the one place the engine is driven from.
//
// WHAT LIVES HERE AND NOWHERE ELSE
//   * `app`, the view model. js/ui.js reads it and never writes to it.
//   * `intents`, the callbacks ui.js is handed. Every one of them is a few
//     lines that either edits `app` (local, cosmetic) or hands a message to
//     applyGameIntent (a change to the game).
//   * `isHost` — "this tab runs the engine". Deliberately not in js/state.js:
//     it is a fact about the RUNTIME, not about the game. The game's own
//     question, "who holds the controls", is `ownerId` and lives in the engine.
//     Keeping them apart from the first commit is what stops the rework that
//     conflating them caused in sequence.
//   * The interval. The engine takes `now` as a parameter and never reads a
//     clock (see the note at the top of state.js), so something outside it has
//     to say what time it is. This is that something.
//
// THE TWO ROLES THIS FILE PLAYS
//   Hosting and joining are not two apps, and the difference between them is
//   smaller than it looks: exactly one function, sendIntent(), branches on it.
//   A host applies its own taps to the engine in its own memory; a client puts
//   the identical object on the wire and the host applies it there. Everything
//   downstream — js/intents.js, js/state.js, js/ui.js — cannot tell which
//   happened, and that is the property that keeps the two from drifting.
//
//   A table with no other humans in it is a host with no connections. It is a
//   real configuration rather than a degraded one: four seats, three bots, full
//   rules, and it is how most people will meet this game.
// ============================================================================

import { render, playableSelection } from './ui.js';
import { GameEngine, PHASES } from './state.js';
import { applyGameIntent } from './intents.js';
import { createBotDriver } from './bot.js';
import {
  createHost, joinHost, peerAvailable,
  isFatalPeerError, describePeerError,
  CONN_ID_PREFIX,
} from './net.js';
import {
  validClientId, validName, validPublicState, validPrivateState,
} from './guards.js';
import {
  generateRoomCode, normalizeCode, copyText, CODE_LENGTH,
  loadName, saveName, saveCode, clientId,
  saveSession, loadSession, clearSession,
  saveEngineSnapshot, loadEngineSnapshot,
} from './util.js';

const root = document.getElementById('app');

/**
 * The id the engine knows this device by while it is hosting.
 *
 * NOT the clientId, and that is a security property rather than a style
 * choice. Player ids go out in publicState().seats[].id, so anything used as
 * an id is published to the whole table — and the clientId is the secret a
 * seat is bound to (see js/util.js). Using it here would broadcast the one
 * credential in the app to every peer in the room, including a hostile one.
 * The clientId is passed separately to addPlayer(), which keeps it host-side.
 *
 * A constant is enough for a host: there is exactly one of them per table.
 * Clients are known by their connection ids, prefixed — see below.
 */
const HOST_ID = 'host';

// This is the assertion that keeps HOST_ID honest, and it is load-bearing.
//
// A joiner picks its own peer id, so without the prefixing in js/net.js a peer
// could register itself as 'host', arrive as engine.ownerId, and play out of
// the host's hand. net.js guarantees every id it hands over starts with
// CONN_ID_PREFIX; this guarantees the host's own id does not, which is the
// other half of the same promise.
//
// A throw at module load looks drastic for a comparison between two constants —
// but it can only fire if somebody edits one of them, and the alternative is a
// silent authentication hole. Same reasoning as the owner-intent check in
// js/intents.js.
if (HOST_ID.startsWith(CONN_ID_PREFIX)) {
  throw new Error(`main.js: HOST_ID '${HOST_ID}' collides with the peer id space '${CONN_ID_PREFIX}'`);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The authoritative engine — only ever non-null in a tab that is hosting. */
let engine = null;

/** The transport. A createHost() handle when hosting, a joinHost() handle when
 *  joining, null on the home screen. The two share enough of an interface that
 *  only teardown and sendIntent ever care which it is. */
let net = null;

/** Whether the broker ever gave us our room code. Until it does, a peer error
 *  means "this table never came up" rather than "the table lost its lobby",
 *  and those deserve completely different screens. */
let hostReady = false;

const app = {
  screen: 'home',           // home | join | connecting | error | hostleft | game
  me: { id: null, name: '', isHost: false },
  code: '',

  pub: null,                // publicState() — what every device may see
  priv: null,               // privateStateFor(me.id) — this device's own cards

  error: null,
  notice: null,
  reconnecting: false,

  // Trouble with the signalling broker, which is NOT trouble with the game —
  // the data connections run device to device and survive it. A banner, never
  // a screen. See hostHandlers().
  netWarning: '',

  // Purely local view state. Never sent anywhere, never survives a reload, and
  // deliberately grouped so it is obvious at a glance which parts of `app` are
  // the game and which parts are just this screen.
  ui: {
    selectedCard: null,     // tapped, not yet confirmed
    lastTrickOpen: false,
    swapFrom: null,         // first seat of a two-tap seat swap
  },

  showHelp: false,
  copied: false,
  nameDraft: loadName(),
  codeDraft: '',
};

// One driver for this tab, built once. It keys its thinking pause off the
// engine's own turn rather than off a timer it owns, so it re-synchronises
// itself after a host reload without being told anything.
const bots = createBotDriver();

// ---------------------------------------------------------------------------
// The host's clock
//
// 250ms rather than a second. Both jobs this drives have targets around a
// second — DEAL_PAUSE_MS and the bot's thinking time — and polling four times
// as often costs nothing measurable while removing up to a second of slop from
// every phase change. It is not an animation frame loop: nothing here paints.
// ---------------------------------------------------------------------------
const HOST_TICK_MS = 250;
let hostTimer = null;

/** Phases where something advances on its own. Everything else is waiting on a
 *  person to press something, and a timer running through those would be four
 *  wake-ups a second to discover that nothing has happened. */
const LIVE_PHASES = new Set([
  PHASES.DEAL_FIVE, PHASES.DECLARE_TRUMP, PHASES.DEAL_REST, PHASES.PLAY,
]);

function syncHostTick() {
  const wanted = !!(engine && app.me.isHost && LIVE_PHASES.has(engine.phase));
  if (wanted === (hostTimer !== null)) return;
  if (!wanted) { clearInterval(hostTimer); hostTimer = null; return; }

  hostTimer = setInterval(() => {
    // The engine can disappear between ticks — endMatch, a return to the home
    // screen — so a tick is never trusted to still be relevant.
    if (!engine) { syncHostTick(); return; }
    const now = Date.now();
    // Phases first, bots second, and in that order on purpose: DEAL_REST has
    // to become PLAY before the bot holding the lead can be offered its turn,
    // or the driver looks at a phase with no current player and does nothing
    // for a whole tick.
    let changed = engine.tick(now);
    if (bots.tick(engine, now)) changed = true;
    if (changed) hostSync();
  }, HOST_TICK_MS);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Re-read the engine, persist it, push it to everyone, redraw.
 *
 * The single funnel every change on the host goes through, which is why it is
 * one function rather than four lines copied into each intent. Miss it once and
 * three phones quietly stop updating while this one looks fine.
 */
function hostSync() {
  if (!engine) { draw(); return; }
  app.pub = engine.publicState();
  app.priv = engine.privateStateFor(app.me.id);
  // The host's own device holds the only copy of the hands and the hidden
  // trump that exists. Written to localStorage, never to the wire.
  saveEngineSnapshot(engine.serialize());
  saveSession({ role: 'host', code: app.code, name: app.me.name });

  // Everything public, plus exactly one private slice per device — theirs.
  // net.js owns that loop, and stateFrameFor() is where the rule is written
  // down and tested. `app.pub` is passed rather than rebuilt per peer so all
  // four devices are looking at one object and cannot disagree.
  if (net && net.pushState) net.pushState(app.pub, (id) => engine.privateStateFor(id));

  syncHostTick();
  draw();
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

let lastView = null;
let lastSituation = null;

/** What screen we are looking at, for the purpose of "is this the same view?".
 *  A phase change is a new view; a card landing is not. */
function viewKey() {
  return `${app.screen}:${app.pub ? app.pub.phase : '-'}`;
}

/** What is happening, for the purpose of "is that error still about now?".
 *  Finer than viewKey: a refusal stops being relevant the moment the table
 *  moves on, even if the phase has not changed. */
function situationKey() {
  const p = app.pub;
  return p ? `${p.phase}:${p.turnSeat}:${p.trickNumber}:${p.trick.length}:${p.log.length}` : '-';
}

function draw() {
  // Forget a selection the moment it stops being a move — see
  // playableSelection() in js/ui.js for the two ways that happens and why the
  // rule is not allowed to differ between here and the renderer.
  //
  // The renderer already refuses to draw it, so this is belt and braces. It
  // earns its place by keeping the STATE honest as well as the pixels: without
  // it a card refused this trick stays selected, and silently re-arms itself
  // the moment a later trick makes it legal again.
  //
  // Note this clears after a successful play too, because the card has left the
  // hand. A play refused for any other reason keeps its selection, so the
  // player can read the message and tap confirm again rather than start over.
  if (app.ui.selectedCard) {
    app.ui.selectedCard = playableSelection(app.ui.selectedCard, app.priv);
  }

  const situation = situationKey();
  if (situation !== lastSituation) {
    lastSituation = situation;
    // An error explains a refusal that has just been overtaken by events.
    // Leaving it up would make the last person's mistake look like the current
    // player's problem.
    if (app.errorAt !== situation) app.error = null;
  }

  const view = viewKey();
  const sameView = view === lastView;
  lastView = view;
  if (!sameView) {
    // Nothing armed survives a screen change: the button that armed it is
    // gone, so there would be no way to see or cancel the state it left.
    app.ui.swapFrom = null;
    app.ui.lastTrickOpen = false;
    app.showHelp = app.screen === 'home' ? app.showHelp : false;
  }

  // Focus and caret survive a full rebuild. This matters most somewhere dull:
  // a state broadcast can redraw the page between two letters of somebody's
  // name, and without this every fourth character would go missing.
  const active = document.activeElement;
  const focusKey = active && active.getAttribute ? active.getAttribute('data-focus') : null;
  let selStart = null, selEnd = null;
  if (focusKey) { try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {} }

  const scrolls = new Map();
  for (const node of root.querySelectorAll('[data-keep-scroll]')) {
    scrolls.set(node.getAttribute('data-keep-scroll'), [node.scrollLeft, node.scrollTop]);
  }
  const pageY = window.scrollY;

  // Fade the shell in on a real screen change, and never on a state update —
  // without this the whole table strobed every time anybody played a card.
  root.classList.toggle('rerender', sameView);
  render(root, app, intents);

  if (focusKey) {
    const next = root.querySelector(`[data-focus="${cssEscape(focusKey)}"]`);
    if (next) {
      // preventScroll because the scroll position is restored just below, and
      // the browser's own scroll-into-view would fight it.
      next.focus({ preventScroll: true });
      if (selStart != null) { try { next.setSelectionRange(selStart, selEnd); } catch (_) {} }
    }
  }
  for (const node of root.querySelectorAll('[data-keep-scroll]')) {
    const saved = scrolls.get(node.getAttribute('data-keep-scroll'));
    if (saved) { node.scrollLeft = saved[0]; node.scrollTop = saved[1]; }
  }
  if (sameView) { if (pageY) window.scrollTo(0, pageY); }
  else window.scrollTo(0, 0);
}

/** CSS.escape with a fallback, because the focus keys include card codes and a
 *  selector built by concatenation is a small injection waiting for the day
 *  somebody adds a key with a quote in it. */
function cssEscape(s) {
  return (window.CSS && window.CSS.escape) ? window.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Sending a game message
// ---------------------------------------------------------------------------

/**
 * Hand one intent to whoever is authoritative.
 *
 * THE ONLY PLACE IN THE APP THAT BRANCHES ON HOST-VERSUS-CLIENT. A host applies
 * the message to the engine in its own memory; everybody else puts the same
 * object on the wire and the host applies it there. The object is identical
 * either way, which is the entire reason js/intents.js exists — two
 * authoritative implementations of "what does this message mean" would drift,
 * and the bug would surface as two devices disagreeing about a trick.
 *
 * Note that the owner's lobby controls travel this path like anything else.
 * Being the owner is not the same as running the engine (see the header), so an
 * owner sitting on a client sends `startMatch` over the wire and the host
 * checks `ownerId` on arrival, exactly as it would for a stranger.
 */
function send(msg) {
  // The refusal on screen was about the previous tap. Clearing it as the next
  // one goes out stops an old "must follow hearts" from looking like an answer
  // to the card just pressed — on a client that gap is a network round trip
  // wide, which is long enough to read.
  app.error = null;
  app.errorAt = null;

  if (app.me.isHost) { handleIntent(app.me.id, msg); return; }
  if (net) net.send(msg);
  draw();
}

// ---------------------------------------------------------------------------
// HOST: everything that arrives from a device, including this one
// ---------------------------------------------------------------------------

/**
 * Deliver a refusal to ONE player, whoever they are.
 *
 * Refusals are private on purpose: a renege attempt is between the host and the
 * person who tried it, and broadcasting "Rehan cannot play that" would leak
 * that Rehan holds a heart to the whole table.
 *
 * The host's own id resolves to no connection — there is no socket to itself —
 * so it is handled first rather than routed through sendTo(), which would drop
 * the message in silence and leave the host tapping a button that does nothing.
 */
function rejectTo(playerId, message) {
  if (playerId === app.me.id) {
    app.error = message || null;
    // Stamped with the situation it refers to, so draw() can tell "still
    // relevant" from "the table has moved on" without a timer.
    app.errorAt = situationKey();
    return;
  }
  if (net) net.sendTo(playerId, { type: 'error', message: message || '' });
}

/**
 * The outermost catch on the host.
 *
 * Everything below has come off the wire from a device we do not control. The
 * engine refuses illegal moves and js/guards.js bounds malformed ones, but
 * neither promises that no input anywhere can throw — and a throw here escapes
 * into PeerJS's data callback, which takes down the host tab, and with it the
 * only copy of the game that exists. One player's malformed message must never
 * be able to end three other people's match.
 */
function handleIntent(playerId, msg) {
  try {
    dispatchIntent(playerId, msg);
  } catch (err) {
    console.warn('[host] dropped an unprocessable message from', playerId, err);
  }
}

function dispatchIntent(playerId, msg) {
  if (!engine || !msg || typeof msg.type !== 'string') return;

  // Identity and the connection lifecycle are this transport's business — a
  // peer id is not a seat — so they are handled here rather than in the shared
  // dispatcher, which deliberately knows nothing about who is connected.
  if (msg.type === 'join') {
    const name = validName(msg.name);
    if (name === null) {
      if (net) net.sendTo(playerId, { type: 'rejected', message: 'Enter a name first.' });
      return;
    }
    // A malformed clientId is dropped rather than refused. It costs the sender
    // its claim on the seat if it ever drops, which is the sender's problem,
    // and a device with storage switched off still gets to play.
    const r = engine.addPlayer(playerId, name, { clientId: validClientId(msg.clientId) });
    if (!r.ok) {
      if (net) net.sendTo(playerId, { type: 'rejected', message: r.error });
      return;
    }
    // A reconnect has just reclaimed a seat under a NEW connection id. The old
    // connection may not have noticed it is dead; retiring it here stops it
    // firing a disconnect later against the seat we just handed back — which
    // would mark the returning player offline moments after they returned.
    if (r.reconnected && r.prevId && r.prevId !== playerId) net.dropConnection(r.prevId);
    if (net) net.sendTo(playerId, { type: 'welcome', playerId });
    hostSync();
    return;
  }

  // Everything else is a game intent and goes through the one dispatcher, which
  // is also where the owner guard lives. Note the actor is `playerId` and never
  // anything the message claims about itself: a client says what it wants done,
  // never who is asking.
  const { handled, result } = applyGameIntent(engine, playerId, msg, Date.now());
  if (!handled) return;
  if (!result.ok) rejectTo(playerId, result.error);
  hostSync();
}

// ---------------------------------------------------------------------------
// Intents — the whole surface ui.js is allowed to touch
// ---------------------------------------------------------------------------

const intents = {
  // --- Home ---------------------------------------------------------------
  setName(value) {
    app.nameDraft = value;
    saveName(value.trim());
    draw();
  },

  setCode(value) {
    app.codeDraft = normalizeCode(value);
    draw();
  },

  toggleHelp() { app.showHelp = !app.showHelp; draw(); },

  goHome() {
    leaveGame();
    app.screen = 'home';
    app.error = null;
    app.notice = null;
    draw();
  },

  goJoin() {
    app.screen = 'join';
    app.error = null;
    draw();
  },

  host() {
    const name = app.nameDraft.trim();
    if (!name) return;
    startHosting(name, generateRoomCode());
  },

  join(code) {
    startJoining(code, app.nameDraft.trim());
  },

  cancelJoin() { intents.goHome(); },

  async copyCode() {
    const done = await copyText(app.code);
    app.copied = done;
    draw();
    if (done) setTimeout(() => { app.copied = false; draw(); }, 1600);
  },

  // --- Lobby --------------------------------------------------------------
  setConfig(patch) { send({ type: 'setConfig', config: patch }); },
  addBot(seat)     { send({ type: 'addBot', seat }); },
  removeBot(seat)  { send({ type: 'removeBot', seat }); },

  /** Two taps: arm a seat, then say where it goes. A drag would be nicer and
   *  is not reachable by keyboard or by a screen reader, which rules it out
   *  for the only control that decides who partners whom. */
  swapSeat(seat) {
    const from = app.ui.swapFrom;
    if (from === null) { app.ui.swapFrom = seat; draw(); return; }
    app.ui.swapFrom = null;
    if (from === seat) { draw(); return; }
    send({ type: 'swapSeats', a: from, b: seat });
  },

  startMatch() { send({ type: 'startMatch' }); },

  // --- Play ---------------------------------------------------------------
  declareTrump(suit) { send({ type: 'declareTrump', suit }); },

  /** Tapping a card selects it. Nothing leaves the hand until confirm — Court
   *  Piece is unforgiving about a mis-tap and the cards are 42px wide. */
  selectCard(code) {
    app.ui.selectedCard = app.ui.selectedCard === code ? null : code;
    draw();
  },

  clearSelection() { app.ui.selectedCard = null; draw(); },

  playCard(code) { send({ type: 'playCard', code }); },

  toggleLastTrick() { app.ui.lastTrickOpen = !app.ui.lastTrickOpen; draw(); },

  // --- Match flow ---------------------------------------------------------
  nextDeal()  { send({ type: 'nextDeal' }); },
  newMatch()  { send({ type: 'newMatch' }); },
  endMatch()  { send({ type: 'endMatch' }); },
};

// ---------------------------------------------------------------------------
// Hosting
// ---------------------------------------------------------------------------

/**
 * What the transport tells the host, and what the host does about it.
 *
 * The judgement running through all of it: A BROKER FAILURE IS NOT A GAME
 * FAILURE. The signalling broker is needed once per connection, to carry the
 * WebRTC handshake; after that the data channels run device to device and do
 * not care whether it is still there. So a broker that falls over mid-deal
 * costs the table exactly one thing — nobody NEW can join — and tearing a live
 * match down over it would throw away a game that is working.
 *
 * Hence the split: a banner for anything the game survives, the error screen
 * only for something genuinely unrecoverable, or for a failure that arrived
 * before the table ever came up at all.
 */
function hostHandlers() {
  const warn = (text) => { app.netWarning = text; draw(); };

  return {
    onOpen: () => { hostReady = true; draw(); },

    // Nothing is sent on connect. The client speaks first, with `join`, and
    // until it has there is no seat and so nothing that is theirs to see.
    onConnect: () => {},

    onData: (playerId, msg) => handleIntent(playerId, msg),

    onDisconnect: (playerId) => {
      if (!engine) return;
      // The seat is KEPT mid-deal — it is theirs to reclaim, and emptying it
      // would end the deal for the other three. A bot covers the turns in the
      // meantime, after a grace period; see OFFLINE_GRACE_MS in js/bot.js.
      engine.disconnect(playerId);
      hostSync();
    },

    onBrokerDown: () => warn('Lost the connection server — trying again. Everyone already at the table is unaffected.'),
    onBrokerUp:   () => { if (app.netWarning) { app.netWarning = ''; draw(); } },
    onBrokerLost: () => warn(`Cannot reach the connection server, so nobody new can join with code ${app.code}. The match itself carries on.`),

    onError: (err) => {
      // Before the room code exists there is no table to protect, so any error
      // is the end of this attempt. After it, only an unrecoverable one is.
      if (isFatalPeerError(err) || !hostReady) {
        teardownNet();
        app.screen = 'error';
        app.error = describePeerError(err);
        draw();
        return;
      }
      warn(describePeerError(err));
    },
  };
}

function startHosting(name, code) {
  teardownNet();
  clearReconnect();

  engine = new GameEngine();
  app.me = { id: HOST_ID, name, isHost: true };
  app.code = code;
  app.screen = 'game';
  app.error = null;
  saveCode(code);

  // The clientId goes in as a SEPARATE argument, never as the id. It stays on
  // this device and in the host's own memory; see the note on HOST_ID above.
  const res = engine.addPlayer(HOST_ID, name, { clientId: clientId(), isOwner: true });
  if (!res.ok) { app.error = res.error; }

  hostReady = false;
  net = createHost(code, hostHandlers());
  hostSync();
}

/**
 * Pick a hosted match back up after the host's tab reloaded.
 *
 * This is not a nicety. In peer-to-peer the host's device holds the only copy
 * of the hands and the trump that exists anywhere, so a reload without this is
 * not a hiccup — it is the end of the match for all four players. The snapshot
 * is written on every sync for exactly this moment.
 *
 * The room code is reused, which is what makes it invisible to everyone else:
 * the host's peer id is derived from the code, so the other three reconnect to
 * the same address on their own, reclaim their seats with their clientIds, and
 * see a few seconds of "Reconnecting…" rather than a dead table.
 */
function resumeHosting(session, snap) {
  engine = new GameEngine();
  engine.restore(snap);
  // Clears the stale `online` flags left pointing at connections the reload
  // destroyed. Without it every genuine rejoin looks like an impostor.
  engine.resumeAsOwner(HOST_ID);

  app.me = { id: HOST_ID, name: session.name || loadName(), isHost: true };
  app.code = session.code || '';
  app.screen = 'game';

  hostReady = false;
  net = createHost(app.code, hostHandlers());
  hostSync();
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

/**
 * How long a first join may take before we admit it is not happening.
 *
 * Generous on purpose, and the standing rule about never setting tight network
 * timeouts is only half the reason. The other half is that this deadline is
 * almost never the thing that reports a wrong code: a code nobody is hosting
 * comes back from the broker as `peer-unavailable` in a second or two, with a
 * far better message than a timeout could give. What is left for the deadline
 * to catch is the case with no error at all — the broker says the host exists
 * and the data channel never comes up, which is what a guest Wi-Fi or a
 * symmetric NAT with the relay blocked looks like from in here.
 *
 * So the timeout is only ever reached by a table that EXISTS and cannot be
 * reached, and being patient about that costs nothing.
 *
 * FORTY-FIVE SECONDS, raised from twenty after watching it. A real join on a
 * machine with two other data channels already open took somewhere between
 * fifteen and thirty seconds to bring the channel up — no error, no warning,
 * just ICE grinding through candidates before one worked. Twenty would have
 * killed a connection that was going to succeed, which is the exact failure
 * the standing rule about tight timeouts is there to prevent, and the worst
 * possible one: it tells the player their friend's table does not exist.
 *
 * It can afford to be this generous because the deadline is NOT the only way
 * out. The connecting screen carries a CANCEL button the whole time (see
 * render() in js/ui.js), so an impatient player never waits on this at all —
 * which makes the number a backstop for somebody who walked away, not the
 * mechanism anyone actually uses.
 */
const JOIN_BUDGET_MS = 45000;
let joinTimer = null;

function clearJoinTimer() {
  if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
}

function startJoining(rawCode, rawName, { reconnect = false } = {}) {
  const name = (rawName || '').trim();
  const code = normalizeCode(rawCode);
  if (!name) { app.screen = 'home'; app.error = 'Enter a name first.'; draw(); return; }
  if (code.length !== CODE_LENGTH) {
    app.screen = 'join';
    app.error = `Enter the full ${CODE_LENGTH}-character code.`;
    draw();
    return;
  }

  teardownNet();
  if (!reconnect) clearReconnect();

  app.me = { id: null, name, isHost: false };
  app.code = code;
  app.error = null;
  app.netWarning = '';
  saveName(name);
  saveCode(code);

  // On a retry, keep the table on screen behind the reconnecting banner.
  // Dropping to a spinner mid-deal loses the player their place — they can no
  // longer see what has been played, and the reconnect usually succeeds.
  if (!reconnect || !app.pub) { app.screen = 'connecting'; app.pub = null; app.priv = null; }
  draw();

  saveSession({ role: 'join', code, name });

  // The deadline guards the FIRST join only. A reconnect has its own bounded
  // ladder and keeps the table visible, so there is nothing to rescue from.
  clearJoinTimer();
  if (!reconnect) {
    joinTimer = setTimeout(() => {
      joinTimer = null;
      if (app.pub) return;
      giveUpJoining('Could not reach that table. Check the code, and that the host still has the game open.');
    }, JOIN_BUDGET_MS);
  }

  net = joinHost(code, {
    // The clientId is what gets THIS DEVICE — and only this device — its seat
    // and its hand back mid-deal. It goes no further than the machine running
    // the game; see the note on it in js/util.js.
    onOpen: () => net.send({ type: 'join', name, clientId: clientId() }),

    onData: (msg) => handleHostMessage(msg),

    // app.pub is only ever set by a state frame, so it means "we were really in
    // a game" — the case worth retrying rather than abandoning.
    onClose: () => {
      if (app.pub) { scheduleReconnect(); return; }
      giveUpJoining('The host closed the connection.');
    },

    onError: (err) => {
      if (app.pub) {
        // Mid-game the broker is irrelevant to us: the link to the host is
        // direct and does not depend on it.
        if (isFatalPeerError(err)) { giveUpJoining(describePeerError(err)); return; }
        scheduleReconnect();
        return;
      }
      if (!net || !net.isOpen()) giveUpJoining(describePeerError(err));
    },

    onBrokerDown: () => {},
    onBrokerUp:   () => {},
    onBrokerLost: () => {},
  });
}

/**
 * Everything a client accepts from the far end of its connection.
 *
 * "Its host" is a hopeful phrase. A room code is four characters on a public
 * broker, so one mistyped character reaches a stranger's table — or a stranger
 * — and this function is where that payload lands. The engine is not here to
 * referee it and could not be; what is here is a shape check, so a malformed
 * frame is dropped instead of thrown out of the renderer as a blank page.
 * See the note above validPublicState() in js/guards.js.
 */
function handleHostMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      // The id the host will know us by from now on. Only meaningful to us —
      // every seat in publicState() carries one, and ui.js compares against it
      // to find which seat is ours.
      if (typeof msg.playerId === 'string') app.me.id = msg.playerId;
      return;

    case 'state': {
      const pub = validPublicState(msg.pub);
      if (!pub) return;
      // A device that has connected but holds no seat legitimately has no
      // private state, so null passes; anything that is neither null nor a
      // usable hand is a malformed frame and the whole thing is dropped.
      const priv = msg.priv == null ? null : validPrivateState(msg.priv);
      if (msg.priv != null && !priv) return;

      clearJoinTimer();
      clearReconnect();
      app.pub = pub;
      app.priv = priv;
      app.screen = 'game';
      draw();
      return;
    }

    case 'rejected':
      // A refusal to seat us at all — the table is full, or somebody is already
      // using that name. Not worth retrying, and the session is cleared so a
      // reload does not walk straight back into it.
      clearReconnect();
      clearSession();
      teardownNet();
      app.screen = 'join';
      app.error = typeof msg.message === 'string' ? msg.message : 'The host refused the connection.';
      draw();
      return;

    case 'error':
      // A refused MOVE, which is a completely different thing from a refused
      // join: we are still at the table.
      app.error = typeof msg.message === 'string' && msg.message ? msg.message : null;
      app.errorAt = situationKey();
      draw();
      return;

    case 'closed':
      // The host left deliberately. Said out loud so the other three get an
      // answer now instead of half a minute of a reconnect ladder that was
      // never going to find anybody.
      clearReconnect();
      clearSession();
      teardownNet();
      app.screen = 'hostleft';
      draw();
      return;

    default:
      return;
  }
}

/** Abandon a join and say why. Kills the retry ladder too, so a failure the
 *  player is reading about on the error screen is not quietly being retried
 *  underneath it. */
function giveUpJoining(message) {
  clearReconnect();
  teardownNet();
  app.screen = 'error';
  app.error = message;
  draw();
}

// ---------------------------------------------------------------------------
// CLIENT: getting back in after the connection drops
//
// The host's peer id is derived from the room code, so a host that reloads or
// blips off Wi-Fi comes back at the SAME address. Rejoining is therefore just
// joining again, and the clientId is what turns that into reclaiming the seat
// and the hand rather than taking a new one.
//
// Six tries at 1, 2, 4, 8, 8, 8 seconds is a little over half a minute. That is
// well past the ten-second budget this project uses for declaring one attempt
// dead, which is the point: a host reloading their tab is offline for a couple
// of seconds, a host walking between rooms for rather longer, and neither
// should cost three other people their match.
// ---------------------------------------------------------------------------
const RECONNECT_TRIES = 6;
let reconnectTimer = null;
let reconnectTries = 0;

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectTries >= RECONNECT_TRIES) {
    clearReconnect();
    teardownNet();
    app.screen = 'hostleft';
    draw();
    return;
  }
  const delay = Math.min(1000 * 2 ** reconnectTries, 8000);
  reconnectTries += 1;
  app.reconnecting = true;
  draw();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startJoining(app.code, app.me.name, { reconnect: true });
  }, delay);
}

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectTries = 0;
  app.reconnecting = false;
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

/** Drop the transport and everything hanging off it, without touching the
 *  engine or the view. Every caller is either leaving or about to reconnect. */
function teardownNet() {
  clearJoinTimer();
  if (hostTimer) { clearInterval(hostTimer); hostTimer = null; }
  // Not mid-pause on anybody's turn any more. Without this, hosting a second
  // table in the same tab inherits a stale "waiting since" from the first.
  bots.reset();
  try { if (net) net.destroy(); } catch (_) {}
  net = null;
  hostReady = false;
  app.netWarning = '';
}

/** Leave the table for the home screen, whichever end of it we were on. */
function leaveGame() {
  // Said before the transport goes, and only by the host: the other three are
  // owed an answer rather than half a minute of a reconnect ladder chasing a
  // tab that has closed. Best effort — if it does not arrive, the ladder does
  // the same job more slowly.
  if (net && app.me.isHost) { try { net.broadcast({ type: 'closed' }); } catch (_) {} }

  teardownNet();
  clearReconnect();
  engine = null;
  app.pub = null;
  app.priv = null;
  app.me = { id: null, name: app.me.name, isHost: false };
  app.ui.selectedCard = null;
  app.ui.lastTrickOpen = false;
  app.ui.swapFrom = null;
  clearSession();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Walk back into whatever was happening before the tab closed.
 *
 * Both roles resume, and they resume differently. A host rehydrates the engine
 * from its own snapshot, because its device holds the only copy in existence. A
 * client rehydrates nothing at all — the game never left the host — and simply
 * dials the same code again, where its clientId gets the seat back.
 */
function resumeSession() {
  const session = loadSession();
  if (!session || !session.code) return false;

  if (session.role === 'host') {
    const snap = loadEngineSnapshot();
    if (!snap) return false;
    resumeHosting(session, snap);
    return true;
  }

  if (session.role === 'join' && session.name) {
    startJoining(session.code, session.name);
    return true;
  }

  return false;
}

function boot() {
  // Said once, on the home screen, before anybody presses anything. The tag in
  // index.html is the only part of this app that can fail to load while the
  // rest works, and finding out at the moment you press HOST is worse than
  // being told while you are typing your name.
  if (!peerAvailable()) {
    app.netWarning = 'The connection library did not load, so this device cannot reach other phones. '
      + 'A table here will be you and three bots. Reload with a signal to play with people.';
  }

  if (!resumeSession()) draw();

  // Coming back to the foreground.
  //
  // Two different catch-ups, because a backgrounded tab on a phone loses two
  // different things. A HOST loses its interval, which stalls the bots for
  // everybody, and nothing can be done about that from in here — a
  // backgrounded tab is not allowed to run — but returning should catch up at
  // once rather than wait out the interval. A CLIENT loses its data channel,
  // and the close event that would normally start the reconnect ladder may
  // have been delivered to a tab that was not running to hear it, so a
  // connection that is quietly dead is checked for by hand.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    if (engine && app.me.isHost) {
      const now = Date.now();
      let changed = engine.tick(now);
      if (bots.tick(engine, now)) changed = true;
      if (changed) hostSync();
      return;
    }

    if (app.screen === 'game' && app.pub && net && !net.isOpen()) scheduleReconnect();
  });
}

/**
 * The offline shell. Relative path, like everything else in this app, so it
 * resolves under a GitHub Pages subpath instead of at the domain root.
 *
 * Registered on `load` rather than straight away, so that fetching sw.js and
 * then precaching twenty files competes with nothing while the first screen is
 * still being painted. Nobody is offline on their first visit — they are
 * looking at the page — so there is no hurry whatsoever.
 *
 * The rejection is swallowed deliberately, and not surfaced anywhere. A worker
 * is refused outright on an insecure origin, in a private window in some
 * browsers, and wherever the user has turned site storage off. In every one of
 * those cases the app works completely; it just starts from the network each
 * time. Telling a player about that would be reporting a problem they do not
 * have, on the one screen where app.netWarning already means something real.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

boot();
