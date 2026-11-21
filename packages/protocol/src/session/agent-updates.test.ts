/** Contracts 0.99.0: server agents keep themselves up to date, over the session (CT-514, CT-515). */

import { HostServerSettings } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { operationSafety, resendAfterNotFound } from './operation-safety.js';
import { API_OPERATIONS, SECRET_API_OPS } from './operations.js';
import { decodeTolerant } from './tolerant.js';

describe('server agents’ updates over the session (CT-514, CT-515)', () => {
  it('reads the setting, and never resends a change to it or an update', () => {
    const read = API_OPERATIONS.get('hosts.agentSettings');
    expect(read?.mutating).toBe(false);
    expect(operationSafety('hosts.agentSettings')).toEqual({ destructive: false, retry: 'safe' });
    for (const op of ['hosts.updateAgentSettings', 'hosts.updateAgent']) {
      expect(API_OPERATIONS.get(op)?.mutating, op).toBe(true);
      expect(operationSafety(op), op).toEqual({ destructive: false, retry: 'never' });
      expect(resendAfterNotFound(op), op).toBe(false);
      expect(SECRET_API_OPS, op).not.toContain(op);
    }
  });

  it('takes the switch alone and an update without a body', () => {
    const patch = API_OPERATIONS.get('hosts.updateAgentSettings');
    const burrow = { burrow: 'lumio-bv' };
    expect(patch?.input.safeParse({ params: burrow, body: { autoUpdate: false } }).success).toBe(true);
    expect(patch?.input.safeParse({ params: burrow, body: {} }).success).toBe(false);
    const update = API_OPERATIONS.get('hosts.updateAgent');
    expect(update?.input.safeParse({ params: { ...burrow, serverId: 'pve-01' } }).success).toBe(true);
    expect(update?.input.safeParse({ params: burrow }).success).toBe(false);
  });

  it('lets an older client leave a new state out instead of failing the settings', () => {
    const settings = {
      id: 'pve-01',
      group: 'Lab',
      location: null,
      remoteControl: { console: true, power: true },
      agentPolicy: { console: true, power: false },
      agent: { version: '0.0.0-20261018094703.5394c53', update: { available: true, state: 'rebooting' } },
    };
    const r = decodeTolerant(HostServerSettings, settings);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.agent?.update?.state).toBeUndefined();
      expect(r.data.agent?.update?.available).toBe(true);
    }
  });
});
