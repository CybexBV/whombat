/**
 * The pure half of the phone's live face (`LiveFace.tsx` draws it, `facePuppet.ts` moves it): what a run or a reply
 * shows, which face on screen may move, the drawing turned into a tree whose movable parts the app can drive, and each
 * move turned into a table of frames. Reanimated can only run its own worklets on the display thread, not
 * `@whombat/avatars/motion`'s functions, so a move is worked out here, ahead, at 60 frames a second, and the display
 * thread only steps through the table. No React Native here: it is unit-tested in Node.
 */
import type { FacePart } from '@whombat/avatars/face';
import {
  composeFrames,
  easing,
  FACE_TIMING,
  type FaceState,
  frameAt,
  mixTransforms,
  type PartFrame,
  type PartMove,
} from '@whombat/avatars/motion';
import type { RunStatus } from '@whombat/core';

/* What a face shows ------------------------------------------------------------------------------------------------ */

/**
 * A run's face: at work while it runs, thinking while nothing has started yet, needs the person while it waits on them
 * (it stopped and asked, or someone paused it), glad when done, sorry when it failed. Taken over: just there.
 */
export function runFaceState(run: {
  status: RunStatus;
  attention?: string | null;
  steps: readonly { state: string }[];
  logCount: number;
}): FaceState {
  switch (run.status) {
    case 'failed':
      return 'sorry';
    case 'done':
      return 'done';
    case 'paused':
      return 'needs';
    case 'taken_over':
      return 'idle';
    case 'live':
      if (run.attention?.trim()) return 'needs';
      if (run.logCount === 0 && run.steps.every((s) => s.state === 'queued')) return 'thinking';
      return 'working';
  }
}

/** The agent's newest message while it works on the next reply: thinking, at work once it does something, sorry when it failed. */
export function replyFaceState(reply: { typing: boolean; acting: boolean; failed: boolean }): FaceState {
  if (reply.typing) return reply.acting ? 'working' : 'thinking';
  return reply.failed ? 'sorry' : 'idle';
}

/** The one face that may move: the biggest; among equals, the newest (the highest id). */
export function pickHolder(faces: Iterable<{ id: number; size: number }>): number | null {
  let best: { id: number; size: number } | null = null;
  for (const f of faces)
    if (!best || f.size > best.size || (f.size === best.size && f.id > best.id)) best = f;
  return best?.id ?? null;
}

/* Transforms as matrices ------------------------------------------------------------------------------------------- */

/** An SVG matrix `[a, b, c, d, e, f]`: x′ = a·x + c·y + e, y′ = b·x + d·y + f (react-native-svg's `matrix` too). */
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` after `n` (n applies first), as SVG's transform list `m n` means. */
export function multiply(m: Matrix, n: Matrix): Matrix {
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
const scale = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];
function rotate(deg: number): Matrix {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, 0, 0];
}

/** An SVG `transform` attribute as one matrix (translate, scale, rotate round a point, matrix, skewX, skewY). */
export function parseTransform(text: string): Matrix {
  let m = IDENTITY;
  for (const [, name, args = ''] of text.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const n = args.trim()
      ? args
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : [];
    const [a = 0, b, c, d = 0, e = 0, f = 0] = n;
    let step: Matrix;
    switch (name) {
      case 'translate':
        step = translate(a, b ?? 0);
        break;
      case 'scale':
        step = scale(a, b ?? a);
        break;
      case 'rotate':
        step =
          b === undefined || c === undefined
            ? rotate(a)
            : multiply(translate(b, c), multiply(rotate(a), translate(-b, -c)));
        break;
      case 'matrix':
        step = [a, b ?? 0, c ?? 0, d, e, f];
        break;
      case 'skewX':
        step = [1, 0, Math.tan((a * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        step = [1, Math.tan((a * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        continue;
    }
    m = multiply(m, step);
  }
  return m;
}

/** A keyframe round its pivot, as `frameTransform` writes it: shift, turn and scale round the point. */
export function frameMatrix(frame: PartFrame, pivot: readonly [number, number]): Matrix {
  const [px, py] = pivot;
  const x = frame.x ?? 0;
  const y = frame.y ?? 0;
  const r = frame.rotate ?? 0;
  const sx = frame.sx ?? 1;
  const sy = frame.sy ?? 1;
  if (!x && !y && !r && sx === 1 && sy === 1) return IDENTITY;
  return multiply(
    translate(px + x, py + y),
    multiply(rotate(r), multiply(scale(sx, sy), translate(-px, -py))),
  );
}

/* Frame tables ----------------------------------------------------------------------------------------------------- */

/** Numbers per frame in a table: the matrix, then the opacity, then how much of a line is drawn. */
export const SAMPLE = 8;
const FRAME_MS = 1000 / 60;

/** What a part shows when nothing moves it: its opacity and how much of its line is drawn. */
export interface PartRest {
  opacity: number;
  draw: number;
}

function push(out: number[], m: Matrix, opacity: number, draw: number): void {
  out.push(m[0], m[1], m[2], m[3], m[4], m[5], opacity, draw);
}

/** One frame: a part standing still at `frame`. */
export function stillSample(frame: PartFrame | undefined, pivot: readonly [number, number], rest: PartRest) {
  const out: number[] = [];
  push(
    out,
    frame ? frameMatrix(frame, pivot) : IDENTITY,
    frame?.opacity ?? rest.opacity,
    frame?.draw ?? rest.draw,
  );
  return out;
}

/** A matrix standing still (a pose's own transform of the head, an ear, a brow). */
export function matrixSample(m: Matrix): number[] {
  const out: number[] = [];
  push(out, m, 1, 1);
  return out;
}

export interface MoveTable {
  samples: number[];
  /** Played over this long, ms, after `delay`. */
  duration: number;
  delay: number;
  /** Where the part rests once the move is over (`hold`: its last frame; otherwise what was held before). */
  held: PartFrame | undefined;
  rest: PartRest;
}

/**
 * A move as frames, as the browser engine plays it: on top of what the part holds (a blink on eyes that glance aside),
 * except a held move, which starts from the part's own place and stays at its last frame. Opacity and drawing change
 * only where a keyframe sets them, and keep their last value after.
 */
export function moveTable(
  move: PartMove,
  pivot: readonly [number, number],
  held: PartFrame | undefined,
  rest: PartRest,
): MoveTable {
  const ease = easing(move.easing);
  const iterations = move.iterations ?? 1;
  const total = move.duration * iterations;
  const under = move.hold ? undefined : held;
  const last = move.frames[move.frames.length - 1] as PartFrame;
  const after = move.hold ? { ...last, at: 1 } : held;
  const end = frameAt(move.frames, ease(1));
  const endRest = { opacity: end.opacity ?? rest.opacity, draw: end.draw ?? rest.draw };
  const n = Math.max(2, Math.ceil(total / FRAME_MS) + 1);
  const samples: number[] = [];
  for (let k = 0; k < n; k++) {
    if (k === n - 1) {
      const finish = composeFrames(after, { at: 1 });
      push(samples, frameMatrix(finish, pivot), endRest.opacity, endRest.draw);
      break;
    }
    const elapsed = (total * k) / (n - 1);
    const t = ease((elapsed % move.duration) / move.duration);
    const frame = composeFrames(under, frameAt(move.frames, t));
    push(samples, frameMatrix(frame, pivot), frame.opacity ?? rest.opacity, frame.draw ?? rest.draw);
  }
  return { samples, duration: total, delay: move.delay ?? 0, held: after, rest: endRest };
}

/**
 * A pose's own transform sliding to the next pose's (`mixTransforms`, the browser engine's blend): after `delay`, over
 * `FACE_TIMING.blend` on the standard curve. A transform of another shape jumps at the end, as there.
 */
export function blendTable(from: string, to: string, delay: number, total: number): number[] {
  const ease = easing('standard');
  const n = Math.max(2, Math.ceil(total / FRAME_MS) + 1);
  const samples: number[] = [];
  for (let k = 0; k < n; k++) {
    const elapsed = (total * k) / (n - 1);
    const t = k === n - 1 ? 1 : ease(Math.min(1, Math.max(0, (elapsed - delay) / FACE_TIMING.blend)));
    push(samples, parseTransform(mixTransforms(from, to, t)), 1, 1);
  }
  return samples;
}

/** The breathing while at work: the head rises a unit and settles, one breath. */
export function breathTable(pivot: readonly [number, number]): number[] {
  const n = Math.ceil(FACE_TIMING.breathe / FRAME_MS) + 1;
  const samples: number[] = [];
  for (let k = 0; k < n; k++) {
    const y = -(1 - Math.cos((2 * Math.PI * k) / (n - 1)));
    push(samples, frameMatrix({ at: 0, y }, pivot), 1, 1);
  }
  return samples;
}

/** The frame `progress` (0–1) of the way through a table, between its two nearest frames. Runs on the display thread. */
export function sampleAt(samples: readonly number[], progress: number): number[] {
  'worklet';
  const n = Math.floor(samples.length / SAMPLE);
  if (n <= 1) return samples.slice(0, SAMPLE);
  const k = Math.min(1, Math.max(0, progress)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(k));
  const f = k - i;
  const out: number[] = [];
  for (let j = 0; j < SAMPLE; j++) {
    const a = samples[i * SAMPLE + j] as number;
    const b = samples[(i + 1) * SAMPLE + j] as number;
    out.push(a + (b - a) * f);
  }
  return out;
}

/* The drawing as a tree ------------------------------------------------------------------------------------------- */

/** An element as react-native-svg's `parse` gives it: attribute names in camelCase, numbers as numbers (ids stay text). */
export interface SvgNode {
  tag: string;
  props: Record<string, unknown>;
  children: (SvgNode | string)[];
}

/** The transforms a pose blend slides: the head and its shadow, each ear, each brow. */
export const BLEND_TARGETS = ['head', 'shadow', 'ear-l', 'ear-r', 'brow-0', 'brow-1'] as const;
export type BlendTarget = (typeof BLEND_TARGETS)[number];

/** The tags a face is drawn with; anything else is left out, as react-native-svg does. */
export const FACE_TAGS = [
  'g',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'path',
  'circle',
  'ellipse',
  'rect',
] as const;
export type FaceTag = (typeof FACE_TAGS)[number];

export type FaceNode =
  | { kind: 'el'; key: string; tag: FaceTag; props: Record<string, unknown>; children: FaceNode[] }
  /** A `data-face-part` group: its own matrix, opacity for the symbol. */
  | { kind: 'part'; key: string; part: FacePart; children: FaceNode[] }
  /** An element whose pose transform slides in a blend: a group that takes the transform (`props` without it). */
  | { kind: 'blend'; key: string; target: BlendTarget; props: Record<string, unknown>; children: FaceNode[] }
  /** Hazel's tick: drawn by its dash, `length` long. */
  | { kind: 'tick'; key: string; props: Record<string, unknown>; length: number }
  /** A thought dot: its opacity steps while the agent thinks. */
  | { kind: 'dot'; key: string; index: number; props: Record<string, unknown> };

export interface FaceTree {
  viewBox: string;
  nodes: FaceNode[];
  /** Each blend target's transform in this pose (absent: this pose doesn't draw it). */
  targets: Partial<Record<BlendTarget, string>>;
  /** Thought dots in the symbol (0 unless asked for). */
  dots: number;
}

/** Attributes only the browser uses: the parts' marks, the root's labels. */
const DROPPED = new Set([
  'dataFacePart',
  'dataFaceSvg',
  'ariaHidden',
  'focusable',
  'role',
  'xmlns',
  'pathLength',
]);
const PARTS = new Set<string>([
  'head',
  'ear-l',
  'ear-r',
  'eyes',
  'brows',
  'mouth',
  'specs',
  'cue',
  'board',
  'tick',
  'cowlick',
]);

function clean(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (!DROPPED.has(k)) out[k] = v;
  return out;
}

/**
 * The face's markup (`faceSvg`, parsed) as nodes the app draws: each part group becomes a node an engine moves, the
 * head's, the ears' and the brows' pose transforms come out to slide between poses, and Hazel's tick is measured for
 * its dash (react-native-svg has no `pathLength`). `dots`: number the circles of the symbol (the thinking pose's).
 */
export function faceTree(root: SvgNode, prefix: string, options: { dots?: boolean } = {}): FaceTree {
  const targets: FaceTree['targets'] = {};
  let dots = 0;
  const targetOf = (id: unknown): BlendTarget | null => {
    if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
    const name = id.slice(prefix.length);
    return name === 'head' || name === 'shadow' || name === 'ear-l' || name === 'ear-r' ? name : null;
  };

  const map = (
    node: SvgNode,
    inCue: boolean,
    brow: number,
    keyOf: (base: string) => string,
  ): FaceNode | null => {
    const part = node.props.dataFacePart;
    if (typeof part === 'string' && PARTS.has(part)) {
      if (part === 'tick') {
        const length = pathLength(String(node.props.d ?? ''));
        return {
          kind: 'tick',
          key: keyOf('part:tick'),
          props: {
            ...clean(node.props),
            strokeDasharray: [length, length],
            strokeDashoffset: length,
            opacity: 0,
          },
          length,
        };
      }
      return {
        kind: 'part',
        key: keyOf(`part:${part}`),
        part: part as FacePart,
        children: kids(node, part === 'cue'),
      };
    }
    if (!(FACE_TAGS as readonly string[]).includes(node.tag)) return null;
    const tag = node.tag as FaceTag;
    const props = clean(node.props);
    const target = targetOf(props.id);
    if (target) {
      const { transform, ...rest } = props;
      targets[target] = typeof transform === 'string' ? transform : '';
      return { kind: 'blend', key: `blend:${target}`, target, props: rest, children: kids(node, inCue) };
    }
    if (brow === 0 || brow === 1) {
      const target: BlendTarget = brow === 0 ? 'brow-0' : 'brow-1';
      const { transform, ...rest } = props;
      targets[target] = typeof transform === 'string' ? transform : '';
      return {
        kind: 'blend',
        key: `blend:${target}`,
        target,
        props: {},
        children: [{ kind: 'el', key: tag, tag, props: rest, children: [] }],
      };
    }
    if (inCue && options.dots && tag === 'circle')
      return { kind: 'dot', key: keyOf('dot'), index: dots++, props };
    const key = typeof props.id === 'string' ? props.id : keyOf(tag);
    return { kind: 'el', key, tag, props, children: kids(node, inCue) };
  };

  const kids = (node: SvgNode, inCue: boolean): FaceNode[] => {
    // The brows' own group (`<g id="…brows">`): its first two rects are the two brows.
    const brows = node.props.id === `${prefix}brows`;
    const out: FaceNode[] = [];
    let rects = 0;
    // Keys among siblings: a pose that adds an element elsewhere doesn't make React draw these again.
    const seen = new Map<string, number>();
    const keyOf = (base: string) => {
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n ? `${base}#${n}` : base;
    };
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      const brow = brows && child.tag === 'rect' ? rects++ : -1;
      const mapped = map(child, inCue, brow, keyOf);
      if (mapped) out.push(mapped);
    }
    return out;
  };

  const viewBox = typeof root.props.viewBox === 'string' ? root.props.viewBox : '0 0 512 512';
  return { viewBox, nodes: kids(root, false), targets, dots };
}

/** How many numbers each path command takes; its end point is its last pair (H and V take one). */
const PATH_ARGS: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };

/** A path's length for its dash: straight lines exactly, a curve as its chord (the tick is lines). */
export function pathLength(d: string): number {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = 'M';
  let length = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        length += Math.hypot(sx - x, sy - y);
        x = sx;
        y = sy;
      }
      continue;
    }
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    const args = tokens.slice(i, i + (PATH_ARGS[upper] ?? 2)).map(Number);
    i += Math.max(1, args.length);
    let nx = x;
    let ny = y;
    if (upper === 'H') nx = (args[0] ?? 0) + (rel ? x : 0);
    else if (upper === 'V') ny = (args[0] ?? 0) + (rel ? y : 0);
    else {
      nx = (args[args.length - 2] ?? 0) + (rel ? x : 0);
      ny = (args[args.length - 1] ?? 0) + (rel ? y : 0);
    }
    if (upper === 'M') {
      sx = nx;
      sy = ny;
      // Pairs after a move are lines.
      cmd = rel ? 'l' : 'L';
    } else length += Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
  }
  return Math.round(length * 100) / 100;
}
