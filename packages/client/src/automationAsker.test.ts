import { type Approval, approvalView, type SystemPrincipal } from '@whombat/core';
import { deployApproval, dusty, mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_SHORT_NAME,
  AUTOMATION_TAG,
  authorStatus,
  automationAsker,
  automationLabel,
  isAutomationPrincipal,
  namesWithAsker,
} from './automationAsker';

/** An automation's own principal, as the server makes it: a system principal, `system: 'automation'`. */
const principal: SystemPrincipal = {
  id: 'prn_auto-fix-web',
  burrowId: dusty.burrowId,
  name: 'Fix web bugs',
  handle: 'fix-web-bugs',
  publicKey: dusty.publicKey,
  fingerprint: dusty.fingerprint,
  createdAt: dusty.createdAt,
  kind: 'system',
  system: 'automation',
};
/** A run waiting on “Approve the fix”. */
const asked: Approval = deployApproval({
  requesterId: principal.id,
  keyId: 'approvals.decide',
  action: {
    type: 'custom',
    params: {
      name: 'continue “Assess and fix new issues on whombat/web”',
      keyId: 'approvals.decide',
      data: { automationId: 'aut_fix-web', runId: 'arn_44', stepId: 'approve', attempt: 0 },
    },
  },
  title: 'Fix #212: Totals round down on the cart page',
  question: 'Fix #212: Totals round down on the cart page?',
  conditions: [
    { id: 'person', kind: 'person_approves', label: 'A person says yes', met: false, approverIds: [mara.id] },
  ],
});
/** The same request, its name cut at 80 characters before the closing quote. */
const cut = {
  ...asked,
  action: { ...asked.action, params: { ...asked.action.params, name: 'continue “Assess and fix' } },
} as Approval;

describe('an automation asking', () => {
  it('is its own principal, never the agent or a person', () => {
    expect(isAutomationPrincipal(principal)).toBe(true);
    expect(isAutomationPrincipal(dusty)).toBe(false);
    expect(isAutomationPrincipal(mara)).toBe(false);
    expect(isAutomationPrincipal({ ...principal, system: 'github' })).toBe(false);
    expect(isAutomationPrincipal(undefined)).toBe(false);
    expect(isAutomationPrincipal(null)).toBe(false);
  });

  it('is named by the request it continues, else by its principal', () => {
    expect(automationAsker(asked, principal)).toEqual({
      name: 'Assess and fix new issues on whombat/web',
      label: 'Automation “Assess and fix new issues on whombat/web”',
    });
    // Without its closing quote the name is incomplete: the principal's name instead.
    expect(automationAsker(cut, principal)?.name).toBe('Fix web bugs');
    // Its principal not known yet (not in the bootstrap): the action says it is an automation's.
    expect(automationAsker(asked, undefined)?.name).toBe('Assess and fix new issues on whombat/web');
    expect(automationAsker(asked, null)?.name).toBe('Assess and fix new issues on whombat/web');
    expect(automationAsker(cut, undefined)).toEqual({ name: null, label: automationLabel(null) });
    expect(automationLabel(null)).toBe('An automation');
  });

  it('leaves the agent’s and people’s requests alone', () => {
    expect(automationAsker(deployApproval(), dusty)).toBeNull();
    expect(automationAsker(deployApproval(), undefined)).toBeNull();
    // The agent's custom request isn't an automation's, even with an automation id in its data.
    expect(automationAsker(asked, dusty)).toBeNull();
    expect(automationAsker(asked, mara)).toBeNull();
  });

  it('names it “The automation” in the approval’s sentences', () => {
    const base = (id: string) => (id === mara.id ? { name: 'Mara Okafor', shortName: 'Mara' } : undefined);
    const names = namesWithAsker(base, principal.id, automationAsker(asked, principal));
    expect(names(principal.id)).toEqual({
      name: 'Assess and fix new issues on whombat/web',
      shortName: AUTOMATION_SHORT_NAME,
    });
    expect(names(mara.id)?.shortName).toBe('Mara');
    const view = approvalView(asked, {
      names,
      now: '2026-09-23T09:22:00.000Z',
      timeZone: 'Europe/Amsterdam',
    });
    expect(view.message.startsWith(AUTOMATION_SHORT_NAME)).toBe(true);
    expect(view.message).not.toContain(principal.name);
    expect(namesWithAsker(base, principal.id, null)).toBe(base);
  });

  it('says “Automation” beside its name in a row, nothing for the agent or a person', () => {
    expect(authorStatus(principal)).toBe(AUTOMATION_TAG);
    expect(authorStatus(dusty)).toBeNull();
    expect(authorStatus(mara)).toBeNull();
  });
});
