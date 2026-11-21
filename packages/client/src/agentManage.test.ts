/** Who may change the agent, and when a card offers “Always allow” (AC-20, RA-06; AP-680, AP-4902). */
import type { Approval } from '@whombat/core';
import { approval as deployApproval, dusty, mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { approveToastFor, canAlwaysAllow, canManageAgent, stopAskingServer } from './agentManage';

describe('canManageAgent (one-agent.md AP-4902; one-person.md OP-01)', () => {
  it('lets the person change the agent, nobody a system actor', () => {
    expect(canManageAgent({ kind: 'agent' })).toBe(true);
    expect(canManageAgent({ kind: 'system' })).toBe(false);
    expect(canManageAgent(undefined)).toBe(false);
  });
});

describe('canAlwaysAllow (RA-06, RA-DC08)', () => {
  it('offers it on a risk-row action, for the agent', () => {
    const agent = { kind: 'agent' };
    expect(canAlwaysAllow(deployApproval.action, agent)).toBe(true);
    expect(canAlwaysAllow(deployApproval.action, { kind: 'system' })).toBe(false);
    const grant = { type: 'grant_key', params: { agentId: dusty.id, keyId: 'ci.run' } } as Approval['action'];
    expect(canAlwaysAllow(grant, agent)).toBe(false);
  });
});

describe('approveToastFor', () => {
  const ctx = {
    names: (id: string) => (id === dusty.id ? { name: 'Dusty', shortName: 'Dusty' } : undefined),
    viewer: { id: mara.id, kind: 'person' as const },
    now: '2026-09-23T09:22:00.000Z',
    timeZone: 'Europe/Amsterdam',
  };

  it('says the row is On after “Always allow”, and the usual toast otherwise', () => {
    expect(approveToastFor(deployApproval, 'agent', ctx)).toBe(
      'Approved. From now on Dusty may deploy without asking.',
    );
    expect(approveToastFor(deployApproval, undefined, ctx)).not.toContain('From now on');
  });
});

describe('“Don’t ask again on {server}” (Whombat server-asks.md SA-07; AP-1720)', () => {
  const restart = {
    ...deployApproval,
    action: {
      type: 'connection_call',
      params: {
        connectionId: 'con_servers',
        handle: 'servers',
        tool: 'guest_power',
        toolHash: 'a'.repeat(64),
        server: { id: 'thetitan', name: 'The Titan' },
      },
    },
  } as Approval;
  const ctx = {
    names: (id: string) => (id === dusty.id ? { name: 'Dusty', shortName: 'Dusty' } : undefined),
    viewer: { id: mara.id, kind: 'person' as const },
    now: '2026-09-23T09:22:00.000Z',
    timeZone: 'Europe/Amsterdam',
  };

  it('names the server of a Servers call, and nothing else', () => {
    expect(stopAskingServer(restart.action)).toEqual({ id: 'thetitan', name: 'The Titan' });
    expect(stopAskingServer(deployApproval.action)).toBeNull();
  });

  it('says Whombat won’t ask again on that server', () => {
    expect(approveToastFor(restart, 'agent', ctx)).toBe('Approved. Whombat won’t ask again on The Titan.');
    expect(approveToastFor(restart, undefined, ctx)).not.toContain('won’t ask again');
  });
});
