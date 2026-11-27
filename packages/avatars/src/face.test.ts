import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FACE_PARTS, faceHasPart, facePivot, faceSvg } from './face';
import { assemblePose, buildFaceData, comparable, FACE_POSES, FACE_STEMS } from './faceBuild';
import { FACE_DRAWINGS } from './faceData';
import { AVATAR_FACES, AVATAR_FILE_STEMS } from './index';

const SVG = join(import.meta.dirname, '../svg');
const EXPRESSIONS = join(import.meta.dirname, '../../../docs/design-handoff/whombat-crew/expressions/svg');
const readSvg = (name: string) => readFileSync(join(SVG, `${name}.svg`), 'utf8');
const readExpression = (stem: string, pose: string) =>
  readFileSync(join(EXPRESSIONS, `${stem}-${pose}.svg`), 'utf8');

describe('the poses', () => {
  it('are the ones the generator builds from the drawings today (run `pnpm --filter @whombat/avatars face-data`)', () => {
    expect(buildFaceData(readSvg, readExpression)).toEqual(FACE_DRAWINGS);
  });

  it('each give back their drawn expression exactly when put on the bust', () => {
    for (const stem of FACE_STEMS) {
      for (const pose of FACE_POSES) {
        const drawing = FACE_DRAWINGS[stem];
        const rebuilt = comparable(assemblePose(drawing.bust, drawing.poses[pose]));
        expect(rebuilt, `${stem}-${pose}`).toBe(comparable(readExpression(stem, pose)));
      }
    }
  });

  it('keep each bust as it is in svg/', () => {
    for (const stem of FACE_STEMS) expect(FACE_DRAWINGS[stem].bust).toBe(readSvg(`${stem}-bust`));
  });
});

describe('faceSvg', () => {
  it('prefixes every id and every reference, so faces share a page', () => {
    const svg = faceSvg('hazel', { pose: 'happy', idPrefix: 'p1-' });
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(id).toMatch(/^p1-/);
    for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(m[1]);
  });

  it('wraps every part the face has for an engine to move', () => {
    for (const face of AVATAR_FACES) {
      const svg = faceSvg(face, { pose: 'thinking', idPrefix: 'x-' });
      for (const part of FACE_PARTS) {
        const count = svg.split(`data-face-part="${part}"`).length - 1;
        // The head moves with its shadow on the shirt: two wrappers.
        const expected = !faceHasPart(face, part) ? 0 : part === 'head' ? 2 : 1;
        expect(count, `${face} ${part}`).toBe(expected);
      }
    }
  });

  it('is decorative, without the file’s title', () => {
    const svg = faceSvg('neo', { idPrefix: 'n-' });
    expect(svg).toMatch(/^<svg aria-hidden="true" focusable="false" data-face-svg="" /);
    expect(svg).not.toContain('<title>');
    expect(svg).not.toContain('role="img"');
  });

  it('leaves the symbol out when asked, and frames the head for small sizes', () => {
    expect(faceSvg('dusty', { pose: 'thinking', idPrefix: 'a-' })).toContain('data-face-part="cue"');
    expect(faceSvg('dusty', { pose: 'thinking', idPrefix: 'a-', cue: false })).not.toContain(
      'data-face-part="cue"',
    );
    const head = faceSvg('dusty', { idPrefix: 'a-', crop: 'head' });
    expect(head).toContain(`<g transform="${FACE_DRAWINGS.associate.headCrop}">`);
  });

  it('speaks with the happy pose’s open mouth on the neutral face', () => {
    const speaking = faceSvg('banjo', { pose: 'neutral', mouthFrom: 'happy', idPrefix: 's-' });
    const happy = faceSvg('banjo', { pose: 'happy', idPrefix: 's-' });
    const mouth = (svg: string) => /<g data-face-part="mouth">[\s\S]*?<\/g><\/g>/.exec(svg)?.[0];
    expect(mouth(speaking)).toBe(mouth(happy));
    expect(speaking).toContain(FACE_DRAWINGS.developer.poses.neutral.head);
  });

  it('turns parts round points inside the drawing', () => {
    for (const face of AVATAR_FACES) {
      for (const pose of FACE_POSES) {
        for (const part of FACE_PARTS) {
          const [x, y] = facePivot(face, pose, part);
          expect(x).toBeGreaterThan(0);
          expect(x).toBeLessThan(512);
          expect(y).toBeGreaterThan(0);
          expect(y).toBeLessThan(512);
        }
      }
      expect(AVATAR_FILE_STEMS[face] in FACE_DRAWINGS).toBe(true);
    }
  });
});
