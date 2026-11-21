import { describe, expect, it } from 'vitest';
import { collabUser, stampState } from './awareness';
import { COLLAB_TOKEN_TTL_MS, CollabTokens } from './token';

const KEY = Buffer.alloc(32, 7).toString('base64');
const now = new Date('2026-09-23T09:22:00.000Z');
const grant = { c: 'cvs_invoice-pdf-plan', b: 'bur_burrow-hq', p: 'prn_mara', d: null };

describe('collab tokens', () => {
  it('round-trips while fresh and expires after five minutes', () => {
    const tokens = new CollabTokens(KEY);
    const { token, expiresAt } = tokens.issue(grant, now);
    expect(token).toMatch(/^wct_[\w-]+\.[\w-]+$/);
    expect(expiresAt.getTime() - now.getTime()).toBe(COLLAB_TOKEN_TTL_MS);
    expect(tokens.verify(token, now)).toMatchObject({ ...grant, v: 1 });
    expect(tokens.verify(token, new Date(now.getTime() + COLLAB_TOKEN_TTL_MS))).toBeNull();
  });

  it('refuses tampered tokens and tokens from another key', () => {
    const tokens = new CollabTokens(KEY);
    const { token } = tokens.issue(grant, now);
    const [body, sig] = token.slice(4).split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...grant, p: 'prn_tom', v: 1, e: now.getTime() + 60_000 }),
    ).toString('base64url');
    expect(tokens.verify(`wct_${forged}.${sig}`, now)).toBeNull();
    expect(tokens.verify(`wct_${body}.${sig.slice(1)}x`, now)).toBeNull();
    expect(tokens.verify('wat_something', now)).toBeNull();
    expect(new CollabTokens(Buffer.alloc(32, 9).toString('base64')).verify(token, now)).toBeNull();
    // Without a master key, the development key (tests, dev) still signs and verifies.
    const dev = new CollabTokens(undefined);
    expect(dev.verify(dev.issue(grant, now).token, now)).not.toBeNull();
  });
});

describe('awareness', () => {
  const _toffee = {
    id: 'prn_dusty',
    name: 'Dusty',
    kind: 'agent' as const,
    agentRole: 'architect' as const,
    tone: null,
  };
  const mara = {
    id: 'prn_mara',
    name: 'Mara Okafor',
    kind: 'person' as const,
    agentRole: null,
    tone: '#d9c3a9',
  };

  it('strips every field a client sent other than the ones it owns, including a forged collabUser', () => {
    // collaborators() (apps/web/.../canvas/collab/users.ts) reads `state.collabUser ?? state.user`, so
    // any extra field the server leaves in place is a place to smuggle a forged identity or color.
    const state = stampState(
      {
        user: { principalId: 'prn_tom', name: 'Tom' },
        collabUser: { principalId: 'prn_dusty', name: 'Dusty', kind: 'person', role: null, color: 'red' },
        writing: true,
        cursor: { a: 1 },
        evil: 'red; background:url(https://evil/beacon)',
      },
      collabUser(mara),
    );
    expect(state).toEqual({ user: collabUser(mara), writing: true, cursor: { a: 1 } });
    expect(state.collabUser).toBeUndefined();
    expect(state.evil).toBeUndefined();
  });
});
