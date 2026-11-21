import { describe, expect, it } from 'vitest';
import { appPageTarget, SECURITY_NOTICES, SecurityPushes } from './security-push';

const refOf = (what: string) => `ref(${what})`;

describe('security pushes', () => {
  it('open the page a push is about, only for the accounts it went to and while it lives', () => {
    const sent = new SecurityPushes(1000);
    sent.remember('passkey-enrolled:ep_1', ['acc_mara'], SECURITY_NOTICES.passkeyEnrolled.path, 0);
    const ref = refOf('passkey-enrolled:ep_1');
    expect(sent.resolve(ref, 'acc_mara', 500, refOf)?.path).toContain('section=devices');
    expect(sent.resolve(ref, 'acc_joris', 500, refOf)).toBeNull();
    expect(sent.resolve('ref(other)', 'acc_mara', 500, refOf)).toBeNull();
    expect(sent.resolve(ref, 'acc_mara', 1500, refOf)).toBeNull();
  });

  it('every notice fits a push preview and names a Settings page', () => {
    for (const notice of Object.values(SECURITY_NOTICES)) {
      expect([...notice.title].length).toBeLessThanOrEqual(80);
      expect([...notice.body].length).toBeLessThanOrEqual(160);
      expect(notice.path).toMatch(/^\/settings\?tab=appliance/);
    }
    expect(appPageTarget('hq', 'https://app.test/', '/settings?tab=appliance')).toEqual({
      burrow: 'hq',
      link: { type: 'external', url: 'https://app.test/settings?tab=appliance' },
    });
  });
});
