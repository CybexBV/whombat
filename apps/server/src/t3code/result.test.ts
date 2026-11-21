import { JOB_REPORT_MAX } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { reportOf, sendPending } from './result';

describe('a job’s report as its result message keeps it', () => {
  it('keeps a report as written, and the start of a longer one, marked cut', () => {
    expect(reportOf('  Done.  ')).toEqual({ text: 'Done.', cut: false });
    expect(reportOf(null)).toEqual({ text: null, cut: false });
    expect(reportOf('   ')).toEqual({ text: null, cut: false });
    const long = `START ${'x'.repeat(JOB_REPORT_MAX)} END`;
    const kept = reportOf(long);
    expect(kept.cut).toBe(true);
    expect(kept.text?.startsWith('START')).toBe(true);
    expect(kept.text).not.toContain('END');
    expect(kept.text?.length).toBeLessThanOrEqual(JOB_REPORT_MAX);
  });

  it('knows when the person’s answers wait for the run they started', () => {
    const send = { at: '2026-11-17T08:00:00.000Z', answers: [], outcome: null };
    const result = (sends: { doneAt: string | null }[]) =>
      ({ sends: sends.map((s) => ({ ...send, ...s })) }) as unknown as Parameters<typeof sendPending>[0];
    expect(sendPending(result([]))).toBe(false);
    expect(sendPending(result([{ doneAt: null }]))).toBe(true);
    expect(sendPending(result([{ doneAt: null }, { doneAt: '2026-11-17T09:00:00.000Z' }]))).toBe(false);
    expect(sendPending(null)).toBe(false);
  });
});
