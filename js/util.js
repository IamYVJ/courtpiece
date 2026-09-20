// ============================================================================
// util.js — Small helpers shared across modules. No game logic here.
//
// Everything this file persists is namespaced `courtpiece.`, so a browser that
// has played several of these games keeps them apart. The namespace is not
// cosmetic: js/state.js binds a seat to the clientId below, and two games
// sharing one key would hand a player the wrong identity.
// ============================================================================

// Unambiguous alphabet: no O/0, no I/1, so a code read aloud across a table
// can't be mistyped by the person writing it down.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

export function generateRoomCode() {
  let code = '';
  const arr = new Uint32Array(CODE_LENGTH);
  (globalThis.crypto || window.crypto).getRandomValues(arr);
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Normalise a typed code: uppercase, then keep only alphabet characters. The
 *  look-alikes are not in the alphabet, so a typed O is DROPPED rather than
 *  silently guessed at as a zero — a code that is wrong by one character
 *  should fail to join, not join the wrong room. */
export function normalizeCode(raw) {
  return (raw || '')
    .toUpperCase()
    .split('')
    .filter((ch) => CODE_ALPHABET.includes(ch))
    .join('')
    .slice(0, CODE_LENGTH);
}

export { CODE_LENGTH };

// --- Clipboard -------------------------------------------------------------
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

// --- Lightweight persistence -----------------------------------------------
const NAME_KEY = 'courtpiece.name';
const CODE_KEY = 'courtpiece.lastCode';

export function loadName()  { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } }
export function saveName(n) { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} }
export function loadCode()  { try { return localStorage.getItem(CODE_KEY) || ''; } catch (_) { return ''; } }
export function saveCode(c) { try { localStorage.setItem(CODE_KEY, c); } catch (_) {} }

// ---------------------------------------------------------------------------
// Device identity
//
// A random 128-bit secret identifying THIS BROWSER to whichever machine is
// running the game, and the only thing a seat in progress is ever bound to.
//
// WHY IT HAS TO BE A SECRET AND NOT THE DISPLAY NAME. Anyone who has — or
// guesses — a four-character room code can connect and type any name they
// like, so a seat that can be reclaimed by naming it can be stolen by naming
// it. The tempting objection is that a peer-to-peer host only ever hears from
// the same Wi-Fi. It doesn't: PeerJS signalling goes through a broker on the
// public internet and the data channel falls back to a public relay. The host
// here is somebody's phone and it is reachable from anywhere.
//
// It is therefore treated like a credential. Never rendered, never logged,
// never put in a URL, never sent to anything except the machine running the
// game. Note what that rules out: it must not appear in publicState(), and the
// engine keeps `clientId` off the player objects it broadcasts for exactly
// that reason.
//
// GENERATED ONCE AND NEVER REGENERATED. There is no rotation and no expiry,
// because a fresh id is indistinguishable from a different device: the host
// would refuse the reclaim and lock a player out of their own seat mid-deal.
// This is also why the footer's "Clear cache & reload" button touches Cache
// Storage and service workers ONLY — see the comment on it in index.html.
//
// The character class matches validClientId() in js/guards.js exactly (8–64 of
// [A-Za-z0-9_-]), so a value that would be refused on arrival cannot be minted
// here, and a value that has been tampered with in localStorage is replaced
// rather than sent.
// ---------------------------------------------------------------------------
const CLIENT_KEY = 'courtpiece.clientId';
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Used only when localStorage is unavailable — private browsing, storage
// denied, a locked-down embedded webview. A per-tab identity still lets a
// connection that blips reclaim its own seat; it just doesn't survive a
// reload, which is the best that can be done with nowhere to write.
let volatileClientId = null;

function newClientId() {
  const bytes = new Uint8Array(16);   // 128 bits
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;   // 32 hex characters, comfortably inside the 8–64 bound
}

export function clientId() {
  try {
    const stored = localStorage.getItem(CLIENT_KEY);
    if (stored && CLIENT_ID_RE.test(stored)) return stored;
    const fresh = newClientId();
    localStorage.setItem(CLIENT_KEY, fresh);
    return fresh;
  } catch (_) {
    if (!volatileClientId) volatileClientId = newClientId();
    return volatileClientId;
  }
}

// --- Session resume --------------------------------------------------------
//
// Remembers whether this device was hosting or joining, the room code and the
// name, plus — for a host — a snapshot of the authoritative engine, so that a
// host reload rehydrates the game rather than ending it for everybody.
//
// Stale sessions expire. A reload the next morning should land in the lobby,
// not spend ten seconds trying to rejoin a game that ended before dinner.
const SESSION_KEY = 'courtpiece.session';
const ENGINE_KEY  = 'courtpiece.engine';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, ts: Date.now() })); } catch (_) {}
}
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.ts || (Date.now() - s.ts) > SESSION_TTL_MS) { clearSession(); return null; }
    return s;
  } catch (_) { return null; }
}
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(ENGINE_KEY); } catch (_) {}
}

export function saveEngineSnapshot(snap) {
  try { localStorage.setItem(ENGINE_KEY, JSON.stringify({ snap, ts: Date.now() })); } catch (_) {}
}
export function loadEngineSnapshot() {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.ts || (Date.now() - o.ts) > SESSION_TTL_MS) return null;
    return o.snap;
  } catch (_) { return null; }
}

// --- DOM helpers -----------------------------------------------------------
//
// The whole of this app's rendering is these two functions and a lot of
// discipline. There is no virtual DOM and no template language, because
// render() in js/ui.js rebuilds #app outright on every draw and a diffing
// layer would be solving a problem that approach does not have.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'string') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      // `true` becomes a bare attribute, so el('button', { disabled: cond })
      // reads naturally and omits the attribute entirely when cond is false.
      node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/**
 * Say something to a screen reader.
 *
 * Writes into #announce, which lives OUTSIDE #app in index.html. That is not
 * tidiness: a live region only fires when text changes inside a node that was
 * already in the document, and #app is emptied and rebuilt on every render, so
 * a live region inside it would be a brand new silent node every time.
 *
 * Deduplicated against the last message, because render() runs far more often
 * than the game changes and repeating "your turn" on every draw turns the
 * screen reader into noise the user switches off.
 */
let lastAnnounced = '';
export function announce(text) {
  const node = document.getElementById('announce');
  if (!node || !text || text === lastAnnounced) return;
  lastAnnounced = text;
  node.textContent = text;
}
