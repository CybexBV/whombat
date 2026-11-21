/**
 * A command on an agent's computer that needs a person (agent-computer.md AC-41, AC-42): the approval screen shows the
 * command and its target and decides with one button per scope; the yes says how far it goes; there is no Undo.
 */
import type { Approval } from '@whombat/core';
import { deployApproval, mara, SEED_NOW } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { approvalScreen, scopedApproveToast } from './approval';

const COMMAND = 'ssh web-1 "cd /srv/site && git pull && sudo systemctl restart site"';

function commandApproval(overrides: Partial<Approval> = {}): Approval {
  const base = deployApproval();
  return deployApproval({
    id: 'apr_command-41',
    number: 41,
    keyId: 'deploy.production',
    action: {
      type: 'run_command',
      params: { command: COMMAND, category: 'deploy_production', target: 'web-1', reason: null },
    },
    title: 'Run a command on the production server web-1',
    question: 'Run a command on the production server web-1?',
    target: 'web-1 · Deploy to production',
    whatHappens: [],
    conditions: base.conditions.filter((c) => c.kind === 'person_approves'),
    ...overrides,
  });
}

describe('a run_command approval on the phone (AC-41, AC-42)', () => {
  it('shows the command in mono under COMMAND and its target', () => {
    const model = approvalScreen(commandApproval(), worldContext(), 'PR #482');
    expect(model.content).toEqual({ label: 'COMMAND', text: COMMAND, mono: true });
    expect(model.target).toBe('web-1 · Deploy to production');
  });

  it('decides with Allow once, Allow for this task, Always allow for the agent, and Don’t allow', () => {
    const model = approvalScreen(commandApproval(), worldContext(), 'PR #482');
    expect(model.footer).toEqual({
      kind: 'choose',
      canApprove: true,
      canDecline: true,
      choices: [
        { scope: 'once', label: 'Allow once' },
        { scope: 'task', label: 'Allow for this task' },
        { scope: 'agent', label: 'Always allow for Dusty' },
      ],
      declineLabel: 'Don’t allow',
    });
  });

  it('says how far the yes went', () => {
    const approval = commandApproval();
    const ctx = worldContext();
    expect(scopedApproveToast(approval, 'once', ctx)).toBe('Allowed once. Dusty runs the command now.');
    expect(scopedApproveToast(approval, 'task', ctx)).toBe(
      'Allowed for this task. Dusty runs the command now.',
    );
    expect(scopedApproveToast(approval, 'agent', ctx)).toBe(
      'Always allowed for Dusty. Dusty runs the command now.',
    );
  });

  it('has no Undo once decided', () => {
    const allowed = commandApproval({
      state: 'approved',
      scope: 'task',
      decidedById: mara.id,
      decidedAt: SEED_NOW.toISOString(),
      conditions: commandApproval().conditions.map((c) => ({ ...c, met: true })),
    });
    expect(approvalScreen(allowed, worldContext(), 'PR #482').footer).toEqual({ kind: 'none' });
  });

  it('leaves every other approval as it was: no target line, Approve / Decline', () => {
    const model = approvalScreen(deployApproval(), worldContext(), 'PR #482');
    expect(model.target).toBeNull();
    expect(model.footer).toMatchObject({ kind: 'decide', declineLabel: 'Decline' });
  });
});

describe('“Always allow” on a risk-row request (RA-06; AP-690)', () => {
  it('keeps Approve / Decline and offers “Always allow Dusty to deploy” apart, behind its question', () => {
    const model = approvalScreen(deployApproval(), worldContext(), 'PR #482');
    expect(model.footer).toMatchObject({ kind: 'decide', canApprove: true, declineLabel: 'Decline' });
    expect(model.lasting?.link).toContain('Always allow Dusty to deploy');
    expect(model.lasting?.title).toContain('deploy');
    // The phone can't change it back: the web can.
    expect(model.lasting?.body).toContain('on the web');
    expect(model.lasting?.keep).toBe('Keep asking');
    expect(scopedApproveToast(deployApproval(), 'agent', worldContext(), 'PR #482')).toBe(
      'Approved. From now on Dusty may deploy without asking.',
    );
  });

  it('leaves a command’s four choices as they were', () => {
    expect(approvalScreen(commandApproval(), worldContext(), 'PR #482').footer.kind).toBe('choose');
  });
});
