import { describe, expect, it } from 'vitest';
import { demoVersionGate } from './versionLink';

describe('the demo’s version link (AP-5375)', () => {
  it('names who must update, nothing else', () => {
    expect(demoVersionGate('whombat://demo/version?who=client')).toBe('client');
    expect(demoVersionGate('whombat://demo/version?who=appliance')).toBe('appliance');
    expect(demoVersionGate('whombat://demo/version?who=someone')).toBeNull();
    expect(demoVersionGate('whombat://settings/whombat')).toBeNull();
    expect(demoVersionGate(null)).toBeNull();
  });
});
