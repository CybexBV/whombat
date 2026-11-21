/**
 * `appliance.status` on an appliance as it is configured (resourceful-agents.md RA-DS50): the server has no credentials
 * root (the runner holds it, appliance NX-20) and reads sign-ins through the runner's bridge (SUB-56). The provider rows
 * are the person's own sign-ins, read through the runner, not the runner's setup; with no runner polling the status
 * answers at once with the runner's setup instead of waiting a bridge timeout for nobody.
 */
import type { CredentialMeta } from '@whombat/agent-runtime/providers';
import { describe, expect, it } from 'vitest';
import { IDS } from '../../seed/test-world';
import { useManagedRuntime } from '../../test/managed';
import { providerLogins } from './service';

const m = useManagedRuntime({ seed: true });
type Row = { provider: string; state: string };
const statusRows = async () => {
  const owner = await m.enroll(IDS.mara);
  const answer = (await (await m.client(owner)).request('appliance.status', {})) as unknown as {
    output: { providers: Row[] };
  };
  return answer.output.providers;
};

const codexMeta = (): CredentialMeta => ({
  v: 1,
  provider: 'codex',
  authMode: 'chatgpt',
  createdAt: '2026-10-04T08:00:00.000Z',
  expiresAt: null,
  verified: 'valid',
  verifiedAt: null,
  creatorAttested: false,
  login: null,
  signal: null,
});

describe('appliance.status’s sign-ins on an appliance (RA-DS50)', () => {
  it('no runner polling: the runner’s setup, at once', async () => {
    expect(m.t.services.config.WHOMBAT_CREDENTIALS_ROOT).toBeUndefined();
    const started = Date.now();
    const rows = await statusRows();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('with the runner there: the person’s own sign-ins, read through it', async () => {
    const bridge = providerLogins(m.t.services).bridge;
    if (!bridge) throw new Error('this server reads sign-ins through the runner');
    let stop = false;
    const lists: unknown[] = [];
    // The runner: keeps a long poll open and answers the sign-in list with Mara's Codex sign-in.
    const runner = (async () => {
      while (!stop) {
        for (const r of await bridge.poll(200)) {
          lists.push(r.method);
          bridge.answer(r.id, {
            ok: true,
            result: r.method === 'list' ? [{ provider: 'codex', meta: codexMeta() }] : null,
          });
        }
      }
    })();
    try {
      await new Promise((r) => setTimeout(r, 50));
      const rows = await statusRows();
      expect(lists).toContain('list');
      // The Codex row (its state is this test host's: no pinned Codex installed here).
      expect(rows).toContainEqual(expect.objectContaining({ provider: 'codex' }));
      // No Claude sign-in: its row says so.
      expect(rows).toContainEqual(expect.objectContaining({ provider: 'claude', state: 'not_signed_in' }));
    } finally {
      stop = true;
      await runner;
    }
  });
});
