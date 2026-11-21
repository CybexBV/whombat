import { describe, expect, it } from 'vitest';
import {
  at,
  dusty,
  mara,
  NOW,
  names,
  TZ,
  deployApproval as worldDeployApproval,
} from '../__fixtures__/world.js';
import { Approval, ApprovalAction } from '../domain/approval.js';
import { alwaysAllowRow } from '../keys/actions.js';
import {
  actionCopy,
  allConditionsMet,
  approvalInboxText,
  approvalPhase,
  approvalView,
  approve,
  canDecide,
  completeExecution,
  decline,
  defaultConditionLabel,
  evaluate,
  lastingWordsAt,
  otherConditionsMet,
  readyToExecute,
  startExecution,
  stopAskingConfirm,
  type TransitionResult,
  undo,
} from './index.js';

const MARA = { id: mara.id, kind: 'person' as const };
const DUSTY = { id: dusty.id, kind: 'agent' as const };

/** The world's staging deploy: Mara reviews the PR and says yes (one person, OP-01). */
const deployApproval = (overrides: Partial<Approval> = {}): Approval => worldDeployApproval(overrides);

const ctx = (now = NOW, viewer: typeof MARA = MARA) => ({
  names,
  viewer,
  now,
  timeZone: TZ,
  where: 'Chat',
});

function ok(r: TransitionResult): Approval {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return Approval.parse(r.approval);
}

/** The moment checks go green and Mara approves the PR (the storyline at 11:38). */
const GREEN = {
  checks: { headSha: '7be20f', state: 'passed' as const, passed: 41, total: 41, fixing: false },
  reviews: { [mara.id]: { state: 'approved' as const, at: at('11:38') } },
};

describe('approval conditions', () => {
  it('starts with nothing met', () => {
    const a = evaluate(deployApproval());
    expect(a.conditions.map((c) => c.met)).toEqual([false, false, false]);
    expect(allConditionsMet(a)).toBe(false);
    expect(otherConditionsMet(a)).toBe(false);
    expect(readyToExecute(a)).toBe(false);
  });

  it('evaluates live checks and reviews', () => {
    const a = evaluate(deployApproval(), GREEN);
    expect(a.conditions.map((c) => c.met)).toEqual([true, true, false]);
    expect(otherConditionsMet(a)).toBe(true);
    const failing = evaluate(deployApproval(), {
      checks: { headSha: '7be20f', state: 'failed', passed: 40, total: 41, fixing: false },
    });
    expect(failing.conditions[0]?.met).toBe(false);
    // Missing facts leave conditions as they were.
    expect(evaluate(a, {}).conditions.map((c) => c.met)).toEqual([true, true, false]);
  });

  it('meets the person condition exactly while approved', () => {
    const approved = ok(approve(deployApproval(), MARA, NOW));
    expect(approved.conditions[2]?.met).toBe(true);
    const back = ok(undo(approved, MARA, NOW));
    expect(back.conditions[2]?.met).toBe(false);
  });

  it('has default labels', () => {
    expect(defaultConditionLabel({ kind: 'checks_pass' })).toBe('Checks pass on the latest commit');
    expect(defaultConditionLabel({ kind: 'review_approved', reviewerName: 'Waffle' })).toBe(
      'Waffle approves the PR',
    );
    expect(defaultConditionLabel({ kind: 'person_approves' })).toBe('A person says yes');
  });
});

describe('approval display: desktop storyline', () => {
  it('NEEDS A PERSON while pending', () => {
    const v = approvalView(deployApproval(), ctx());
    expect(v.phase).toBe('needs_person');
    expect(v.label).toBe('NEEDS A PERSON');
    expect(v.tone).toBe('warn');
    expect(v.pendingBorder).toBe(true);
    expect(v.kicker).toBe('DUSTY IS ASKING');
    expect(v.cta).toBe('Approve in advance');
    expect(v.message).toMatch(/^Dusty won’t deploy without a person\./);
    expect(v.conditions.map((c) => [c.mark, c.label, c.note])).toEqual([
      ['', 'Checks pass on the latest commit', '38 of 41 · fixing'],
      ['', 'Mara approves the PR', 'changes requested'],
      ['', 'A person says yes', 'you'],
    ]);
    expect(v.short).toMatch(/^Dusty is waiting for a person/);
    expect(v.whatHappens.map((s) => s.n)).toEqual(['01', '02', '03', '04']);
    expect(v.whatHappens[0]?.text).toBe('Build 7be20f, the latest commit on feat/invoice-pdf');
    expect(v.logPill).toEqual({ text: 'WAITING ON A PERSON', tone: 'warn' });
    expect(v.logDecided).toEqual({ text: 'Nobody yet. Dusty is holding the deploy.', tone: 'warn' });
    expect(v.planStep).toEqual({ state: 'gate', label: 'Needs you' });
    expect(v.inboxDone).toBeNull();
    expect(v.canApprove && v.canDecline).toBe(true);
    expect(v.canUndo).toBe(false);
    expect(v.toasts.approve).toMatch(/^Approved in advance\. Dusty will deploy/);
    expect(v.toasts.decline).toBe('Declined. Dusty won’t deploy this commit.');
  });

  it('names the person as “you”', () => {
    expect(approvalView(deployApproval(), ctx()).conditions[2]?.note).toBe('you');
  });

  it('APPROVED · WAITING FOR CHECKS after approving in advance', () => {
    const approved = ok(approve(deployApproval(), MARA, NOW));
    const v = approvalView(approved, ctx());
    expect(v.phase).toBe('waiting');
    expect(v.label).toBe('APPROVED · WAITING FOR CHECKS');
    expect(v.tone).toBe('warn');
    expect(v.pendingBorder).toBe(false);
    expect(v.message).toMatch(/^Approved\. Dusty deploys as soon as checks are green and Mara signs off/);
    expect(v.conditions[2]?.note).toBe('Mara · just now');
    expect(v.conditions[2]?.mark).toBe('✓');
    expect(v.short).toBe('Mara approved. Waiting for checks and Mara.');
    expect(v.logPill).toEqual({ text: 'APPROVED BY MARA', tone: 'ok' });
    expect(v.logDecided.text).toBe('Mara Okafor approved just now');
    expect(v.planStep).toEqual({ state: 'gate', label: 'Approved' });
    expect(v.canUndo).toBe(true);
    expect(v.canApprove).toBe(false);
    expect(v.inboxDone).toBe('Approved · waiting for checks and Mara');
  });

  it('waits for review only once checks are green', () => {
    const approved = ok(approve(deployApproval(), MARA, NOW));
    const v = approvalView(evaluate(approved, { checks: GREEN.checks }), ctx());
    expect(v.label).toBe('APPROVED · WAITING FOR REVIEW');
    expect(v.message).toBe('Approved. Dusty deploys as soon as Mara signs off.');
  });

  it('switches the CTA to "Approve and deploy" once the other conditions are met', () => {
    const v = approvalView(evaluate(deployApproval(), GREEN), ctx(at('11:39')));
    expect(v.cta).toBe('Approve and deploy');
    expect(v.label).toBe('NEEDS A PERSON');
    expect(v.conditions.map((c) => c.note)).toEqual(['41 of 41', 'approved 11:38', 'you']);
    expect(v.toasts.approve).toBe('Approved. Dusty is deploying to staging.');
  });

  it('APPROVED · DEPLOYING → DEPLOYED when the executor runs', () => {
    const approved = evaluate(ok(approve(deployApproval(), MARA, at('11:30'))), GREEN);
    expect(readyToExecute(approved)).toBe(true);
    expect(approvalView(approved, ctx(at('11:38'))).label).toBe('APPROVED · DEPLOYING');

    const running = ok(startExecution(approved, '2026-09-23T09:38:00.000Z'));
    expect(approvalPhase(running)).toBe('executing');
    expect(undo(running, MARA, NOW)).toMatchObject({ ok: false, error: 'executing' });

    const done = ok(
      completeExecution(running, '2026-09-23T09:40:14.000Z', {
        ok: true,
        resultUrl: 'https://staging.burrowhq.example/invoices/2026-000142.pdf',
      }),
    );
    expect(done.executedAt).toBe('2026-09-23T09:40:14.000Z');
    expect(done.execution.durationMs).toBe(134_000);
    const v = approvalView(done, ctx('2026-09-23T09:42:28.000Z'));
    expect(v.phase).toBe('executed');
    expect(v.label).toBe('DEPLOYED');
    expect(v.tone).toBe('ok');
    expect(v.message).toBe(
      'Deployed to staging in 2m 14s. Try it: staging.burrowhq.example/invoices/2026-000142.pdf',
    );
    expect(v.short).toBe('Deployed to staging 2m 14s ago. Mara approved.');
    expect(approvalView(done, ctx('2026-09-23T12:40:14.000Z')).short).toBe(
      'Deployed to staging 3 hours ago. Mara approved.',
    );
    expect(v.planStep).toEqual({ state: 'done', label: 'Deployed' });
    expect(v.inboxDone).toBe('Deployed');
    expect(v.canUndo).toBe(false);
    expect(undo(done, MARA, NOW)).toMatchObject({ ok: false, error: 'already_executed' });
  });

  it('keeps the duration an executor measured itself (a deploy workflow run)', () => {
    const approved = evaluate(ok(approve(deployApproval(), MARA, at('11:30'))), GREEN);
    const running = ok(startExecution(approved, '2026-09-23T09:38:00.000Z'));
    const done = ok(
      completeExecution(running, '2026-09-23T09:38:03.000Z', {
        ok: true,
        resultUrl: 'https://staging.burrowhq.example/invoices/2026-000142.pdf',
        durationMs: 134_000,
      }),
    );
    expect(done.execution.durationMs).toBe(134_000);
    expect(approvalView(done, ctx('2026-09-23T09:40:17.000Z')).message).toBe(
      'Deployed to staging in 2m 14s. Try it: staging.burrowhq.example/invoices/2026-000142.pdf',
    );
  });

  it('DECLINED, and undo returns to pending', () => {
    const declined = ok(decline(deployApproval(), MARA, NOW));
    const v = approvalView(declined, ctx());
    expect(v.label).toBe('DECLINED');
    expect(v.tone).toBe('bad');
    expect(v.message).toMatch(/^Declined\. Dusty won’t deploy this commit\./);
    expect(v.message).not.toContain('been told');
    expect(v.mobileMessage).toMatch(/^Dusty won’t deploy this commit\./);
    expect(v.short).toBe('Declined by Mara.');
    expect(v.conditions[2]?.note).toBe('declined');
    expect(v.logPill).toEqual({ text: 'DECLINED BY MARA', tone: 'bad' });
    expect(v.planStep).toEqual({ state: 'blocked', label: 'Declined' });
    expect(v.inboxDone).toBe('Declined');
    expect(v.canUndo).toBe(true);
    const back = ok(undo(declined, MARA, NOW));
    expect(back.state).toBe('pending');
    expect(back.decidedById).toBeNull();
    expect(approvalView(back, ctx()).label).toBe('NEEDS A PERSON');
  });

  it('DEPLOY FAILED keeps Undo; a retry is undo + approve, never automatic', () => {
    const approved = evaluate(ok(approve(deployApproval(), MARA, NOW)), GREEN);
    const running = ok(startExecution(approved, NOW));
    const failed = ok(completeExecution(running, NOW, { ok: false, error: 'Pods did not become ready.' }));
    const v = approvalView(failed, ctx());
    expect(v.label).toBe('DEPLOY FAILED');
    expect(v.message).toBe('Deploy to staging failed. Pods did not become ready.');
    expect(v.canUndo).toBe(true);
    expect(readyToExecute(failed)).toBe(false);
    expect(startExecution(failed, NOW)).toMatchObject({ ok: false, error: 'not_ready' });
    const back = ok(undo(failed, MARA, NOW));
    expect(back.execution.state).toBe('idle');
    const again = evaluate(ok(approve(back, MARA, NOW)), GREEN);
    expect(startExecution(again, NOW).ok).toBe(true);
  });
});

describe('approval display: mobile', () => {
  const green = evaluate(deployApproval(), GREEN);

  it('pending: summary, mobile labels and context line', () => {
    const v = approvalView(green, ctx(at('11:40')));
    expect(v.mobileLabel).toBe('NEEDS A PERSON');
    expect(v.mobileCta).toBe('Approve');
    expect(v.mobileContext).toBe('Dusty · Chat · 11:25');
    expect(v.mobileMessage).toBe(green.summary);
    expect(v.mobileMessage).toMatch(/^Dusty builds 7be20f/);
    expect(v.conditions.map((c) => [c.mobileLabel, c.mobileNote])).toEqual([
      ['Checks pass on 7be20f', '41 of 41'],
      ['Mara approves the PR', 'approved 11:38'],
      ['A person says yes', 'Waiting for you'],
    ]);
  });

  it('approved: APPROVED · DEPLOYING with "you · just now"', () => {
    const approved = ok(approve(green, MARA, at('11:40')));
    const v = approvalView(approved, ctx(at('11:40')));
    expect(v.mobileLabel).toBe('APPROVED · DEPLOYING');
    expect(v.tone).toBe('ok');
    expect(v.mobileMessage).toMatch(/^Dusty is rolling billing-api to staging\./);
    expect(v.conditions[2]?.mobileNote).toBe('you · just now');
    expect(v.conditions[2]?.note).toBe('Mara · just now');
    expect(v.inboxDone).toBe('Approved · deploying');
  });

  it('writes the needs-you inbox text', () => {
    expect(approvalInboxText(green, { names })).toMatch(
      /^Deploy feat\/invoice-pdf to staging\. .*Mara approved/,
    );
    expect(approvalInboxText(deployApproval(), { names })).toMatch(/Goes out once .*Mara signs off/);
  });
});

describe('approval transitions', () => {
  it('lets the person decide, never the agent (CT-1517)', () => {
    expect(approve(deployApproval(), DUSTY, NOW)).toMatchObject({ ok: false, error: 'agents_cannot_decide' });
    expect(canDecide(deployApproval(), DUSTY)).toBe('agents_cannot_decide');
    expect(canDecide(deployApproval(), MARA)).toBeNull();
    expect(approve(deployApproval(), MARA, NOW).ok).toBe(true);
  });

  it('rejects deciding twice and undoing nothing', () => {
    const approved = ok(approve(deployApproval(), MARA, NOW));
    expect(approve(approved, MARA, NOW)).toMatchObject({ ok: false, error: 'not_pending' });
    expect(decline(approved, MARA, NOW)).toMatchObject({ ok: false, error: 'not_pending' });
    expect(undo(deployApproval(), MARA, NOW)).toMatchObject({ ok: false, error: 'not_decided' });
  });

  it('lets the person undo, never the agent', () => {
    const byMara = ok(approve(deployApproval(), MARA, NOW));
    expect(undo(byMara, MARA, NOW).ok).toBe(true);
    expect(undo(byMara, DUSTY, NOW)).toMatchObject({ ok: false, error: 'agents_cannot_decide' });
  });

  it('guards the executor', () => {
    expect(startExecution(deployApproval(), NOW)).toMatchObject({ ok: false, error: 'not_ready' });
    const approvedNotGreen = ok(approve(deployApproval(), MARA, NOW));
    expect(startExecution(approvedNotGreen, NOW)).toMatchObject({ ok: false, error: 'not_ready' });
    expect(completeExecution(approvedNotGreen, NOW, { ok: true })).toMatchObject({
      ok: false,
      error: 'not_running',
    });
    const running = ok(startExecution(evaluate(approvedNotGreen, GREEN), NOW));
    expect(startExecution(running, NOW)).toMatchObject({ ok: false, error: 'executing' });
  });

  it('shows older decisions with their time', () => {
    const decided = ok(approve(deployApproval(), MARA, '2026-09-22T15:20:00.000Z'));
    expect(approvalView(decided, ctx()).logDecided.text).toBe('Mara Okafor approved at 17:20');
    const older = ok(approve(deployApproval(), MARA, '2026-09-01T15:20:00.000Z'));
    expect(approvalView(older, ctx()).logDecided.text).toBe('Mara Okafor approved on 1 Sep at 17:20');
  });

  it('writes copy for other action types', () => {
    const refund = deployApproval({
      requesterId: 'prn_muffin',
      keyId: 'refunds.issue',
      action: { type: 'refund', params: { accountId: '3310', amountCents: 2400, currency: 'EUR' } },
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
    });
    const names2 = (id: string) =>
      id === 'prn_muffin' ? { name: 'Muffin', shortName: 'Muffin' } : names(id);
    const v = approvalView(refund, { names: names2, now: NOW, timeZone: TZ });
    expect(v.message).toBe('Muffin won’t refund without a person.');
    expect(v.cta).toBe('Approve and refund');
    expect(v.logDecided.text).toBe('Nobody yet. Muffin is waiting.');
    const declined = ok(decline(refund, MARA, NOW));
    expect(approvalView(declined, { names: names2, now: NOW, timeZone: TZ }).message).toBe(
      'Declined. Muffin won’t refund this payment.',
    );
  });
});

describe('approval copy comes from the action', () => {
  it('reproduces the mock’s copy for the staging deploy, so the mocked approval shows no note', () => {
    const a = deployApproval();
    expect(actionCopy(a.action)).toEqual({
      title: 'Deploy feat/invoice-pdf to staging',
      question: 'Deploy feat/invoice-pdf to staging?',
      target: 'staging · billing-api',
      runs: 'Build the latest commit on feat/invoice-pdf (PR #482), then roll billing-api to staging',
    });
    const v = approvalView(a, ctx());
    expect([v.title, v.question, v.target, v.actionNote]).toEqual([a.title, a.question, a.target, null]);
  });

  it('shows the real action when the stored wording says something else (staging copy, production action)', () => {
    const a: Approval = {
      ...deployApproval(),
      keyId: 'deploy.production',
      action: {
        type: 'deploy',
        params: {
          environment: 'production',
          service: 'billing-api',
          ref: 'main',
          sha: null,
          repo: 'whombat/billing',
          prNumber: 482,
        },
      },
    };
    const v = approvalView(a, ctx());
    expect(v.title).toBe('Deploy main to production');
    expect(v.question).toBe('Deploy main to production?');
    expect(v.target).toBe('production · billing-api');
    expect(v.actionNote).toBe(
      'What actually runs: Build the latest commit on main in whombat/billing (PR #482), then roll billing-api to production.',
    );
    expect(approvalInboxText(a, { names })).toMatch(/^Deploy main to production\./);
  });

  it('names the commit and repo an action carries', () => {
    expect(
      actionCopy({
        type: 'deploy',
        params: {
          environment: 'production',
          service: 'api',
          ref: 'v2.1.0',
          sha: '7be20f7c',
          repo: 'whombat/api',
        },
      }).runs,
    ).toBe('Build 7be20f from v2.1.0 in whombat/api, then roll api to production');
    expect(
      actionCopy({ type: 'merge_pr', params: { prNumber: 479, repo: 'whombat/billing', base: 'main' } }),
    ).toMatchObject({
      title: 'Merge PR #479 into main',
      target: 'whombat/billing · PR #479',
      runs: 'Merge PR #479 in whombat/billing into main',
    });
    // The method the agent asked for (CT-290); squash says nothing.
    expect(
      actionCopy({
        type: 'merge_pr',
        params: { prNumber: 1, repo: 'acme/patches', base: 'main', method: 'merge' },
      }).runs,
    ).toBe('Merge PR #1 in acme/patches into main with a merge commit');
    expect(
      actionCopy({ type: 'merge_pr', params: { prNumber: 1, base: 'main', method: 'rebase' } }).runs,
    ).toBe('Merge PR #1 into main, rebased');
    expect(
      actionCopy({ type: 'merge_pr', params: { prNumber: 1, base: 'main', method: 'squash' } }).runs,
    ).toBe('Merge PR #1 into main');
    expect(
      actionCopy({ type: 'refund', params: { accountId: '3310', amountCents: 2400, currency: 'EUR' } }),
    ).toMatchObject({ title: 'Refund €24,00 on account 3310', target: 'account 3310 · €24,00' });
  });
});

describe('approval content (IN-16)', () => {
  it('shows each approved attachment and the selected provider on every approval surface', () => {
    const mail = Approval.parse({
      ...deployApproval(),
      action: {
        type: 'mail_send',
        params: {
          provider: 'microsoft',
          connectionEmail: 'mara@example.com',
          to: ['a@example.com'],
          subject: 'Invoice',
          bodyPreview: 'See attached',
          draftId: 'draft',
          attachments: [
            { name: 'invoice.pdf', mimeType: 'application/pdf', size: 2048, sha256: 'a'.repeat(64) },
          ],
        },
      },
    });
    const view = approvalView(mail, ctx());
    expect(view.whatHappens.map((s) => s.text)).toContain('Attach “invoice.pdf” (2,048 bytes)');
    expect(actionCopy(mail.action).target).toBe('Outlook Mail · mara@example.com');
  });

  it('shows the whole body of an email, and nothing for other actions', () => {
    const body = `${'First paragraph. '.repeat(80)}\n\nThe tail after character 1000.`;
    const mail = Approval.parse({
      ...deployApproval(),
      action: {
        type: 'mail_send',
        params: {
          connectionEmail: 'mara@example.com',
          to: ['a@b.com'],
          subject: 'Invoice',
          bodyPreview: body.slice(0, 1000),
          body,
          draftId: 'd1',
        },
      },
    });
    expect(approvalView(mail, ctx()).content).toEqual({ label: 'MESSAGE', text: body });
    // Stored before the whole body was kept: the preview is what there is.
    const old = Approval.parse({
      ...mail,
      action: { ...mail.action, params: { ...(mail.action.params as object), body: undefined } },
    });
    expect(approvalView(old, ctx()).content?.text).toBe(body.slice(0, 1000));
    expect(approvalView(deployApproval(), ctx()).content).toBeNull();
  });
});

describe('“Always allow” on a risk-row card (RA-06)', () => {
  it('offers Approve and “Always allow Dusty to deploy” on a deploy card, to people who may change its keys', () => {
    const v = approvalView(deployApproval(), ctx());
    expect(v.scopeChoices).toEqual([
      { scope: 'once', label: 'Approve in advance' },
      { scope: 'agent', label: 'Always allow Dusty to deploy' },
    ]);
    expect(v.cta).toBe('Approve in advance');
    expect(v.toasts.always).toBe('Approved. From now on Dusty may deploy without asking.');
    const green = approvalView(evaluate(deployApproval(), GREEN), ctx());
    expect(green.scopeChoices?.[0]).toEqual({ scope: 'once', label: 'Approve and deploy' });
  });

  it('offers it on an agent’s gh write card under a risk row too, and says what it allows', () => {
    const gh = deployApproval({
      keyId: 'deploy',
      title: 'Edit release v1.0.10 in acme/os',
      action: {
        type: 'custom',
        params: { name: 'edit release v1.0.10 in acme/os', keyId: 'deploy', data: { ghHash: 'ab' } },
      },
    });
    const v = approvalView(gh, ctx());
    expect(v.scopeChoices?.[1]).toEqual({ scope: 'agent', label: 'Always allow Dusty to deploy' });
    expect(v.toasts.always).toBe('Approved. From now on Dusty may deploy without asking.');
  });

  it('says the yes lasts once the person chose it', () => {
    const approved = ok(approve(evaluate(deployApproval(), GREEN), MARA, NOW));
    const running = ok(startExecution({ ...approved, scope: 'agent' }, NOW));
    expect(approvalView(running, ctx()).message).toMatch(/ From now on Dusty may deploy without asking\.$/);
    expect(approvalView(ok(startExecution(approved, NOW)), ctx()).message).not.toMatch(/From now on/);
  });

  it('names the row of each typed action, and none for anything else', () => {
    const row = (action: unknown) => alwaysAllowRow(ApprovalAction.parse(action));
    expect(row({ type: 'merge_pr', params: { prNumber: 1, base: 'main' } })).toBe('merge');
    expect(row({ type: 'merge_pr', params: { prNumber: 1, base: 'release' } })).toBe('merge');
    expect(row({ type: 'push_shared_branch', params: { repo: 'o/r', branch: 'main', sha: 'abcdef' } })).toBe(
      'branch.main.push',
    );
    expect(
      row({ type: 'push_shared_branch', params: { repo: 'o/r', branch: 'release/1', sha: 'abcdef' } }),
    ).toBeNull();
    expect(row({ type: 'message_external', params: { to: 'a@b.com', body: 'Hi' } })).toBe(
      'messages.external',
    );
    expect(row({ type: 'refund', params: { accountId: 'acc_x', amountCents: 500, currency: 'EUR' } })).toBe(
      'refunds.issue',
    );
    expect(row({ type: 'custom', params: { name: 'Pay', keyId: 'billing.write', data: {} } })).toBeNull();
    // An agent's gh write that waits for a yes: the row of its key, when it has one.
    const gh = (keyId: string) => ({
      type: 'custom',
      params: { name: 'edit release v1', keyId, data: { ghHash: 'ab' } },
    });
    expect(row(gh('deploy'))).toBe('deploy');
    expect(row(gh('commands.destructive'))).toBe('commands.destructive');
    expect(row(gh('pr.comment'))).toBeNull();
    expect(row({ type: 'grant_key', params: { keyId: 'deploy' } })).toBeNull();
    expect(
      row({
        type: 'run_command',
        params: { command: 'fly deploy', category: 'deploy', target: null, reason: null },
      }),
    ).toBeNull();
  });
});

describe('lastingWordsAt', () => {
  it('names where the lasting yes changes back, keeping the rest of the words', () => {
    const words = lastingWordsAt(stopAskingConfirm('Neo', 'pve-02'), 'on pve-02’s page in Overview');
    expect(words.body).toContain('tells you after');
    expect(words.body).toContain('on pve-02’s page in Overview');
    expect(words.body).not.toContain('Settings');
    expect([words.confirm, words.keep]).toEqual(['Let Neo do it', 'Keep asking']);
  });
});
