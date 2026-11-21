/**
 * Links the server writes on a managed appliance (parity G-10; docs/decisions/managed-runtime.md MR-45): the hosted UI
 * at this appliance (`WHOMBAT_APP_URL/appliances/<device id>/…`), never the development address.
 */
import { describe, expect, it } from 'vitest';
import { automationRunUrl } from '../automations/notice';
import { burrowWhere, webOrigin } from '../commands/burrows';
import { useManagedRuntime } from '../test/managed';
import { claimSecretHash } from './trust';

const m = useManagedRuntime({ env: { WHOMBAT_APP_URL: 'https://app.whombat.com' } });

describe('managed links', () => {
  it('point at the hosted UI and name the appliance; never localhost', async () => {
    // Before provisioning names the device: the hosted UI's origin only.
    expect(webOrigin(m.t.services)).toBe('https://app.whombat.com');
    await m.runtime.trust.provisionClaim({
      deviceId: 'dev-links-01',
      secretHash: claimSecretHash('dev-links-01', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
    });
    const base = 'https://app.whombat.com/appliances/dev-links-01';
    expect(webOrigin(m.t.services)).toBe(base);
    const ctx = { services: m.t.services, burrow: { slug: 'burrow-hq' } } as never;
    expect(automationRunUrl(ctx, 12)).toBe(`${base}/burrow-hq/automation-runs/12`);
    expect(burrowWhere(m.t.services, 'burrow-hq')).toBe('app.whombat.com/appliances/dev-links-01/burrow-hq');
    for (const link of [webOrigin(m.t.services), burrowWhere(m.t.services, 'x'), automationRunUrl(ctx, 1)])
      expect(link).not.toMatch(/localhost|5180/);
  });

  it('are never relative: without the hosted UI’s origin they refuse instead of writing a path', async () => {
    const saved = m.t.services.config.WHOMBAT_APP_URL;
    const base = m.t.services.links.managedBase;
    (m.t.services.config as { WHOMBAT_APP_URL?: string }).WHOMBAT_APP_URL = undefined;
    m.t.services.links.managedBase = null;
    try {
      await expect(m.runtime.trust.refreshLinks()).rejects.toThrow(/WHOMBAT_APP_URL is required/);
      expect(() => webOrigin(m.t.services)).toThrow(/WHOMBAT_APP_URL is required/);
    } finally {
      (m.t.services.config as { WHOMBAT_APP_URL?: string }).WHOMBAT_APP_URL = saved;
      m.t.services.links.managedBase = base;
      await m.runtime.trust.refreshLinks();
    }
  });
});
