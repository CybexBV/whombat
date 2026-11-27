/**
 * A live face's drawing for one pose: `faceSvg`'s markup parsed by react-native-svg's own parser and turned into the
 * app's tree (`faceTree`), kept for the next time the face takes that pose. The parser's middleware takes the parsed
 * tree before react-native-svg turns it into elements, so it is parsed once and never built twice.
 */
import type { AvatarFace } from '@whombat/avatars';
import { type FacePose, faceSvg } from '@whombat/avatars/face';
import { parse, type XmlAST } from 'react-native-svg';
import { type FaceTree, faceTree, type SvgNode } from './faceEngine';

/** What a live face draws: the face, its framing, the pose (and another pose's mouth), the symbol or not. */
export interface Drawing {
  face: AvatarFace;
  crop: 'bust' | 'head';
  pose: FacePose;
  mouthFrom?: FacePose | undefined;
  cue: boolean;
  /** Put in front of the drawing's ids, one per face on screen. */
  prefix: string;
}

export function sameDrawing(a: Drawing, b: Drawing): boolean {
  return (
    a.face === b.face &&
    a.crop === b.crop &&
    a.pose === b.pose &&
    a.mouthFrom === b.mouthFrom &&
    a.cue === b.cue &&
    a.prefix === b.prefix
  );
}

const EMPTY: FaceTree = { viewBox: '0 0 512 512', nodes: [], targets: {}, dots: 0 };
/** A few faces on screen with a handful of poses each; the oldest go first. */
const KEPT = 48;
const trees = new Map<string, FaceTree>();

/** The markup parsed into react-native-svg's tree, without building its elements. */
export function parseFaceMarkup(markup: string): SvgNode | null {
  const out: { root: XmlAST | null } = { root: null };
  parse(markup, (ast) => {
    out.root = ast;
    return { ...ast, children: [] };
  });
  return out.root;
}

/** The drawing as the app's tree (an empty one, said once, when the markup can't be read). */
export function faceTreeFor(drawing: Drawing): FaceTree {
  const key = [
    drawing.face,
    drawing.crop,
    drawing.pose,
    drawing.mouthFrom ?? '',
    drawing.cue ? 1 : 0,
    drawing.prefix,
  ].join(':');
  const kept = trees.get(key);
  if (kept) {
    trees.delete(key);
    trees.set(key, kept);
    return kept;
  }
  let tree = EMPTY;
  try {
    const markup = faceSvg(drawing.face, {
      pose: drawing.pose,
      idPrefix: drawing.prefix,
      crop: drawing.crop,
      mouthFrom: drawing.mouthFrom,
      cue: drawing.cue,
    });
    const root = parseFaceMarkup(markup);
    if (root) tree = faceTree(root, drawing.prefix, { dots: drawing.pose === 'thinking' });
  } catch (error) {
    console.error(error);
  }
  trees.set(key, tree);
  if (trees.size > KEPT) {
    const oldest = trees.keys().next().value;
    if (oldest !== undefined) trees.delete(oldest);
  }
  return tree;
}
