/**
 * The live face: the agent's bust drawing, put in a pose and cut into named parts that can move (`@whombat/avatars/face`).
 * Pure strings, no DOM, so the web, the desk screen and the phone draw the same markup. Kept out of the package's main
 * entry: the drawings and poses are about 130 KB, loaded only where a face is alive.
 *
 * A part is a `<g data-face-part="…">` wrapped round the drawing's own element. Engines move the wrapper and never touch
 * the drawing's own `transform`, so a pose and a move add up. Every move turns round a pivot in the drawing's units
 * (`facePivot`).
 */
import { assemblePose, BUST_FRAME, type FacePose, type FacePoseData } from './faceBuild';
import { FACE_DRAWINGS } from './faceData';
import { AVATAR_FILE_STEMS, type AvatarFace } from './index';
import {
  appendInside,
  elementMarkup,
  prefixIds,
  removeElement,
  replaceElement,
  wrapElement,
} from './svgParts';

export { FACE_POSES, type FacePose } from './faceBuild';

/** The parts an engine can move. `specs` is Dusty's and Banjo's glasses or Neo's shades. */
export const FACE_PARTS = [
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
] as const;
export type FacePart = (typeof FACE_PARTS)[number];

export interface FaceSvgOptions {
  /** The drawn expression to show. Default `neutral`, the bust as it is. */
  pose?: FacePose;
  /** Put in front of every id: many faces share a page. */
  idPrefix: string;
  /** `bust` (default, 40 px and up) or `head`: the bust drawing at the head file's framing, for 25–39 px. */
  crop?: 'bust' | 'head';
  /** The mouth of another expression (speaking takes `happy`'s open mouth on the neutral face). */
  mouthFrom?: FacePose;
  /** The small symbol beside the head (thought dots, zZ, sparkles). Default true; too small to read under 64 px. */
  cue?: boolean;
}

/** The pose's data: where its eyes and mouth are, for the blink and the talking mouth. */
export function facePoseData(face: AvatarFace, pose: FacePose): FacePoseData {
  return FACE_DRAWINGS[AVATAR_FILE_STEMS[face]].poses[pose];
}

/** Whether the face has a part (only Hazel holds a clipboard; only Skipper has a cowlick). */
export function faceHasPart(face: AvatarFace, part: FacePart): boolean {
  if (part === 'board' || part === 'tick') return face === 'hazel';
  if (part === 'cowlick') return face === 'skipper';
  if (part === 'specs') return face === 'dusty' || face === 'banjo' || face === 'neo';
  return true;
}

/** The point a part turns and scales round, in the drawing's units, for `pose`. */
export function facePivot(face: AvatarFace, pose: FacePose, part: FacePart): readonly [number, number] {
  const data = facePoseData(face, pose);
  switch (part) {
    case 'head':
      return [256, 400];
    case 'ear-l':
      return [140, 232];
    case 'ear-r':
      return [372, 232];
    case 'eyes':
      return [256, data.eyeY];
    case 'brows':
      return [256, data.eyeY - 45];
    case 'mouth':
      return [256, data.mouthY];
    case 'specs':
      return [256, 210];
    case 'cue':
      return [450, 130];
    case 'board':
    case 'tick':
      return [374, 440];
    case 'cowlick':
      return [256, 134];
  }
}

const PART = (name: FacePart) => `data-face-part="${name}"`;
const SHADOW = /<g clip-path="url\(#bc\)">(\s*)<g transform=/;
const COWLICK = /(<path d="M226 134C[^>]*\/>\s*<path d="M238 128C[^>]*\/>)/;
/** Hazel's tick on her clipboard, hidden until her gesture draws it (`pathLength` lets the web draw it by length). */
const TICK =
  `<path ${PART('tick')} d="M-15 26l6 6 10-11" fill="none" stroke="#74792a" stroke-width="4.5" stroke-linecap="round" ` +
  'stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" opacity="0"/>';

/**
 * The face in `pose` as one SVG document: ids prefixed, each part wrapped for an engine to move. Its root has
 * `aria-hidden`: the element around it carries the name.
 */
export function faceSvg(face: AvatarFace, options: FaceSvgOptions): string {
  const drawing = FACE_DRAWINGS[AVATAR_FILE_STEMS[face]];
  const pose = options.pose ?? 'neutral';
  let m = assemblePose(drawing.bust, drawing.poses[pose]);
  if (options.mouthFrom && options.mouthFrom !== pose) {
    const other = assemblePose(drawing.bust, drawing.poses[options.mouthFrom]);
    const mouth = elementMarkup(other, 'mouth');
    if (mouth) m = replaceElement(m, 'mouth', mouth);
  }
  if (options.cue === false) m = removeElement(m, 'cue');
  if (options.crop === 'head') m = m.replace(BUST_FRAME, `<g transform="${drawing.headCrop}">`);
  m = m
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(/^<svg ([^>]*?)\srole="img"/, '<svg $1')
    .replace(/^<svg /, '<svg aria-hidden="true" focusable="false" data-face-svg="" ')
    .replace(SHADOW, `<g clip-path="url(#bc)">$1<g id="shadow" transform=`)
    .replace(COWLICK, `<g ${PART('cowlick')}>$1</g>`);
  if (face === 'hazel') m = appendInside(m, 'clipboard', TICK);
  m = wrapElement(m, 'head', PART('head'));
  m = wrapElement(m, 'shadow', PART('head'));
  m = wrapElement(m, 'ear-l', PART('ear-l'));
  m = wrapElement(m, 'ear-r', PART('ear-r'));
  m = wrapElement(m, 'eyes', PART('eyes'));
  m = wrapElement(m, 'brows', PART('brows'));
  m = wrapElement(m, 'mouth', PART('mouth'));
  m = wrapElement(m, 'glasses', PART('specs'));
  m = wrapElement(m, 'shades', PART('specs'));
  m = wrapElement(m, 'cue', PART('cue'));
  m = wrapElement(m, 'clipboard', PART('board'));
  return prefixIds(m, options.idPrefix);
}
