/** A yes to a `run_command` carries how far it goes (agent-computer.md AC-42; AP-623). */
import type { Approval } from '@whombat/core';
import { approval as deployApproval } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { decidedApproval } from './optimistic';

const command: Approval = {
  ...deployApproval,
  keyId: 'deploy.production',
  action: {
    type: 'run_command',
    params: {
      command: 'ssh web-1 sudo systemctl restart api',
      category: 'deploy_production',
      target: 'web-1',
      reason: null,
    },
  },
  scope: null,
};

describe('decidedApproval and a command’s scope', () => {
  it('keeps the scope chosen, once by default', () => {
    expect(decidedApproval(command, 'approve', 'prn_mara', '2026-10-02T09:00:00.000Z', 'task').scope).toBe(
      'task',
    );
    expect(decidedApproval(command, 'approve', 'prn_mara', '2026-10-02T09:00:00.000Z').scope).toBe('once');
  });

  it('has none after a no, and for other actions only an “Always allow” on a risk row (RA-06; AP-680)', () => {
    expect(
      decidedApproval(command, 'decline', 'prn_mara', '2026-10-02T09:00:00.000Z', 'agent').scope,
    ).toBeNull();
    // A deploy is under the Deploy row: “Always allow Neo to deploy” reads `agent` at once.
    expect(
      decidedApproval(deployApproval, 'approve', 'prn_mara', '2026-10-02T09:00:00.000Z', 'agent').scope,
    ).toBe('agent');
    expect(decidedApproval(deployApproval, 'approve', 'prn_mara', '2026-10-02T09:00:00.000Z').scope).toBe(
      deployApproval.scope,
    );
    expect(
      decidedApproval(deployApproval, 'decline', 'prn_mara', '2026-10-02T09:00:00.000Z', 'agent').scope,
    ).toBe(deployApproval.scope);
    // A key request isn't under a row: no scope of its own.
    const grant: Approval = {
      ...deployApproval,
      action: {
        type: 'grant_key',
        params: { agentId: 'prn_neo', keyId: 'ci.run', tier: 'can', scope: null },
      },
    } as Approval;
    expect(decidedApproval(grant, 'approve', 'prn_mara', '2026-10-02T09:00:00.000Z', 'agent').scope).toBe(
      grant.scope,
    );
  });
});
