// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Visualization helpers for git-time-lapse: color computation for the blame
 * gutter and line-background coloring modes (diff / blame / age).
 *
 * The author hue is a deterministic hash of the author string, so an author
 * gets the same color everywhere. DOM rendering lives in `ui/app.ts`; this
 * module is pure data → color.
 */

import type { BlameEntry } from "./types";

/** Per-line blame/age data used to drive gutter text and coloring. */
export interface LineInfo {
  commitHex: string;
  authorName: string;
  authorEmail: string;
  authoredDate: Date;
  // Stable 1-based line number within the commit that introduced this line
  // (from BlameEntry.originLine). Persists across revisions, so
  // (commitHex, originLine) uniquely identifies a physical line through history.
  originLine: number;
}

/** An `#rrggbb` color string. */
export type Hex = string;

// ---------------------------------------------------------------------------
// Small color utilities
// ---------------------------------------------------------------------------

function toHex(r: number, g: number, b: number): Hex {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** HSV → RGB, matching Python's colorsys.hsv_to_rgb (h,s,v in [0,1]). */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0) return [v * 255, v * 255, v * 255];
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    case 5: [r, g, b] = [v, p, q]; break;
  }
  return [r * 255, g * 255, b * 255];
}

/**
 * MD5, used for the stable author-color hue (the author string is hashed with
 * md5 and digest[0] picks the hue). Small self-contained impl so we
 * don't pull in a crypto dependency; only the first digest byte is used.
 */
function md5FirstByte(input: string): number {
  return md5(input)[0];
}

// Minimal MD5 returning a 16-byte array. Adapted to a compact form.
function md5(str: string): number[] {
  function toBytesUtf8(s: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff) {
        const c2 = s.charCodeAt(++i);
        c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 0x3f),
          0x80 | ((c >> 6) & 0x3f),
          0x80 | (c & 0x3f),
        );
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }
  const bytes = toBytesUtf8(str);
  const n = bytes.length;
  // Pre-processing: append 0x80, pad to 56 mod 64, then 64-bit length.
  const withPad = bytes.slice();
  withPad.push(0x80);
  while (withPad.length % 64 !== 56) withPad.push(0);
  const bitLen = n * 8;
  for (let i = 0; i < 8; i++) {
    withPad.push((bitLen >>> (8 * i)) & 0xff);
  }

  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c));

  for (let off = 0; off < withPad.length; off += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] =
        withPad[off + i * 4] |
        (withPad[off + i * 4 + 1] << 8) |
        (withPad[off + i * 4 + 2] << 16) |
        (withPad[off + i * 4 + 3] << 24);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0;
      let g = 0;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out: number[] = [];
  for (const v of [a0, b0, c0, d0]) {
    out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Author color
// ---------------------------------------------------------------------------

/**
 * Deterministically map an author identity to a distinct color. The hue comes
 * from a stable md5 hash of the author string (first byte), so an author gets
 * the same color in every session and on every platform.
 */
export function authorColor(
  author: string,
  opts: { dark?: boolean; saturation?: number; value?: number } = {},
): Hex {
  const dark = opts.dark ?? false;
  const saturation = opts.saturation ?? (dark ? 0.4 : 0.45);
  const value = opts.value ?? (dark ? 0.35 : 0.92);
  const hue = md5FirstByte(author) / 255.0;
  const [r, g, b] = hsvToRgb(hue, saturation, value);
  return toHex(r, g, b);
}

/**
 * Return an author label for the blame gutter. `fmt` selects: 'full' (display
 * name), 'first' (first word), 'last' (last word), 'email' (username before @).
 * Truncated to `maxChars` only when it is provided; otherwise the full label is
 * returned and the gutter clips it via CSS overflow.
 */
export function authorDisplay(
  name: string,
  email = "",
  opts: { maxChars?: number; fmt?: string } = {},
): string {
  const fmt = opts.fmt ?? "full";
  let label = "";
  if (fmt === "email") {
    label = email && email.includes("@") ? email.split("@", 1)[0] : name;
  } else {
    const parts = name.split(/\s+/).filter(Boolean);
    if (fmt === "first") label = parts.length ? parts[0] : name;
    else if (fmt === "last") label = parts.length ? parts[parts.length - 1] : name;
    else label = name;
  }
  label = label.trim();
  if (!label) return "?";
  return opts.maxChars !== undefined ? label.slice(0, opts.maxChars) : label;
}

// ---------------------------------------------------------------------------
// Age buckets (4-tier green, P4-style)
// ---------------------------------------------------------------------------

const AGE_BUCKETS_LIGHT: Hex[] = [
  toHex(220, 240, 220),
  toHex(180, 225, 180),
  toHex(120, 200, 120),
  toHex(60, 180, 60),
];
const AGE_BUCKETS_DARK: Hex[] = [
  toHex(0x20, 0x30, 0x20),
  toHex(0x25, 0x40, 0x25),
  toHex(0x30, 0x58, 0x30),
  toHex(0x38, 0x70, 0x38),
];

export function ageBucketHexes(dark: boolean): Hex[] {
  return dark ? AGE_BUCKETS_DARK.slice() : AGE_BUCKETS_LIGHT.slice();
}

/** Map a line's age to one of four discrete green buckets (P4-style). */
export function ageColor(
  authoredDate: Date,
  oldest: Date,
  newest: Date,
  dark: boolean,
): Hex {
  const buckets = dark ? AGE_BUCKETS_DARK : AGE_BUCKETS_LIGHT;
  const a = authoredDate.getTime() / 1000;
  const lo = oldest.getTime() / 1000;
  const hi = newest.getTime() / 1000;
  const span = hi - lo;
  if (span <= 0) return buckets[buckets.length - 1];
  const frac = Math.max(0, Math.min(1, (a - lo) / span));
  const idx = Math.min(3, Math.floor(frac * 4));
  return buckets[idx];
}

// ---------------------------------------------------------------------------
// Diff colors
// ---------------------------------------------------------------------------

const DIFF_COLORS_LIGHT: Record<string, Hex | null> = {
  added: toHex(198, 239, 206),
  modified: toHex(198, 239, 206),
  unchanged: null,
};
const REMOVED_COLOR_LIGHT: Hex = toHex(255, 199, 206);

const DIFF_COLORS_DARK: Record<string, Hex | null> = {
  added: toHex(0x26, 0x4d, 0x26),
  modified: toHex(0x26, 0x4d, 0x26),
  unchanged: null,
};
const REMOVED_COLOR_DARK: Hex = toHex(0x4d, 0x26, 0x26);

export function diffColorsFor(dark: boolean): Record<string, Hex | null> {
  return dark ? DIFF_COLORS_DARK : DIFF_COLORS_LIGHT;
}

export function removedColorFor(dark: boolean): Hex {
  return dark ? REMOVED_COLOR_DARK : REMOVED_COLOR_LIGHT;
}

// Current-line (selection) highlight overlay per theme.
const CURRENT_LINE_LIGHT: Hex = toHex(0xe8, 0xf0, 0xfe);
const CURRENT_LINE_DARK: Hex = toHex(0x3a, 0x3a, 0x50);

export function currentLineColorFor(dark: boolean): Hex {
  return dark ? CURRENT_LINE_DARK : CURRENT_LINE_LIGHT;
}

function parseHex(hex: Hex): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function selectedDiffColor(base: Hex, dark: boolean): Hex {
  const [r, g, b] = parseHex(base);
  if (dark) {
    const f = 1.45;
    return toHex(r * f, g * f, b * f);
  }
  const f = 0.78;
  return toHex(r * f, g * f, b * f);
}

// ---------------------------------------------------------------------------
// Blame → per-line LineInfo
// ---------------------------------------------------------------------------

/** Flatten blame blocks into a per-line list of LineInfo (1 per source line). */
export function blameToLineInfos(entries: BlameEntry[]): LineInfo[] {
  const infos: LineInfo[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.lines.length; i++) {
      infos.push({
        commitHex: entry.commitHex,
        authorName: entry.authorName,
        authorEmail: entry.authorEmail,
        authoredDate: entry.authoredDate,
        originLine: entry.originLine + i,
      });
    }
  }
  return infos;
}
