/**
 * “Asks you first” in the fixture world (Whombat server-asks.md SA-04, SA-05; AP-1719): every read carries it,
 * `never` until changed, and `hosts.updateServer` stores it — alone or with other changes.
 */
import { HostFleet, HostServerDetail, HostServerSettings } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsFixtures } from './fixtures';

const NOW = Date.parse('2026-10-18T10:00:00Z');

function world() {
  const fx = createHostsFixtures(NOW);
  const call = (method: string, path: string, body: Record<string, unknown> = {}) =>
    fx.handle({ method, path, query: {}, body });
  const asks = (id: string) => ({
    fleet: HostFleet.parse(call('GET', '/fleet')?.body).servers.find((s) => s.id === id)?.asksFirst,
    detail: HostServerDetail.parse(call('GET', `/servers/${id}`)?.body).server.asksFirst,
    settings: HostServerSettings.parse(call('GET', `/servers/${id}/settings`)?.body).asksFirst,
  });
  return { fx, call, asks };
}

describe('stream SA’s fixtures (Asks you first)', () => {
  it('acts on its own until the person changes it', () => {
    const { asks } = world();
    expect(asks('pve-02')).toEqual({ fleet: 'never', detail: 'never', settings: 'never' });
    expect(asks('thetitan')).toEqual({ fleet: 'never', detail: 'never', settings: 'never' });
  });

  it('stores Before risky actions from a body with only `asksFirst`, and back again', () => {
    const { call, asks } = world();
    const out = call('PATCH', '/servers/pve-02', { asksFirst: 'risky' });
    expect(out?.status).toBe(200);
    expect(HostServerSettings.parse(out?.body).asksFirst).toBe('risky');
    expect(asks('pve-02')).toEqual({ fleet: 'risky', detail: 'risky', settings: 'risky' });
    expect(asks('pve-01').settings).toBe('never');
    call('PATCH', '/servers/pve-02', { asksFirst: 'never' });
    expect(asks('pve-02').detail).toBe('never');
  });

  it('keeps the other changes of the same body', () => {
    const { call, asks } = world();
    const out = call('PATCH', '/servers/pve-01', { asksFirst: 'never', remoteControl: { console: false } });
    const s = HostServerSettings.parse(out?.body);
    expect(s.asksFirst).toBe('never');
    expect(s.remoteControl.console).toBe(false);
    expect(asks('pve-01').settings).toBe('never');
  });

  it('refuses another value', () => {
    const { call } = world();
    expect(call('PATCH', '/servers/pve-02', { asksFirst: 'sometimes' })?.status).toBe(400);
  });
});
