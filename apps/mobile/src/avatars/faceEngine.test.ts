import { AVATAR_FACES } from '@whombat/avatars';
import { facePivot, faceSvg } from '@whombat/avatars/face';
import { SIGNATURE_GESTURES } from '@whombat/avatars/motion';
import type { parse as parseSvg } from 'react-native-svg';
import { describe, expect, it, vi } from 'vitest';
import {
  BLEND_TARGETS,
  type FaceNode,
  faceTree,
  frameMatrix,
  IDENTITY,
  type Matrix,
  moveTable,
  multiply,
  parseTransform,
  pathLength,
  pickHolder,
  replyFaceState,
  runFaceState,
  SAMPLE,
  type SvgNode,
  sampleAt,
} from './faceEngine';

// react-native-svg's own parser, as the app runs it, without the native elements it would build after. Named through a
// variable so the typecheck reads the package's types, not its sources.
vi.mock('react-native-svg/src/xmlTags', () => ({ tags: {} }));
vi.mock('react-native-svg/src/utils/fetchData', () => ({ fetchText: async () => null }));
const XML_PARSER = 'react-native-svg/src/xml';
const { parse } = (await import(/* @vite-ignore */ XML_PARSER)) as { parse: typeof parseSvg };

function parsed(markup: string): SvgNode {
  const out: { root: SvgNode | null } = { root: null };
  parse(markup, (ast) => {
    out.root = ast as unknown as SvgNode;
    return { ...ast, children: [] };
  });
  if (!out.root) throw new Error('not parsed');
  return out.root;
}

function* walk(nodes: FaceNode[]): Generator<FaceNode> {
  for (const n of nodes) {
    yield n;
    if (n.kind === 'el' || n.kind === 'part' || n.kind === 'blend') yield* walk(n.children);
  }
}

const run = (status: 'live' | 'paused' | 'done' | 'failed' | 'taken_over', more: object = {}) => ({
  status,
  attention: null,
  steps: [{ state: 'running' }],
  logCount: 3,
  ...more,
});

describe('what a face shows', () => {
  it('follows a run', () => {
    expect(runFaceState(run('live'))).toBe('working');
    expect(runFaceState(run('live', { steps: [{ state: 'queued' }], logCount: 0 }))).toBe('thinking');
    expect(runFaceState(run('live', { attention: 'Which branch?' }))).toBe('needs');
    expect(runFaceState(run('live', { attention: '  ' }))).toBe('working');
    expect(runFaceState(run('paused'))).toBe('needs');
    expect(runFaceState(run('done'))).toBe('done');
    expect(runFaceState(run('failed'))).toBe('sorry');
    expect(runFaceState(run('taken_over'))).toBe('idle');
  });

  it('follows the agent’s next reply', () => {
    expect(replyFaceState({ typing: true, acting: false, failed: false })).toBe('thinking');
    expect(replyFaceState({ typing: true, acting: true, failed: false })).toBe('working');
    expect(replyFaceState({ typing: false, acting: false, failed: true })).toBe('sorry');
    expect(replyFaceState({ typing: false, acting: false, failed: false })).toBe('idle');
  });
});

describe('the one face that moves', () => {
  it('is the biggest, then the newest', () => {
    expect(pickHolder([])).toBeNull();
    expect(
      pickHolder([
        { id: 1, size: 112 },
        { id: 2, size: 44 },
      ]),
    ).toBe(1);
    expect(
      pickHolder([
        { id: 3, size: 44 },
        { id: 5, size: 44 },
        { id: 4, size: 44 },
      ]),
    ).toBe(5);
  });
});

describe('transforms as matrices', () => {
  const close = (a: Matrix, b: Matrix) => {
    for (const [i, v] of a.entries()) expect(v).toBeCloseTo(b[i] as number, 6);
  };

  it('reads an SVG transform list', () => {
    close(parseTransform(''), IDENTITY);
    close(parseTransform('translate(10 20)'), [1, 0, 0, 1, 10, 20]);
    close(parseTransform('translate(10,20) scale(2)'), [2, 0, 0, 2, 10, 20]);
    close(parseTransform('matrix(1 2 3 4 5 6)'), [1, 2, 3, 4, 5, 6]);
    // A quarter turn round (10, 10) takes (20, 10) to (10, 20).
    const m = parseTransform('rotate(90 10 10)');
    expect(m[0] * 20 + m[2] * 10 + m[4]).toBeCloseTo(10, 6);
    expect(m[1] * 20 + m[3] * 10 + m[5]).toBeCloseTo(20, 6);
  });

  it('turns a keyframe round its pivot, which stays put', () => {
    close(frameMatrix({ at: 0 }, [256, 400]), IDENTITY);
    const m = frameMatrix({ at: 0, rotate: 12, sx: 1.1, sy: 0.9 }, [256, 400]);
    expect(m[0] * 256 + m[2] * 400 + m[4]).toBeCloseTo(256, 6);
    expect(m[1] * 256 + m[3] * 400 + m[5]).toBeCloseTo(400, 6);
    close(frameMatrix({ at: 0, x: 3, y: -2 }, [0, 0]), [1, 0, 0, 1, 3, -2]);
    close(multiply(IDENTITY, m), m);
  });
});

describe('a move as a table of frames', () => {
  const pivot = [256, 230] as const;
  const rest = { opacity: 1, draw: 1 };

  it('starts and ends where the move does, and ends where a held move stays', () => {
    const blink = {
      part: 'eyes' as const,
      easing: 'linear' as const,
      duration: 180,
      frames: [{ at: 0 }, { at: 0.5, sy: 0.1 }, { at: 1 }],
    };
    const t = moveTable(blink, pivot, undefined, rest);
    expect(t.samples.length % SAMPLE).toBe(0);
    expect(t.duration).toBe(180);
    expect(sampleAt(t.samples, 0).slice(0, 6)).toEqual([...IDENTITY]);
    expect(sampleAt(t.samples, 1).slice(0, 6)).toEqual([...IDENTITY]);
    // Halfway the eyes are nearly shut.
    expect(sampleAt(t.samples, 0.5)[3]).toBeLessThan(0.3);
    expect(t.held).toBeUndefined();

    const aside = {
      part: 'eyes' as const,
      easing: 'linear' as const,
      duration: 240,
      hold: true,
      frames: [{ at: 0 }, { at: 1, x: 6 }],
    };
    const h = moveTable(aside, pivot, undefined, rest);
    expect(sampleAt(h.samples, 1)[4]).toBeCloseTo(6, 6);
    expect(h.held?.x).toBe(6);
    // A blink on eyes held aside stays aside.
    const over = moveTable(blink, pivot, h.held, rest);
    expect(sampleAt(over.samples, 0.5)[4]).toBeCloseTo(6, 0);
    expect(sampleAt(over.samples, 1)[4]).toBeCloseTo(6, 6);
  });

  it('keeps every face’s own gesture finite', () => {
    for (const face of AVATAR_FACES)
      for (const move of SIGNATURE_GESTURES[face]) {
        const t = moveTable(move, facePivot(face, 'neutral', move.part), undefined, rest);
        expect(t.samples.every(Number.isFinite)).toBe(true);
      }
  });
});

describe('the drawing as a tree', () => {
  const prefix = 'wf7-';

  it('makes each part a group to move and strips what only the browser reads', () => {
    for (const face of AVATAR_FACES) {
      const tree = faceTree(parsed(faceSvg(face, { pose: 'neutral', idPrefix: prefix })), prefix);
      const nodes = [...walk(tree.nodes)];
      const parts = new Set(nodes.flatMap((n) => (n.kind === 'part' ? [n.part] : [])));
      for (const part of ['head', 'ear-l', 'ear-r', 'eyes', 'brows', 'mouth'] as const)
        expect(parts.has(part), `${face} ${part}`).toBe(true);
      expect(parts.has('board')).toBe(face === 'hazel');
      expect(parts.has('cowlick')).toBe(face === 'skipper');
      expect(tree.viewBox).toBe('0 0 512 512');
      for (const n of nodes) {
        if (n.kind === 'part') continue;
        for (const key of ['dataFacePart', 'dataFaceSvg', 'ariaHidden', 'pathLength'])
          expect(n.props, `${face} ${n.key}`).not.toHaveProperty(key);
        if (typeof n.props.id === 'string') expect(n.props.id.startsWith(prefix)).toBe(true);
      }
      // Each target's pose transform comes out of the drawing to slide between poses.
      for (const target of BLEND_TARGETS) expect(tree.targets, `${face} ${target}`).toHaveProperty(target);
      const blends = nodes.filter((n) => n.kind === 'blend');
      expect(blends.map((n) => n.target).sort()).toEqual([...BLEND_TARGETS].sort());
      for (const n of blends) expect(n.props).not.toHaveProperty('transform');
    }
  });

  it('keeps sibling keys unique', () => {
    const tree = faceTree(parsed(faceSvg('hazel', { pose: 'thinking', idPrefix: prefix })), prefix, {
      dots: true,
    });
    const check = (nodes: FaceNode[]) => {
      expect(new Set(nodes.map((n) => n.key)).size).toBe(nodes.length);
      for (const n of nodes)
        if (n.kind === 'el' || n.kind === 'part' || n.kind === 'blend') check(n.children);
    };
    check(tree.nodes);
  });

  it('measures Hazel’s tick for its dash and hides it', () => {
    const tree = faceTree(parsed(faceSvg('hazel', { pose: 'neutral', idPrefix: prefix })), prefix);
    const tick = [...walk(tree.nodes)].find((n) => n.kind === 'tick');
    expect(tick?.kind).toBe('tick');
    if (tick?.kind !== 'tick') return;
    expect(tick.length).toBeCloseTo(23.35, 2);
    expect(tick.props.strokeDasharray).toEqual([tick.length, tick.length]);
    expect(tick.props.strokeDashoffset).toBe(tick.length);
    expect(tick.props.opacity).toBe(0);
  });

  it('numbers the thought dots only when asked', () => {
    const markup = faceSvg('dusty', { pose: 'thinking', idPrefix: prefix });
    const dots = faceTree(parsed(markup), prefix, { dots: true });
    expect(dots.dots).toBeGreaterThan(0);
    const found = [...walk(dots.nodes)].flatMap((n) => (n.kind === 'dot' ? [n.index] : []));
    expect(found).toEqual([...Array(dots.dots).keys()]);
    expect(faceTree(parsed(markup), prefix).dots).toBe(0);
  });
});

describe('a path’s length', () => {
  it('adds up its lines, relative and absolute', () => {
    expect(pathLength('M0 0L3 4')).toBe(5);
    expect(pathLength('M0 0h3v4')).toBe(7);
    expect(pathLength('M0 0 3 4 3 0Z')).toBe(12);
  });
});
