import { describe, expect, it } from 'vitest';
import { FACE_POSES } from './faceBuild';
import {
  composeFrames,
  easing,
  FACE_STATE_POSE,
  FACE_STATES,
  faceAllowance,
  faceSequence,
  frameAt,
  frameTransform,
  liveFaceCrop,
  mixTransforms,
  mouthOpening,
  restingPose,
  SIGNATURE_GESTURES,
} from './faceMotion';
import { AVATAR_FACES } from './index';

describe('what a face may do', () => {
  it('stays the still small head under 25 px', () => {
    expect(faceAllowance(24, 'full').live).toBe(false);
    expect(faceAllowance(20, 'full')).toMatchObject({ blink: false, blend: false, loops: false });
  });

  it('only changes pose at 25–39 px, from the bust drawing at the head’s framing', () => {
    expect(faceAllowance(30, 'full')).toEqual({
      live: true,
      blend: false,
      blink: false,
      gestures: false,
      mouth: false,
      dots: false,
      cue: false,
      loops: false,
    });
    expect(liveFaceCrop(30)).toBe('head');
    expect(liveFaceCrop(40)).toBe('bust');
  });

  it('blinks, blends and gestures from 40 px, shows the symbol from 64, loops from 96 only with full motion', () => {
    expect(faceAllowance(44, 'full')).toMatchObject({
      blink: true,
      blend: true,
      gestures: true,
      mouth: true,
      cue: false,
      dots: false,
      loops: false,
    });
    expect(faceAllowance(64, 'full')).toMatchObject({ cue: true, dots: true, loops: false });
    expect(faceAllowance(96, 'full').loops).toBe(true);
    expect(faceAllowance(128, 'calm')).toMatchObject({ blink: true, mouth: true, dots: true, loops: false });
  });

  it('changes pose without moving under reduced motion', () => {
    expect(faceAllowance(160, 'reduced')).toMatchObject({
      live: true,
      blend: false,
      blink: false,
      gestures: false,
      mouth: false,
      dots: false,
      loops: false,
      cue: true,
    });
  });

  it('lets only the face that holds motion move', () => {
    expect(faceAllowance(96, 'full', false)).toMatchObject({
      live: true,
      blend: false,
      blink: false,
      loops: false,
    });
  });
});

describe('states', () => {
  it('each show a drawn pose', () => {
    for (const state of FACE_STATES) {
      expect(FACE_POSES).toContain(FACE_STATE_POSE[state]);
      expect(FACE_POSES).toContain(restingPose(state));
    }
  });

  it('done is glad, then its gesture, then calm again', () => {
    expect(faceSequence('done', 'working')).toEqual([
      { pose: 'happy' },
      { wait: 1200 },
      { gesture: true },
      { wait: 250 },
      { pose: 'neutral' },
    ]);
    expect(restingPose('done')).toBe('neutral');
  });

  it('a welcome wakes from sleep', () => {
    const steps = faceSequence('welcome', 'asleep');
    expect(steps[0]).toEqual({ pose: 'neutral' });
    expect(faceSequence('welcome', 'idle')[0]).toEqual({ pose: 'sleepy' });
  });

  it('speaking keeps the neutral face with an open mouth', () => {
    expect(faceSequence('speaking', 'thinking')).toEqual([{ pose: 'neutral', mouthFrom: 'happy' }]);
  });
});

describe('moves', () => {
  it('every face has a signature gesture that ends where it started', () => {
    for (const face of AVATAR_FACES) {
      const moves = SIGNATURE_GESTURES[face];
      expect(moves.length).toBeGreaterThan(0);
      for (const m of moves) {
        const last = m.frames[m.frames.length - 1];
        expect(last?.at).toBe(1);
        expect(frameTransform({ ...last, at: 1, opacity: undefined, draw: undefined }, [256, 256])).toBe('');
      }
    }
  });

  it('turns round the pivot', () => {
    expect(frameTransform({ at: 0 }, [256, 400])).toBe('');
    expect(frameTransform({ at: 0, rotate: 3 }, [256, 400])).toBe(
      'translate(256 400) rotate(3) scale(1 1) translate(-256 -400)',
    );
  });

  it('mixes keyframes and transforms in a straight line', () => {
    const f = frameAt(
      [
        { at: 0, y: 0 },
        { at: 0.5, y: 10 },
        { at: 1, y: 0 },
      ],
      0.25,
    );
    expect(f.y).toBe(5);
    expect(f.opacity).toBeUndefined();
    expect(mixTransforms('translate(0 0) rotate(0 140 232)', 'translate(0 -4) rotate(8 140 232)', 0.5)).toBe(
      'translate(0 -2) rotate(4 140 232)',
    );
  });

  it('blinks on top of eyes that glance aside', () => {
    const held = { at: 1, x: 7, y: 3 };
    expect(composeFrames(held, { at: 0.5, sy: 0.1 })).toMatchObject({ x: 7, y: 3, sy: 0.1, sx: 1 });
    expect(composeFrames(undefined, { at: 0.5, sy: 0.1 })).toEqual({ at: 0.5, sy: 0.1 });
  });

  it('eases from 0 to 1', () => {
    for (const name of ['standard', 'in', 'out', 'inOut', 'spring', 'linear'] as const) {
      const ease = easing(name);
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
    }
  });

  it('opens the mouth in four steps with the voice', () => {
    expect([0, 0.3, 0.6, 0.9].map(mouthOpening)).toEqual([0.18, 0.5, 0.78, 1]);
  });
});
