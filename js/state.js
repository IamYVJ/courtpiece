// ============================================================================
// state.js — The authoritative Court Piece engine.
//
// HOST-AUTHORITATIVE, WITH A PUBLIC/PRIVATE SPLIT
//   One device owns this object and validates every intent. Each player is sent
//   publicState() plus privateStateFor(theirId) — never another player's cards.
//   The follow-suit check happens HERE; the greyed-out cards in the UI are a
//   courtesy that mirrors this, never the enforcement point.
//
//   The host can see every hand. That is the same accepted trade-off as
//   sequence: there is no server, so somebody's tab has to hold the deck. We
//   don't build anti-cheat for it, and we don't make it worse.
//
// isHost VERSUS isOwner
//   They are NOT the same thing and are kept apart from day one, because
//   conflating them is what forced the painful rework in sequence.
//
//     isHost  — "this tab runs the game". A property of the runtime, not of the
//               game, so it does not appear in this file at all. It lives in
//               js/main.js. When a server exists, the server is the host and no
//               tab is.
//     ownerId — "who holds the room's controls". A property of the GAME, so it
//               lives here, and js/intents.js gates the owner intents on it.
//
//   Today the owner happens to be sitting at the host's tab. Nothing in here
//   assumes that, which is the entire point.
//
// NO TIMERS IN THIS FILE
//   Same rule as sequence, for the same three reasons: the engine is serialized
//   to localStorage and rehydrated after a host reload, it must behave
//   identically under a browser tab and a future server, and the test suite
//   plays thousands of deals as fast as it can. Time arrives as a parameter.
//   The two dealing phases carry a `phaseAt` stamp, a completed trick carries a
//   `trickAt` stamp, and all three are advanced by tick(), which whoever owns
//   the engine calls from the interval it already runs.
//
// Node-safe: imports only rules.js, trick.js and cards.js, none of which touch
// the DOM.
// ============================================================================

import {
  SEAT_COUNT, SUITS, HAND_SIZE, DEAL_BATCHES, TRICKS_TO_WIN, TRICKS_PER_DEAL,
  DEFAULTS, normalizeConfig, cleanName, courtTeam, decideMatch, suitOf, suitName,
} from './rules.js';
import {
  nextSeat, partnerOf, teamOf, seatsFrom, legalPlays, canPlay, illegalReason,
  ledSuitOf, trickWinner,
} from './trick.js';
import {
  buildDeck, shuffle, dealPacket, emptyHands, sortHand,
} from './cards.js';

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  DEAL_FIVE: 'dealFive',
  DECLARE_TRUMP: 'declareTrump',
  DEAL_REST: 'dealRest',
  PLAY: 'play',
  DEAL_OVER: 'dealOver',
  MATCH_OVER: 'matchOver',
});

/**
 * How long the two dealing phases are held before advancing themselves.
 *
 * Not a timer — a duration compared against a `now` handed to tick(). The
 * phases exist so the deal is something you watch happen rather than a hand
 * that appears; without the pause, DEAL_FIVE and DEAL_REST would be states no
 * eye ever sees and the phase machine would be lying about them.
 */
export const DEAL_PAUSE_MS = 1000;

/**
 * How long a completed trick stays on the table before it is gathered in.
 *
 * The same mechanism as DEAL_PAUSE_MS, for the same reason. Without the hold
 * the fourth card and the cleared table go out in one broadcast, so the card
 * that decided the trick is the one card nobody at the table ever sees.
 *
 * Scoring waits for the hold as well: the trick count, the next lead and the
 * end of the deal all happen when tick() gathers the trick in, so the numbers
 * do not move while the cards that move them are still face up.
 */
export const TRICK_PAUSE_MS = 1200;

/** Names for bots filling empty seats. Flavoured, and deliberately not
 *  human-looking, so nobody spends a deal wondering who they are playing. */
const BOT_NAMES = Object.freeze(['Rung Bot', 'Hukum Bot', 'Sarr Bot', 'Kot Bot']);

const LOG_CAP = 40;

export class GameEngine {
  constructor() { this.reset(); }

  reset() {
    this.phase = PHASES.LOBBY;

    /** Who holds the room's controls. See the isHost/isOwner note at the top. */
    this.ownerId = null;

    // Exactly four seats, indexed 0..3, numbered CLOCKWISE (see js/trick.js).
    // A null is an empty seat. Seats are an ARRAY OF FIXED LENGTH rather than a
    // growable player list, because in this game the seat is the primary thing:
    // a player's team is teamOf(seat) and their partner is partnerOf(seat), so a
    // list that could be reordered would silently re-partner the table.
    this.seats = Array.from({ length: SEAT_COUNT }, () => null);

    this.config = { ...DEFAULTS };

    // --- match ---------------------------------------------------------
    this.courts = [0, 0];          // courts scored, indexed by team
    // Deals taken, indexed by team. Not a scoring line — only courts score —
    // but it is the tie-break in DEALS mode and the DEAL_OVER screen wants it
    // anyway, so it is counted from the start rather than reconstructed.
    this.dealsWon = [0, 0];
    this.dealsPlayed = 0;

    // `matchOver` and `matchWinner` are SEPARATE because a DEALS-mode match can
    // finish level on both courts and deals, which is a genuine draw: over, and
    // with no winner. Collapsing them would make a draw indistinguishable from
    // a match still in progress, and the table would sit at DEAL_OVER forever.
    this.matchOver = false;
    this.matchWinner = null;       // 0 | 1, or null for a draw / not yet decided

    // --- deal ----------------------------------------------------------
    this.dealerSeat = 0;
    // The player to the dealer's RIGHT, who cuts, calls trump and leads trick
    // one. Because play runs anticlockwise this is nextSeat(dealer), which is
    // also why the dealer and the caller are always opponents.
    this.callerSeat = 0;

    this.hands = emptyHands();     // HOST-PRIVATE. Never in publicState().
    this.stock = [];               // HOST-PRIVATE. Undealt remainder.

    // The real trump, in force from the moment it is declared.
    //
    // HOST-PRIVATE WHILE `trumpHidden` IS TRUE. publicState() substitutes null
    // for it, so a player with devtools open reads nothing. This is the same
    // discipline as hiding hands, and it is tested the same way.
    this.trumpSuit = null;
    this.trumpHidden = false;

    // Team that took each trick, in trick order. tricksWon and the court check
    // are both derived from this rather than counted alongside it, so they
    // cannot drift out of step with each other.
    this.trickWinners = [];
    this.trick = [];               // [{ seat, code }] of the trick in progress
    this.turnSeat = 0;
    // When the fourth card of `trick` landed. Only meaningful while the trick
    // is full and waiting out TRICK_PAUSE_MS; see tick().
    this.trickAt = 0;

    // Every completed trick this deal, oldest first, as
    // { plays: [{ seat, code }], winnerSeat, winnerTeam }.
    //
    // PUBLIC, unlike hands and the hidden trump. Every one of these cards was
    // played face-up in front of four people, so withholding it would only
    // handicap whoever was not writing things down — which in practice means
    // the bots, who have no memory between turns and reconstruct what they know
    // from this array. See js/bot.js.
    this.tricks = [];
    this.lastTrick = null;         // the one on top of `tricks`, for the UI

    this.dealResult = null;        // filled in at DEAL_OVER
    this.phaseAt = 0;              // when the current phase was entered
    this.log = [];
  }

  // =========================================================================
  // Seating
  // =========================================================================

  /**
   * Seat a player, or hand a seat back to someone reconnecting.
   *
   * WHO OWNS A SEAT
   *   A seat in progress belongs to a `clientId` — a random secret the joining
   *   device keeps in its own localStorage and never shows on screen — not to
   *   the display name above it. The name is how humans find each other at the
   *   table; it is not a credential, because everyone can see it.
   *
   *   This matters more here than in sequence. A four-player trick game with a
   *   dropped seat is not a degraded game, it is a stopped one, so reclaiming
   *   has to work on the first try and has to be impossible to steal. PeerJS
   *   signalling is a public broker, so anyone who guesses a four-character
   *   room code can reach this host and type any name they like.
   *
   *   In the LOBBY a name reclaim is still allowed: no cards have been dealt,
   *   so the worst case is a seat, and a device that has genuinely lost its
   *   clientId can still get back in before the deal.
   */
  addPlayer(id, name, { clientId = null, isOwner = false } = {}) {
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'Enter a name first.' };

    // The clientId is checked first and on its own: a returning device is
    // entitled to its seat even under a different display name, and that lookup
    // must not be reachable by choosing a name.
    const ownedSeat = clientId ? this._seatByClientId(clientId) : -1;
    const namedSeat = this._seatByName(clean);
    const seat = ownedSeat >= 0 ? ownedSeat : namedSeat;

    if (seat >= 0) {
      const player = this.seats[seat];

      // Mid-deal, a name is not enough. Refused with the same wording whichever
      // way it failed, so an attacker learns nothing from the message and the
      // honest case that lands here — two people who typed the same name — is
      // exactly what it says.
      if (this.phase !== PHASES.LOBBY && seat !== ownedSeat
          && player.clientId && player.clientId !== clientId) {
        return { ok: false, error: 'Someone in this game is already using that name.' };
      }

      const prevId = player.id;
      player.id = id;
      player.online = true;
      // A seat with no clientId recorded is one restored from a snapshot; it
      // binds the first clientId offered rather than locking the device out of
      // its own game.
      if (clientId) player.clientId = clientId;
      // A reclaim may arrive under a new name, and the table should show the
      // name the device is actually using — but only if it is free. Two
      // identical names at one table is worse than one stale one.
      if (namedSeat < 0 || namedSeat === seat) player.name = clean;
      // A human reclaiming a seat that was being covered stops being a bot.
      player.isBot = false;
      if (isOwner) this.ownerId = id;
      if (this.ownerId === prevId) this.ownerId = id;
      return { ok: true, seat, reconnected: true, prevId };
    }

    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: 'That game has already started.' };
    }

    // An empty seat first; failing that, take a bot's. Bots are placeholders for
    // absent humans, so a human arriving should always beat one to a chair.
    let target = this.seats.findIndex((p) => p === null);
    if (target < 0) target = this.seats.findIndex((p) => p && p.isBot);
    if (target < 0) return { ok: false, error: 'This game is full (4 players).' };

    this.seats[target] = { id, name: clean, clientId, online: true, isBot: false };
    if (isOwner) this.ownerId = id;
    return { ok: true, seat: target, reconnected: false };
  }

  _seatByClientId(clientId) {
    return this.seats.findIndex((p) => p && p.clientId === clientId);
  }

  _seatByName(name) {
    const lower = name.toLowerCase();
    return this.seats.findIndex((p) => p && p.name.toLowerCase() === lower);
  }

  seatOf(playerId) {
    return this.seats.findIndex((p) => p && p.id === playerId);
  }

  getPlayer(playerId) {
    const seat = this.seatOf(playerId);
    return seat < 0 ? null : this.seats[seat];
  }

  /** All four cards are down and the trick is being held on the table. Nobody
   *  is on turn until tick() gathers it in. */
  get trickComplete() {
    return this.trick.length >= SEAT_COUNT;
  }

  get currentPlayer() {
    return this.phase === PHASES.PLAY && !this.trickComplete ? this.seats[this.turnSeat] : null;
  }

  /** Mark a device gone. The seat is KEPT — it is theirs to reclaim, and in a
   *  four-handed game emptying it would end the deal for everybody. Bots cover
   *  an offline seat so play continues; see the driver in js/bot.js. */
  disconnect(playerId) {
    const seat = this.seatOf(playerId);
    if (seat < 0) return;
    if (this.phase === PHASES.LOBBY) { this.seats[seat] = null; return; }
    this.seats[seat].online = false;
  }

  /** Seat a bot in a specific empty seat, or the first one going spare. */
  addBot(seat = -1) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The match has already started.' };
    const target = seat >= 0 && seat < SEAT_COUNT && !this.seats[seat]
      ? seat
      : this.seats.findIndex((p) => p === null);
    if (target < 0) return { ok: false, error: 'Every seat is taken.' };

    const taken = new Set(this.seats.filter(Boolean).map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) || `Bot ${target + 1}`;
    // No clientId: there is no device to give one to, which is also what keeps
    // a bot out of the reclaim lookup and out of any future server's seat map.
    this.seats[target] = {
      id: `bot:${target}:${Math.random().toString(36).slice(2, 8)}`,
      name, clientId: null, online: true, isBot: true,
    };
    return { ok: true, seat: target };
  }

  removeBot(seat) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The match has already started.' };
    const player = this.seats[seat];
    if (!player || !player.isBot) return { ok: false, error: 'That is not a bot.' };
    this.seats[seat] = null;
    return { ok: true };
  }

  /** Swap two seats. The only seating control that matters in this game: who
   *  sits opposite whom IS who partners whom, and that is worth choosing. */
  swapSeats(a, b) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The match has already started.' };
    if (!this._validSeat(a) || !this._validSeat(b) || a === b) {
      return { ok: false, error: 'Pick two different seats.' };
    }
    [this.seats[a], this.seats[b]] = [this.seats[b], this.seats[a]];
    return { ok: true };
  }

  _validSeat(s) { return Number.isInteger(s) && s >= 0 && s < SEAT_COUNT; }

  setConfig(patch) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The match has already started.' };
    this.config = normalizeConfig({ ...this.config, ...patch });
    return { ok: true };
  }

  // =========================================================================
  // Starting a match
  // =========================================================================

  startMatch(actorId, now = 0) {
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'The match has already started.' };
    if (actorId !== this.ownerId) return { ok: false, error: 'Only the host can start the match.' };
    if (!this.seats.some((p) => p && !p.isBot)) {
      return { ok: false, error: 'Somebody real has to be at the table.' };
    }

    // Fill what is left with bots. Four seats is not negotiable in Court Piece,
    // so "start with fewer" is not a thing that can be offered.
    while (this.seats.some((p) => p === null)) {
      const res = this.addBot();
      if (!res.ok) return res;
    }

    this.courts = [0, 0];
    this.dealsWon = [0, 0];
    this.dealsPlayed = 0;
    this.matchOver = false;
    this.matchWinner = null;
    this.log = [];
    // A random first dealer, through shuffle() so the seeded RNG in the test
    // harness governs it and a failing match can be replayed.
    this.dealerSeat = shuffle([0, 1, 2, 3])[0];
    this._beginDeal(now);
    return { ok: true };
  }

  _beginDeal(now) {
    this.callerSeat = nextSeat(this.dealerSeat);

    this.hands = emptyHands();
    this.stock = shuffle(buildDeck());
    this.trumpSuit = null;
    this.trumpHidden = false;
    this.trickWinners = [];
    this.trick = [];
    this.tricks = [];
    this.lastTrick = null;
    this.dealResult = null;

    // The first packet: five cards each, dealt to the dealer's right first.
    ({ hands: this.hands, stock: this.stock } =
      dealPacket(this.stock, this.hands, DEAL_BATCHES[0], this.callerSeat));

    this.turnSeat = this.callerSeat;
    this._enter(PHASES.DEAL_FIVE, now);
    this._say(`${this._name(this.dealerSeat)} deals. ${this._name(this.callerSeat)} cuts and calls.`);
  }

  /**
   * Advance the phases that pass on their own.
   *
   * Called from the interval whoever owns the engine already runs for the bots.
   * Returns true when something changed and the caller should broadcast.
   */
  tick(now) {
    if (this.phase === PHASES.DEAL_FIVE && now - this.phaseAt >= DEAL_PAUSE_MS) {
      this._enter(PHASES.DECLARE_TRUMP, now);
      return true;
    }
    if (this.phase === PHASES.DEAL_REST && now - this.phaseAt >= DEAL_PAUSE_MS) {
      this._enter(PHASES.PLAY, now);
      return true;
    }
    if (this.phase === PHASES.PLAY && this.trickComplete
        && now - this.trickAt >= TRICK_PAUSE_MS) {
      this._resolveTrick(now);
      return true;
    }
    return false;
  }

  // =========================================================================
  // Declaring trump
  // =========================================================================

  /**
   * The trump-caller names a suit, having seen five cards and nobody else's.
   *
   * No consultation: this is checked by seat, so a partner sending the message
   * is refused rather than quietly accepted, whatever the UI on their device
   * happens to be showing.
   */
  declareTrump(actorId, suit, now = 0) {
    if (this.phase !== PHASES.DECLARE_TRUMP) return { ok: false, error: 'It is not time to call trump.' };
    const seat = this.seatOf(actorId);
    if (seat !== this.callerSeat) return { ok: false, error: 'Only the player who cut calls trump.' };
    if (!SUITS.includes(suit)) return { ok: false, error: 'Pick a suit.' };

    this.trumpSuit = suit;
    // Under Hidden Rung the suit is in force immediately but stays out of
    // publicState() until somebody cannot follow suit. Classic announces it now.
    this.trumpHidden = !!this.config.hiddenRung;

    if (this.trumpHidden) {
      this._say(`${this._name(seat)} called trump face-down.`, 'trump');
    } else {
      this._say(`${this._name(seat)} called ${suitName(suit)} as trump.`, 'trump');
    }

    // The remaining eight cards, in two packets of four, dealt from the same
    // seat the first packet started at.
    for (let i = 1; i < DEAL_BATCHES.length; i++) {
      ({ hands: this.hands, stock: this.stock } =
        dealPacket(this.stock, this.hands, DEAL_BATCHES[i], this.callerSeat));
    }

    // The caller leads trick one.
    this.turnSeat = this.callerSeat;
    this._enter(PHASES.DEAL_REST, now);
    return { ok: true };
  }

  // =========================================================================
  // Trick play
  // =========================================================================

  playCard(actorId, code, now = 0) {
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'No trick is in progress.' };
    const seat = this.seatOf(actorId);
    if (seat < 0) return { ok: false, error: 'You are not at this table.' };
    // A full trick is still on the table. `turnSeat` is stale until tick()
    // gathers it in, so this has to be asked before the turn is.
    if (this.trickComplete) return { ok: false, error: 'The last trick is still on the table.' };
    if (seat !== this.turnSeat) return { ok: false, error: 'It is not your turn.' };

    const hand = this.hands[seat];
    const led = ledSuitOf(this.trick);
    // THE enforcement point. The client greys cards out to be helpful; this is
    // what actually decides, and it is the only thing a hostile peer meets.
    if (!canPlay(hand, code, led)) {
      return { ok: false, error: illegalReason(hand, code, led) || 'You cannot play that card.' };
    }

    // Playing off-suit is only legal when void, so an off-suit card IS the
    // proof that this player could not follow — which is exactly the trigger
    // Hidden Rung waits for. Checked before the card moves, while `led` is
    // still the suit that was led rather than the suit of a finished trick.
    if (this.trumpHidden && led && suitOf(code) !== led) {
      this.trumpHidden = false;
      this._say(
        `${this._name(seat)} could not follow ${suitName(led)} — trump is ${suitName(this.trumpSuit)}.`,
        'reveal',
      );
    }

    this.hands[seat] = hand.filter((c) => c !== code);
    this.trick.push({ seat, code });

    if (this.trick.length < SEAT_COUNT) {
      this.turnSeat = nextSeat(this.turnSeat);
      return { ok: true };
    }
    // The fourth card. NOT resolved here — it stays face up for TRICK_PAUSE_MS
    // and tick() resolves it, or the last card of every trick would be cleared
    // in the same broadcast that delivered it.
    this.trickAt = now;
    return { ok: true };
  }

  _resolveTrick(now) {
    const winnerSeat = trickWinner(this.trick, this.trumpSuit);
    const winnerTeam = teamOf(winnerSeat);

    this.trickWinners.push(winnerTeam);
    this.tricks.push({ plays: this.trick.slice(), winnerSeat, winnerTeam });
    // The same object, not a second copy of it: `lastTrick` means "the one on
    // top", and two independently-built records would be two things to keep in
    // step for no gain.
    this.lastTrick = this.tricks[this.tricks.length - 1];
    this.trick = [];
    // The trick winner leads the next one.
    this.turnSeat = winnerSeat;

    this._say(`${this._name(winnerSeat)} takes trick ${this.trickWinners.length}.`, 'trick');

    const counts = this._tricksWon();
    // Seven of thirteen decides it, and the remaining tricks cannot change who
    // won — so play stops here rather than dealing out a settled hand.
    if (counts[0] >= TRICKS_TO_WIN || counts[1] >= TRICKS_TO_WIN) {
      this._endDeal(counts[0] >= TRICKS_TO_WIN ? 0 : 1, now);
    }
  }

  _tricksWon() {
    const counts = [0, 0];
    for (const team of this.trickWinners) counts[team] += 1;
    return counts;
  }

  // =========================================================================
  // Ending a deal
  // =========================================================================

  _endDeal(winnerTeam, now) {
    const court = courtTeam(this.trickWinners);
    if (court !== null) this.courts[court] += 1;
    this.dealsWon[winnerTeam] += 1;
    this.dealsPlayed += 1;

    // WHO DEALS NEXT.
    //
    //   dealer's team won  -> the deal passes one seat to the right
    //   dealer's team lost -> the same dealer deals again
    //
    // A court does NOT change this. The sources qualify the rule with "without
    // scoring a court", implying a court alters succession, but they never say
    // how — so rather than invent a variant, a court is deliberately irrelevant
    // here. Settled; not an unimplemented TODO.
    const dealerWon = teamOf(this.dealerSeat) === winnerTeam;
    const nextDealerSeat = dealerWon ? nextSeat(this.dealerSeat) : this.dealerSeat;

    this._scoreMatch();

    this.dealResult = {
      winnerTeam,
      court,
      tricksWon: this._tricksWon(),
      trickCount: this.trickWinners.length,
      dealerSeat: this.dealerSeat,
      dealerWon,
      nextDealerSeat,
      // Carried so the UI can say it plainly rather than re-deriving a rule.
      trumpSuit: this.trumpSuit,
      courts: this.courts.slice(),
      dealsWon: this.dealsWon.slice(),
    };

    // Plural verbs throughout ("win", not "wins"): {team} is replaced with a
    // plural word on every device that has a seat — "We" or "They" — and a
    // side is a plural thing anyway.
    if (court !== null) {
      this._say('COURT! {team} took the opening seven tricks.', 'court', court);
    } else {
      this._say('{team} win the deal.', 'deal', winnerTeam);
    }
    if (this.matchOver) {
      if (this.matchWinner === null) {
        this._say('The match is drawn — level on courts and level on deals.', 'match');
      } else {
        this._say('{team} win the match.', 'match', this.matchWinner);
      }
    }

    this.dealerSeat = nextDealerSeat;
    // A deal ends when tick() gathers in the deciding trick, so there is a real
    // `now` to stamp with. Nothing reads it yet: DEAL_OVER is left by an owner
    // pressing a button, never by tick().
    this._enter(PHASES.DEAL_OVER, now);
  }

  /**
   * Has the match finished, and if so who took it?
   *
   * Called once per deal, AFTER the courts and deals have been counted. The two
   * modes are genuinely different questions — "has anyone got there yet" versus
   * "have we run out of deals" — so they are two branches rather than one
   * comparison with a swapped operand.
   */
  _scoreMatch() {
    if (this.config.matchMode === 'deals') {
      if (this.dealsPlayed < this.config.dealsToPlay) return;
      this.matchOver = true;
      this.matchWinner = decideMatch(this.courts, this.dealsWon);
      return;
    }
    // RACE: the first team to the court target, checked the moment they reach
    // it. No draw is possible — two teams cannot score the winning court in the
    // same deal, because only one team can take the opening seven tricks.
    if (this.courts[0] >= this.config.courtsToWin) { this.matchOver = true; this.matchWinner = 0; }
    else if (this.courts[1] >= this.config.courtsToWin) { this.matchOver = true; this.matchWinner = 1; }
  }

  /** Move on from DEAL_OVER: either the next deal, or the match result. */
  nextDeal(actorId, now = 0) {
    if (this.phase !== PHASES.DEAL_OVER) return { ok: false, error: 'The deal is not over.' };
    if (actorId !== this.ownerId) return { ok: false, error: 'Only the host can deal again.' };

    if (this.matchOver) {
      this._enter(PHASES.MATCH_OVER, now);
      return { ok: true };
    }
    this._beginDeal(now);
    return { ok: true };
  }

  /** A fresh match with the same table. Courts back to zero; seats untouched,
   *  because the people who just played each other are the people still there. */
  newMatch(actorId, now = 0) {
    if (this.phase !== PHASES.MATCH_OVER) return { ok: false, error: 'The match is not over.' };
    if (actorId !== this.ownerId) return { ok: false, error: 'Only the host can start a new match.' };
    this.courts = [0, 0];
    this.dealsWon = [0, 0];
    this.dealsPlayed = 0;
    this.matchOver = false;
    this.matchWinner = null;
    this.log = [];
    this._beginDeal(now);
    return { ok: true };
  }

  /** Abandon the match and go back to the lobby. */
  endMatch(actorId) {
    if (actorId !== this.ownerId) return { ok: false, error: 'Only the host can end the match.' };
    if (this.phase === PHASES.LOBBY) return { ok: false, error: 'No match is running.' };
    const seats = this.seats;
    const owner = this.ownerId;
    const config = this.config;
    this.reset();
    this.seats = seats;
    this.ownerId = owner;
    this.config = config;
    return { ok: true };
  }

  // =========================================================================
  // Logging
  // =========================================================================

  _enter(phase, now) {
    this.phase = phase;
    this.phaseAt = now;
  }

  _name(seat) {
    const player = this.seats[seat];
    return player ? player.name : `Seat ${seat + 1}`;
  }

  /**
   * `kind` lets the UI shout about the loud ones — a trump reveal and a court
   * both need to look like events, not like another line of history.
   *
   * `team` marks a line that names a side, and the text carries a `{team}`
   * token instead of a team number. One log goes to four devices, but "Team 2
   * wins the deal" is a sentence every reader has to translate into "us" or
   * "them" before it means anything — and this app otherwise never makes them
   * do that, because the palette makes your own side crimson wherever you are
   * sitting. So the log stays a single neutral record that all four devices
   * agree on, and the token is filled in on the way to the screen against the
   * seat the READING device holds. The engine still knows nothing about who is
   * looking at it.
   */
  _say(text, kind = 'info', team = null) {
    const entry = { text, kind };
    if (team !== null) entry.team = team;
    this.log.push(entry);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
  }

  // =========================================================================
  // Views sent over the wire
  // =========================================================================

  /**
   * What every device may see.
   *
   * Deliberately excludes `hands` and `stock`, and substitutes null for the
   * trump while it is hidden. Those three omissions are the whole privacy model
   * of this game, so they are asserted in the test suite rather than trusted.
   */
  publicState() {
    return {
      phase: this.phase,
      ownerId: this.ownerId,
      config: this.config,

      seats: this.seats.map((p, seat) => (p ? {
        id: p.id,
        name: p.name,
        seat,
        team: teamOf(seat),
        online: p.online,
        // Public, not private: everyone at the table is entitled to know which
        // of the other three is a computer before they agree to play.
        isBot: !!p.isBot,
        // How many cards are left in that hand, never which ones. Public
        // because anyone watching the table can count them anyway.
        handCount: this.hands[seat].length,
      } : null)),

      dealerSeat: this.dealerSeat,
      callerSeat: this.callerSeat,

      // THE HIDDEN RUNG BOUNDARY. While trumpHidden is true this is null, and
      // the real suit exists only in the host's own memory and its private
      // snapshot. Do not be tempted to send it "for the animation".
      trump: this.trumpHidden ? null : this.trumpSuit,
      trumpHidden: this.trumpHidden,

      trick: this.trick.slice(),
      // The led suit is public the instant the first card lands — everybody can
      // see it — and it does not leak the trump even when the two coincide.
      ledSuit: ledSuitOf(this.trick),
      lastTrick: this.lastTrick,
      // The cards already played this deal. Public because they were all played
      // face-up; see the note on `tricks` in reset(). Shallow copy, so a reader
      // cannot push onto the engine's own array.
      tricks: this.tricks.slice(),
      trickNumber: this.trickWinners.length + 1,
      tricksWon: this._tricksWon(),

      // Null while a completed trick is being held, as well as outside PLAY:
      // nobody is on turn until it is gathered in.
      turnSeat: this.phase === PHASES.PLAY && !this.trickComplete ? this.turnSeat : null,
      turnPlayerId: this.currentPlayer ? this.currentPlayer.id : null,

      courts: this.courts.slice(),
      dealsWon: this.dealsWon.slice(),
      dealsPlayed: this.dealsPlayed,
      // The match target, already resolved to the mode in force, so the UI and
      // the scoreboard do not each re-implement the branch.
      matchMode: this.config.matchMode,
      matchTarget: this.config.matchMode === 'deals'
        ? this.config.dealsToPlay
        : this.config.courtsToWin,
      dealsLeft: this.config.matchMode === 'deals'
        ? Math.max(0, this.config.dealsToPlay - this.dealsPlayed)
        : null,
      matchOver: this.matchOver,
      // null while the match runs AND when it ends level — read matchOver to
      // tell those apart. See decideMatch() in js/rules.js.
      matchWinner: this.matchWinner,
      matchDrawn: this.matchOver && this.matchWinner === null,
      dealResult: this.dealResult,

      phaseAt: this.phaseAt,
      log: this.log,
      startCheck: this._startCheck(),
    };
  }

  _startCheck() {
    const humans = this.seats.filter((p) => p && !p.isBot).length;
    if (!humans) return { ok: false, reason: 'Somebody real has to be at the table.' };
    const empty = this.seats.filter((p) => p === null).length;
    return {
      ok: true,
      humans,
      willSeatBots: empty,
      reason: empty ? `${empty} empty ${empty === 1 ? 'seat' : 'seats'} will be filled by bots.` : '',
    };
  }

  /**
   * One player's own cards, and what they may do with them.
   *
   * `legal` is computed here rather than on the client for the same reason the
   * hand is: the client is a convenience layer. A client that ignored it would
   * simply have its move refused by playCard().
   */
  privateStateFor(playerId) {
    const seat = this.seatOf(playerId);
    if (seat < 0) return null;

    const led = ledSuitOf(this.trick);
    const isTurn = this.phase === PHASES.PLAY && !this.trickComplete && seat === this.turnSeat;

    // Sorted with the trump the PLAYER is entitled to know — which under Hidden
    // Rung is nothing, even for the caller who chose it. Sort order is visible
    // information: a partner watching which end of your fan you play from can
    // infer where the trumps are, so trump-first sorting for the caller alone
    // would leak the secret out through their own hand. The caller gets
    // `trumpYouCalled` below as a discreet reminder instead.
    const shown = this.trumpHidden ? null : this.trumpSuit;
    const hand = sortHand(this.hands[seat], shown).map((code) => ({
      code,
      legal: isTurn && canPlay(this.hands[seat], code, led),
      reason: isTurn ? illegalReason(this.hands[seat], code, led) : null,
    }));

    return {
      seat,
      team: teamOf(seat),
      partnerSeat: partnerOf(seat),
      isTurn,
      isCaller: seat === this.callerSeat,
      isDealer: seat === this.dealerSeat,
      hand,
      // Only ever non-null for the one player who chose it, and only while it
      // is hidden — once revealed it is in publicState() like everything else.
      // They already know it; telling them back is not a leak, and after a
      // reload it is the only way their device can know what they called.
      trumpYouCalled: (this.trumpHidden && seat === this.callerSeat) ? this.trumpSuit : null,
      // Whether declaring is this device's job right now.
      mustDeclare: this.phase === PHASES.DECLARE_TRUMP && seat === this.callerSeat,
    };
  }

  // =========================================================================
  // Snapshot — HOST-PRIVATE, for surviving a reload
  // =========================================================================

  /**
   * The whole engine, hands and hidden trump included.
   *
   * This goes to the host's own localStorage and NOWHERE else. It is the only
   * place the hidden trump and the four hands are written down, which is why
   * the cache-reset button in index.html clears Cache Storage but never
   * localStorage — clearing it on the host's device ends the match for the
   * whole table.
   */
  serialize() {
    return {
      phase: this.phase,
      ownerId: this.ownerId,
      seats: this.seats,
      config: this.config,
      courts: this.courts,
      dealsWon: this.dealsWon,
      dealsPlayed: this.dealsPlayed,
      matchOver: this.matchOver,
      matchWinner: this.matchWinner,
      dealerSeat: this.dealerSeat,
      callerSeat: this.callerSeat,
      hands: this.hands,
      stock: this.stock,
      trumpSuit: this.trumpSuit,
      trumpHidden: this.trumpHidden,
      trickWinners: this.trickWinners,
      trick: this.trick,
      tricks: this.tricks,
      turnSeat: this.turnSeat,
      trickAt: this.trickAt,
      lastTrick: this.lastTrick,
      dealResult: this.dealResult,
      phaseAt: this.phaseAt,
      log: this.log,
    };
  }

  restore(snapshot) {
    if (!snapshot) return;
    this.reset();
    Object.assign(this, snapshot);
  }

  /**
   * Take ownership of a restored snapshot after the host's tab reloaded.
   *
   * The reload destroyed every peer connection, so the snapshot's `online`
   * flags all point at dead peer ids. They have to be cleared: addPlayer()
   * reads `online` to decide whether a name is taken, so leaving them set makes
   * every genuine rejoin look like an impostor and locks the whole table out of
   * the game just restored.
   *
   * Bots stay online through a reload — they had no connection to lose.
   */
  resumeAsOwner(ownerId) {
    this.ownerId = ownerId;
    for (const player of this.seats) {
      if (!player) continue;
      player.online = !!player.isBot || player.id === ownerId;
    }
  }
}

// Re-exported so callers that already import the engine do not have to reach
// past it into trick.js for the two helpers they always need alongside it.
export { teamOf, partnerOf, nextSeat, seatsFrom, legalPlays, HAND_SIZE, TRICKS_PER_DEAL };
