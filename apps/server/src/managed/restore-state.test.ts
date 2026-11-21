/**
 * The backup service's restore state as the runtime reads it (backup-options.md): a phase `interrupted` is a failed
 * restore that can be tried again, the technical detail stays on the box, and a reason it can't carry doesn't make the
 * answer unreadable.
 */
import { describe, expect, it } from 'vitest';
import { restoreStateOf } from './restore-state';

const base = {
  phase: 'failed',
  stage: null,
  since: '2026-11-04T10:00:00Z',
  error: 'Bringing the backup back didn’t work, so this Whombat was put back as it was. Try again.',
  restored: null,
  oldApplianceId: null,
  relogin: [],
  servers: null,
  items: [],
};

describe('a restore state from the backup service', () => {
  it('reads an interrupted restore as failed with its reason, never with the technical detail', () => {
    const state = restoreStateOf({ ...base, phase: 'interrupted', detail: 'rename /persist/db: EIO' });
    expect(state).toMatchObject({ phase: 'failed', reason: 'interrupted', error: base.error });
    expect(state && 'detail' in state).toBe(false);
  });

  it('keeps a reason the service gave, and leaves out one it can’t carry', () => {
    expect(restoreStateOf({ ...base, reason: 'no_space' })?.reason).toBe('no_space');
    expect(restoreStateOf({ ...base, reason: 'not a code!' })).toMatchObject({ phase: 'failed' });
    expect(restoreStateOf({ ...base, reason: 'not a code!' })?.reason).toBeUndefined();
    expect(restoreStateOf(base)?.reason).toBeUndefined();
    expect(restoreStateOf({ phase: 'mystery' })).toBeNull();
    expect(restoreStateOf(null)).toBeNull();
  });
});
