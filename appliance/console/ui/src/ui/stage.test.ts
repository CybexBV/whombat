import { describe, expect, it } from 'vitest';
import { DESK_STAGE } from '../lib/deskScene';
import { stageScale } from './Stage';

describe('stageScale', () => {
  it('maps 1024×768 one to one and scales up by height on wide screens', () => {
    expect(stageScale(1024, 768)).toBe(1);
    expect(stageScale(1920, 1080)).toBeCloseTo(1.40625);
    expect(1920 / stageScale(1920, 1080)).toBeCloseTo(1365.33, 1);
  });

  it('scales by width on narrow screens', () => {
    expect(stageScale(1280, 1024)).toBe(1.25);
  });
});

describe('stageScale on the desk (CG-38)', () => {
  it('draws the Z13 at 200 % and keeps 1280×800 the smallest layout', () => {
    expect(stageScale(2560, 1600, DESK_STAGE)).toBe(2);
    expect(stageScale(1280, 800, DESK_STAGE)).toBe(1);
    expect(stageScale(1920, 1080, DESK_STAGE)).toBeCloseTo(1.35);
    expect(768 / stageScale(1024, 768, DESK_STAGE)).toBe(960);
  });
});
