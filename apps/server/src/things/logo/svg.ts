/**
 * A service's SVG logo, an untrusted file, turned into the path shapes Whombat's apps draw (`ThingLogo` in
 * `@whombat/core`). Whombat reads the file as XML and draws it itself: every shape becomes path data in numbers, with
 * its transforms applied, its colours worked out from attributes, `style` and simple `<style>` rules, and only those
 * numbers and `#rrggbb` colours go out, so nothing of the file — no script, link, text or picture — reaches an app.
 * What it can't draw faithfully (text, pictures, masks) is refused with a problem a person can read, never drawn
 * half. A logo in one very dark or very light colour comes back in `currentColor`, so it reads on either theme. Pure.
 */
import { THING_LOGO_PATH_MAX, THING_LOGO_SHAPES_MAX, ThingLogo, type ThingLogoShape } from '@whombat/core';
import { Parser } from 'htmlparser2';
import svgpath from 'svgpath';
import { luminance, parseColour, type Rgba, toHex } from './colours';

export type SvgProblem =
  | 'not_svg'
  | 'too_large'
  | 'text'
  | 'picture'
  | 'mask'
  | 'nothing'
  | 'too_complex'
  | 'invalid';

export type SvgLogoResult =
  | { ok: true; logo: ThingLogo }
  | { ok: false; problem: SvgProblem; message: string };

/** The largest file Whombat reads: logos are a few kilobytes, anything far bigger is a picture or an attack. */
export const SVG_LOGO_BYTES_MAX = 512 * 1024;
/** Elements in a file before Whombat stops reading it, so a large file can't keep the server busy. */
const ELEMENTS_MAX = 20_000;
/** Shapes drawn before merging, and how deep groups may nest. */
const DRAWN_MAX = 10_000;
const DEPTH_MAX = 100;

const MESSAGES: Record<SvgProblem, string> = {
  not_svg: 'That file isn’t an SVG picture.',
  too_large: 'That logo file is too large for Whombat to read.',
  text: 'That logo uses text Whombat can’t draw.',
  picture: 'That logo has a picture inside that Whombat can’t draw.',
  mask: 'That logo uses a mask Whombat can’t draw.',
  nothing: 'That logo has nothing in it Whombat can draw.',
  too_complex: 'That logo has too many shapes for Whombat to draw.',
  invalid: 'Whombat couldn’t read that logo file.',
};

class LogoProblem {
  constructor(readonly problem: SvgProblem) {}
}

const fail = (problem: SvgProblem): SvgLogoResult => ({ ok: false, problem, message: MESSAGES[problem] });

/** Turn an SVG file into a logo, or say plainly why not. Never throws. */
export function svgToLogo(svg: string): SvgLogoResult {
  try {
    if (typeof svg !== 'string') return fail('invalid');
    if (svg.length > SVG_LOGO_BYTES_MAX || Buffer.byteLength(svg, 'utf8') > SVG_LOGO_BYTES_MAX)
      return fail('too_large');
    const root = parseXml(svg);
    if (root?.name !== 'svg') return fail('not_svg');
    const doc = new Doc(root);
    const viewBox = rootViewBox(root);
    if (!viewBox) return fail('invalid');
    doc.box = viewBox;
    doc.drawRoot(root);
    return finish(doc.drawn, viewBox);
  } catch (e) {
    if (e instanceof LogoProblem) return fail(e.problem);
    return fail('invalid');
  }
}

// ——— Reading the XML ———

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  /** The element's own text, for `<style>` and to see whether a `<text>` says anything. */
  text: string;
  parent: El | null;
}

/**
 * The file's root element, or null when there is none. htmlparser2 in XML mode doesn't read a DOCTYPE's entity
 * declarations, so `&name;` stays as written and nothing is expanded.
 */
function parseXml(svg: string): El | null {
  let root: El | null = null;
  let done = false;
  let count = 0;
  const stack: El[] = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (done) return;
        count += 1;
        if (count > ELEMENTS_MAX) throw new LogoProblem('too_complex');
        const parent = stack.at(-1) ?? null;
        const el: El = { name: name.replace(/^svg:/, ''), attrs, children: [], text: '', parent };
        if (parent) parent.children.push(el);
        else root = el;
        stack.push(el);
      },
      ontext(text) {
        const el = stack.at(-1);
        if (el && !done) el.text += text;
      },
      onclosetag() {
        if (done) return;
        stack.pop();
        if (stack.length === 0 && root) done = true;
      },
    },
    { xmlMode: true },
  );
  parser.write(svg);
  parser.end();
  return root;
}

// ——— Numbers, lengths and transforms ———

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

const NUM = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;
const NUM_RE = new RegExp(NUM, 'g');

function numbers(s: string): number[] {
  return (s.match(NUM_RE) ?? []).map(Number);
}

/** A `transform` list as one matrix; a list browsers wouldn't read is ignored whole, as they do. */
function parseTransform(s: string | undefined): Matrix {
  if (!s?.trim()) return IDENTITY;
  const re = /\s*([a-zA-Z]+)\s*\(([^()]*)\)\s*,?/y;
  let m = IDENTITY;
  let at = 0;
  while (at < s.length) {
    re.lastIndex = at;
    const found = re.exec(s);
    if (!found) return s.slice(at).trim() === '' ? m : IDENTITY;
    at = re.lastIndex;
    const args = numbers(found[2] ?? '');
    if (!args.every(Number.isFinite)) return IDENTITY;
    const step = transformStep(found[1] ?? '', args);
    if (!step) return IDENTITY;
    m = mul(m, step);
  }
  return m;
}

function transformStep(name: string, a: number[]): Matrix | null {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const [a0 = 0, a1, a2] = a;
  switch (name) {
    case 'matrix':
      return a.length === 6 ? (a as Matrix) : null;
    case 'translate':
      return a.length === 1 || a.length === 2 ? translate(a0, a1 ?? 0) : null;
    case 'scale':
      return a.length === 1 || a.length === 2 ? [a0, 0, 0, a1 ?? a0, 0, 0] : null;
    case 'rotate': {
      if (a.length !== 1 && a.length !== 3) return null;
      const c = Math.cos(rad(a0));
      const s = Math.sin(rad(a0));
      const r: Matrix = [c, s, -s, c, 0, 0];
      if (a.length === 1) return r;
      return mul(mul(translate(a1 ?? 0, a2 ?? 0), r), translate(-(a1 ?? 0), -(a2 ?? 0)));
    }
    case 'skewX':
      return a.length === 1 ? [1, 0, Math.tan(rad(a0)), 1, 0, 0] : null;
    case 'skewY':
      return a.length === 1 ? [1, Math.tan(rad(a0)), 0, 1, 0, 0] : null;
    default:
      return null;
  }
}

const UNITS: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

/** A length in user units; a percentage is of `whole` (the logo's box), null when it isn't a length. */
function length(s: string | undefined, whole: number | null): number | null {
  if (s === undefined) return null;
  const m = new RegExp(`^\\s*(${NUM})\\s*([a-z]*|%)\\s*$`, 'i').exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === '%') return whole === null ? null : (n / 100) * whole;
  const k = UNITS[unit];
  return k === undefined || !Number.isFinite(n) ? null : n * k;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseViewBox(s: string | undefined): Box | null {
  if (!s) return null;
  const parts = s.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (new RegExp(`^${NUM}$`).test(p) ? Number(p) : Number.NaN));
  const [x, y, w, h] = n as [number, number, number, number];
  if (!n.every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function rootViewBox(root: El): Box | null {
  const vb = parseViewBox(root.attrs.viewBox);
  if (vb) return vb;
  const w = length(root.attrs.width, null);
  const h = length(root.attrs.height, null);
  return w && h && w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null;
}

/** How a nested viewport's viewBox lands in its width and height (`preserveAspectRatio`, meet by default). */
function viewBoxMatrix(vb: Box | null, w: number | null, h: number | null, par: string | undefined): Matrix {
  if (!vb) return IDENTITY;
  const width = w && w > 0 ? w : vb.w;
  const height = h && h > 0 ? h : vb.h;
  const sx = width / vb.w;
  const sy = height / vb.h;
  const p = (par ?? '').trim();
  if (p.startsWith('none')) return [sx, 0, 0, sy, -vb.x * sx, -vb.y * sy];
  const s = p.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
  const pos = (align: string, room: number) => (align === 'Min' ? 0 : align === 'Max' ? room : room / 2);
  const ax = /x(Min|Mid|Max)/.exec(p)?.[1] ?? 'Mid';
  const ay = /Y(Min|Mid|Max)/.exec(p)?.[1] ?? 'Mid';
  return [s, 0, 0, s, -vb.x * s + pos(ax, width - vb.w * s), -vb.y * s + pos(ay, height - vb.h * s)];
}

// ——— Styles ———

type Declarations = Map<string, string>;

interface Rule {
  kind: '#' | '.' | '';
  key: string;
  /** Ids over classes over element names, then the later rule. */
  weight: number;
  order: number;
  decls: Declarations;
}

function parseDeclarations(s: string): Declarations {
  const out: Declarations = new Map();
  for (const part of s.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const value = part
      .slice(at + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim();
    if (prop && value) out.set(prop, value);
  }
  return out;
}

/** The end of a `{ … }` block that starts at `open`, nested braces and all. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

/** `<style>` rules with simple selectors only (`.class`, `#id`, `path`, lists of them); the rest is skipped. */
function parseCss(text: string, start: number): Rule[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!\[CDATA\[|\]\]>/g, '');
  const rules: Rule[] = [];
  let at = 0;
  let order = start;
  while (at < css.length) {
    const open = css.indexOf('{', at);
    const head = (open < 0 ? css.slice(at) : css.slice(at, open)).trim();
    if (head.startsWith('@')) {
      const semi = css.indexOf(';', at);
      if (semi >= 0 && (open < 0 || semi < open)) {
        at = semi + 1;
        continue;
      }
    }
    if (open < 0) break;
    const close = blockEnd(css, open);
    if (!head.startsWith('@')) {
      const decls = parseDeclarations(css.slice(open + 1, close));
      for (const sel of head.split(',')) {
        const m = /^([.#]?)(-?[A-Za-z_][\w-]*)$/.exec(sel.trim());
        if (!m) continue;
        const kind = (m[1] ?? '') as Rule['kind'];
        rules.push({
          kind,
          key: m[2] ?? '',
          weight: kind === '#' ? 100 : kind === '.' ? 10 : 1,
          order,
          decls,
        });
        order += 1;
      }
    }
    at = close + 1;
  }
  return rules;
}

type Paint = { kind: 'none' } | { kind: 'current' } | { kind: 'rgb'; c: Rgba };
type Cap = 'butt' | 'round' | 'square';
type Join = 'miter' | 'round' | 'bevel';

/** What an element inherits and draws with. */
interface Style {
  fill: Paint;
  stroke: Paint;
  strokeWidth: number;
  linecap: Cap;
  linejoin: Join;
  evenodd: boolean;
  fillOpacity: number;
  strokeOpacity: number;
  visible: boolean;
  /** The `color` that `currentColor` means, when the file sets one. */
  color: Rgba | null;
}

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const NONE: Paint = { kind: 'none' };

const ROOT_STYLE: Style = {
  fill: { kind: 'rgb', c: BLACK },
  stroke: NONE,
  strokeWidth: 1,
  linecap: 'butt',
  linejoin: 'miter',
  evenodd: false,
  fillOpacity: 1,
  strokeOpacity: 1,
  visible: true,
  color: null,
};

function opacityValue(s: string | undefined): number | null {
  if (s === undefined) return null;
  const m = new RegExp(`^\\s*(${NUM})\\s*(%?)\\s*$`).exec(s);
  if (!m) return null;
  const n = Number(m[1]) / (m[2] ? 100 : 1);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

/** Shapes as Whombat draws them, before they are merged and written out. */
interface Drawn {
  abs: string;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  linecap?: Cap;
  linejoin?: Join;
  evenodd: boolean;
  opacity: number;
  box: [number, number, number, number];
}

interface Context {
  m: Matrix;
  style: Style;
  opacity: number;
  /** Inside what a `<use>` drew: a `<use>` in there isn't followed, so references can't loop. */
  inUse: boolean;
  depth: number;
}

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const GROUPS = new Set(['g', 'a', 'svg', 'switch', 'use']);
const TEXT = new Set(['text', 'tspan', 'textPath']);

class Doc {
  readonly drawn: Drawn[] = [];
  box: Box = { x: 0, y: 0, w: 1, h: 1 };
  private readonly ids = new Map<string, El>();
  /** `<style>` rules by selector (`#id`, `.class`, `path`), so a long style sheet stays quick to match. */
  private readonly rules = new Map<string, Rule[]>();
  private readonly own = new WeakMap<El, Declarations>();

  constructor(root: El) {
    const stack = [root];
    let order = 0;
    while (stack.length) {
      const el = stack.pop() as El;
      const id = el.attrs.id;
      if (id && !this.ids.has(id)) this.ids.set(id, el);
      if (el.name === 'style') {
        for (const rule of parseCss(el.text, order)) {
          const key = rule.kind + rule.key;
          const list = this.rules.get(key);
          if (list) list.push(rule);
          else this.rules.set(key, [rule]);
          order = rule.order + 1;
        }
      }
      for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i] as El);
    }
  }

  /** The element's value for a property: its `style` attribute, then `<style>` rules, then the attribute. */
  private declared(el: El, prop: string): string | undefined {
    let own = this.own.get(el);
    if (!own) {
      const keys = [
        el.name,
        ...(el.attrs.class ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((c) => `.${c}`),
      ];
      if (el.attrs.id) keys.push(`#${el.attrs.id}`);
      const matching = [...new Set(keys)]
        .flatMap((k) => this.rules.get(k) ?? [])
        .sort((a, b) => a.weight - b.weight || a.order - b.order);
      own = new Map();
      for (const r of matching) for (const [p, v] of r.decls) own.set(p, v);
      for (const [p, v] of parseDeclarations(el.attrs.style ?? '')) own.set(p, v);
      this.own.set(el, own);
    }
    const value = own.get(prop) ?? (Object.hasOwn(el.attrs, prop) ? el.attrs[prop] : undefined);
    const v = value?.trim();
    return v === '' || v === 'inherit' ? undefined : v;
  }

  private hidden(el: El): boolean {
    return this.declared(el, 'display') === 'none';
  }

  private computeStyle(el: El, parent: Style): Style {
    const d = (p: string) => this.declared(el, p);
    const colourValue = d('color');
    const parsedColour = colourValue ? parseColour(colourValue) : null;
    const color = parsedColour && typeof parsedColour === 'object' ? parsedColour : parent.color;
    const paint = (p: string, inherited: Paint): Paint => {
      const v = d(p);
      return v === undefined ? inherited : (this.paint(v, color) ?? inherited);
    };
    const width = length(d('stroke-width'), Math.hypot(this.box.w, this.box.h) / Math.SQRT2);
    const cap = d('stroke-linecap');
    const join = d('stroke-linejoin');
    const rule = d('fill-rule');
    const visibility = d('visibility');
    return {
      fill: paint('fill', parent.fill),
      stroke: paint('stroke', parent.stroke),
      strokeWidth: width !== null && width >= 0 ? width : parent.strokeWidth,
      linecap: cap === 'butt' || cap === 'round' || cap === 'square' ? cap : parent.linecap,
      linejoin:
        join === 'round' || join === 'bevel'
          ? join
          : join === 'miter' || join === 'miter-clip' || join === 'arcs'
            ? 'miter'
            : parent.linejoin,
      evenodd: rule === 'evenodd' ? true : rule === 'nonzero' ? false : parent.evenodd,
      fillOpacity: opacityValue(d('fill-opacity')) ?? parent.fillOpacity,
      strokeOpacity: opacityValue(d('stroke-opacity')) ?? parent.strokeOpacity,
      visible:
        visibility === 'hidden' || visibility === 'collapse'
          ? false
          : visibility === 'visible' || parent.visible,
      color,
    };
  }

  /** A paint value; null when it isn't one, so the inherited paint stays (as browsers do). */
  private paint(value: string, color: Rgba | null): Paint | null {
    const url = /^url\(\s*(['"]?)([^'")]*)\1\s*\)\s*(.*)$/i.exec(value);
    if (url) {
      const ref = url[2]?.trim() ?? '';
      const gradient = ref.startsWith('#') ? this.gradient(ref.slice(1)) : null;
      if (gradient) return gradient;
      const fallback = url[3]?.trim();
      return fallback ? (this.paint(fallback, color) ?? NONE) : NONE;
    }
    const c = parseColour(value);
    if (c === null) return null;
    if (c === 'none') return NONE;
    if (c === 'currentColor') return color ? { kind: 'rgb', c: color } : { kind: 'current' };
    return { kind: 'rgb', c };
  }

  /** A gradient drawn as one colour: its middle stop, or the mean of the two middle ones. */
  private gradient(id: string): Paint | null {
    const seen = new Set<El>();
    let el = this.ids.get(id);
    while (el && (el.name === 'linearGradient' || el.name === 'radialGradient') && !seen.has(el)) {
      seen.add(el);
      const stops = el.children.filter((c) => c.name === 'stop');
      if (stops.length) {
        const colours = stops.map((s) => this.stopColour(s));
        const n = colours.length;
        const mid =
          n % 2 === 1
            ? (colours[(n - 1) / 2] as Rgba)
            : mean(colours[n / 2 - 1] as Rgba, colours[n / 2] as Rgba);
        return { kind: 'rgb', c: mid };
      }
      const href = el.attrs.href ?? el.attrs['xlink:href'];
      el = href?.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
    }
    return seen.size ? NONE : null;
  }

  private stopColour(stop: El): Rgba {
    const v = this.declared(stop, 'stop-color');
    const c = v ? parseColour(v) : BLACK;
    const rgb = c && typeof c === 'object' ? c : c === 'none' ? { ...BLACK, a: 0 } : BLACK;
    return { ...rgb, a: rgb.a * (opacityValue(this.declared(stop, 'stop-opacity')) ?? 1) };
  }

  drawRoot(root: El): void {
    this.draw(root, { m: IDENTITY, style: ROOT_STYLE, opacity: 1, inUse: false, depth: 0 }, true);
  }

  private draw(el: El, ctx: Context, isRoot = false): void {
    if (ctx.depth > DEPTH_MAX) throw new LogoProblem('too_complex');
    const drawable = SHAPES.has(el.name) || GROUPS.has(el.name) || TEXT.has(el.name) || el.name === 'image';
    if (!drawable || this.hidden(el)) return;
    const mask = this.declared(el, 'mask');
    if (mask && mask !== 'none') throw new LogoProblem('mask');
    if (TEXT.has(el.name)) {
      if (hasText(el)) throw new LogoProblem('text');
      return;
    }
    if (el.name === 'image') throw new LogoProblem('picture');

    const style = this.computeStyle(el, ctx.style);
    const opacity = ctx.opacity * (opacityValue(this.declared(el, 'opacity')) ?? 1);
    let m = mul(ctx.m, parseTransform(el.attrs.transform));
    const next = (matrix: Matrix, s: Style = style): Context => ({
      m: matrix,
      style: s,
      opacity,
      inUse: ctx.inUse,
      depth: ctx.depth + 1,
    });

    switch (el.name) {
      case 'g':
      case 'a':
        for (const c of el.children) this.draw(c, next(m));
        return;
      case 'svg': {
        if (!isRoot) {
          m = mul(m, translate(this.x(el.attrs.x), this.y(el.attrs.y)));
          m = mul(
            m,
            viewBoxMatrix(
              parseViewBox(el.attrs.viewBox),
              length(el.attrs.width, this.box.w),
              length(el.attrs.height, this.box.h),
              el.attrs.preserveAspectRatio,
            ),
          );
        }
        for (const c of el.children) this.draw(c, next(m));
        return;
      }
      case 'switch': {
        // A switch draws its first child a viewer understands; Illustrator puts a foreignObject first for itself.
        const first = el.children.find(
          (c) => c.name !== 'foreignObject' && (SHAPES.has(c.name) || GROUPS.has(c.name)),
        );
        if (first) this.draw(first, next(m));
        return;
      }
      case 'use': {
        if (ctx.inUse) return;
        const href = el.attrs.href ?? el.attrs['xlink:href'];
        const ref = href?.startsWith('#') ? this.ids.get(href.slice(1)) : undefined;
        if (!ref || isAncestor(ref, el)) return;
        m = mul(m, translate(this.x(el.attrs.x), this.y(el.attrs.y)));
        const inner = { ...next(m), inUse: true };
        if (ref.name === 'symbol') {
          if (this.hidden(ref)) return;
          const symbolStyle = this.computeStyle(ref, style);
          const symbolM = mul(
            mul(m, parseTransform(ref.attrs.transform)),
            viewBoxMatrix(
              parseViewBox(ref.attrs.viewBox),
              length(el.attrs.width ?? ref.attrs.width, this.box.w),
              length(el.attrs.height ?? ref.attrs.height, this.box.h),
              ref.attrs.preserveAspectRatio,
            ),
          );
          const symbolCtx = {
            ...inner,
            m: symbolM,
            style: symbolStyle,
            opacity: opacity * (opacityValue(this.declared(ref, 'opacity')) ?? 1),
          };
          for (const c of ref.children) this.draw(c, symbolCtx);
          return;
        }
        this.draw(ref, inner);
        return;
      }
      default:
        this.shape(el, style, opacity, m);
    }
  }

  private x(s: string | undefined): number {
    return length(s, this.box.w) ?? 0;
  }

  private y(s: string | undefined): number {
    return length(s, this.box.h) ?? 0;
  }

  private shape(el: El, style: Style, opacity: number, m: Matrix): void {
    if (!style.visible) return;
    const d = this.pathData(el);
    if (!d) return;
    const det = m[0] * m[3] - m[1] * m[2];
    if (!m.every(Number.isFinite) || Math.abs(det) < 1e-12) return;

    const fillPaint = el.name === 'line' ? NONE : style.fill;
    const fillAlpha = paintAlpha(fillPaint) * style.fillOpacity;
    const strokeAlpha = paintAlpha(style.stroke) * style.strokeOpacity;
    const strokeWidth = style.strokeWidth * Math.sqrt(Math.abs(det));
    const fill = fillAlpha > 0 ? paintName(fillPaint) : 'none';
    const stroke = strokeAlpha > 0 && strokeWidth > 0 ? paintName(style.stroke) : 'none';
    if (fill === 'none' && stroke === 'none') return;
    const shapeOpacity = opacity * (fill !== 'none' ? fillAlpha : strokeAlpha);
    if (shapeOpacity <= 0.0005) return;

    const path = svgpath(d).matrix(m).abs();
    const abs = path.toString();
    if (!abs) return;
    if (this.drawn.length >= DRAWN_MAX) throw new LogoProblem('too_complex');
    const stroked = stroke !== 'none';
    this.drawn.push({
      abs,
      fill,
      ...(stroked
        ? {
            stroke,
            strokeWidth,
            ...(style.linecap !== 'butt' ? { linecap: style.linecap } : {}),
            ...(style.linejoin !== 'miter' ? { linejoin: style.linejoin } : {}),
          }
        : {}),
      evenodd: style.evenodd && fill !== 'none',
      opacity: shapeOpacity,
      box: bounds(abs, stroked ? strokeWidth : 0),
    });
  }

  /** The element as path data, before transforms. */
  private pathData(el: El): string | null {
    const a = el.attrs;
    const { w: bw, h: bh } = this.box;
    const diag = Math.hypot(bw, bh) / Math.SQRT2;
    const lx = (s: string | undefined) => length(s, bw);
    const ly = (s: string | undefined) => length(s, bh);
    switch (el.name) {
      case 'path':
        return a.d?.trim() || null;
      case 'rect': {
        const x = lx(a.x) ?? 0;
        const y = ly(a.y) ?? 0;
        const w = lx(a.width) ?? 0;
        const h = ly(a.height) ?? 0;
        if (w <= 0 || h <= 0) return null;
        let rx = lx(a.rx);
        let ry = ly(a.ry);
        if (rx === null || rx < 0) rx = ry !== null && ry >= 0 ? ry : 0;
        if (ry === null || ry < 0) ry = rx;
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        if (rx === 0 || ry === 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
        return [
          `M${x + rx} ${y}H${x + w - rx}`,
          `A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}`,
          `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}`,
          `A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}`,
          `A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`,
        ].join('');
      }
      case 'circle':
      case 'ellipse': {
        const cx = lx(a.cx) ?? 0;
        const cy = ly(a.cy) ?? 0;
        let rx = el.name === 'circle' ? length(a.r, diag) : lx(a.rx);
        let ry = el.name === 'circle' ? rx : ly(a.ry);
        if (rx === null || rx < 0) rx = ry;
        if (ry === null || ry < 0) ry = rx;
        if (!rx || !ry || rx <= 0 || ry <= 0) return null;
        return `M${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}Z`;
      }
      case 'line':
        return `M${lx(a.x1) ?? 0} ${ly(a.y1) ?? 0}L${lx(a.x2) ?? 0} ${ly(a.y2) ?? 0}`;
      case 'polyline':
      case 'polygon': {
        const n = numbers(a.points ?? '');
        if (n.length < 4) return null;
        const pairs: string[] = [];
        for (let i = 0; i + 1 < n.length; i += 2) pairs.push(`${n[i]} ${n[i + 1]}`);
        return `M${pairs.join('L')}${el.name === 'polygon' ? 'Z' : ''}`;
      }
      default:
        return null;
    }
  }
}

function hasText(el: El): boolean {
  return el.text.trim() !== '' || el.children.some(hasText);
}

function isAncestor(candidate: El, el: El): boolean {
  for (let p: El | null = el; p; p = p.parent) if (p === candidate) return true;
  return false;
}

function mean(a: Rgba, b: Rgba): Rgba {
  return { r: (a.r + b.r) / 2, g: (a.g + b.g) / 2, b: (a.b + b.b) / 2, a: (a.a + b.a) / 2 };
}

function paintAlpha(p: Paint): number {
  return p.kind === 'none' ? 0 : p.kind === 'current' ? 1 : p.c.a;
}

function paintName(p: Paint): string {
  return p.kind === 'none' ? 'none' : p.kind === 'current' ? 'currentColor' : toHex(p.c);
}

/**
 * A box around the path, never smaller than what it draws: control points hold their curves, and an arc stays within
 * its diameter (or its chord, when it is too small to reach) of its end point.
 */
function bounds(abs: string, strokeWidth: number): [number, number, number, number] {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const add = (x: number, y: number, r = 0) => {
    x0 = Math.min(x0, x - r);
    y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r);
    y1 = Math.max(y1, y + r);
  };
  svgpath(abs).iterate((seg, _i, x, y) => {
    const s = seg as unknown as [string, ...number[]];
    const n = s.slice(1) as number[];
    switch (s[0]) {
      case 'H':
        add(n[0] ?? x, y);
        break;
      case 'V':
        add(x, n[0] ?? y);
        break;
      case 'A': {
        const ex = n[5] ?? x;
        const ey = n[6] ?? y;
        const reach = Math.max(
          2 * Math.max(Math.abs(n[0] ?? 0), Math.abs(n[1] ?? 0)),
          Math.hypot(ex - x, ey - y),
        );
        add(x, y, reach);
        add(ex, ey, reach);
        break;
      }
      default:
        for (let i = 0; i + 1 < n.length; i += 2) add(n[i] as number, n[i + 1] as number);
    }
  });
  // A stroke reaches past the path, further at a sharp mitred corner.
  const r = strokeWidth * 2;
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}

function overlaps(a: Drawn['box'], b: Drawn['box']): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function paintKey(s: Drawn): string {
  return [s.fill, s.stroke, s.strokeWidth, s.linecap, s.linejoin, s.evenodd, s.opacity.toFixed(3)].join('|');
}

/** One colour for the whole logo that is near black or near white follows the text instead. */
function followText(drawn: Drawn[]): void {
  const colours = new Set<string>();
  for (const s of drawn) {
    if (s.fill !== 'none') colours.add(s.fill);
    if (s.stroke) colours.add(s.stroke);
  }
  if (colours.size !== 1) return;
  const [only] = colours as Set<string>;
  if (!only?.startsWith('#')) return;
  const c = parseColour(only);
  if (!c || typeof c !== 'object') return;
  const l = luminance(c);
  if (l >= 0.06 && l <= 0.9) return;
  for (const s of drawn) {
    if (s.fill !== 'none') s.fill = 'currentColor';
    if (s.stroke) s.stroke = 'currentColor';
  }
}

/**
 * Consecutive shapes painted alike become one path. Shapes that overlap stay apart unless they are opaque strokes:
 * joined, overlapping fills could cut holes in each other (even-odd, or opposite windings).
 */
function merge(drawn: Drawn[]): Drawn[][] {
  const groups: Drawn[][] = [];
  let key = '';
  for (const s of drawn) {
    const k = paintKey(s);
    const group = groups.at(-1);
    const safe = s.fill === 'none' && s.opacity >= 0.9995;
    if (group && k === key && (safe || !group.some((g) => overlaps(g.box, s.box)))) group.push(s);
    else groups.push([s]);
    key = k;
  }
  return groups;
}

function formatNumber(n: number): string {
  const v = Number(n.toPrecision(10));
  return String(Object.is(v, -0) ? 0 : v);
}

function finish(drawn: Drawn[], box: Box): SvgLogoResult {
  if (drawn.length === 0) return fail('nothing');
  followText(drawn);
  const groups = merge(drawn);
  if (groups.length > THING_LOGO_SHAPES_MAX) return fail('too_complex');
  // Two decimals on a 24-unit box, none on a 1000-unit one: finer than any screen draws a logo.
  const size = Math.max(box.w, box.h);
  const base = Math.min(6, Math.max(0, Math.ceil(3 - Math.log10(size))));
  for (let decimals = base; decimals >= Math.max(0, base - 1); decimals--) {
    const shapes = write(groups, decimals);
    if (shapes.length === 0) return fail('nothing');
    const total = shapes.reduce((n, s) => n + s.d.length, 0);
    if (total > THING_LOGO_PATH_MAX) continue;
    const parsed = ThingLogo.safeParse({
      viewBox: [box.x, box.y, box.w, box.h].map(formatNumber).join(' '),
      shapes,
    });
    return parsed.success ? { ok: true, logo: parsed.data } : fail('invalid');
  }
  return fail('too_complex');
}

function write(groups: Drawn[][], decimals: number): ThingLogoShape[] {
  const shapes: ThingLogoShape[] = [];
  for (const group of groups) {
    const d = group
      .map((s) => svgpath(s.abs).rel().round(decimals).toString())
      .join('')
      .trim();
    const first = group[0];
    if (!d || !first) continue;
    const opacity = Math.round(first.opacity * 1000) / 1000;
    if (opacity <= 0) continue;
    const shape: ThingLogoShape = { d, fill: first.fill as ThingLogoShape['fill'] };
    if (first.stroke && first.strokeWidth) {
      shape.stroke = first.stroke as NonNullable<ThingLogoShape['stroke']>;
      // One decimal finer than the path, and never rounded down to nothing.
      shape.strokeWidth = Number(Math.max(10 ** -(decimals + 1), first.strokeWidth).toFixed(decimals + 1));
      if (first.linecap) shape.linecap = first.linecap;
      if (first.linejoin) shape.linejoin = first.linejoin;
    }
    if (first.evenodd) shape.fillRule = 'evenodd';
    if (opacity < 1) shape.opacity = opacity;
    shapes.push(shape);
  }
  return shapes;
}
