/** Agents asking for a key (docs/decisions/key-requests.md): the `grant_key` action, its copy and its rules. */
import { describe, expect, it } from 'vitest';
import { deployApproval, mara, NOW, names, TZ } from '../__fixtures__/world.js';
import { Approval, ApprovalAction } from '../domain/approval.js';
import type { Grant } from '../domain/grant.js';
import { actionKey, describeAction, describeAsk } from '../keys/actions.js';
import { decide } from '../keys/engine.js';
import { keyRowTier, RISK_ROW_KEYS } from '../keys/grants.js';
import { grantsWithRequestedKey, heldTier, keyRequestProblem, requestedTier } from '../keys/requests.js';
import {
  actionCopy,
  approvalCopy,
  approvalView,
  approve,
  completeExecution,
  decline,
  startExecution,
} from './index.js';

const TINKER = 'prn_tinker';
const names2 = (id: string) => (id === TINKER ? { name: 'Tinker', shortName: 'Tinker' } : names(id));
const MARA = { id: mara.id, kind: 'person' as const };

function keyRequest(keyId: 'web.browse' | 'deploy.staging' | 'messages.search' = 'web.browse'): Approval {
  const action = ApprovalAction.parse({ type: 'grant_key', params: { keyId } });
  const copy = actionCopy(action, names2, TINKER);
  return Approval.parse(
    deployApproval({
      requesterId: TINKER,
      keyId,
      action,
      title: copy.title,
      question: copy.question,
      target: copy.target,
      whatHappens: [copy.runs],
      conditions: [
        {
          id: 'person',
          kind: 'person_approves',
          label: 'A person says yes',
          met: false,
          approverIds: [mara.id],
        },
      ],
      involvedIds: [],
    }),
  );
}

function ok(r: ReturnType<typeof approve>): Approval {
  if (!r.ok) throw new Error(r.error);
  return r.approval;
}

describe('grant_key action', () => {
  it('is about the key asked for and names it by its label', () => {
    const action = ApprovalAction.parse({ type: 'grant_key', params: { keyId: 'web.browse' } });
    expect(actionKey(action)).toBe('web.browse');
    expect(describeAction(action)).toBe('get the key “Browse the web”');
    expect(describeAsk(action)).toBe('Asked to get the key “Browse the web”');
    expect(() => ApprovalAction.parse({ type: 'grant_key', params: { keyId: 'nope' } })).toThrow();
  });

  it('writes its copy from the requester and the key’s label, never the id', () => {
    const a = keyRequest();
    expect(actionCopy(a.action, names2, TINKER)).toEqual({
      title: 'Give Tinker “Browse the web”',
      question: 'Give Tinker “Browse the web”?',
      target: 'keys · Tinker',
      runs: 'Give Tinker “Browse the web”, to use without asking',
    });
    expect(actionCopy(keyRequest('deploy.staging').action, names2, TINKER).runs).toBe(
      'Give Tinker “Deploy to staging”, still asking a person each time',
    );
    // Without a name for the requester the stored copy stands.
    const stored = approvalCopy(a, () => undefined);
    expect(stored.title).toBe('Give Tinker “Browse the web”');
    expect(stored.matchesStored).toBe(true);
    expect(approvalCopy(a, names2).matchesStored).toBe(true);
  });

  it('shows the card with “Give Tinker …” as its primary button', () => {
    const a = keyRequest();
    const v = approvalView(a, { names: names2, viewer: MARA, now: NOW, timeZone: TZ });
    expect(v.label).toBe('NEEDS A PERSON');
    expect(v.title).toBe('Give Tinker “Browse the web”');
    expect(v.question).toBe('Give Tinker “Browse the web”?');
    expect(v.target).toBe('keys · Tinker');
    expect(v.actionNote).toBeNull();
    expect(v.cta).toBe('Give Tinker “Browse the web”');
    expect(v.mobileCta).toBe('Give “Browse the web”');
    expect(v.message).toBe('Tinker can’t get a key without a person.');
    expect(v.canApprove).toBe(true);
  });

  it('keeps the whole label on mobile when it fits', () => {
    const a = keyRequest();
    const short = (id: string) => (id === TINKER ? { name: 'Tin', shortName: 'Tin' } : names(id));
    const action = ApprovalAction.parse({ type: 'grant_key', params: { keyId: 'ci.run' } });
    const v = approvalView(
      { ...a, action, title: 'Give Tin “Run CI”', question: 'Give Tin “Run CI”?' },
      {
        names: short,
        now: NOW,
        timeZone: TZ,
      },
    );
    expect(v.mobileCta).toBe('Give Tin “Run CI”');
  });

  it('reads as giving the key through approve, execute and decline', () => {
    const a = keyRequest();
    const view = (x: Approval) => approvalView(x, { names: names2, viewer: MARA, now: NOW, timeZone: TZ });
    const approved = ok(approve(a, MARA, NOW));
    expect(view(approved).label).toBe('APPROVED · GIVING THE KEY');
    expect(view(approved).toasts.approve).toBe('Approved. Giving Tinker “Browse the web”.');
    const running = ok(startExecution(approved, NOW));
    expect(view(running).message).toBe('Giving Tinker “Browse the web” now.');
    const done = ok(completeExecution(running, NOW, { ok: true, resultUrl: null }));
    expect(view(done).label).toBe('GIVEN');
    expect(view(done).message).toBe('Given. Tinker can use “Browse the web” from its next turn.');
    expect(view(done).inboxDone).toBe('Given');
    const declined = ok(decline(a, MARA, NOW));
    expect(view(declined).message).toBe('Declined. Tinker won’t get “Browse the web”.');
    const asks = keyRequest('deploy.staging');
    const given = ok(
      completeExecution(ok(startExecution(ok(approve(asks, MARA, NOW)), NOW)), NOW, {
        ok: true,
        resultUrl: null,
      }),
    );
    expect(view(given).message).toBe(
      'Given. Tinker holds “Deploy to staging” and asks a person each time it uses it.',
    );
  });
});

describe('who may ask for which key', () => {
  const tinker = { id: TINKER, name: 'Tinker' };
  const g = (keyId: Grant['keyId'], tier: Grant['tier'], agentId = TINKER): Grant => ({
    agentId,
    keyId,
    tier,
  });

  it('lets an agent ask for a key it doesn’t hold, or holds at ask or cannot', () => {
    expect(keyRequestProblem(tinker, [], 'web.browse')).toBeNull();
    expect(keyRequestProblem(tinker, [g('web.browse', 'cannot')], 'web.browse')).toBeNull();
    expect(keyRequestProblem(tinker, [g('pr.open', 'ask')], 'pr.open')).toBeNull();
    expect(keyRequestProblem(tinker, [], 'deploy.staging')).toBeNull();
    // An outside message is a risk row since 0.44 (RA-01): held at ask, it is held as far as a request gives it.
    expect(keyRequestProblem(tinker, [g('messages.external', 'ask')], 'messages.external')).toMatch(
      /asks a person each time.*Settings → Agent/,
    );
  });

  it('refuses keys for people only, but no longer Merge into main (CT-211) or Push to main (CT-222)', () => {
    expect(keyRequestProblem(tinker, [], 'merge.main')).toBeNull();
    expect(keyRequestProblem(tinker, [g('merge.main', 'cannot')], 'merge.main')).toBeNull();
    // Push to main is a three-state row since 0.36: asked for, it is given at ask.
    expect(keyRequestProblem(tinker, [], 'branch.main.push')).toBeNull();
    expect(requestedTier('branch.main.push')).toBe('ask');
    expect(keyRequestProblem(tinker, [g('branch.main.push', 'ask')], 'branch.main.push')).toMatch(
      /“Push to main” and asks a person each time/,
    );
    const peopleOnly = keyRequestProblem(tinker, [], 'agents.manage');
    expect(peopleOnly).toMatch(/is for people/);
    expect(peopleOnly).toContain('Tinker');
  });

  it('refuses a key the agent already holds as far as an agent can', () => {
    expect(keyRequestProblem(tinker, [g('web.browse', 'can')], 'web.browse')).toBe(
      'Tinker already holds “Browse the web”.',
    );
    expect(keyRequestProblem(tinker, [g('mail.send', 'ask')], 'mail.send')).toMatch(
      /already holds “Send emails”, and it always asks/,
    );
    // A Merge or Deploy key held at ask is held as far as a request gives it (CT-213).
    expect(keyRequestProblem(tinker, [g('deploy.staging', 'ask')], 'deploy.staging')).toMatch(
      /“Deploy to staging” and asks a person each time/,
    );
    expect(keyRequestProblem(tinker, [g('merge', 'ask')], 'merge.main')).toMatch(/asks a person each time/);
    expect(keyRequestProblem(tinker, [g('deploy', 'can')], 'deploy.production')).toBe(
      'Tinker already holds “Deploy to production”.',
    );
    // An umbrella or another wording counts.
    expect(keyRequestProblem(tinker, [g('code.write', 'can')], 'branch.shared.push')).toMatch(
      /already holds/,
    );
    // Other agents' grants don't.
    expect(keyRequestProblem(tinker, [g('web.browse', 'can', 'prn_other')], 'web.browse')).toBeNull();
  });

  it('lets the one agent ask for any key an agent may hold, a person’s accounts too (OA-10)', () => {
    for (const keyId of ['mail.read', 'web.browse', 'messages.search', 'deploy.staging'] as const)
      expect(keyRequestProblem(tinker, [], keyId), keyId).toBeNull();
  });

  it('gives the key at can, clamped, and keeps every other grant', () => {
    expect(requestedTier('web.browse')).toBe('can');
    expect(requestedTier('deploy.staging')).toBe('ask');
    const before = [g('repos.read', 'can'), g('web.browse', 'cannot'), g('messages.external', 'ask')];
    expect(grantsWithRequestedKey(TINKER, before, 'web.browse')).toEqual([
      g('repos.read', 'can'),
      g('messages.external', 'ask'),
      g('web.browse', 'can'),
    ]);
    expect(heldTier(TINKER, grantsWithRequestedKey(TINKER, before, 'web.browse'), 'web.browse')).toBe('can');
  });

  it('gives a key of a risk row at ask, for the whole row (MD-04, CT-213, RA-01)', () => {
    const agent = { id: TINKER, kind: 'agent' as const };
    for (const keyId of RISK_ROW_KEYS) expect(requestedTier(keyId), keyId).toBe('ask');
    // Money: a request for billing data gives refunds too, at ask.
    expect(grantsWithRequestedKey(TINKER, [], 'billing.write')).toEqual([
      g('refunds.issue', 'ask'),
      g('billing.write', 'ask'),
    ]);
    expect(actionCopy(keyRequest('deploy.staging').action, names2, TINKER).runs).toMatch(/still asking/);
    // A Developer (merge.main and deploy at cannot) asks for Merge into main: the Merge row reads Ask.
    const developer = [g('pr.open', 'can'), g('merge.main', 'cannot'), g('deploy', 'cannot')];
    const merged = grantsWithRequestedKey(TINKER, developer, 'merge.main');
    expect(merged).toEqual([
      g('pr.open', 'can'),
      g('merge.main', 'ask'),
      g('deploy', 'cannot'),
      g('merge', 'ask'),
    ]);
    expect(decide(agent, merged, 'merge.main').outcome).toBe('ask');
    expect(decide(agent, merged, 'merge').outcome).toBe('ask');
    expect(keyRowTier(merged, 'merge')).toBe('ask');
    // Deploy to staging: the umbrella moves to ask, so a production deploy asks too (the row reads Ask).
    const deploys = grantsWithRequestedKey(TINKER, developer, 'deploy.staging');
    expect(deploys).toEqual([g('pr.open', 'can'), g('merge.main', 'cannot'), g('deploy', 'ask')]);
    expect(decide(agent, deploys, 'deploy.production').outcome).toBe('ask');
    expect(keyRowTier(deploys, 'deploy')).toBe('ask');
    // A row key already at can is never lowered: only the asked key's own grant moves to ask.
    const partly = [g('deploy.staging', 'can'), g('deploy.production', 'cannot')];
    expect(grantsWithRequestedKey(TINKER, partly, 'deploy.production')).toEqual([
      g('deploy.staging', 'can'),
      g('deploy.production', 'ask'),
    ]);
    // Other agents' grants are left out, as before.
    expect(grantsWithRequestedKey(TINKER, [g('merge', 'can', 'prn_other')], 'merge.main')).toEqual([
      g('merge', 'ask'),
    ]);
  });
});
