/** Contracts 0.123.0: one agent over the session (CT-1124, CT-1126; Whombat one-agent.md). */
import { describe, expect, it } from 'vitest';
import { LicenceLimitDetails, LicenceStatusView } from './licence.js';
import { OPERATION_SAFETY } from './operation-safety.js';

describe('one agent (CT-1124, CT-1126)', () => {
  it('has the agent’s ops and none of the crew’s, channels or handoffs', () => {
    const ops = Object.keys(OPERATION_SAFETY);
    expect(ops.filter((op) => op.startsWith('agents.'))).toEqual([]);
    for (const op of ['agent.get', 'agent.update', 'agent.setKeys', 'spend.week'])
      expect(ops, op).toContain(op);
    for (const op of [
      'plans.delegate',
      'conversations.openDirect',
      'conversations.createChannel',
      'messages.ask',
      'vault.agentKeys',
      'skills.libraryAdd',
    ])
      expect(ops, op).not.toContain(op);
  });

  it('counts and limits no agents and no people in the licence (CT-1138, OA-02; CT-1562)', () => {
    expect(Object.keys(LicenceStatusView.shape.usage.shape)).toEqual(['connectors']);
    expect(LicenceLimitDetails.shape.limit.options).toEqual(['connectors']);
    for (const limit of ['agents', 'members'])
      expect(LicenceLimitDetails.safeParse({ code: 'licence.limit', limit, allowed: 1 }).success, limit).toBe(
        false,
      );
  });
});
