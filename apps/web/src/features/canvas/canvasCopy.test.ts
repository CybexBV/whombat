import { describe, expect, it } from 'vitest';
import { canvasHeading } from './canvasCopy';

describe('canvasHeading', () => {
  it('only strips the last separator', () => {
    expect(canvasHeading('A · B · plan')).toBe('A · B');
  });
});
