import { describe, expect, it } from 'vitest';
import { planStepMarker } from './planMarker';

describe('planStepMarker', () => {
  it('rotates a small warn square into a diamond for a gate step', () => {
    const m = planStepMarker('gate');
    expect(m.borderRadius).toBe('3px');
    expect(m.borderColor).toBe('var(--warn)');
    expect(m.transform).toBe('rotate(45deg) scale(.85)');
  });
});
