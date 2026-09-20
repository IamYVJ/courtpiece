// ============================================================================
// gen-icons.js — the PNG icons, drawn from scratch with no dependencies.
//
// Mirrors icons/icon.svg: three cards held in a hand, the front one face-down
// and crimson. Run:
//   npm run icons
//
// WHY THIS EXISTS AT ALL, WHEN THE SVG ALREADY DOES
//   A manifest needs raster icons. Android will not use an SVG for the home
//   screen and iOS will not use one for apple-touch-icon, so the PNGs are not
//   optional — and generating them with sharp or canvas would put a dependency
//   in a repo whose whole point is not having any. Node ships zlib, a PNG is a
//   zlib stream with four framing chunks around it, and the mark is four
//   rectangles. So it is about ninety lines, and `git diff` on an icon change
//   shows you numbers instead of a wall of base64.
//
// KEEPING THE TWO IN STEP
//   The CARDS table below is the same three boxes as the <rect>s in the SVG,
//   at the same angles and in the same paint order. Change one, change the
//   other. Nothing enforces it — a test that rasterised the SVG would need an
//   SVG renderer, which is the dependency this file exists to avoid — so the
//   honest answer is: it is nine numbers, and they are next to each other in
//   the diff.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Straight out of the :root block in css/styles.css.
const INK = [0x0B, 0x0A, 0x0F];   // --bg
const GLOW = [0x1C, 0x12, 0x18];  // --bg-glow
const CREAM = [0xF2, 0xED, 0xE3]; // --card
const CRIMSON = [0xE2, 0x46, 0x4F]; // --accent
const BACK = [0xF7, 0xC3, 0xC6];  // the pattern on the face-down card

// Every card is the same 176x246 box — the 5:7 of a real card — so only its
// centre and its angle vary. Back of the hand first, front card last.
const CARD_W = 176, CARD_H = 246, RADIUS = 18;
const CARDS = [
  { cx: 222, cy: 262, deg: -21, fill: CREAM },
  { cx: 292, cy: 256, deg: 17, fill: CREAM },
  { cx: 256, cy: 268, deg: -3, fill: CRIMSON, back: true },
];
// Half of the SVG's 13-wide stroke, which is the half that falls outside the
// rect. It is the background colour, so it reads as a gap between overlapping
// cards rather than as an outline. Without it the cream cards fuse into one
// blob at 48px, which is the size that actually decides whether this works.
const GAP = 6.5;
// The face-down pattern: a border inset inside the front card, and a diamond
// lattice inside that. Deliberately not a suit — see the note in icon.svg.
const INSET = 22;       // from the card edge to the middle of the border
const LINE = 3.5;       // half the border's 7-wide stroke
const LATTICE = 26;     // spacing between lattice lines
const LATTICE_LINE = 1.75; // half the lattice stroke

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Signed distance from a point to a rounded rectangle centred on the origin:
 * negative inside, positive outside, and — unlike a plain inside/outside test
 * — meaningful for a few pixels either side of the edge.
 *
 * That last property is what makes one function enough for the whole mark.
 * A fill is `dist < 0`, the gap around a card is the same distance tested
 * against a larger threshold, and a stroke is `|dist| < half the width`. No
 * shape here needed a second primitive.
 */
function roundRectDist(lx, ly, hw, hh, r) {
  const qx = Math.abs(lx) - (hw - r);
  const qy = Math.abs(ly) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Distance to the nearest line of an infinite set spaced `period` apart and
 * perpendicular to `axis`. `axis` arrives already divided by root two by the
 * caller, because the two families here run along lx+ly and lx-ly and that
 * division is what turns those sums back into real distances.
 */
function latticeDist(axis, period) {
  const m = axis - Math.floor(axis / period) * period;
  return Math.min(m, period - m);
}

/** Coverage in [0,1], anti-aliased across ±aa of the edge. */
function coverage(dist, edge, aa) { return 1 - smoothstep(edge - aa, edge + aa, dist); }

function drawIcon(size, scale = 1) {
  const u = size / 512;             // design units -> pixels
  const aa = u * 1.4;               // ~1.4px of softening, independent of size
  const cx = size / 2, cy = size / 2;
  const buf = Buffer.alloc(size * size * 4);

  // Design coords -> pixels, scaled about the centre. scale < 1 shrinks the
  // whole mark into the maskable safe area without moving it off centre.
  const at = (v) => cx + (v - 256) * u * scale;
  const aty = (v) => cy + (v - 256) * u * scale;

  const k = u * scale;  // one design unit, in pixels, after scaling
  // Each card is pre-resolved to a centre in pixels and the cos/sin of the
  // INVERSE of its rotation, so the inner loop only has to move the pixel into
  // the card's own frame and ask an axis-aligned question there.
  const boxes = CARDS.map((c) => {
    const a = (-c.deg * Math.PI) / 180;
    return {
      px: at(c.cx), py: aty(c.cy), cos: Math.cos(a), sin: Math.sin(a),
      hw: (CARD_W / 2) * k, hh: (CARD_H / 2) * k, r: RADIUS * k, gap: GAP * k,
      fill: c.fill, back: !!c.back,
    };
  });
  const inset = INSET * k, line = LINE * k;
  const lat = LATTICE * k, latLine = LATTICE_LINE * k;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;

      // The table: a soft glow from the top edge, matching the radialGradient
      // in the SVG and the one behind the app itself.
      const g = 1 - smoothstep(0, size * 0.75, Math.hypot(px - cx, py) * 0.9);
      let r = INK[0] * (1 - g) + GLOW[0] * g;
      let gr = INK[1] * (1 - g) + GLOW[1] * g;
      let b = INK[2] * (1 - g) + GLOW[2] * g;

      // Painter's order, one whole card at a time — gap, then face, then
      // whatever is printed on it. Finishing each card before starting the
      // next is what makes the overlaps come out right: a card is separated
      // from the ones UNDER it and never from the ones over it, which is what
      // a hand of cards actually looks like.
      for (const box of boxes) {
        const dx = px - box.px, dy = py - box.py;
        const lx = dx * box.cos - dy * box.sin;
        const ly = dx * box.sin + dy * box.cos;

        const d = roundRectDist(lx, ly, box.hw, box.hh, box.r);
        const edge = coverage(d, box.gap, aa);
        r = r * (1 - edge) + INK[0] * edge;
        gr = gr * (1 - edge) + INK[1] * edge;
        b = b * (1 - edge) + INK[2] * edge;

        const face = coverage(d, 0, aa);
        r = r * (1 - face) + box.fill[0] * face;
        gr = gr * (1 - face) + box.fill[1] * face;
        b = b * (1 - face) + box.fill[2] * face;

        if (!box.back) continue;
        // The border: a stroke is just `|distance| < half the width`.
        const dInset = roundRectDist(lx, ly, box.hw - inset, box.hh - inset, 10 * k);
        const border = coverage(Math.abs(dInset), line, aa);
        // The lattice: two families of parallel lines at right angles, drawn
        // only where the border already encloses them. Clipping by the inset
        // rectangle's own distance costs nothing — the shape is already here.
        const inside = coverage(dInset, -line, aa);
        const grid = Math.max(
          coverage(latticeDist((lx + ly) / Math.SQRT2, lat), latLine, aa),
          coverage(latticeDist((lx - ly) / Math.SQRT2, lat), latLine, aa),
        ) * inside * 0.42;
        // `face` keeps both inside the rounded corner they are printed within,
        // for the same reason a real card's back has a margin.
        const mark = Math.max(border * 0.85, grid) * face;
        r = r * (1 - mark) + BACK[0] * mark;
        gr = gr * (1 - mark) + BACK[1] * mark;
        b = b * (1 - mark) + BACK[2] * mark;
      }

      const i = (y * size + x) * 4;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(gr); buf[i + 2] = Math.round(b); buf[i + 3] = 255;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// PNG container. Signature, IHDR, one IDAT, IEND — the minimum a decoder will
// accept, which is all this needs to be.
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // The remaining three bytes stay zero: deflate, adaptive filtering, no
  // interlace. All three are the only values a PNG is allowed to use anyway.

  // Every scanline is prefixed with its filter type. Type 0 is "none" — the
  // image is four flat colours and a few soft edges, so deflate gets almost
  // everything on its own and a smarter filter would buy nothing.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'icons');
const targets = [
  { name: 'icon-192.png', size: 192, scale: 1 },
  { name: 'icon-512.png', size: 512, scale: 1 },
  // Maskable: Android crops this to whatever shape the launcher likes, and
  // only the middle 80% of the width is guaranteed to survive. 0.7 leaves the
  // mark comfortably inside even a circle.
  { name: 'icon-maskable.png', size: 512, scale: 0.7 },
];
for (const t of targets) {
  const png = encodePNG(drawIcon(t.size, t.scale), t.size);
  fs.writeFileSync(path.join(outDir, t.name), png);
  console.log('wrote', t.name, png.length, 'bytes');
}
