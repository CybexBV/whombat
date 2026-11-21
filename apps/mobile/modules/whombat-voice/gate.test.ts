import { describe, expect, it } from 'vitest';
import { createRecordingGate } from './gate';

describe('the recording the app listens to', () => {
  it('drops an earlier recording’s events once the next one started', () => {
    const gate = createRecordingGate();
    const first = gate.begin();
    expect(gate.accepts(first)).toBe(true);
    gate.end();
    expect(gate.accepts(first)).toBe(false);
    const second = gate.begin();
    expect(second).not.toBe(first);
    expect(gate.accepts(first)).toBe(false);
    expect(gate.accepts(second)).toBe(true);
  });

  it('takes events without a number while something records, none after', () => {
    const gate = createRecordingGate();
    expect(gate.accepts(undefined)).toBe(false);
    gate.begin();
    expect(gate.accepts(undefined)).toBe(true);
    gate.end();
    expect(gate.accepts(undefined)).toBe(false);
  });
});
