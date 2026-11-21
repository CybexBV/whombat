import { tailscaleAnswer, tailscaleView } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { createDemoTailscale } from './tailscale';

describe('Tailscale in the demo world (AP-5378)', () => {
  it('starts off; you turn it on, sign in and turn it off', async () => {
    const demo = createDemoTailscale();
    const api = demo.api();
    expect(tailscaleView(await api.state())).toMatchObject({ dot: 'mut', actions: ['turn_on'] });
    const signIn = tailscaleView(tailscaleAnswer(await api.on()));
    expect(signIn.actions[0]).toBe('sign_in');
    expect(signIn.loginUrl).toMatch(/^https:\/\//);
    expect(signIn.pollMs).not.toBeNull();
    demo.signedIn();
    const on = tailscaleView(await api.state());
    expect(on).toMatchObject({ dot: 'ok', actions: ['turn_off'], pollMs: null });
    expect(tailscaleView(tailscaleAnswer(await api.off())).actions).toEqual(['turn_on']);
  });
});
