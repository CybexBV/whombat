import {
  DirectAddresses,
  directRoutesFor,
  TailscaleStatus,
  tailscaleStatusValid,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { DIRECT_ADDRESSES, DIRECT_ADDRESSES_LAN_ONLY, TAILSCALE_STATES_FIXTURE } from './direct.js';

describe('the direct ways and Tailscale fixtures (CT-1252…CT-1254)', () => {
  it('parse, and every Tailscale state is consistent', () => {
    for (const a of [DIRECT_ADDRESSES, DIRECT_ADDRESSES_LAN_ONLY])
      expect(DirectAddresses.parse(a)).toEqual(a);
    expect(directRoutesFor(DIRECT_ADDRESSES, { secureOnly: true })).toHaveLength(1);
    for (const [state, s] of Object.entries(TAILSCALE_STATES_FIXTURE)) {
      expect(TailscaleStatus.parse(s).state, state).toBe(state);
      expect(tailscaleStatusValid(s), state).toBe(true);
    }
  });
});
