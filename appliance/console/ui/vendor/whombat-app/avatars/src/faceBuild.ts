/**
 * How a face's poses are kept and put back together. Pure: `scripts/face-data.ts` uses it to write `faceData.ts` from
 * the drawings, and `face.ts` uses it to draw a pose.
 */
import {
  attributeOf,
  elementMarkup,
  findElement,
  insertAfter,
  removeElement,
  replaceElement,
  setAttribute,
} from './svgParts';

/** The drawn expressions a live face uses, by the handoff's names (`<stem>-<pose>.svg`). `neutral` is the bust itself. */
export const FACE_POSES = [
  'neutral',
  'listening',
  'thinking',
  'working',
  'happy',
  'apologetic',
  'sleepy',
  'surprised',
  'celebrate',
] as const;
export type FacePose = (typeof FACE_POSES)[number];

/** The drawing's file stems (`AVATAR_FILE_STEMS`' values), repeated here so this module stands alone. */
export const FACE_STEMS = ['associate', 'developer', 'operator', 'lead', 'assistant'] as const;
export type FaceStem = (typeof FACE_STEMS)[number];

/** The parts a pose may change, besides the head's and the ears' transforms. */
export const POSE_PART_IDS = ['blush', 'mouth', 'eyes', 'brows', 'glasses', 'shades', 'cue'] as const;
export type PosePartId = (typeof POSE_PART_IDS)[number];

/**
 * Parts added to the drawings after the handoff (the small-size fixes): Hazel's pencil, Neo's rim. No pose touches
 * them; `face.test.ts` takes them out before comparing a pose with its expression file.
 */
export const ART_FIX_IDS = ['pencil', 'rim'] as const;

export interface FacePoseData {
  /** The `transform` of the head (and of its shadow on the shirt). */
  head: string;
  /** The ears' `transform`s. */
  earL: string;
  earR: string;
  /** Parts that differ from the bust: their markup, or null when the pose has none. Absent: as in the bust. */
  parts: Partial<Record<PosePartId, string | null>>;
  /** Where the eyes' middle and the mouth's top are, in the drawing's units: the blink and the talking mouth pivot there. */
  eyeY: number;
  mouthY: number;
}

export interface FaceDrawing {
  /** The bust file's markup, as it is. */
  bust: string;
  /** The head file's framing (the `transform` of its outer group): the live face at 25–39 px uses the bust at this crop. */
  headCrop: string;
  poses: Record<FacePose, FacePoseData>;
}

export type FaceDrawings = Record<FaceStem, FaceDrawing>;

/** The bust's outer framing; the head crop replaces it. */
export const BUST_FRAME = /<g transform="(scale\([^)]*\) translate\([^)]*\))">/;
/** The head's shadow on the shirt: the group in the body's clip, which tilts with the head. */
const SHADOW = /(<g clip-path="url\(#bc\)">\s*<g transform=")([^"]*)(")/;

/** The bust with `pose` put on it: the same markup as the pose's expression file (but for the title). */
export function assemblePose(bust: string, pose: FacePoseData): string {
  let m = setAttribute(bust, 'head', 'transform', pose.head);
  m = m.replace(SHADOW, `$1${pose.head}$3`);
  m = setAttribute(m, 'ear-l', 'transform', pose.earL);
  m = setAttribute(m, 'ear-r', 'transform', pose.earR);
  for (const id of POSE_PART_IDS) {
    const part = pose.parts[id];
    if (part === undefined) continue;
    if (part === null) m = removeElement(m, id);
    else if (findElement(m, id)) m = replaceElement(m, id, part);
    else if (id === 'blush') m = insertAfter(m, 'muzzle', part);
    // The symbol floats beside the head (after it in the drawing): it doesn't tilt with it.
    else if (id === 'cue') m = insertAfter(m, 'head', part);
    else throw new Error(`no place for ${id}`);
  }
  return m;
}

/**
 * The markup without its title and without the parts added after the handoff. The neutral expression names its eyelid
 * clips after itself (`clneutral`) where the bust says `clb`: the same drawing.
 */
export function comparable(markup: string): string {
  let m = markup
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(/(["#])clneutral\b/g, '$1clb')
    .replace(/(["#])crneutral\b/g, '$1crb');
  for (const id of ART_FIX_IDS) m = removeElement(m, id);
  return m;
}

function eyeY(eyes: string | null): number {
  const ys = [...(eyes ?? '').matchAll(/<circle cx="[^"]*" cy="([\d.]+)" r="([\d.]+)"/g)]
    .filter((m) => Number(m[2]) >= 12)
    .map((m) => Number(m[1]));
  return ys.length ? round(ys.reduce((a, b) => a + b, 0) / ys.length) : 210;
}

function mouthY(mouth: string | null): number {
  const y = /\sd="M[\d.]+[ ,]([\d.]+)/.exec(mouth ?? '');
  return y ? Number(y[1]) : 312;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function poseOf(neutral: string, expression: string, name: string): FacePoseData {
  const need = (id: string, attr: string) => {
    const v = attributeOf(expression, id, attr);
    if (v === null) throw new Error(`${name}: no ${id} ${attr}`);
    return v;
  };
  const parts: FacePoseData['parts'] = {};
  for (const id of POSE_PART_IDS) {
    const before = elementMarkup(neutral, id);
    const after = elementMarkup(expression, id);
    if (before !== after) parts[id] = after;
  }
  const eyes = elementMarkup(expression, 'eyes');
  const mouth = elementMarkup(expression, 'mouth');
  return {
    head: need('head', 'transform'),
    earL: need('ear-l', 'transform'),
    earR: need('ear-r', 'transform'),
    parts,
    eyeY: eyeY(eyes),
    mouthY: mouthY(mouth),
  };
}

/**
 * Every face's bust and poses. `readSvg('associate-bust')` reads `svg/`; `readExpression('associate', 'happy')` the
 * handoff's expressions. Throws when an expression changes more than a pose can say.
 */
export function buildFaceData(
  readSvg: (name: string) => string,
  readExpression: (stem: FaceStem, pose: FacePose) => string,
): FaceDrawings {
  const out = {} as FaceDrawings;
  for (const stem of FACE_STEMS) {
    const bust = readSvg(`${stem}-bust`);
    const headCrop = BUST_FRAME.exec(readSvg(`${stem}-head`))?.[1];
    if (!headCrop) throw new Error(`${stem}-head: no framing`);
    const neutral = comparable(bust);
    if (neutral !== comparable(readExpression(stem, 'neutral')))
      throw new Error(`${stem}: bust isn't the neutral pose`);
    const poses = {} as Record<FacePose, FacePoseData>;
    for (const pose of FACE_POSES) {
      const expression = comparable(readExpression(stem, pose));
      const data = poseOf(neutral, expression, `${stem}-${pose}`);
      if (assemblePose(neutral, data) !== expression)
        throw new Error(`${stem}-${pose}: the pose doesn't rebuild its expression`);
      poses[pose] = data;
    }
    out[stem] = { bust, headCrop, poses };
  }
  return out;
}
