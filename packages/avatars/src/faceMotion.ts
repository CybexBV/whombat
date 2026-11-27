/**
 * How the live face moves, written once for every engine (the web and the desk screen in `puppet.ts`, the phone with
 * Reanimated): which state shows which pose, what may move at which size, the timings, and each move as keyframes per
 * part. Pure data and small functions, no DOM.
 *
 * The rule behind it (docs/app/decisions/face-motion.md): the face moves when something happens, then stands still.
 * One-off moves (a blink, a pose change, a gesture) cost almost nothing even on the box's screen without a graphics chip;
 * what costs is anything that redraws every frame without end, so loops are rare, short and only where there is a chip.
 */
import type { FacePart, FacePose } from './face';
import type { AvatarFace } from './index';

/** What the agent is doing, as the face shows it. */
export const FACE_STATES = [
  'idle',
  'listening',
  'thinking',
  'working',
  'speaking',
  'needs',
  'done',
  'sorry',
  'asleep',
  'welcome',
  'celebrate',
] as const;
export type FaceState = (typeof FACE_STATES)[number];

/** The drawn expression each state shows (and `poke`'s brief surprise). */
export const FACE_STATE_POSE: Record<FaceState | 'poke', FacePose> = {
  idle: 'neutral',
  listening: 'listening',
  thinking: 'thinking',
  working: 'working',
  speaking: 'neutral',
  needs: 'neutral',
  done: 'happy',
  sorry: 'apologetic',
  asleep: 'sleepy',
  welcome: 'neutral',
  celebrate: 'celebrate',
  poke: 'surprised',
};

/**
 * `full`: everything the size allows. `calm`: no loops (the box's screen without a graphics chip; its kiosk forces
 * reduced motion for exactly that). `reduced`: the person asked for less motion, or turned “Moving faces” off: poses still
 * change, because they say something, but nothing moves between them.
 */
export type FaceMotionMode = 'full' | 'calm' | 'reduced';

/** The smallest live face: below it the still small head shows and never changes. */
export const LIVE_FACE_MIN_SIZE = 25;
/** From here the face is the bust; below it, the bust drawing at the head's framing. */
export const LIVE_BUST_MIN_SIZE = 40;
/** From here the small symbol beside the head (thought dots, zZ, sparkles) is readable. */
export const FACE_CUE_MIN_SIZE = 64;
/** From here loops may run (breathing while working, ears following a voice). */
export const FACE_LOOP_MIN_SIZE = 96;

export interface FaceAllowance {
  /** Draw a live face at all (otherwise the still file). */
  live: boolean;
  /** Blend from one pose to the next (otherwise swap at once). */
  blend: boolean;
  blink: boolean;
  /** One-off moves: nods, the signature gesture, a poke's answer. */
  gestures: boolean;
  /** The talking mouth, in steps. */
  mouth: boolean;
  /** The thought dots stepping. */
  dots: boolean;
  /** Draw the symbol beside the head. */
  cue: boolean;
  /** Loops: breathing while working, the first 20 s; the ears following the voice. */
  loops: boolean;
}

/**
 * What a face of `size` px may do in `mode`. `holdsMotion`: whether this face is the one moving face on the screen
 * (the biggest, or the newest of the biggest); the others only change pose.
 */
export function faceAllowance(size: number, mode: FaceMotionMode, holdsMotion = true): FaceAllowance {
  const live = size >= LIVE_FACE_MIN_SIZE;
  const big = size >= LIVE_BUST_MIN_SIZE;
  const moving = live && big && mode !== 'reduced' && holdsMotion;
  return {
    live,
    blend: moving,
    blink: moving,
    gestures: moving,
    mouth: moving,
    dots: moving && size >= FACE_CUE_MIN_SIZE,
    cue: size >= FACE_CUE_MIN_SIZE,
    loops: moving && mode === 'full' && size >= FACE_LOOP_MIN_SIZE,
  };
}

/** The crop a live face of `size` px uses unless it asks for one: the head under 40 px, where the bust reads too small. */
export function liveFaceCrop(size: number): 'bust' | 'head' {
  return size >= LIVE_BUST_MIN_SIZE ? 'bust' : 'head';
}

/** Timings, ms. */
export const FACE_TIMING = {
  /** A pose blend: the eyes close, the parts move, the eyes open on the new pose. */
  blend: 240,
  eyesClose: 70,
  eyesOpen: 110,
  /** The brows lead, the head follows, the ears trail. */
  headDelay: 30,
  earsDelay: 70,
  /** Between blinks, at random; one blink in six is double. */
  blinkMin: 3500,
  blinkMax: 7000,
  doubleBlink: 1 / 6,
  /** Blinking stops after this long without a state change or a touch, and starts again with one. */
  blinkFor: 120_000,
  /** Done: glad this long before the gesture. */
  doneHold: 1200,
  celebrateHold: 2000,
  /** A poke: surprised this long; one at most every `pokeGap`. */
  pokeHold: 260,
  pokeGap: 2000,
  /** Steps of the talking mouth and of the thought dots. */
  mouthStep: 100,
  dotsStep: 450,
  /** The breathing loop's period, and how long it runs. */
  breathe: 4500,
  breatheFor: 20_000,
  /** The ears following the voice, a step. */
  earStep: 100,
} as const;

/** Easing curves as cubic-bézier points. */
export const FACE_EASINGS = {
  standard: [0.2, 0.8, 0.2, 1],
  in: [0.4, 0, 1, 1],
  out: [0, 0, 0.2, 1],
  inOut: [0.42, 0, 0.58, 1],
  spring: [0.34, 1.56, 0.64, 1],
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;
export type FaceEasing = keyof typeof FACE_EASINGS;

/** One keyframe of a part: a shift (drawing units), a turn (degrees) and a scale round the part's pivot. */
export interface PartFrame {
  /** 0 to 1 along the move. */
  at: number;
  x?: number;
  y?: number;
  rotate?: number;
  sx?: number;
  sy?: number;
  opacity?: number;
  /** How much of a line is drawn, 0 to 1 (Hazel's tick). */
  draw?: number;
}

/** One part's move. */
export interface PartMove {
  part: FacePart;
  frames: readonly PartFrame[];
  duration: number;
  delay?: number;
  easing: FaceEasing;
  /** Times it plays. Default 1. */
  iterations?: number;
  /** Stays at its last frame (until the next pose). */
  hold?: boolean;
}

/** The talking mouth's openings; `mouthOpening(level)` picks one from the voice's loudness (0–1). */
export const MOUTH_OPENINGS = [0.18, 0.5, 0.78, 1] as const;
export function mouthOpening(level: number): number {
  if (level < 0.15) return MOUTH_OPENINGS[0];
  if (level < 0.45) return MOUTH_OPENINGS[1];
  if (level < 0.75) return MOUTH_OPENINGS[2];
  return MOUTH_OPENINGS[3];
}

/** How far the ears lean with the voice while listening, degrees at full loudness. */
export const EAR_FOLLOW_DEGREES = 2.5;

const once = (
  part: FacePart,
  frames: PartFrame[],
  duration: number,
  easing: FaceEasing,
  more: Partial<PartMove> = {},
) => ({ part, frames, duration, easing, ...more }) satisfies PartMove;

export const BLINK: readonly PartMove[] = [
  once(
    'eyes',
    [
      { at: 0, sy: 1 },
      { at: 0.32, sy: 0.1 },
      { at: 0.5, sy: 0.1 },
      { at: 1, sy: 1 },
    ],
    220,
    'in',
  ),
];

/** A nod: the head dips 6 units and comes back. */
export function nod(times = 1): PartMove[] {
  return [
    once('head', [{ at: 0 }, { at: 0.4, y: 6, rotate: -1 }, { at: 1 }], times > 1 ? 280 : 360, 'inOut', {
      iterations: times,
    }),
  ];
}

/** The ears come up and settle: waking, hearing someone. */
export const PERK: readonly PartMove[] = [
  once('ear-l', [{ at: 0 }, { at: 0.35, rotate: 9 }, { at: 1 }], 520, 'spring'),
  once('ear-r', [{ at: 0 }, { at: 0.35, rotate: -9 }, { at: 1 }], 520, 'spring'),
];

/** A look toward a card that waits, with a lifted brow; held until the next pose. */
export const GLANCE: readonly PartMove[] = [
  once('eyes', [{ at: 0 }, { at: 1, x: 7, y: 3 }], 300, 'standard', { hold: true }),
  once('brows', [{ at: 0 }, { at: 1, y: -6 }], 300, 'standard', { hold: true }),
];

/** A poke's first answer: a small squash of the whole face. */
export const SQUASH: readonly PartMove[] = [
  once('head', [{ at: 0 }, { at: 0.5, sx: 1.02, sy: 0.97 }, { at: 1 }], 160, 'out'),
];

/** Each character's own move: once when a run someone waited for is done, and when poked. */
export const SIGNATURE_GESTURES: Record<AvatarFace, readonly PartMove[]> = {
  // Dusty pushes the glasses up, one brow raised.
  dusty: [
    once('specs', [{ at: 0 }, { at: 0.3, y: -8 }, { at: 0.65, y: 1.5 }, { at: 1 }], 560, 'out'),
    once(
      'brows',
      [{ at: 0 }, { at: 0.3, y: -7, rotate: -3 }, { at: 0.75, y: -7, rotate: -3 }, { at: 1 }],
      900,
      'inOut',
    ),
  ],
  // Banjo reads a line left to right, then nudges the taped glasses.
  banjo: [
    once(
      'eyes',
      [
        { at: 0 },
        { at: 0.12, x: -7 },
        { at: 0.3, x: -7 },
        { at: 0.42, x: 0 },
        { at: 0.58, x: 0 },
        { at: 0.7, x: 7 },
        { at: 0.86, x: 7 },
        { at: 1 },
      ],
      1400,
      'inOut',
    ),
    once('specs', [{ at: 0 }, { at: 0.4, y: -4, rotate: 2.5 }, { at: 1 }], 380, 'out', { delay: 1400 }),
  ],
  // Neo lowers the shades and peeks over them.
  neo: [
    once('specs', [{ at: 0 }, { at: 0.25, y: 16 }, { at: 0.72, y: 16 }, { at: 1 }], 1400, 'standard'),
    once('brows', [{ at: 0 }, { at: 0.25, y: -6 }, { at: 0.72, y: -6 }, { at: 1 }], 1400, 'inOut'),
  ],
  // Skipper's cowlick springs while the head cocks with the wink.
  skipper: [
    once(
      'cowlick',
      [
        { at: 0 },
        { at: 0.18, rotate: -14 },
        { at: 0.4, rotate: 9 },
        { at: 0.62, rotate: -4 },
        { at: 0.8, rotate: 1.5 },
        { at: 1 },
      ],
      800,
      'out',
    ),
    once('head', [{ at: 0 }, { at: 0.35, rotate: 3.5 }, { at: 0.7, rotate: 3.5 }, { at: 1 }], 900, 'inOut'),
  ],
  // Hazel ticks her clipboard and nods twice. (Her clipboard is in the bust only; the nod is enough at head sizes.)
  hazel: [
    once(
      'tick',
      [
        { at: 0, draw: 0, opacity: 1 },
        { at: 0.2, draw: 1, opacity: 1 },
        { at: 0.85, draw: 1, opacity: 1 },
        { at: 1, draw: 1, opacity: 0 },
      ],
      1600,
      'out',
    ),
    ...nod(2).map((m) => ({ ...m, delay: 120 })),
  ],
};

/** A step of a state's sequence. */
export type FaceStep =
  | { pose: FacePose; mouthFrom?: FacePose }
  | { wait: number }
  | { moves: readonly PartMove[] }
  | { gesture: true };

/**
 * What a state does when it starts. Most states are one pose; a few are short scenes that end calm. `from` is the state
 * before (a welcome starts from asleep).
 */
export function faceSequence(state: FaceState, from: FaceState | null): FaceStep[] {
  switch (state) {
    case 'done':
      return [
        { pose: 'happy' },
        { wait: FACE_TIMING.doneHold },
        { gesture: true },
        { wait: 250 },
        { pose: 'neutral' },
      ];
    case 'celebrate':
      return [{ pose: 'celebrate' }, { wait: FACE_TIMING.celebrateHold }, { pose: 'neutral' }];
    case 'welcome':
      return [
        ...(from === 'asleep' ? [] : [{ pose: 'sleepy' as const }, { wait: 400 }]),
        { pose: 'neutral' },
        { moves: [...PERK, ...nod()] },
      ];
    case 'needs':
      return [{ pose: 'neutral' }, { moves: GLANCE }];
    case 'speaking':
      return [{ pose: 'neutral', mouthFrom: 'happy' }];
    default:
      return [{ pose: FACE_STATE_POSE[state] }];
  }
}

/** The pose a state rests in once its sequence has played (done and celebrate end calm). */
export function restingPose(state: FaceState): FacePose {
  if (state === 'done' || state === 'celebrate' || state === 'welcome') return 'neutral';
  return FACE_STATE_POSE[state];
}

/** A part's transform at one keyframe, round its pivot, as SVG transform text (drawing units). */
export function frameTransform(frame: PartFrame, pivot: readonly [number, number]): string {
  const [px, py] = pivot;
  const x = frame.x ?? 0;
  const y = frame.y ?? 0;
  const r = frame.rotate ?? 0;
  const sx = frame.sx ?? 1;
  const sy = frame.sy ?? 1;
  if (!x && !y && !r && sx === 1 && sy === 1) return '';
  return `translate(${fix(px + x)} ${fix(py + y)}) rotate(${fix(r)}) scale(${fix(sx)} ${fix(sy)}) translate(${fix(-px)} ${fix(-py)})`;
}

/** `frame` on top of a held one (a blink on eyes that glance aside): moves and turns add up, sizes multiply. */
export function composeFrames(held: PartFrame | undefined, frame: PartFrame): PartFrame {
  if (!held) return frame;
  return {
    at: frame.at,
    x: (held.x ?? 0) + (frame.x ?? 0),
    y: (held.y ?? 0) + (frame.y ?? 0),
    rotate: (held.rotate ?? 0) + (frame.rotate ?? 0),
    sx: (held.sx ?? 1) * (frame.sx ?? 1),
    sy: (held.sy ?? 1) * (frame.sy ?? 1),
    opacity: frame.opacity ?? held.opacity,
    draw: frame.draw ?? held.draw,
  };
}

/** The frame between keyframes at `t` (0–1, already eased), every property in a straight line. */
export function frameAt(frames: readonly PartFrame[], t: number): PartFrame {
  const first = frames[0] as PartFrame;
  if (t <= first.at) return first;
  for (let i = 1; i < frames.length; i++) {
    const b = frames[i] as PartFrame;
    if (t <= b.at) {
      const a = frames[i - 1] as PartFrame;
      const k = b.at === a.at ? 1 : (t - a.at) / (b.at - a.at);
      const mix = (p: keyof PartFrame, base: number) => {
        const va = (a[p] as number | undefined) ?? base;
        const vb = (b[p] as number | undefined) ?? base;
        return va + (vb - va) * k;
      };
      // Opacity and drawing only where a keyframe sets them: a part that never fades keeps the drawing's own.
      const maybe = (p: 'opacity' | 'draw') =>
        a[p] === undefined && b[p] === undefined ? undefined : mix(p, 1);
      return {
        at: t,
        x: mix('x', 0),
        y: mix('y', 0),
        rotate: mix('rotate', 0),
        sx: mix('sx', 1),
        sy: mix('sy', 1),
        opacity: maybe('opacity'),
        draw: maybe('draw'),
      };
    }
  }
  return frames[frames.length - 1] as PartFrame;
}

/** A cubic-bézier easing as a function of 0–1. */
export function easing(name: FaceEasing): (x: number) => number {
  const [x1, y1, x2, y2] = FACE_EASINGS[name];
  if (name === 'linear') return (x) => x;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (t: number) => ((ax * t + bx) * t + cx) * t;
  const Y = (t: number) => ((ay * t + by) * t + cy) * t;
  const dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = dX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (X(t) - x) / d;
    }
    return Y(Math.min(1, Math.max(0, t)));
  };
}

/** Numbers in two transforms of the same shape, mixed (`t` 0–1); a different shape jumps at the end. */
export function mixTransforms(a: string, b: string, t: number): string {
  const na = a.match(NUMBER);
  const nb = b.match(NUMBER);
  if (!na || !nb || na.length !== nb.length) return t < 1 ? a : b;
  let i = 0;
  return b.replace(NUMBER, () => {
    const v = Number(na[i]) + (Number(nb[i]) - Number(na[i])) * t;
    i++;
    return fix(v);
  });
}
const NUMBER = /-?\d*\.?\d+(?:e-?\d+)?/g;

function fix(n: number): string {
  return String(Math.round(n * 100) / 100);
}
