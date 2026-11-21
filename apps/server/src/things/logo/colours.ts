/**
 * CSS colours as an SVG logo writes them, read into numbers for `svg.ts`: hex, `rgb()`, `hsl()` and the named colours.
 * Anything else reads as unknown, so a strange value can never pass through to an app. Pure.
 */

/** A colour as numbers: red, green and blue 0–255 and alpha 0–1. */
export type Rgba = { r: number; g: number; b: number; a: number };

/** The CSS named colours (CSS Color Module Level 4), as `rrggbb`. */
const NAMED: Record<string, string> = {
  aliceblue: 'f0f8ff',
  antiquewhite: 'faebd7',
  aqua: '00ffff',
  aquamarine: '7fffd4',
  azure: 'f0ffff',
  beige: 'f5f5dc',
  bisque: 'ffe4c4',
  black: '000000',
  blanchedalmond: 'ffebcd',
  blue: '0000ff',
  blueviolet: '8a2be2',
  brown: 'a52a2a',
  burlywood: 'deb887',
  cadetblue: '5f9ea0',
  chartreuse: '7fff00',
  chocolate: 'd2691e',
  coral: 'ff7f50',
  cornflowerblue: '6495ed',
  cornsilk: 'fff8dc',
  crimson: 'dc143c',
  cyan: '00ffff',
  darkblue: '00008b',
  darkcyan: '008b8b',
  darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9',
  darkgreen: '006400',
  darkgrey: 'a9a9a9',
  darkkhaki: 'bdb76b',
  darkmagenta: '8b008b',
  darkolivegreen: '556b2f',
  darkorange: 'ff8c00',
  darkorchid: '9932cc',
  darkred: '8b0000',
  darksalmon: 'e9967a',
  darkseagreen: '8fbc8f',
  darkslateblue: '483d8b',
  darkslategray: '2f4f4f',
  darkslategrey: '2f4f4f',
  darkturquoise: '00ced1',
  darkviolet: '9400d3',
  deeppink: 'ff1493',
  deepskyblue: '00bfff',
  dimgray: '696969',
  dimgrey: '696969',
  dodgerblue: '1e90ff',
  firebrick: 'b22222',
  floralwhite: 'fffaf0',
  forestgreen: '228b22',
  fuchsia: 'ff00ff',
  gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff',
  gold: 'ffd700',
  goldenrod: 'daa520',
  gray: '808080',
  green: '008000',
  greenyellow: 'adff2f',
  grey: '808080',
  honeydew: 'f0fff0',
  hotpink: 'ff69b4',
  indianred: 'cd5c5c',
  indigo: '4b0082',
  ivory: 'fffff0',
  khaki: 'f0e68c',
  lavender: 'e6e6fa',
  lavenderblush: 'fff0f5',
  lawngreen: '7cfc00',
  lemonchiffon: 'fffacd',
  lightblue: 'add8e6',
  lightcoral: 'f08080',
  lightcyan: 'e0ffff',
  lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3',
  lightgreen: '90ee90',
  lightgrey: 'd3d3d3',
  lightpink: 'ffb6c1',
  lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa',
  lightskyblue: '87cefa',
  lightslategray: '778899',
  lightslategrey: '778899',
  lightsteelblue: 'b0c4de',
  lightyellow: 'ffffe0',
  lime: '00ff00',
  limegreen: '32cd32',
  linen: 'faf0e6',
  magenta: 'ff00ff',
  maroon: '800000',
  mediumaquamarine: '66cdaa',
  mediumblue: '0000cd',
  mediumorchid: 'ba55d3',
  mediumpurple: '9370db',
  mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee',
  mediumspringgreen: '00fa9a',
  mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585',
  midnightblue: '191970',
  mintcream: 'f5fffa',
  mistyrose: 'ffe4e1',
  moccasin: 'ffe4b5',
  navajowhite: 'ffdead',
  navy: '000080',
  oldlace: 'fdf5e6',
  olive: '808000',
  olivedrab: '6b8e23',
  orange: 'ffa500',
  orangered: 'ff4500',
  orchid: 'da70d6',
  palegoldenrod: 'eee8aa',
  palegreen: '98fb98',
  paleturquoise: 'afeeee',
  palevioletred: 'db7093',
  papayawhip: 'ffefd5',
  peachpuff: 'ffdab9',
  peru: 'cd853f',
  pink: 'ffc0cb',
  plum: 'dda0dd',
  powderblue: 'b0e0e6',
  purple: '800080',
  rebeccapurple: '663399',
  red: 'ff0000',
  rosybrown: 'bc8f8f',
  royalblue: '4169e1',
  saddlebrown: '8b4513',
  salmon: 'fa8072',
  sandybrown: 'f4a460',
  seagreen: '2e8b57',
  seashell: 'fff5ee',
  sienna: 'a0522d',
  silver: 'c0c0c0',
  skyblue: '87ceeb',
  slateblue: '6a5acd',
  slategray: '708090',
  slategrey: '708090',
  snow: 'fffafa',
  springgreen: '00ff7f',
  steelblue: '4682b4',
  tan: 'd2b48c',
  teal: '008080',
  thistle: 'd8bfd8',
  tomato: 'ff6347',
  turquoise: '40e0d0',
  violet: 'ee82ee',
  wheat: 'f5deb3',
  white: 'ffffff',
  whitesmoke: 'f5f5f5',
  yellow: 'ffff00',
  yellowgreen: '9acd32',
};

function hex(s: string): Rgba | null {
  if (!/^[0-9a-f]+$/.test(s)) return null;
  let h = s;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A number, or a percentage of `whole`; NaN for anything else. */
function amount(s: string, whole: number): number {
  const m = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)(%?)$/.exec(s);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  return m[2] ? (n / 100) * whole : n;
}

/** An alpha: a number 0–1 or a percentage. */
function alpha(s: string | undefined): number {
  if (s === undefined) return 1;
  return clamp(amount(s, 1), 0, 1);
}

function hue(s: string): number {
  const m = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)(deg|rad|grad|turn)?$/.exec(s);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const unit = m[2] ?? 'deg';
  const deg =
    unit === 'rad' ? (n * 180) / Math.PI : unit === 'grad' ? n * 0.9 : unit === 'turn' ? n * 360 : n;
  return ((deg % 360) + 360) % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * A colour value read into numbers, `none` for `none` and `transparent`, `currentColor`, or null when it isn't a colour
 * Whombat knows.
 */
export function parseColour(value: string): Rgba | 'none' | 'currentColor' | null {
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return 'none';
  if (v === 'currentcolor') return 'currentColor';
  if (v.startsWith('#')) return hex(v.slice(1));
  if (Object.hasOwn(NAMED, v)) return hex(NAMED[v] as string);
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = (fn[2] ?? '')
    .trim()
    .split(/\s*[,/]\s*|\s+/)
    .filter((p) => p !== '');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [p0, p1, p2, p3] = parts as [string, string, string, string | undefined];
  const a = alpha(p3);
  if (fn[1]?.startsWith('rgb')) {
    const [r, g, b] = [p0, p1, p2].map((p) => clamp(amount(p, 255), 0, 255));
    if ([r, g, b, a].some((n) => n === undefined || Number.isNaN(n))) return null;
    return { r: Math.round(r as number), g: Math.round(g as number), b: Math.round(b as number), a };
  }
  const h = hue(p0);
  if (!p1.endsWith('%') || !p2.endsWith('%')) return null;
  const s = clamp(amount(p1, 1), 0, 1);
  const l = clamp(amount(p2, 1), 0, 1);
  if ([h, s, l, a].some((n) => Number.isNaN(n))) return null;
  const [r, g, b] = hslToRgb(h, s, l);
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
}

/** `#rrggbb` in lower case. */
export function toHex(c: Rgba): string {
  return `#${[c.r, c.g, c.b].map((n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

/** The colour's relative luminance (WCAG), 0 for black to 1 for white. */
export function luminance(c: Rgba): number {
  const lin = (n: number) => {
    const s = n / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}
