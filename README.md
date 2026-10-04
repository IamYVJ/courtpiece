# Court Piece — Rang

A complete, **static** web implementation of *Court Piece* — also called
**Rang**, **Rung**, **Coat Piece** or **Kot Pees**. One player hosts from their
own browser tab; the other three join with a 4-character code — easiest when
everyone is on the same Wi-Fi, though it isn't required. All game logic and
authoritative state live in the host's tab — **no game server, no accounts, no
install** — and each player is sent the table plus only their own hand, so your
cards stay yours. Installable as a PWA.

There is no hotseat mode and there will not be one. Court Piece is a hidden-hand
game; passing one phone round the table is a different game with the same rules.

## How to play

Four players, two fixed teams, **partners sitting opposite**. You do not pick
your partner — the seat does.

The whole deck is dealt, thirteen cards each, ace high:

```
A K Q J 10 9 8 7 6 5 4 3 2
```

**Deal and play both run anticlockwise** — the next player is always the one on
your *right*. That single fact drives everything else below.

1. The **dealer** shuffles. The player to the dealer's **right** cuts, which
   makes that player the **trump-caller**. Dealer and caller are therefore
   always opponents, every deal, by construction.
2. The caller is dealt **five cards** and names the trump — the **rung** —
   **alone**, seeing nothing but those five. Nobody else has a card yet.
3. The rest of the deck goes out in **batches of four** until everyone holds
   thirteen.
4. The **caller leads trick one**.

Then it is thirteen tricks:

- **Follow the suit led if you can.**
- **If you cannot, play anything at all.** There is no obligation to trump. A
  discard is very often the better card, and the app will not nag you into
  ruffing.
- The highest **trump** takes the trick; if no trump was played, the highest
  card of the **suit led**. The winner leads the next trick.

**Seven tricks of thirteen wins the deal.** Once a team reaches seven the deal
is decided and play stops — the remaining tricks cannot change the answer.

### The court

Take the **opening seven tricks** — tricks 1 through 7, with the opponents on
nothing — and that is a **court** (*kot*, *kap*, *coat*). It is the thing the
game is named around and the only thing that scores.

It is also genuinely rare. The bot soak in
[`scripts/test-engine.mjs`](scripts/test-engine.mjs) plays a thousand
even-strength deals and courts about **6.6%** of them — roughly one deal in
fifteen. Every default in the app that depends on how often a court happens is
set from that measurement rather than from a guess.

One thing worth being precise about, because it is the easiest rule in the game
to get wrong: a team that loses trick one and then takes the next seven has won
the deal and has **not** scored a court. It has to be the opening seven.

### Who deals next

- Dealer's team **won** the deal → the deal passes **one seat to the right**.
- Dealer's team **lost** → the **same dealer** deals again.

A court does not change this. Some sources qualify the succession rule with
"without scoring a court", implying a court alters it, but none of them say
*how* — so rather than invent a variant, a court is deliberately irrelevant to
who deals next. That is a settled decision, not an unimplemented one.

## Game modes

The host sets two things in the lobby, before the first deal. That is the whole
configurable surface — everything else about Court Piece is fixed by the rules,
so there is nothing else honest to offer.

### Hidden Rung

| | |
| --- | --- |
| **Off (default)** | Classic. The caller names the trump out loud and everyone sees it from the start. |
| **On** | The caller chooses the trump **face-down**. It is in force immediately, but nobody else — including their own partner — knows what it is. |

Under Hidden Rung the suit is revealed the moment **the first player who cannot
follow suit** plays a card, whatever they play. That player has just proved they
are void, which is the trigger; the rung turns face up for everyone at once, the
log records it in amber, and screen readers are told — that reveal is the one
piece of news on the play screen a sighted player gets for free, since the chip
in the header silently changes and nothing else moves.

**A player with devtools open cannot read it early.** The real suit lives in
host-private state and `publicState()` substitutes `null` for it while the rung
is hidden, exactly the same discipline that hides hands. There is a test that
fails if it ever appears in a broadcast payload before the reveal.

The bots play in the same fog you do — `chooseCard()` is handed the public state
and *one* player's private view and nothing else, so a bot that did not call the
trump learns the suit at the same instant everybody else does. There is a test
for that too.

### How the match ends

A court is the only thing that scores, so how a match ends is entirely a
question about courts. There are two defensible answers and the host picks:

| Mode | What it is | Default |
| ---- | ---------- | ------- |
| **Race** | First team to N courts. | **1 court** |
| **Deals** | Play N deals; most **deals won** takes it, courts break a tie. | **8 deals** |

Neither is the "real" rule — the sources say "most courts over an agreed number
of deals" and tables plainly play it both ways.

**Race defaults to one court, which looks timid and is not.** At the measured
6.6% court rate the median match runs **11 deals** to first-to-one, **39** to
first-to-two and **62** to first-to-three. Two courts is a three-hour sitting on
a phone. One court is also the more faithful reading: a court is the whole point
of the game, and making it the finish line rather than a milestone on the way to
one is what gives it its weight. Longer targets (2, 3, 5) stay on the menu for
tables that want the evening.

**Deals mode ranks deals won first and courts second**, and that order matters
more than it sounds. Ranking on courts first decides almost nothing: 62% of
eight-deal matches end nil–nil on courts, so the "tie-break" would quietly be
settling nearly two matches in three. Deals won is also the number the table has
actually been counting all evening. Courts now settle 4–4, which is the one
place the deal count genuinely cannot separate two teams.

Level on deals *and* level on courts is reported as a **draw**. There is no
sudden-death decider, because the entire selling point of deals mode is a known
length.

## The play screen

A phone cannot show four hands, a trick and a scoreboard at once, so the two
things you need *continuously* are pinned to opposite edges and never scroll
away: a strip across the top with whose turn it is, the score, the rung and the
last trick; your hand docked along the bottom. The four seats and the trick in
progress sit between them, laid out the way they are round a real table — your
partner opposite, your opponents left and right.

- **Playing a card is two taps.** Tap a card to select it, then tap the confirm
  button, which names the card back to you — **PLAY 10♠**. On a phone, in a
  game where a misplay cannot be taken back, a single tap in a row of thirteen
  overlapping cards is not a decision, it is an accident waiting to happen.
- Cards you may not play are **greyed out and inert**, and each carries the
  reason — *"Queen of hearts, cannot play, must follow clubs"* — so a screen
  reader gets the explanation the colour gives everyone else. Off-turn every
  card is tappable, because picking one up to look at it is not a move.
- The hand **wraps naturally** and gaps between suits, so thirteen cards read as
  four runs rather than one row you have to count along.
- The last completed trick is one tap away behind a **LAST** chip rather than
  permanently on screen. While a trick is live there is exactly one that
  matters, and it is the one in front of you.
- The move log appears on the lobby, deal-over and match-over screens. Lines
  that are *events* are colour-tagged — amber for the two rung lines, crimson
  for the two that end something — and everything else stays muted, so the
  colour means something.

Greying out an illegal card is a courtesy that mirrors the host's check. It is
never the enforcement point: the follow-suit rule is applied on the host, to the
hand the host holds, on every single play.

## Bots

**+ BOT** on an empty chair in the lobby seats a computer player. You can start
a table with anything from one to four humans; bots take whatever is left.

The reason they exist is that Court Piece is *exactly* four players — not "four
is best", four is the game, because fixed partnerships sitting opposite is what
the whole thing is built on. Three friends in a room cannot start. A fourth
player walking out does not degrade the game, it stops it.

A bot is an ordinary player in every way that matters: it takes a seat, takes
its team from that seat, is dealt from the same deck, and plays through the same
rules the app enforces for you. It cannot see anyone else's cards, and it never
computes what is legal — it only ranks the moves it was already offered, so it
cannot produce an illegal play even if the ranking is wrong. There is one skill
level, deliberately. It pauses about a second and a half before moving, so the
table can see whose turn it was and what they did before the next card lands.

**A bot also covers an absent human.** This game has no pass, no skip and no
turn timer, and it cannot be played three-handed — so a player whose phone locks
does not slow the table down, they stop it permanently for the other three.
After ten seconds offline a bot plays that seat's card. The seat is **covered,
never converted**: it keeps its name, keeps its `clientId`, still shows as
offline, and the moment that player reconnects they take the next turn
themselves.

One thing to know before you rely on them: **bots stop when the host's screen
does.** A bot moves when the machine running the game ticks, and that machine is
the host's browser tab — so if the host switches apps or their phone locks, the
table waits on one device until that screen comes back. Nothing in the app can
fix that; a backgrounded tab is not allowed to run. Host from the device least
likely to go to sleep.

## Hosting & joining

1. The **host** opens the site, enters a name, and taps **HOST A TABLE**. A
   4-character room code appears — share it with the table.
2. **Players** open the same site, enter a name, tap **JOIN A TABLE**, type the
   code, and tap **JOIN**.
3. The host seats bots on any empty chairs, picks the rules, and taps
   **START THE MATCH**.

> Everyone must be reaching the same URL — share the link, not a screenshot of
> the code.

A host who reloads, or whose phone blips off Wi-Fi, comes back at the same
address: the host's peer id is derived from the room code. The other three keep
their table on screen behind a banner and retry for a little over half a minute
rather than being told the game is over. A seat is reclaimed by the rejoining
device's secret `clientId`, never by the name printed above it.

## Watching on a TV

A fifth screen — a TV, a laptop on the sideboard, somebody on the sofa — can
show the table without sitting at it. On that device open the site, tap
**WATCH A TABLE**, type the room code and tap **WATCH**. No name is needed, and
it can join before the match or halfway through a deal.

It shows the table from above: the four seats, the cards as they are played,
both teams' tricks and match standing, the last trick, the log, and the room
code so a player who dropped can find their way back in. On a wide screen it
fills the display and scales with it; on a phone it is one column.

**It never shows anybody's cards**, and under Hidden Rung it does not show the
trump until the table has seen it. A watching screen is sent the public table
and nothing else — the same frame a player gets, with the private half left
out — so it is safe to put where all four players are looking. It also cannot
play a card or press a host control: it holds no seat, and the engine refuses
anything that does not come from one.

The lobby tells the players when a screen is watching. Up to four can watch a
table. A watching screen keeps the display awake where the browser allows it,
and picks the table back up by itself after a reload.

## Project layout

```
index.html              app shell (loads PeerJS + fonts, registers the SW)
manifest.webmanifest    PWA manifest (relative paths, for /repo/ subpaths)
sw.js                   service worker — precaches the shell, then stale-while-
                          revalidate (bump CACHE when imports change; never
                          caches /health or the visitor beacon, because a
                          cached "yes" and a replayed hit are both lies)
css/styles.css          dark felt theme, crimson accent
js/
  rules.js              ← ALL rule constants — the deck, the table, the court,
                          the two match modes and the four host-configurable
                          keys — plus pure logic. Imports nothing, from anywhere
  cards.js              the deck: build, shuffle, deal in packets, sort a hand
  trick.js              ← seating and trick resolution: who is next round an
                          ANTICLOCKWISE table, which cards are legal, who won
  state.js              host-authoritative engine / phase machine, and the
                          public/private split that keeps hands — and a hidden
                          rung — out of the broadcast. No timers: `now` is a
                          parameter, so a host reload rehydrates from a snapshot
  intents.js            ← the one intent dispatcher, so a move from a peer and a
                          move from a bot take the same path
  guards.js             ← the bounds on anything from another device (token
                          bucket, 64 KiB frame cap, frame shape, card and id
                          validation). A room code is reachable from the public
                          internet, so the host tab is guarded like a server
  bot.js                ← chooseCard() and chooseTrump() are pure functions of
                          the two views the engine already emits, plus the paced
                          driver that also covers an absent human's seat
  net.js                PeerJS transport (BROKER_CONFIG at the top), broker
                          recovery, connection ceiling, half-open reaper, and
                          the `peer:` prefix that stops a peer claiming to be
                          the host
  ui.js                 rendering (pure view layer) + the screen-reader voice
  util.js               room code, clipboard, persistence, clientId, DOM helpers
  config.js             ← the server-mode seam: both URLs blank, so server mode
                          does not exist. It is here so that "who is
                          authoritative" never leaks into the other eleven files
  main.js               controller wiring net + engine + bots + UI together
icons/                  app icons (svg source + generated png, both committed)
scripts/
  gen-icons.js          regenerates the PNG icons (node, no deps — a hand-rolled
                          PNG encoder over zlib)
  test-engine.mjs       headless tests — see below
package.json            npm test / npm run icons (no dependencies)
```

Every path in the repo is **relative**, because this is published to a GitHub
Pages subpath. A leading slash works perfectly on localhost and 404s for every
real visitor. There is a test for that.

The one third-party thing on the page is the PeerJS bundle, loaded from a CDN as
a `<script>` tag rather than an npm dependency, because there is no build step
and PeerJS ships as a UMD bundle. It is pinned to an exact version with no
range, deliberately: a floating tag would let a third party change the code that
handles every byte from every other device. If it fails to load, the game still
boots and says so.

## Tests

```
npm test            # node scripts/test-engine.mjs
npm run icons       # regenerate icons/*.png from the same source as icon.svg
npm run serve       # python -m http.server 8000
```

No framework and no install: a couple of assertion helpers and a seeded LCG
standing in for `crypto.getRandomValues`, so a deal is reproducible and a
failure is a fixed sequence of plays rather than a story about one. Around 1400
assertions covering the deck and trick resolution, the phase machine, the intent
dispatcher, the frame guards, and the two id spaces the transport keeps apart.

Three things it checks that are easy to get wrong and invisible when you do:

- **Hands and a hidden rung never appear in a broadcast payload.** Asserted
  against the real `publicState()` output, not against the intent.
- **A bot that did not call the trump cannot see it.** The test fails if the
  hidden suit reaches a non-caller's decision.
- **The service worker's precache list matches the real import graph.** Every
  `js/` file on disk is in `SHELL`, every relative import resolves, and the
  pinned CDN URL in `index.html` is the same one `sw.js` caches. One missing
  module is a dead app offline, and the symptom is a blank page on somebody's
  phone with a console error nobody will ever see.

Then two soaks: a thousand bot-vs-bot deals per mode — which is where the 6.6%
court rate comes from — and two hundred deals per match mode played with random
*legal* moves, asserting that every illegal play offered is refused and that
both ways of ending a match terminate.

## Not in this version

Named here so it is clear they were considered and left out, rather than
forgotten:

- **Double Sir** and **Be-Ranga Double Sar** — the variants where a player who
  sweeps consecutive tricks claims them back.
- **Hotseat.** See the top of this file.
- **Turn timers**, match history across sessions, and a server backend.
- **A watching screen that shows the hands.** The TV view shows what the table
  can see and no more; a broadcast view with all four hands face up would have
  to be kept out of the players' sight, and there is no way to enforce that.

---

*Court Piece* is a traditional card game with no single owner. This is a
non-commercial implementation for playing with friends.
