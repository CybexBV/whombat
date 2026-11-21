import { describe, expect, it } from 'vitest';
import { CollabUser } from './index.js';

describe('collaboration contract', () => {
  it('only accepts a role token or a 6-digit hex as a collaborator color', () => {
    const base = { principalId: 'prn_dusty', name: 'Dusty', kind: 'agent' as const };
    expect(CollabUser.safeParse({ ...base, color: 'var(--role-architect)' }).success).toBe(true);
    expect(CollabUser.safeParse({ ...base, color: '#d9c3a9' }).success).toBe(true);
    expect(CollabUser.safeParse({ ...base, color: 'var(--brand)' }).success).toBe(true);
    // Defense in depth for a forged `color`: nothing that could break out of a CSS custom property
    // (`--writer: <color>`, `--caret: <color>`) or address something other than a token/hex is a valid color.
    expect(CollabUser.safeParse({ ...base, color: 'red' }).success).toBe(false);
    expect(CollabUser.safeParse({ ...base, color: '#000000; background:url(https://evil/x)' }).success).toBe(
      false,
    );
    expect(CollabUser.safeParse({ ...base, color: 'var(--brand); }body{}' }).success).toBe(false);
  });
});
