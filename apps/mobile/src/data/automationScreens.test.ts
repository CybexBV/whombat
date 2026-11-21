import { AUTOMATION_ASKING, AUTOMATION_SHORT_NAME } from '@whombat/client';
import type { Approval, SystemPrincipal } from '@whombat/core';
import { bootstrap, deployApproval, dusty, mara, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { approvalScreen, scopedApproveToast } from './approval';
import { auditContext, auditRow, SYSTEM_AUDIT_TAGS } from './audit';
import { cardSummary } from './messages';
import { peopleFrom, type ViewContext, viewerOf } from './people';

/** An automation's own principal, as the server makes it (BP-C04): a system principal (Whombat one-agent.md OA-17). */
const principal: SystemPrincipal = {
  id: 'prn_auto-fix-web',
  burrowId: dusty.burrowId,
  name: 'Fix web bugs',
  handle: 'auto-fix-web',
  publicKey: dusty.publicKey,
  fingerprint: dusty.fingerprint,
  createdAt: dusty.createdAt,
  kind: 'system',
  system: 'automation',
};
/** Run #44 waiting on “Approve the fix” (request #31 in #incidents), as the web's fixture world has it. */
const asked: Approval = deployApproval({
  id: 'apr_fix-212',
  number: 31,
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
  summary: '',
  explainer: '',
  conditions: [
    { id: 'person', kind: 'person_approves', label: 'A person says yes', met: false, approverIds: [mara.id] },
  ],
});

/** The fixture world with the automation's principal in the bootstrap (as the server sends it), or without. */
function context(withPrincipal = true): ViewContext {
  const b = bootstrap();
  const principals = withPrincipal ? [...b.principals, principal] : b.principals;
  return { people: peopleFrom(principals), viewer: viewerOf(b), now: SEED_NOW, timeZone: SEED_TIME_ZONE };
}

describe('the approval screen for an automation (AP-999)', () => {
  it('shows its mark and “AN AUTOMATION IS ASKING”, never the agent’s face', () => {
    const model = approvalScreen(asked, context(), '#incidents');
    expect(model.automation).toEqual({
      name: 'Assess and fix new issues on whombat/web',
      label: 'Automation “Assess and fix new issues on whombat/web”',
    });
    // No wombat: the screen draws the mark when `automation` is set, and never an agent's face.
    expect(model.requesterFace).toBeNull();
    expect(model.requesterName).toBe('Assess and fix new issues on whombat/web');
    expect(model.label).toBe(AUTOMATION_ASKING);
    expect(model.tone).toBe('warn');
    expect(model.question).toBe('Fix #212: Totals round down on the cart page?');
    expect(model.context).toBe('Assess and fix new issues on whombat/web · #incidents · 11:25');
    // An everyday ask says what happens among its facts, not in a sentence over them.
    expect(model.facts?.permission.text).toBeTruthy();
    expect(model.footer.kind).toBe('answers');
    expect(model.lasting).toBeNull();
  });

  it('reads the same before its principal is in the bootstrap', () => {
    const model = approvalScreen(asked, context(false), '#incidents');
    expect(model.automation?.name).toBe('Assess and fix new issues on whombat/web');
    expect(model.label).toBe(AUTOMATION_ASKING);
    expect(model.facts).not.toBeNull();
    // A cut name and no principal: still an automation, never “Someone”.
    const cut = {
      ...asked,
      action: { ...asked.action, params: { ...asked.action.params, name: 'continue “Assess and fix' } },
    } as Approval;
    const unnamed = approvalScreen(cut, context(false));
    expect(unnamed.requesterName).toBe('An automation');
    expect(unnamed.automation?.label).toBe('An automation');
    expect(unnamed.context).toBe('An automation · 11:25');
  });

  it('says the state once decided, and “The automation” in what follows', () => {
    const declined: Approval = {
      ...asked,
      state: 'declined',
      decidedById: mara.id,
      decidedAt: asked.createdAt,
    };
    const model = approvalScreen(declined, context(), '#incidents');
    expect(model.label).toBe('DECLINED');
    expect(model.message.startsWith(AUTOMATION_SHORT_NAME)).toBe(true);
    expect(model.message).not.toContain('Fix web bugs');
    expect(scopedApproveToast(asked, 'once', context(), '#incidents')).not.toContain('Fix web bugs');
  });

  it('shows the agent’s request with its face and name (AP-4995)', () => {
    const model = approvalScreen(deployApproval(), context(), 'PR #482');
    expect(model.automation).toBeNull();
    expect(model.requesterFace).toBe(dusty.face);
    expect(model.requesterName).toBe('Dusty');
    expect(model.label).toBe('NEEDS A PERSON');
    expect(model.context).toContain('Dusty');
  });
});

describe('an automation in rows (AP-1000)', () => {
  it('names it “The automation” on its request’s card in the thread', () => {
    const card = cardSummary({ kind: 'approval', approval: asked }, context());
    expect(card?.label).toBe('The automation needs your OK');
    // A door to the approval screen while it waits; no line repeating that it waits.
    expect(card?.approvalDoor).toEqual({ waiting: true, state: null });
    expect(card?.detail).toBeNull();
  });

  it('is tagged AUTOMATION in the audit log, the agent AGENT (AP-4994)', () => {
    const b = bootstrap();
    const audit = auditContext([...b.principals, principal], SEED_NOW, SEED_TIME_ZONE);
    const event = (actorId: string) =>
      ({
        id: 'evt_1',
        actorId,
        createdAt: SEED_NOW.toISOString(),
        text: 'Did a thing',
        where: null,
      }) as never;
    expect(auditRow(event(principal.id), audit, principal).tag).toBe(SYSTEM_AUDIT_TAGS.automation);
    expect(auditRow(event(dusty.id), audit, dusty).tag).toBe('AGENT');
    expect(auditRow(event(mara.id), audit, mara).tag).toBe('PERSON');
  });
});
