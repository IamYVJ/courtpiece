// ============================================================================
// ui.js — All rendering, and nothing else.
//
//   render(root, app, intents)
//
// A PURE VIEW LAYER. It is handed state and callbacks and it builds DOM. It
// never touches the engine, the network or localStorage, and it holds no state
// of its own between calls — everything it needs to remember (which card is
// selected, whether the last trick is open) lives in `app` and is owned by
// js/main.js. That is what makes the whole screen safe to throw away and
// rebuild on every draw, which is exactly what clear(root) below does.
//
//   app     : { screen, me, code, pub, priv, error, ui:{…}, … }  see main.js
//   intents : plain callbacks, one per thing a person can ask for
//
// WHAT THIS FILE IS NOT ALLOWED TO DECIDE
//   Whether a card may be played. `priv.hand[].legal` arrives from the engine,
//   computed with the same canPlay() that refuses an illegal move, so the
//   greyed-out card and the refused move can never disagree. This file greys
//   things out; it does not adjudicate. (See the note on .hand-card.illegal in
//   css/styles.css, and playCard() in js/state.js, which is the real gate.)
//
// NODE-SAFE AT IMPORT TIME. Nothing here touches `document` until a function
// is called, so scripts/test-engine.mjs can import seatPositions() below and
// pin the screen geometry without a DOM. That is not an accident — the
// anticlockwise layout is the single most breakable thing in the app.
// ============================================================================

import { el, clear, announce, CODE_LENGTH } from './util.js';
import {
  SUITS, SEAT_COUNT, MAX_NAME_LEN, TRICKS_TO_WIN,
  MATCH_TARGET_OPTIONS, DEAL_TARGET_OPTIONS,
  rankLabel, suitGlyph, suitName, cardName, isRedCard, isRedSuit, suitOf,
} from './rules.js';
import { PHASES } from './state.js';
import { teamOf, trickWinner, winningCard } from './trick.js';

// ---------------------------------------------------------------------------
// Screen geometry
//
// THE OTHER HALF OF THE ANTICLOCKWISE RULE. js/trick.js owns the arithmetic —
// seats are numbered CLOCKWISE and nextSeat() subtracts one; this owns where
// those seats are drawn.
//
// You are always at the bottom. Your partner is always opposite you. Nobody is
// ever shown a seat index, because "seat 3" means nothing to a person holding
// a phone, and a table that renumbered itself per-device would be unreadable.
//
// From your seat S the screen reads bottom S, left S+1, top S+2, right S+3 —
// i.e. the list below is simply the seats in CLOCKWISE order starting at you,
// which is what the numbering already is. Turn order subtracts one, so play
// sweeps S -> S+3 -> S+2 -> S+1 = bottom -> right -> top -> left, and that is
// anticlockwise on screen.
//
// Note what did NOT happen: nobody reversed anything here to "make it look
// right". The direction falls out of the numbering, which is why it can be
// tested — see the seat-order block in scripts/test-engine.mjs, which fails if
// anybody renumbers the seats or flips nextSeat().
// ---------------------------------------------------------------------------

/** Screen positions at offsets 0..3 clockwise from the viewer's own seat. */
export const SCREEN_SLOTS = Object.freeze(['bottom', 'left', 'top', 'right']);

/** Which seat sits at each screen position, viewed from `mySeat`. */
export function seatPositions(mySeat) {
  const out = {};
  for (let i = 0; i < SEAT_COUNT; i++) {
    out[SCREEN_SLOTS[i]] = (mySeat + i) % SEAT_COUNT;
  }
  return out;
}

/** Where on screen `seat` is drawn, viewed from `mySeat`. */
export function slotOf(seat, mySeat) {
  return SCREEN_SLOTS[((seat - mySeat) % SEAT_COUNT + SEAT_COUNT) % SEAT_COUNT];
}

/**
 * The tapped card, but only while it is still a move. Null otherwise.
 *
 * Tapping off-turn is allowed on purpose — picking a card up to look at it is
 * not a move — so a selection outlives the moment it was made. Two things can
 * happen to it in the meantime:
 *
 *   - the card gets played, and the hand no longer holds it;
 *   - the trick opens in a suit you hold, and the diamond you were eyeing
 *     becomes a renege.
 *
 * The card itself greys out and disables on its own, but the selection behind
 * it used to survive both, keep `PLAY J♦` on screen, and earn a rejection from
 * the host when pressed. The host was right to refuse — it is the only thing
 * that adjudicates legality, and that does not change. But a refusal must never
 * be reachable from a button this app drew. Greying out illegal cards is a
 * convenience, and a convenience with a hole in it is worse than none, because
 * players learn to trust it and stop reading.
 *
 * Clearing it also stops a stale pick re-arming itself: a card that is illegal
 * this trick can be legal the next one, and nobody wants PLAY already lit for a
 * card they last thought about two tricks ago.
 *
 * Pure, and exported, so both the renderer and main.js's draw() apply one rule
 * and the harness can hold them to it without a DOM.
 */
export function playableSelection(code, priv) {
  if (!code || !priv || !priv.hand) return null;
  const card = priv.hand.find((c) => c.code === code);
  if (!card) return null;
  if (priv.isTurn && !card.legal) return null;
  return code;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function render(root, app, intents) {
  clear(root);

  let node;
  switch (app.screen) {
    case 'home':       node = homeScreen(app, intents); break;
    case 'join':       node = joinScreen(app, intents); break;
    // Always give the waiting player a way out. A host listed on the broker but
    // unreachable over WebRTC produces no error at all, so without a cancel the
    // only escape is a page reload — which loses the seat.
    case 'connecting': node = noticeScreen(app, intents,
      app.reconnecting ? 'Reconnecting…' : 'Connecting…',
      app.notice || 'Finding the table. This can take a few seconds on a phone network.',
      el('button', { class: 'btn btn-ghost', onclick: intents.cancelJoin }, '✕ CANCEL'),
    ); break;
    case 'error':      node = noticeScreen(app, intents,
      'Could not join', app.error || 'Something went wrong.',
      el('button', { class: 'btn btn-primary', onclick: intents.goHome }, '‹ BACK')); break;
    case 'hostleft':   node = noticeScreen(app, intents, 'Table closed',
      'The device running the game has gone. A Court Piece hand cannot continue three-handed, so the match ended here.',
      el('button', { class: 'btn btn-primary', onclick: intents.goHome }, '‹ BACK')); break;
    case 'game':       node = gameScreen(app, intents); break;
    default:           node = homeScreen(app, intents);
  }

  root.appendChild(node);
  speak(app);
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function wordmark(app, intents, { help = true } = {}) {
  return el('div', { class: 'wordmark' },
    el('span', { class: 'wordmark-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'wordmark-text' }, 'Court Piece'),
    help ? el('button', {
      class: 'help-btn', type: 'button',
      'aria-label': 'How to play',
      'aria-expanded': app.showHelp ? 'true' : 'false',
      onclick: intents.toggleHelp,
    }, '?') : null,
  );
}

function shell(...children) {
  return el('div', { class: 'shell' }, ...children);
}

/**
 * Standing bad news about the transport — not a per-action error.
 *
 * Separate from app.error, and rendered in a different place, because the two
 * have opposite lifetimes. An error is the answer to the last tap and clears on
 * the next one (send() nulls it); this is a condition that will still be true
 * in five minutes however many buttons get pressed, and the only one that
 * exists today is "PeerJS did not load, so this device cannot reach other
 * phones". Showing that in the error slot would mean it vanished the first time
 * anybody touched anything, which is precisely wrong for a fact about the
 * device rather than about the tap.
 *
 * role="status" and not role="alert": a screen reader should mention it when it
 * finishes the sentence it is on, not interrupt to say the network is bad.
 *
 * Deliberately NOT drawn on the table screen. That layout has no vertical slack
 * at all — the hand dock's bottom edge is the viewport's bottom edge at 375×812
 * — so a banner there would push cards off the screen. It is also pointless
 * there: every warning this can carry is about who can still JOIN, which stops
 * mattering the moment a match starts.
 */
function netBanner(app) {
  if (!app.netWarning) return null;
  return el('p', { class: 'net-banner', role: 'status' }, app.netWarning);
}

/**
 * The four screens that are neither the home screen nor a game: connecting,
 * could-not-join, table-closed, loading.
 *
 * Carries the wordmark like every other screen. That is not decoration here —
 * "Connecting…" is the FIRST thing a guest sees after following a link, on a
 * device that has never run this app, and a bare heading pinned to the top edge
 * of a black page is indistinguishable from a page that has failed to load. The
 * wordmark is the only thing on screen saying the link worked.
 *
 * No `?` on it, though: three of these four screens are dead ends the player
 * wants out of, not moments to read the rules, and the way out is the one
 * button underneath.
 */
function noticeScreen(app, intents, title, body, action) {
  return shell(
    wordmark(app, intents, { help: false }),
    el('h1', { class: 'title' }, title),
    el('p', { class: 'subtitle' }, body),
    action,
  );
}

/**
 * Inline `--team` custom properties.
 *
 * Every team-coloured thing in the stylesheet reads var(--team) rather than a
 * fixed colour, because "us" and "them" are relative to whoever is holding the
 * phone: team 0 is crimson on one device and teal on the one opposite. Setting
 * the pair here, at the point the node is built, is what lets one stylesheet
 * serve four different points of view.
 */
function teamStyle(team, myTeam) {
  const mine = team === myTeam;
  return mine
    ? '--team: var(--us); --team-dim: var(--us-dim);'
    : '--team: var(--them); --team-dim: var(--them-dim);';
}

/** A card face — the two spans every card-shaped thing in the app is made of. */
function face(code) {
  return [
    el('span', { class: 'r' }, rankLabel(code)),
    el('span', { class: 's' }, suitGlyph(suitOf(code))),
  ];
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function homeScreen(app, intents) {
  const ready = !!app.nameDraft.trim();
  return shell(
    wordmark(app, intents),
    el('h1', { class: 'title' }, 'Court Piece'),
    el('p', { class: 'subtitle' },
      'Four players, four phones, fixed partners sitting opposite. '
      + 'Take seven of thirteen tricks to win the deal — take the first seven and it is a court.'),

    // Above the name field, not below the buttons: it changes what HOST A TABLE
    // means, so it has to be read before the tap and not after it.
    netBanner(app),

    el('div', { class: 'field' },
      el('label', { class: 'section-label', for: 'name' }, 'Your name'),
      el('input', {
        class: 'input', id: 'name', type: 'text',
        maxlength: String(MAX_NAME_LEN),
        placeholder: 'Name at the table',
        value: app.nameDraft,
        autocomplete: 'nickname',
        'data-focus': 'name',
        oninput: (e) => intents.setName(e.target.value),
        onkeydown: (e) => { if (e.key === 'Enter' && ready) intents.host(); },
      }),
    ),

    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary', type: 'button', disabled: !ready,
        onclick: intents.host,
      }, 'HOST A TABLE'),
      el('button', {
        class: 'btn', type: 'button', disabled: !ready,
        onclick: intents.goJoin,
      }, 'JOIN A TABLE'),
    ),

    // Needs no name, unlike the two above it: a screen that only watches holds
    // no seat, so there is nothing at the table to print a name on.
    el('button', {
      class: 'btn btn-ghost', type: 'button',
      onclick: intents.goWatch,
    }, 'WATCH A TABLE'),

    app.error ? el('p', { class: 'prompt error' }, app.error) : null,
    app.showHelp ? helpPanel() : null,
  );
}

function joinScreen(app, intents) {
  const code = app.codeDraft || '';
  const ready = code.length === CODE_LENGTH;
  // One screen for both, because both are "type the four characters". What
  // differs is what the host is asked for once they are typed.
  const watch = app.joinMode === 'watch';
  return shell(
    wordmark(app, intents, { help: false }),
    el('h1', { class: 'title' }, watch ? 'Watch a table' : 'Join a table'),
    el('p', { class: 'subtitle' }, watch
      ? 'Four characters, from whoever is hosting. This screen shows the table and the score — '
        + 'never anybody’s cards — so it can sit where all four players can see it.'
      : 'Four characters, from whoever is hosting.'),

    // Worth more here than anywhere: with no PeerJS there is no join at all,
    // and the alternative is the player typing a code they read off someone
    // else's screen and then being told it failed.
    netBanner(app),

    el('div', { class: 'field' },
      el('label', { class: 'section-label', for: 'code' }, 'Room code'),
      el('input', {
        class: 'input input-code', id: 'code', type: 'text',
        // Not `type="number"`: the alphabet is letters and digits, and a
        // numeric keypad would make half of every code untypeable.
        inputmode: 'latin', autocapitalize: 'characters', autocomplete: 'off',
        spellcheck: 'false', maxlength: String(CODE_LENGTH),
        value: code,
        'data-focus': 'code',
        oninput: (e) => intents.setCode(e.target.value),
        onkeydown: (e) => { if (e.key === 'Enter' && ready) intents.join(code); },
      }),
    ),

    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary', type: 'button', disabled: !ready,
        onclick: () => intents.join(code),
      }, watch ? 'WATCH' : 'JOIN'),
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: intents.goHome }, '‹ BACK'),
    ),

    app.error ? el('p', { class: 'prompt error' }, app.error) : null,
  );
}

function helpPanel() {
  const line = (name, hint) => el('div', { class: 'rule-row' },
    el('div', { class: 'rule-text' },
      el('span', { class: 'rule-name' }, name),
      el('span', { class: 'rule-hint' }, hint),
    ),
  );
  return el('div', { class: 'card-panel' },
    el('p', { class: 'section-label' }, 'How it goes'),
    line('Four players, two teams',
      'Partners sit opposite. You never choose your partner mid-match — the seat decides it.'),
    line('Play runs to the right',
      'Deal and play both go anticlockwise, so the next player is always the one on your right.'),
    line('The cut calls trump',
      'The player to the dealer’s right sees five cards, names the trump suit alone, and leads the first trick.'),
    line('Follow suit if you can',
      'If you cannot, play anything at all. There is no obligation to trump — a discard is often the better card.'),
    line('Seven of thirteen',
      'Highest trump takes the trick, or the highest card of the suit led. Seven tricks wins the deal.'),
    // Deliberately not "the only thing that scores", which is only true of a
    // race. This panel is one text for both match modes, so it has to say what
    // a court IS and leave what it is worth to the turn strip, which names the
    // target the table actually picked.
    line('A court is the whole point',
      'Take the opening seven tricks — opponents on nothing — and that is a court. It is the rare one, and the one worth chasing.'),
  );
}

// ---------------------------------------------------------------------------
// The game, by phase
// ---------------------------------------------------------------------------

function gameScreen(app, intents) {
  const { pub } = app;
  if (!pub) return noticeScreen(app, intents, 'Loading…', 'Waiting for the table.', null);

  // A watching screen gets one layout for every phase. See watchScreen().
  if (app.me.watching) return watchScreen(app, intents);

  switch (pub.phase) {
    case PHASES.LOBBY:      return withLinkNote(app, lobbyScreen(app, intents));
    case PHASES.DEAL_OVER:  return withLinkNote(app, dealOverScreen(app, intents));
    case PHASES.MATCH_OVER: return withLinkNote(app, matchOverScreen(app, intents));
    // DEAL_FIVE, DECLARE_TRUMP, DEAL_REST and PLAY are ONE screen on purpose.
    // They are four steps of the same moment at the table — cards arriving, a
    // suit being named, the rest arriving, the first card going down — and
    // swapping the whole layout between them would make the deal feel like
    // four page loads instead of one hand being dealt to you.
    // DEAL_FIVE, DECLARE_TRUMP, DEAL_REST and PLAY get no banner. Not an
    // oversight — that screen fills the viewport exactly, so a banner would
    // push the hand off the bottom, and it carries the same news in two places
    // it already has room for: the turn strip and the prompt line.
    default:                return tableScreen(app, intents);
  }
}

/**
 * Tell a player their connection has dropped, on the screens that can spare a
 * line for it.
 *
 * A dropped CLIENT deliberately keeps its last known table on screen while the
 * ladder in js/main.js dials back in — losing the board mid-deal is worse than
 * a stale board, and the retry usually wins. The cost of that choice is that
 * nothing on screen would otherwise have changed at all, so the player has no
 * way to tell a frozen game from a quiet one. This is the thing that changed.
 *
 * Inserted into the finished screen rather than threaded through three
 * signatures. The screens are real DOM nodes, not a virtual tree, so this is
 * an ordinary insert and not a hack — and it keeps lobbyScreen, dealOverScreen
 * and matchOverScreen ignorant of the transport, which is where that knowledge
 * belongs.
 *
 * Shorter wording than the table screen's. Nothing is waiting on this player
 * in the lobby or between deals, so the sentence about a bot covering the seat
 * would be alarming and untrue.
 */
function withLinkNote(app, node) {
  if (!app.reconnecting) return node;
  const note = el('p', { class: 'net-banner', role: 'status' },
    'Connection lost — dialling back in. Your seat is held.');
  const mark = node.querySelector('.wordmark');
  if (mark) mark.after(note); else node.prepend(note);
  return node;
}

// --- Lobby -----------------------------------------------------------------

function lobbyScreen(app, intents) {
  const { pub, me } = app;
  const isOwner = pub.ownerId === me.id;
  const mySeat = seatOfId(pub, me.id);
  const myTeam = mySeat < 0 ? 0 : teamOf(mySeat);
  const check = pub.startCheck || { ok: false, reason: '' };

  return shell(
    wordmark(app, intents),

    el('div', { class: 'field' },
      el('label', { class: 'section-label', for: 'room' }, 'Room code'),
      el('div', { class: 'row' },
        // A readonly input rather than a span: it is selectable and long-press
        // copyable on every phone, which is how most people will actually pass
        // this to the person sitting next to them.
        el('input', {
          class: 'input input-code', id: 'room', type: 'text',
          readonly: true, value: app.code || '----',
          'aria-label': `Room code ${(app.code || '').split('').join(' ')}`,
        }),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: intents.copyCode },
          app.copied ? 'COPIED' : 'COPY'),
      ),
      // Directly under the code, because the code is the thing it invalidates.
      // The lobby is also where the warning can CHANGE: onBrokerDown sets it
      // while the host is waiting for people, onBrokerUp clears it again.
      netBanner(app),
    ),

    el('div', { class: 'stack' },
      el('p', { class: 'section-label' }, 'The table'),
      el('ul', { class: 'seat-list' },
        ...pub.seats.map((p, seat) => seatRow(app, intents, p, seat, mySeat, myTeam, isOwner)),
      ),
      pairingNote(pub, mySeat, myTeam),
      watchersNote(pub),
    ),

    isOwner ? rulesPanel(pub, intents) : rulesSummary(pub),

    el('div', { class: 'host-bar' },
      isOwner
        ? el('button', {
            class: 'btn btn-primary', type: 'button', disabled: !check.ok,
            onclick: intents.startMatch,
          }, 'START THE MATCH')
        : el('p', { class: 'waiting-note' }, 'Waiting for the host to start.'),
      check.reason ? el('p', { class: 'rule-hint' }, check.reason) : null,
      app.error ? el('p', { class: 'prompt error' }, app.error) : null,
    ),

    app.showHelp ? helpPanel() : null,

    pub.log.length ? logSection(pub, 4, myTeam) : null,
  );
}

function seatRow(app, intents, p, seat, mySeat, myTeam, isOwner) {
  const team = teamOf(seat);
  const mine = seat === mySeat;
  const cls = ['seat-row'];
  if (!p) cls.push('empty');
  if (mine) cls.push('you');

  // Two taps to swap: the first arms a seat, the second says where it goes.
  // Swapping is the only seating control that matters, because who sits
  // opposite whom IS who partners whom.
  //
  // The button is worded for the tap that is actually available right now
  // rather than for the control in the abstract, because a two-tap gesture is
  // only discoverable if the second tap announces itself. An arrow glyph was
  // tried first and read as noise: it says a swap exists, not what to press.
  const armed = app.ui.swapFrom;
  const isArmed = armed === seat;
  const armedPlayer = armed === null || armed === undefined ? null : app.pub.seats[armed];
  const swapLabel = isArmed ? 'CANCEL' : (armedPlayer ? 'SWAP' : 'MOVE');

  return el('li', { class: cls.join(' '), style: teamStyle(team, myTeam) },
    el('span', { class: 'seat-index' }, `Team ${team + 1}`),
    el('span', { class: 'seat-name' }, p ? p.name : 'Empty seat'),
    mine ? el('span', { class: 'seat-tag you' }, 'You') : null,
    p && p.isBot ? el('span', { class: 'seat-tag' }, 'Bot') : null,
    p && p.id === app.pub.ownerId ? el('span', { class: 'seat-tag' }, 'Host') : null,

    isOwner && p && p.isBot
      ? el('button', {
          class: 'btn btn-ghost', type: 'button',
          style: 'min-height:38px;padding:0 11px;',
          'aria-label': `Remove ${p.name}`,
          onclick: () => intents.removeBot(seat),
        }, '✕')
      : null,

    isOwner && !p
      ? el('button', {
          class: 'btn btn-ghost', type: 'button',
          style: 'min-height:38px;padding:0 11px;',
          'aria-label': `Seat a bot in the ${ordinal(seat)} chair`,
          onclick: () => intents.addBot(seat),
        }, '+ BOT')
      : null,

    isOwner && p
      ? el('button', {
          class: 'choice', type: 'button',
          style: 'padding:0 10px;',
          'aria-pressed': isArmed ? 'true' : 'false',
          'aria-label': isArmed
            ? `Cancel moving ${p.name}`
            : armedPlayer
              ? `Swap ${armedPlayer.name} with ${p.name}`
              : `Move ${p.name} to another seat`,
          onclick: () => intents.swapSeat(seat),
        }, swapLabel)
      : null,
  );
}

function pairingNote(pub, mySeat, myTeam) {
  if (mySeat < 0) {
    return el('p', { class: 'pairing-note' },
      el('span', { class: 'team-dot', style: teamStyle(0, 0) }),
      'Partners sit opposite each other.');
  }
  const partner = pub.seats[(mySeat + 2) % SEAT_COUNT];
  return el('p', { class: 'pairing-note', style: teamStyle(myTeam, myTeam) },
    el('span', { class: 'team-dot', 'aria-hidden': 'true' }),
    partner
      ? `You and ${partner.name} are partners — you sit opposite each other.`
      : 'Your partner is the seat opposite yours. Nobody is in it yet.',
  );
}

/**
 * Says that a screen is watching, and what it can see.
 *
 * Both halves matter. The count is how whoever set the TV up learns it worked
 * without walking over to look at it; the second sentence is for the other
 * three, who are entitled to know that an extra screen in the room is not
 * showing anybody their hand.
 *
 * `watchers` is added to the frame by the host (hostSync() in js/main.js), not
 * by the engine, so an older host simply does not send it and nothing is drawn.
 */
function watchersNote(pub) {
  const n = Number.isInteger(pub.watchers) ? pub.watchers : 0;
  if (n <= 0) return null;
  return el('p', { class: 'pairing-note' },
    el('span', { class: 'team-dot', 'aria-hidden': 'true' }),
    `${n} screen${n === 1 ? ' is' : 's are'} watching. `
      + `${n === 1 ? 'It shows' : 'They show'} the table and the score, never anybody’s cards.`);
}

function rulesPanel(pub, intents) {
  const c = pub.config;
  const choice = (label, pressed, onclick, aria) => el('button', {
    class: 'choice', type: 'button', 'aria-pressed': pressed ? 'true' : 'false',
    'aria-label': aria || undefined, onclick,
  }, label);

  return el('div', { class: 'card-panel' },
    el('p', { class: 'section-label' }, 'House rules'),

    el('div', { class: 'rule-row' },
      el('div', { class: 'rule-text' },
        el('span', { class: 'rule-name' }, 'Hidden Rung'),
        el('span', { class: 'rule-hint' },
          'Trump is called face-down and stays secret until the first player who cannot follow suit.'),
      ),
      el('div', { class: 'choice-group' },
        choice('OFF', !c.hiddenRung, () => intents.setConfig({ hiddenRung: false })),
        choice('ON', c.hiddenRung, () => intents.setConfig({ hiddenRung: true })),
      ),
    ),

    el('div', { class: 'rule-row' },
      el('div', { class: 'rule-text' },
        el('span', { class: 'rule-name' }, 'Match ends'),
        el('span', { class: 'rule-hint' }, c.matchMode === 'race'
          ? 'A race: first team to the court target takes it, however long that takes.'
          : 'A fixed number of deals. Most deals won takes it, with courts breaking a tie.'),
      ),
      el('div', { class: 'choice-group' },
        choice('RACE', c.matchMode === 'race', () => intents.setConfig({ matchMode: 'race' })),
        choice('DEALS', c.matchMode === 'deals', () => intents.setConfig({ matchMode: 'deals' })),
      ),
    ),

    c.matchMode === 'race'
      ? el('div', { class: 'rule-row' },
          el('div', { class: 'rule-text' },
            el('span', { class: 'rule-name' }, 'Courts to win'),
            el('span', { class: 'rule-hint' },
              'A court is rare — roughly one deal in fifteen — so one court is about eleven deals. Two is an evening.'),
          ),
          el('div', { class: 'choice-group' },
            ...MATCH_TARGET_OPTIONS.map((n) => choice(String(n), c.courtsToWin === n,
              () => intents.setConfig({ courtsToWin: n }), `${n} court${n === 1 ? '' : 's'} to win`)),
          ),
        )
      : el('div', { class: 'rule-row' },
          el('div', { class: 'rule-text' },
            el('span', { class: 'rule-name' }, 'Deals to play'),
            el('span', { class: 'rule-hint' },
              'Whole trips round the table, so everybody deals the same number of times.'),
          ),
          el('div', { class: 'choice-group' },
            ...DEAL_TARGET_OPTIONS.map((n) => choice(String(n), c.dealsToPlay === n,
              () => intents.setConfig({ dealsToPlay: n }), `${n} deals`)),
          ),
        ),
  );
}

/** What a non-owner sees instead: the same facts, none of the controls. */
function rulesSummary(pub) {
  const c = pub.config;
  return el('div', { class: 'card-panel' },
    el('p', { class: 'section-label' }, 'House rules'),
    el('p', { class: 'rule-hint' },
      c.hiddenRung ? 'Hidden Rung — trump is called face-down.' : 'Classic — trump is called out loud.'),
    el('p', { class: 'rule-hint' },
      c.matchMode === 'race'
        ? `First team to ${c.courtsToWin} court${c.courtsToWin === 1 ? '' : 's'} wins the match.`
        : `${c.dealsToPlay} deals, then most deals won takes the match.`),
  );
}

// --- The table: DEAL_FIVE, DECLARE_TRUMP, DEAL_REST, PLAY ------------------

function tableScreen(app, intents) {
  const { pub, priv, me } = app;
  // A device with no seat — a reconnect that has not finished, or a state
  // arriving a beat before the private half. Show the table, not a spinner.
  const mySeat = priv ? priv.seat : Math.max(0, seatOfId(pub, me.id));
  const myTeam = teamOf(mySeat);

  return el('div', { class: 'shell shell-play' },
    turnStrip(app, priv, myTeam),
    scoreboard(app, intents, myTeam),
    app.ui.lastTrickOpen && pub.lastTrick ? lastTrickPanel(pub, mySeat, myTeam) : null,
    tableGrid(app, mySeat, myTeam),
    promptLine(app, priv),
    handDock(app, intents, priv),
  );
}

/**
 * The strip carries the MATCH: what winning it takes, where it stands, and who
 * the table is waiting on. The scoreboard underneath carries the DEAL. Keeping
 * the two lines to one subject each is what lets both stay on one row at 375px
 * — the match standing sat in the scoreboard first and wrapped the LAST chip
 * onto a line of its own.
 */
function turnStrip(app, priv, myTeam) {
  const { pub } = app;

  // A dropped client keeps the whole table on screen while it dials back in —
  // see the note in startJoining() in js/main.js — so the third chip is the
  // only thing that can say so. It takes priority over the turn word because
  // while we are disconnected the turn word is a guess: it is whatever the last
  // frame said, and the trick may already have moved on without us.
  const down = !!app.reconnecting;

  return el('div', { class: 'turn-strip' },
    el('span', { class: 'section-label' }, matchContext(pub)),
    matchStanding(pub, myTeam),
    el('span', {
      class: 'turn-state' + (down ? ' stale' : (priv && priv.isTurn ? ' yours' : '')),
      // Not aria-live. render() rebuilds #app wholesale on every draw, so a live
      // region here would be a brand new node every time and never fire; the
      // announcer in speak() is the live region, and it reads the prompt line.
    }, down ? 'Reconnecting…' : turnWord(pub, priv)),
  );
}

function matchContext(pub) {
  if (pub.matchMode === 'deals') {
    return `Deal ${Math.min(pub.dealsPlayed + 1, pub.matchTarget)} of ${pub.matchTarget}`;
  }
  return pub.matchTarget === 1 ? 'First court wins' : `Race to ${pub.matchTarget} courts`;
}

/** Where the match stands, us first: courts in a race, deals in a deals match
 *  — whichever one is actually being played to. Always drawn, including at
 *  0–0, because a number that only appears once somebody scores is a number
 *  nobody has learnt to read by the time it matters. */
function matchStanding(pub, myTeam) {
  const deals = pub.matchMode === 'deals';
  const nums = deals ? pub.dealsWon : pub.courts;
  const label = deals ? 'deals' : 'courts';
  return el('span', {
    class: 'match-standing',
    'aria-label': `Match standing: us ${nums[myTeam]} ${label}, them ${nums[1 - myTeam]}`,
  }, `${nums[myTeam]}–${nums[1 - myTeam]}`);
}

function turnWord(pub, priv) {
  if (pub.phase === PHASES.DEAL_FIVE) return 'Dealing';
  if (pub.phase === PHASES.DEAL_REST) return 'Dealing';
  if (pub.phase === PHASES.DECLARE_TRUMP) {
    return priv && priv.mustDeclare ? 'Call trump' : 'Calling trump';
  }
  if (priv && priv.isTurn) return 'Your turn';
  const who = pub.turnSeat === null ? null : pub.seats[pub.turnSeat];
  return who ? who.name : '—';
}

function scoreboard(app, intents, myTeam) {
  const { pub } = app;

  // The pills carry TRICKS TAKEN IN THIS DEAL, not the match score.
  //
  // This screen only ever renders mid-deal, and mid-deal the live race is to
  // seven tricks — it is the number behind every decision at the table, and
  // whether the opponents are still on zero is the whole of the court. The
  // match tally by contrast moves once every ten minutes or so: a race to one
  // court reads 0–0 for most of an evening, so it sits up in the turn strip
  // beside the target it is counting towards.
  const tricks = pub.tricksWon || [0, 0];

  const pill = (team, who) => el('div', {
    class: 'score-pill', style: teamStyle(team, myTeam),
    'aria-label': `${who}: ${tricks[team]} of ${TRICKS_TO_WIN} tricks`,
  },
    el('span', { class: 'who' }, who),
    el('span', { class: 'num' }, String(tricks[team])),
    el('span', { class: 'of', 'aria-hidden': 'true' }, `/${TRICKS_TO_WIN}`),
  );

  return el('div', { class: 'scoreboard' },
    pill(myTeam, 'Us'),
    pill(1 - myTeam, 'Them'),
    rungChip(app),
    el('button', {
      class: 'last-chip', type: 'button',
      disabled: !pub.lastTrick,
      'aria-expanded': app.ui.lastTrickOpen ? 'true' : 'false',
      onclick: intents.toggleLastTrick,
    }, 'LAST'),
  );
}

function rungChip(app) {
  const { pub, priv } = app;

  // Before a suit has been named there is nothing to draw at all.
  if (pub.phase === PHASES.DEAL_FIVE
      || (pub.phase === PHASES.DECLARE_TRUMP && !pub.trumpHidden && !pub.trump)) {
    return el('span', { class: 'rung-chip' },
      el('span', { class: 'glyph', 'aria-hidden': 'true' }, '▧'),
      'no rung yet');
  }

  if (pub.trumpHidden) {
    // The one person entitled to know: whoever called it. This comes from
    // privateStateFor(), never from the broadcast — see the Hidden Rung
    // boundary in publicState().
    const own = priv && priv.trumpYouCalled;
    return el('span', {
      class: 'rung-chip hidden-rung',
      'aria-label': own ? `Hidden rung — you called ${suitName(own)}` : 'Rung is hidden',
    },
      el('span', { class: 'glyph', 'aria-hidden': 'true' }, own ? suitGlyph(own) : '▧'),
      own ? 'yours' : 'hidden',
    );
  }

  const suit = pub.trump;
  if (!suit) return null;
  return el('span', { class: 'rung-chip', 'aria-label': `Rung is ${suitName(suit)}` },
    el('span', { class: 'glyph' + (isRedSuit(suit) ? ' red' : ''), 'aria-hidden': 'true' },
      suitGlyph(suit)),
    'rung',
  );
}

/**
 * `mySeat` is the seat drawn at the bottom; `selfSeat` is the seat that gets
 * called "You". For a player they are the same seat, which is why the second
 * defaults to the first. A watching screen needs them apart: somebody has to
 * be at the bottom of the picture, and nobody on it is "You".
 */
function tableGrid(app, mySeat, myTeam, selfSeat = mySeat) {
  const at = seatPositions(mySeat);
  return el('div', { class: 'table' },
    seatPlate(app, at.top, 'partner', selfSeat, myTeam),
    seatPlate(app, at.left, 'left', selfSeat, myTeam),
    seatPlate(app, at.right, 'right', selfSeat, myTeam),
    seatPlate(app, at.bottom, 'mine', selfSeat, myTeam),
    trickGrid(app, mySeat, myTeam, selfSeat),
  );
}

function seatPlate(app, seat, position, mySeat, myTeam) {
  const { pub } = app;
  const p = pub.seats[seat];
  if (!p) return el('div', { class: `seat ${position}` }, el('span', { class: 'seat-who' }, '—'));

  const cls = ['seat', position];
  const acting = pub.turnSeat === seat
    || (pub.phase === PHASES.DECLARE_TRUMP && pub.callerSeat === seat);
  if (acting) cls.push('acting');
  if (!p.online) cls.push('offline');
  // A bot that is mid-pause. Without this the table looks frozen for a second
  // and a half every time it is a computer's turn.
  if (acting && p.isBot) cls.push('thinking');

  // "dealer", not "deals" — the shorter word collides with the deals-mode
  // vocabulary two inches up in the scoreboard, and a badge that could mean
  // either "this player deals" or "deals won" is worse than no badge.
  const role = seat === pub.dealerSeat ? 'dealer'
    : seat === pub.callerSeat ? 'cut' : null;

  return el('div', {
    class: cls.join(' '),
    style: teamStyle(teamOf(seat), myTeam),
    'aria-label': [
      p.name,
      seat === mySeat ? '(you)' : null,
      teamOf(seat) === myTeam ? 'your team' : 'opponent',
      `${p.handCount} cards`,
      p.isBot ? 'bot' : null,
      p.online ? null : 'offline',
      acting ? 'to play' : null,
    ].filter(Boolean).join(', '),
  },
    el('span', { class: 'seat-who' }, seat === mySeat ? 'You' : p.name),
    el('span', { class: 'seat-meta', 'aria-hidden': 'true' },
      el('span', { class: 'status-dot' + (p.online ? '' : ' off') }),
      el('span', { class: 'count' }, String(p.handCount)),
      role ? el('span', { class: 'bot-tag' }, role) : null,
      p.isBot ? el('span', { class: 'bot-tag' }, 'bot') : null,
    ),
  );
}

function trickGrid(app, mySeat, myTeam, selfSeat = mySeat) {
  const { pub } = app;
  const plays = pub.trick || [];

  // WHO IS WINNING, COMPUTED ON THE CLIENT — and it is safe to do so even under
  // Hidden Rung, which looks wrong at first glance. pub.trump is null while the
  // rung is hidden, so this would misjudge a trick somebody had trumped. But
  // the rung stays hidden only while nobody has broken suit, and a player who
  // has followed suit has not trumped: every card in an unrevealed trick is of
  // the led suit, so highest-of-led is the right answer. The moment that stops
  // being true the engine has already revealed the suit.
  const leader = plays.length ? winningCard(plays, pub.trump) : null;
  const leadSeat = leader ? plays.find((p) => p.code === leader).seat : null;

  const slot = (position) => {
    const seat = (mySeat + SCREEN_SLOTS.indexOf(position)) % SEAT_COUNT;
    const idx = plays.findIndex((p) => p.seat === seat);
    const who = pub.seats[seat];

    if (idx < 0) {
      const yours = seat === selfSeat;
      return el('li', { class: `trick-slot ${position}` },
        el('div', {
          class: 'slot-empty' + (yours ? ' yours' : ''),
          'aria-label': `${yours ? 'You have' : (who ? who.name : 'Seat')} not played yet`,
        }),
      );
    }

    const code = plays[idx].code;
    const winning = seat === leadSeat;
    // All four down: the engine is holding the trick on the table for a beat
    // before gathering it in, and "currently" would be the wrong word for it.
    const settled = plays.length >= SEAT_COUNT;
    return el('li', { class: `trick-slot ${position}` },
      el('div', {
        class: ['played', isRedCard(code) ? 'red' : '', winning ? 'winning' : ''].filter(Boolean).join(' '),
        style: teamStyle(teamOf(seat), myTeam),
        'aria-label': `${seat === selfSeat ? 'You' : (who ? who.name : 'Seat')} played `
          + `${cardName(code)}${winning ? (settled ? ', takes the trick' : ', currently winning') : ''}`,
      },
        ...face(code),
        // Play order, so a glance at a part-played trick says who led.
        el('span', { class: 'pip', 'aria-hidden': 'true' }, String(idx + 1)),
      ),
    );
  };

  return el('ol', {
    // `trick-grid`, not `trick` — see the note on the rule in css/styles.css.
    // A log line's event kind is also a class, and `.log-line.trick` exists.
    class: 'trick-grid',
    'aria-label': plays.length ? `Trick ${pub.trickNumber}, in play order` : 'No cards played yet',
  },
    slot('top'), slot('left'), slot('right'), slot('bottom'),
  );
}

function promptLine(app, priv) {
  const { pub } = app;
  if (app.error) return el('p', { class: 'prompt error' }, app.error);

  // Ahead of every phase prompt, because all of them are about what to do next
  // and right now nothing the player does will arrive. Says what happens to the
  // seat as well as what happens to the connection: a bot covering a hand is
  // alarming to come back to unexplained, and it is the reason the other three
  // are not sitting waiting on a phone that went into a pocket.
  if (app.reconnecting) {
    return el('p', { class: 'prompt error' },
      'Connection lost — dialling back in. Your seat is held; a bot plays it if the table has to wait.');
  }

  if (pub.phase === PHASES.DEAL_FIVE) {
    return el('p', { class: 'prompt' }, 'Five cards each, dealt to the right of the dealer…');
  }
  if (pub.phase === PHASES.DEAL_REST) {
    return el('p', { class: 'prompt' }, 'And the rest, four at a time…');
  }
  if (pub.phase === PHASES.DECLARE_TRUMP) {
    if (priv && priv.mustDeclare) {
      return el('p', { class: 'prompt you' },
        'You cut. Name the trump suit from these five — nobody else gets a say.');
    }
    const caller = pub.seats[pub.callerSeat];
    return el('p', { class: 'prompt' },
      `${caller ? caller.name : 'The player who cut'} is looking at five cards and choosing the rung.`);
  }

  if (priv && priv.isTurn) {
    if (!pub.ledSuit) {
      return el('p', { class: 'prompt you' }, `Your lead — trick ${pub.trickNumber}.`);
    }
    // Whether they are following or free is already decided by the engine and
    // shown by the greying. This just says which of the two it is in words,
    // because "everything is tappable" and "nothing is tappable" look alike.
    const canFollow = priv.hand.some((c) => c.legal && suitOf(c.code) === pub.ledSuit);
    return el('p', { class: 'prompt you' }, canFollow
      ? `Follow ${suitName(pub.ledSuit)}.`
      : `No ${suitName(pub.ledSuit)} — play anything. You do not have to trump.`);
  }

  // A full trick held on the table: nobody is on turn, so say who took it
  // rather than "Waiting…" for nobody. Computed here for the same reason, and
  // with the same Hidden Rung safety, as the highlight in trickGrid().
  const plays = pub.trick || [];
  if (plays.length >= SEAT_COUNT) {
    const taker = trickWinner(plays, pub.trump);
    if (priv && taker === priv.seat) return el('p', { class: 'prompt you' }, 'You take the trick.');
    const name = taker === null || !pub.seats[taker] ? null : pub.seats[taker].name;
    return el('p', { class: 'prompt' }, name ? `${name} takes the trick.` : 'Trick taken.');
  }

  const who = pub.turnSeat === null ? null : pub.seats[pub.turnSeat];
  return el('p', { class: 'prompt' }, who ? `Waiting for ${who.name}…` : 'Waiting…');
}

// --- The hand dock ---------------------------------------------------------

function handDock(app, intents, priv) {
  const { pub } = app;
  if (!priv) {
    return el('div', { class: 'hand-dock' },
      el('p', { class: 'waiting-note' }, 'You are watching this table, not sitting at it.'));
  }

  const declaring = pub.phase === PHASES.DECLARE_TRUMP && priv.mustDeclare;
  const selected = playableSelection(app.ui.selectedCard, priv);

  return el('div', { class: 'hand-dock' },
    declaring ? suitChoice(intents) : null,
    handCards(app, intents, priv),
    // The confirm row is only built when there is something to confirm, so the
    // dock is one row shorter for the other three players and the table gets
    // the pixels back.
    !declaring && priv.isTurn && selected ? confirmRow(intents, selected) : null,
  );
}

function suitChoice(intents) {
  return el('div', { class: 'suit-choice', role: 'group', 'aria-label': 'Choose the trump suit' },
    ...SUITS.map((s) => el('button', {
      class: 'suit-btn' + (isRedSuit(s) ? ' red' : ''),
      type: 'button',
      'aria-label': `Call ${suitName(s)} as trump`,
      'data-focus': `suit-${s}`,
      onclick: () => intents.declareTrump(s),
    },
      el('span', { 'aria-hidden': 'true' }, suitGlyph(s)),
      el('span', { class: 'name' }, suitName(s)),
    )),
  );
}

function handCards(app, intents, priv) {
  // Same rule as the confirm row, so the lifted card and the PLAY button
  // appear and disappear together — a card lifted with no way to play it is
  // the same lie told quietly.
  const selected = playableSelection(app.ui.selectedCard, priv);
  let prevSuit = null;

  return el('div', {
    class: 'hand', role: 'group',
    'aria-label': `Your hand, ${priv.hand.length} card${priv.hand.length === 1 ? '' : 's'}`,
  },
    ...priv.hand.map((c) => {
      const suit = suitOf(c.code);
      // The hand arrives suit-sorted from sortHand(), so a change of suit is a
      // run boundary and gets the wider gutter. Follow-suit is the rule the
      // whole game turns on and it operates on exactly these runs.
      const starts = prevSuit !== null && suit !== prevSuit;
      prevSuit = suit;

      const cls = ['hand-card'];
      if (isRedCard(c.code)) cls.push('red');
      if (starts) cls.push('suit-start');
      if (priv.isTurn && !c.legal) cls.push('illegal');
      if (c.code === selected) cls.push('selected');

      return el('button', {
        class: cls.join(' '),
        type: 'button',
        // Tapping is always allowed off-turn — picking a card up to look at it
        // is not a move. Only the engine's own `legal` flag makes one inert,
        // and only while it is actually your turn to play.
        disabled: priv.isTurn && !c.legal,
        'aria-pressed': c.code === selected ? 'true' : 'false',
        'aria-label': cardName(c.code) + (c.reason ? `, ${c.reason}` : ''),
        // Selecting rebuilds the tree; without this the keyboard focus the
        // card was holding would jump back to the top of the page.
        'data-focus': `card-${c.code}`,
        onclick: () => intents.selectCard(c.code),
      }, ...face(c.code));
    }),
  );
}

function confirmRow(intents, code) {
  return el('div', { class: 'confirm-row' },
    el('button', {
      class: 'btn btn-primary', type: 'button',
      'aria-label': `Play the ${cardName(code)}`,
      'data-focus': 'confirm',
      onclick: () => intents.playCard(code),
    }, `PLAY ${rankLabel(code)}${suitGlyph(suitOf(code))}`),
    el('button', {
      class: 'btn btn-ghost', type: 'button', onclick: intents.clearSelection,
    }, 'CANCEL'),
  );
}

// --- Last trick ------------------------------------------------------------

function lastTrickPanel(pub, mySeat, myTeam) {
  const t = pub.lastTrick;
  const winner = pub.seats[t.winnerSeat];
  return el('div', {
    class: 'last-trick', role: 'status',
    'aria-label': `Last trick: taken by ${t.winnerSeat === mySeat ? 'you' : (winner ? winner.name : 'nobody')}`,
  },
    el('div', { class: 'mini-row' },
      ...t.plays.map((p) => el('div', {
        class: ['mini', isRedCard(p.code) ? 'red' : '', p.seat === t.winnerSeat ? 'won' : '']
          .filter(Boolean).join(' '),
        style: teamStyle(teamOf(p.seat), myTeam),
        'aria-label': cardName(p.code),
      },
        el('span', {}, rankLabel(p.code)),
        el('span', {}, suitGlyph(suitOf(p.code))),
      )),
    ),
    el('span', { class: 'caption' },
      `${t.winnerSeat === mySeat ? 'You' : (winner ? winner.name : 'Nobody')} took it.`),
  );
}

// --- Deal over -------------------------------------------------------------

function dealOverScreen(app, intents) {
  const { pub, me } = app;
  const mySeat = Math.max(0, seatOfId(pub, me.id));
  const myTeam = teamOf(mySeat);
  const r = pub.dealResult;
  const isOwner = pub.ownerId === me.id;
  const weWon = r.winnerTeam === myTeam;
  const courted = r.court !== null;
  const courtUs = r.court === myTeam;

  return shell(
    wordmark(app, intents, { help: false }),

    el('div', { class: 'result-banner', style: teamStyle(r.winnerTeam, myTeam) },
      el('span', { class: 'result-kicker' }, courted ? 'Court' : 'Deal over'),
      el('h1', { class: 'result-headline' + (courted ? ' court' : '') },
        courted
          ? (courtUs ? 'You courted them' : 'You were courted')
          : (weWon ? 'You win the deal' : 'They win the deal')),
      el('p', { class: 'result-detail' }, dealDetail(pub, r, myTeam)),
      el('div', { class: 'tally' },
        tallyItem(r.tricksWon[myTeam], 'our tricks'),
        tallyItem(r.tricksWon[1 - myTeam], 'their tricks'),
        tallyItem(pub.courts[myTeam], 'our courts'),
        tallyItem(pub.courts[1 - myTeam], 'their courts'),
      ),
    ),

    el('div', { class: 'stack' },
      // Not "the thirteen": seven tricks decides it, so a deal that ends on
      // the seventh has six cells that never existed. The heading has to
      // describe what is actually drawn underneath it.
      el('p', { class: 'section-label' }, 'Trick by trick'),
      trickStrip(pub, myTeam),
      el('p', { class: 'rule-hint' }, successionNote(pub, r, mySeat)),
    ),

    el('div', { class: 'host-bar' },
      isOwner
        ? el('button', { class: 'btn btn-primary', type: 'button', onclick: intents.nextDeal },
            pub.matchOver ? 'SEE THE RESULT' : 'DEAL AGAIN')
        : el('p', { class: 'waiting-note' },
            pub.matchOver ? 'Waiting for the host…' : 'Waiting for the host to deal again.'),
      isOwner ? el('button', { class: 'btn btn-danger', type: 'button', onclick: intents.endMatch },
        'END THE MATCH') : null,
      app.error ? el('p', { class: 'prompt error' }, app.error) : null,
    ),

    logSection(pub, 6, myTeam),
  );
}

function dealDetail(pub, r, myTeam) {
  const took = r.tricksWon[r.winnerTeam];
  const suit = r.trumpSuit ? `${suitName(r.trumpSuit)} were trumps. ` : '';
  if (r.court !== null) {
    return `${suit}All seven opening tricks, with nothing on the other side. `
      + (pub.matchMode === 'race'
        ? `${pub.courts[r.court]} of ${pub.matchTarget}.`
        : 'A court settles a level match.');
  }
  return `${suit}${took} tricks to ${r.tricksWon[1 - r.winnerTeam]}, decided on trick ${r.trickCount}.`;
}

function tallyItem(num, label) {
  return el('div', { class: 'tally-item' },
    el('span', { class: 'tally-num' }, String(num)),
    el('span', { class: 'tally-label' }, label),
  );
}

/** Every trick of the deal just finished, as a scrubbable strip. Only ever
 *  shown once the deal is over — during play you get the last trick and your
 *  own memory, which is most of the game. */
function trickStrip(pub, myTeam, side = (team) => (team === myTeam ? 'us' : 'them')) {
  return el('div', { class: 'trick-strip', 'data-keep-scroll': 'tricks' },
    ...pub.tricks.map((t, i) => el('div', {
      class: 'trick-cell',
      style: teamStyle(t.winnerTeam, myTeam),
      'aria-label': `Trick ${i + 1} to ${side(t.winnerTeam)}`,
    },
      el('span', { class: 'n' }, String(i + 1)),
      el('span', { class: 'w' }),
    )),
  );
}

/** The dealer rule, stated rather than left to be inferred. It is the one rule
 *  in Court Piece that depends on the PREVIOUS deal, so a table that has not
 *  played before will otherwise wonder why the deal did not move. */
function successionNote(pub, r, mySeat) {
  const next = pub.seats[r.nextDealerSeat];
  const who = r.nextDealerSeat === mySeat ? 'You deal' : `${next ? next.name : 'Next'} deals`;
  return r.dealerWon
    ? `${who} next — the dealer's team took the deal, so it passes one seat to the right.`
    : `${who} again — the dealer's team lost, so the same dealer redeals.`;
}

// --- Match over ------------------------------------------------------------

function matchOverScreen(app, intents) {
  const { pub, me } = app;
  const mySeat = Math.max(0, seatOfId(pub, me.id));
  const myTeam = teamOf(mySeat);
  const isOwner = pub.ownerId === me.id;
  const drawn = pub.matchDrawn;
  const weWon = pub.matchWinner === myTeam;

  return shell(
    wordmark(app, intents, { help: false }),

    el('div', {
      class: 'result-banner',
      style: teamStyle(drawn ? myTeam : pub.matchWinner, myTeam),
    },
      el('span', { class: 'result-kicker' }, 'Match over'),
      el('h1', { class: 'result-headline' },
        drawn ? 'Drawn' : (weWon ? 'You take the match' : 'They take the match')),
      el('p', { class: 'result-detail' }, matchDetail(pub, myTeam)),
      el('div', { class: 'tally' },
        tallyItem(pub.courts[myTeam], 'our courts'),
        tallyItem(pub.courts[1 - myTeam], 'their courts'),
        tallyItem(pub.dealsWon[myTeam], 'our deals'),
        tallyItem(pub.dealsWon[1 - myTeam], 'their deals'),
      ),
    ),

    el('div', { class: 'host-bar' },
      isOwner
        ? el('div', { class: 'btn-row' },
            el('button', { class: 'btn btn-primary', type: 'button', onclick: intents.newMatch },
              'PLAY AGAIN'),
            el('button', { class: 'btn', type: 'button', onclick: intents.endMatch },
              'BACK TO THE LOBBY'),
          )
        : el('p', { class: 'waiting-note' }, 'Waiting for the host.'),
      app.error ? el('p', { class: 'prompt error' }, app.error) : null,
    ),

    logSection(pub, 8, myTeam),
  );
}

function matchDetail(pub, myTeam) {
  if (pub.matchDrawn) {
    return `Level on deals at ${pub.dealsWon[0]} apiece and level on courts. `
      + 'Nobody separated anybody — which is a result, not a missing one.';
  }
  if (pub.matchMode === 'race') {
    const n = pub.courts[pub.matchWinner];
    return `${n} court${n === 1 ? '' : 's'} over ${pub.dealsPlayed} deal${pub.dealsPlayed === 1 ? '' : 's'}.`;
  }
  const win = pub.dealsWon[pub.matchWinner];
  const lose = pub.dealsWon[1 - pub.matchWinner];
  return win === lose
    ? `Level at ${win} deals each — the court decided it.`
    : `${win} deals to ${lose} over ${pub.dealsPlayed}.`;
}

// ---------------------------------------------------------------------------
// Watching — a TV in the room, or a fifth person on the sofa
//
// A device that dialled in with WATCH instead of JOIN. It holds no seat, so it
// is sent no private state at all (see stateFrameFor() in js/net.js) and
// everything below is drawn from `pub` alone: the cards on the table, how many
// each player still holds, the score, the rung once it is face up. That is
// exactly what somebody standing behind the table can see, which is what makes
// it safe to put on a screen all four players are looking at.
//
// ONE LAYOUT FOR EVERY PHASE, unlike a player's device. A phone swaps whole
// screens between the lobby, the table and the result because each one needs
// the whole phone. A TV is a scoreboard that stays up for the evening: the
// room code, the two teams and the log keep their places, and only the stage
// in the middle changes. Somebody glancing up from their hand should find the
// score where it was the last time they looked.
//
// NOBODY IS "YOU" AND NO SIDE IS "US". Seat 0 is drawn at the bottom because
// somebody has to be, team 0 takes the crimson because one of them has to, and
// every word that a player's device would write as "You", "We" or "They" is a
// name here. The rule for which words those are is teamLabel(), below.
// ---------------------------------------------------------------------------

/** The seat a watching screen draws at the bottom of the table. */
const WATCH_SEAT = 0;
/** The team it paints in --us. Nothing more than "the first one". */
const WATCH_TEAM = 0;
/** The seat it calls "You": none. Every seat index is >= 0, so nothing matches. */
const WATCH_SELF = -1;

/**
 * A team, named by the people on it: "Asha & Ravi".
 *
 * "Team 1" is what the engine would say, and it means nothing to a room —
 * nobody at a card table knows which team is the first one. The two names are
 * unambiguous, they are already on the seat plates, and "{team} win the deal"
 * reads correctly with a pair in it because the log's verbs are plural on
 * purpose (see _endDeal() in js/state.js).
 *
 * Exported, and pure, so the harness can pin it without a DOM.
 */
export function teamLabel(pub, team) {
  if (team === null || team === undefined) return 'Nobody';
  const names = pub.seats
    .filter((p, seat) => p && teamOf(seat) === team)
    .map((p) => p.name);
  return names.length ? names.join(' & ') : `Team ${team + 1}`;
}

function watchScreen(app, intents) {
  const { pub } = app;
  const side = (team) => teamLabel(pub, team);

  let stage;
  switch (pub.phase) {
    case PHASES.LOBBY:      stage = watchLobby(app, intents); break;
    case PHASES.DEAL_OVER:  stage = watchDealOver(pub, side); break;
    case PHASES.MATCH_OVER: stage = watchMatchOver(pub, side); break;
    default:                stage = watchTable(app);
  }

  return el('div', { class: 'shell tv' },
    watchHead(app, intents),
    el('div', { class: 'tv-body' },
      el('div', { class: 'tv-stage' }, stage),
      el('aside', { class: 'tv-side' },
        watchScores(pub),
        pub.lastTrick ? lastTrickPanel(pub, WATCH_SELF, WATCH_TEAM) : null,
        logSection(pub, 6, WATCH_TEAM, side),
      ),
    ),
  );
}

/**
 * The room code stays up for the whole match, not just the lobby. On a phone it
 * would be wasted space once play starts; on the one screen everybody can see
 * it is how a player who dropped finds the code to get back in.
 */
function watchHead(app, intents) {
  const { pub } = app;
  const down = !!app.reconnecting;
  return el('header', { class: 'tv-head' },
    wordmark(app, intents, { help: false }),
    el('span', {
      class: 'tv-code',
      'aria-label': `Room code ${(app.code || '').split('').join(' ')}`,
    }, app.code || '----'),
    el('span', { class: 'section-label' }, matchContext(pub)),
    el('div', { class: 'tv-head-right' },
      rungChip(app),
      el('span', { class: 'turn-state' + (down ? ' stale' : '') },
        down ? 'Reconnecting…' : 'Watching'),
      // The only control on the screen. A TV has nobody to press it, which is
      // fine — it is for the laptop driving the TV, at the end of the night.
      el('button', { class: 'btn btn-ghost tv-leave', type: 'button', onclick: intents.goHome },
        '✕ LEAVE'),
    ),
  );
}

/**
 * Both teams, always on screen: who they are, the tricks in this deal, and the
 * match standing underneath. A player's device splits those across two bars
 * and shows only one number per side at a time, because that is all a phone
 * has room for. Here there is room, and a spectator who walked in halfway has
 * no other way to learn any of it.
 */
function watchScores(pub) {
  const tricks = pub.tricksWon || [0, 0];
  // Before the first deal there are no tricks to count, and a pair of zeros
  // out of seven would be a score for a game that has not started.
  const dealing = pub.phase !== PHASES.LOBBY;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const card = (team) => el('div', {
    class: 'tv-team', style: teamStyle(team, WATCH_TEAM),
    'aria-label': `${teamLabel(pub, team)}: `
      + (dealing ? `${tricks[team]} of ${TRICKS_TO_WIN} tricks, ` : '')
      + `${plural(pub.courts[team], 'court')}, ${plural(pub.dealsWon[team], 'deal')}`,
  },
    el('div', { class: 'tv-team-text', 'aria-hidden': 'true' },
      el('span', { class: 'tv-team-name' }, teamLabel(pub, team)),
      el('span', { class: 'tv-team-match' },
        `${plural(pub.courts[team], 'court')} · ${plural(pub.dealsWon[team], 'deal')}`),
    ),
    dealing ? el('div', { class: 'tv-team-tricks', 'aria-hidden': 'true' },
      el('span', { class: 'num' }, String(tricks[team])),
      el('span', { class: 'of' }, `/${TRICKS_TO_WIN}`),
    ) : null,
  );

  return el('div', { class: 'tv-scores' }, card(0), card(1));
}

/** DEAL_FIVE, DECLARE_TRUMP, DEAL_REST and PLAY — the same four-in-one as a
 *  player's table screen, without the hand dock, because there is no hand. */
function watchTable(app) {
  const { pub } = app;
  return el('div', { class: 'tv-table' },
    tableGrid(app, WATCH_SEAT, WATCH_TEAM, WATCH_SELF),
    // promptLine() with no private state is already the spectator's caption:
    // every branch that says "you" is behind a check on `priv`. It is handed
    // the public state and nothing else, so a refusal or a dropped link meant
    // for a player cannot be read out to the room.
    app.reconnecting
      ? el('p', { class: 'prompt error' }, 'Connection lost — dialling back in.')
      : promptLine({ pub, error: null, reconnecting: false }, null),
  );
}

/** Before the match: the code at a size the far end of the sofa can read, and
 *  who has sat down so far. This is the screen the table gathers round. */
function watchLobby(app, intents) {
  const { pub } = app;
  const seated = pub.seats.filter(Boolean).length;
  return el('div', { class: 'tv-lobby' },
    el('p', { class: 'section-label' }, 'Join this table'),
    el('p', { class: 'tv-bigcode', 'aria-hidden': 'true' }, app.code || '----'),
    el('p', { class: 'subtitle' },
      'On your phone, open this site, tap JOIN A TABLE and enter the code.'),
    el('ul', { class: 'seat-list' },
      ...pub.seats.map((p, seat) => seatRow(app, intents, p, seat, WATCH_SELF, WATCH_TEAM, false)),
    ),
    rulesSummary(pub),
    el('p', { class: 'waiting-note' },
      seated < SEAT_COUNT
        ? 'Waiting for players. Empty seats are filled by bots when the host starts.'
        : 'Waiting for the host to start.'),
  );
}

function watchDealOver(pub, side) {
  const r = pub.dealResult;
  const courted = r.court !== null;
  return el('div', { class: 'tv-result' },
    el('div', { class: 'result-banner', style: teamStyle(r.winnerTeam, WATCH_TEAM) },
      el('span', { class: 'result-kicker' }, courted ? 'Court' : 'Deal over'),
      el('h1', { class: 'result-headline' + (courted ? ' court' : '') },
        courted ? `${side(r.court)} score a court` : `${side(r.winnerTeam)} win the deal`),
      el('p', { class: 'result-detail' }, dealDetail(pub, r, WATCH_TEAM)),
    ),
    el('p', { class: 'section-label' }, 'Trick by trick'),
    trickStrip(pub, WATCH_TEAM, side),
    el('p', { class: 'rule-hint' }, successionNote(pub, r, WATCH_SELF)),
    el('p', { class: 'waiting-note' },
      pub.matchOver ? 'Waiting for the host…' : 'Waiting for the host to deal again.'),
  );
}

function watchMatchOver(pub, side) {
  const drawn = pub.matchDrawn;
  return el('div', { class: 'tv-result' },
    el('div', {
      class: 'result-banner',
      style: teamStyle(drawn ? WATCH_TEAM : pub.matchWinner, WATCH_TEAM),
    },
      el('span', { class: 'result-kicker' }, 'Match over'),
      el('h1', { class: 'result-headline' },
        drawn ? 'Drawn' : `${side(pub.matchWinner)} take the match`),
      el('p', { class: 'result-detail' }, matchDetail(pub, WATCH_TEAM)),
    ),
    el('p', { class: 'waiting-note' }, 'Waiting for the host.'),
  );
}

// --- Log -------------------------------------------------------------------

/** `side` names a team for whoever is reading. A seated device says "We" and
 *  "They"; a watching screen has no "we" and names the two players instead. */
function logSection(pub, limit, myTeam, side = (team) => sideWord(team, myTeam)) {
  const lines = pub.log.slice(-limit);
  if (!lines.length) return null;
  return el('section', { class: 'log-section' },
    el('p', { class: 'section-label' }, 'What happened'),
    el('ul', { class: 'log-list' },
      // Newest first: the interesting line is the last one, and a phone should
      // not need scrolling to reach it.
      ...lines.slice().reverse().map((line, i) => el('li', {
        class: ['log-line', i === 0 ? 'latest' : '', line.kind].filter(Boolean).join(' '),
      },
        el('span', { class: 'kind' }, line.kind === 'info' ? '' : line.kind),
        el('span', {}, logText(line, side)),
      )),
    ),
  );
}

// ---------------------------------------------------------------------------
// Screen reader
//
// One announcement per genuine change, decided here rather than sprinkled
// through the views, because render() runs far more often than the game moves
// and four callers would each have to dedupe. announce() itself drops a repeat
// of the last message, so this can be called on every single draw.
// ---------------------------------------------------------------------------

/**
 * Armed while the rung is face-down, spent the moment it turns over.
 *
 * A flag rather than a comparison against the previous snapshot, because
 * render() is handed a fresh public state on every draw and the one before it
 * is already gone. announce()'s own dedupe is not enough on its own either: it
 * remembers only the single last message, so one turn line landing in between
 * would let the reveal be spoken twice.
 *
 * It cannot go stale across deals. Every Hidden Rung deal re-arms it the
 * instant declareTrump() sets trumpHidden, and a deal played face-up never
 * arms it at all — which is exactly right, because there is no reveal to
 * announce when nothing was hidden.
 */
let rungArmed = false;

function speak(app) {
  const { pub, priv } = app;
  if (!pub) return;

  if (pub.trumpHidden) rungArmed = true;

  // Spoken from this device's side of the table, exactly like the banner the
  // sighted player is looking at. A screen reader saying "Team 2 wins" while
  // the screen says "They win the deal" is two different accounts of the same
  // moment, and only one of them answers the question being asked.
  const myTeam = priv && priv.seat >= 0 ? teamOf(priv.seat) : null;
  // A watching screen has no side of its own, so it names the pair — the same
  // words its own banner is showing.
  const side = app.me && app.me.watching
    ? (team) => teamLabel(pub, team)
    : (team) => sideWord(team, myTeam);

  if (pub.phase === PHASES.MATCH_OVER) {
    announce(pub.matchDrawn ? 'The match is drawn.'
      : `${side(pub.matchWinner)} win the match.`);
    return;
  }
  if (pub.phase === PHASES.DEAL_OVER && pub.dealResult) {
    const r = pub.dealResult;
    announce(r.court !== null
      ? `Court. ${side(r.court)} took the opening seven tricks.`
      : `${side(r.winnerTeam)} win the deal, ${r.tricksWon[r.winnerTeam]} tricks to `
        + `${r.tricksWon[1 - r.winnerTeam]}.`);
    return;
  }
  if (pub.phase === PHASES.DECLARE_TRUMP && priv && priv.mustDeclare) {
    announce('You cut. Call the trump suit.');
    return;
  }
  // The rung turning face up, said once.
  //
  // This is the one thing on the play screen a sighted player gets for free and
  // a screen reader user does not: the chip in the header silently stops saying
  // HIDDEN and starts showing a suit, and nothing else on the page moves. It is
  // also the most consequential single fact in a Hidden Rung deal — a player
  // who has been sitting on a low card of the wrong suit all deal needs it now,
  // not when they next take a turn.
  //
  // Spoken even to the caller, who knew all along, but in different words:
  // "your rung is showing" is news to them, and hearing the neutral sentence
  // would leave them wondering whether something had gone wrong.
  if (rungArmed && pub.phase === PHASES.PLAY && !pub.trumpHidden && pub.trump) {
    rungArmed = false;
    const mine = priv && priv.seat === pub.callerSeat;
    const line = mine
      ? `Your rung is face up — ${suitName(pub.trump)}.`
      : `The rung is ${suitName(pub.trump)}.`;
    // Folded into ONE string rather than two announce() calls, because the
    // second would simply overwrite the first in the live region. And it has to
    // be folded rather than dropped: if this draw is also the draw that hands
    // this device the turn, there may never be another render to say so on.
    announce(priv && priv.isTurn ? `${line} Your turn.` : line);
    return;
  }
  if (pub.phase === PHASES.PLAY && priv && priv.isTurn) {
    // A dash, not a full stop: suitName() is lower case by design (it is built
    // for mid-sentence use everywhere else), so "Your turn. clubs led." starts
    // a sentence in lower case. Capitalising it here would mean a second casing
    // rule for one string; the dash makes it one sentence and the problem goes.
    announce(pub.ledSuit
      ? `Your turn — ${suitName(pub.ledSuit)} led.`
      : `Your turn to lead trick ${pub.trickNumber}.`);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function seatOfId(pub, id) {
  return pub.seats.findIndex((p) => p && p.id === id);
}

/**
 * Which side a team is, said from where this device is sitting: "We" or
 * "They". Always plural, so a caller can pick one verb form and be right both
 * ways ("We win" / "They win", "We took" / "They took").
 *
 * The neutral "Team 2" is the fallback, not the default — it is reached only
 * by a device with no seat, which is the one case where there is no "we".
 */
function sideWord(team, myTeam) {
  if (team === null || team === undefined) return 'Nobody';
  if (myTeam === null || myTeam === undefined || myTeam < 0) return `Team ${team + 1}`;
  return team === myTeam ? 'We' : 'They';
}

/** Fill the `{team}` token the engine leaves in log lines. See _say() in
 *  js/state.js for why the log ships the token rather than a team name. */
function logText(line, side) {
  if (!line.text.includes('{team}')) return line.text;
  return line.text.replace('{team}', side(line.team));
}

function ordinal(seat) {
  return ['first', 'second', 'third', 'fourth'][seat] || `${seat + 1}th`;
}
