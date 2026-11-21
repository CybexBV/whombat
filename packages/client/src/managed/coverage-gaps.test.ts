import { describe, expect, it } from 'vitest';
import { coverageGaps } from './status-copy';

describe('coverageGaps', () => {
  it('keeps what the backup leaves out by design apart from a real gap', () => {
    expect(
      coverageGaps(['identity', 'recovery-secrets', 'manager', 'postgres-datadir', 'backup-state', 'caches']),
    ).toEqual({
      gaps: [],
      onPurpose: ['identity', 'recovery-secrets', 'manager', 'postgres-datadir', 'backup-state', 'caches'],
    });
    expect(coverageGaps(['workspaces', 'caches'])).toEqual({ gaps: ['workspaces'], onPurpose: ['caches'] });
  });
});
