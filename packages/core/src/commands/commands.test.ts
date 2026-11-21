/** The agent's commands (Whombat agent-computer.md, one-person.md OP-07): the `run_command` approval, copy and contracts. */
import { describe, expect, it } from 'vitest';
import { deployApproval, dusty, mara, NOW, names, TZ } from '../__fixtures__/world.js';
import {
  actionCopy,
  approvalCopy,
  approvalInboxText,
  approvalView,
  approve,
  undoBlock,
} from '../approvals/index.js';
import { api, runnerApi } from '../contracts/index.js';
import {
  AuthorizeCommandBody,
  AuthorizeCommandReply,
  AuthorizeWaitQuery,
  AuthorizeWaitReply,
  CommandKeyPath,
  DispatchCommandsContext,
  RunnerNotifyBody,
  TurnKeys,
} from '../contracts/runner.js';
import { DecideApprovalBody } from '../contracts/work.js';
import { AgentApprovalAction, Approval, ApprovalAction, isAgentApprovalAction } from '../domain/approval.js';
import { EVENT_TYPES } from '../domain/audit.js';
import {
  actionKey,
  actionScope,
  describeAction,
  describeActionForLog,
  describeAsk,
} from '../keys/actions.js';
import { KEY_CATALOG } from '../keys/catalog.js';
import {
  COMMAND_ALLOWANCES_COPY,
  COMMAND_CATEGORY_LABELS,
  COMMAND_EXIT_CODES,
  CommandAllowance,
  commandAllowanceLine,
  commandAllowedText,
  commandBlockedText,
  commandDeclinedText,
  commandScopeLabels,
  commandTimedOutText,
  commandWaitingText,
  commandWhy,
  commandWhyNeededText,
} from './index.js';

const DUSTY = dusty.id;
const MARA = { id: mara.id, kind: 'person' as const };
const T = '2026-10-02T09:00:00.000Z';

const action = ApprovalAction.parse({
  type: 'run_command',
  params: {
    command: 'ssh web-1 "cd /srv/app && ./deploy.sh"',
    category: 'deploy_production',
    target: 'web-1',
    reason: 'Deploy the new pricing page',
  },
});

function runCommand(over: Partial<Approval> = {}): Approval {
  const copy = actionCopy(action, names, DUSTY);
  return Approval.parse(
    deployApproval({
      requesterId: DUSTY,
      keyId: 'deploy.production',
      action,
      title: copy.title,
      question: copy.question,
      target: copy.target,
      whatHappens: [copy.runs],
      conditions: [
        {
          id: 'person',
          kind: 'person_approves',
          label: 'You say yes',
          met: false,
          approverIds: [mara.id],
        },
      ],
      involvedIds: [],
      ...over,
    }),
  );
}

describe('run_command action (AC-41)', () => {
  it('is the server’s, never an agent’s', () => {
    expect(isAgentApprovalAction(action)).toBe(false);
    expect(AgentApprovalAction.safeParse(action).success).toBe(false);
    expect(
      ApprovalAction.safeParse({
        type: 'run_command',
        params: { command: '', category: 'deploy', target: null, reason: null },
      }).success,
    ).toBe(false);
    expect(
      ApprovalAction.safeParse({
        type: 'run_command',
        params: { command: 'x'.repeat(8001), category: 'deploy', target: null, reason: null },
      }).success,
    ).toBe(false);
    expect(
      ApprovalAction.safeParse({
        type: 'run_command',
        params: { command: 'ls', category: 'rm', target: null, reason: null },
      }).success,
    ).toBe(false);
  });

  it('needs its category’s key and never logs the command', () => {
    expect(actionKey(action)).toBe('deploy.production');
    expect(actionScope(action)).toEqual({});
    const push = ApprovalAction.parse({
      type: 'run_command',
      params: { command: 'git push origin main', category: 'push_main', target: 'main', reason: null },
    });
    expect(actionKey(push)).toBe('branch.main.push');
    expect(actionScope(push)).toEqual({ branch: 'main' });
    expect(describeAction(action)).toBe('run a command on the production server web-1');
    expect(describeActionForLog(action)).toBe('run a command on the production server web-1');
    expect(describeAsk(push)).toBe('Asked to run a command that pushes to main');
    const phrase = (category: string, target: string | null) =>
      describeAction(
        ApprovalAction.parse({
          type: 'run_command',
          params: { command: 'x', category, target, reason: null },
        }),
      );
    expect(phrase('deploy', null)).toBe('run a deploy command');
    expect(phrase('merge', 'o/r')).toBe('run a command that merges a pull request in o/r');
    expect(phrase('destructive', 'staging')).toBe('run a destructive command on staging');
    expect(phrase('destructive', null)).toBe('run a destructive command on another machine');
    expect(phrase('message_external', 'hooks.slack.com')).toBe(
      'run a command that sends a message to hooks.slack.com',
    );
    expect(phrase('message_external', null)).toBe('run a command that sends a message outside your Whombat');
    expect(phrase('deploy_production', null)).toBe('run a command that reaches production');
  });

  it('is copied from the action', () => {
    const copy = actionCopy(action, names, DUSTY);
    expect(copy.title).toBe('Run a command on the production server web-1');
    expect(copy.question).toBe('Run a command on the production server web-1?');
    expect(copy.target).toBe('web-1 · Deploy to production');
    expect(copy.runs).toContain('ssh web-1');
    expect(copy.runs).not.toContain('computer');
    expect(approvalCopy({ ...runCommand(), requesterId: DUSTY }, names).matchesStored).toBe(true);
  });

  it('shows the command and the four buttons while pending (AC-42)', () => {
    const view = approvalView(runCommand(), { names, viewer: MARA, now: NOW, timeZone: TZ });
    expect(view.phase).toBe('needs_person');
    expect(view.kicker).toBe('DUSTY IS ASKING');
    expect(view.content).toEqual({ label: 'COMMAND', text: 'ssh web-1 "cd /srv/app && ./deploy.sh"' });
    expect(view.scopeChoices).toEqual([
      { scope: 'once', label: 'Allow once' },
      { scope: 'task', label: 'Allow for this task' },
      { scope: 'agent', label: 'Always allow for Dusty' },
    ]);
    expect(view.cta).toBe('Allow once');
    expect(view.mobileCta).toBe('Allow once');
    expect(view.declineCta).toBe('Don’t allow');
    expect(view.message).toBe('Dusty won’t run the command without a person.');
    expect(view.canApprove).toBe(true);
  });

  it('says why the agent runs it, under the title; a web or browser call’s reason is no why', () => {
    const ctx = { names, viewer: MARA, now: NOW, timeZone: TZ };
    expect(approvalView(runCommand(), ctx).why).toBe('Deploy the new pricing page');
    const lower = (reason: string | null, category = 'deploy_production') =>
      approvalView(
        runCommand({
          action: ApprovalAction.parse({
            type: 'run_command',
            params: { ...action.params, category, reason },
          }),
        }),
        ctx,
      ).why;
    expect(lower('stop the soak test first')).toBe('Stop the soak test first');
    expect(lower(null)).toBeNull();
    expect(lower('  ')).toBeNull();
    expect(lower('https://docs.example.com/a', 'web')).toBeNull();
    // The phone's notification and the needs-you list say it too.
    expect(approvalInboxText(runCommand(), { names })).toBe(
      'Run a command on the production server web-1. Deploy the new pricing page.',
    );
  });

  it('says how long a yes lasts, and has no Undo', () => {
    const decided = (scope: Approval['scope']) => {
      const r = approve(runCommand(), MARA, T);
      if (!r.ok) throw new Error(r.error);
      return { ...r.approval, scope };
    };
    const ctx = { names, viewer: MARA, now: NOW, timeZone: TZ };
    expect(approvalView(decided('once'), ctx).message).toBe(
      'Allowed once. Dusty runs the command in its turn.',
    );
    expect(approvalView(decided('task'), ctx).toasts.approve).toBe(
      'Allowed for this task. Dusty runs the command now.',
    );
    expect(approvalView(decided('agent'), ctx).message).toBe(
      'Always allowed for Dusty. Dusty runs the command in its turn.',
    );
    expect(approvalView(decided('once'), ctx).canUndo).toBe(false);
    expect(undoBlock(decided('once'))).toBe('already_executed');
    // A deploy card offers Approve and “Always allow” since 0.44 (RA-06), never a command's three.
    const other = approvalView(Approval.parse(deployApproval()), ctx);
    expect(other.scopeChoices?.map((c) => c.scope)).toEqual(['once', 'agent']);
    expect(other.declineCta).toBe('Decline');
    // Other approvals have no scope choices.
    const other2 = approvalView(
      Approval.parse(
        deployApproval({
          keyId: 'pr.open',
          action: { type: 'custom', params: { name: 'Open a pull request', keyId: 'pr.open', data: {} } },
        }),
      ),
      ctx,
    );
    expect(other2.scopeChoices).toBeNull();
    // Older approvals carry no scope.
    expect(Approval.parse(deployApproval()).scope).toBeUndefined();
  });

  it('takes a scope on approvals.decide (absent: once)', () => {
    expect(DecideApprovalBody.parse({ decision: 'approve' })).toEqual({ decision: 'approve' });
    expect(DecideApprovalBody.parse({ decision: 'approve', scope: 'agent' }).scope).toBe('agent');
    expect(DecideApprovalBody.safeParse({ decision: 'approve', scope: 'forever' }).success).toBe(false);
    expect(api.approvals.decide.body).toBe(DecideApprovalBody);
  });
});

describe('command copy and allowances (AC-41, AC-42)', () => {
  it('tells the agent what happened', () => {
    const blocked = commandBlockedText('deploy_production', 'Dusty');
    expect(blocked).toContain('“Deploy to production”');
    expect(blocked).toContain('Dusty doesn’t hold');
    expect(blocked).toContain('request_approval (grant_key)');
    expect(commandWaitingText('push_main')).toContain('“Push to main”');
    expect(commandDeclinedText('Mara')).toBe('Mara said no; the command didn’t run.');
    expect(commandTimedOutText(15)).toMatch(/^Nobody answered in 15 minutes; the command didn’t run\./);
    expect(commandTimedOutText(1)).toMatch(/^Nobody answered in 1 minute;/);
    expect(commandAllowedText('task', 'Mara')).toBe('Allowed for this task by Mara.');
    expect(COMMAND_EXIT_CODES).toEqual({ refused: 126, timedOut: 125 });
    expect(commandScopeLabels('Dusty').agent).toBe('Always allow for Dusty');
    expect(COMMAND_CATEGORY_LABELS.destructive).toBe('Destructive command on another machine');
    expect(KEY_CATALOG['commands.destructive'].label).toBe('Destructive commands on other machines');
  });

  it('lists and removes allowances under the agent', () => {
    const allowance = CommandAllowance.parse({
      id: 'cma_1',
      agentId: DUSTY,
      keyId: 'deploy.production',
      command: 'ssh web-1 ./deploy.sh',
      target: 'web-1',
      createdById: mara.id,
      createdAt: T,
    });
    expect(commandAllowanceLine(allowance)).toBe('web-1 · Deploy to production');
    expect(commandAllowanceLine({ keyId: 'deploy', target: null })).toBe('Deploy');
    expect(CommandAllowance.safeParse({ ...allowance, id: 'apr_1' }).success).toBe(false);
    expect(api.agent.commandAllowances).toMatchObject({
      method: 'GET',
      path: '/burrows/:burrow/agent/command-allowances',
    });
    expect(api.agent.removeCommandAllowance).toMatchObject({
      method: 'DELETE',
      path: '/burrows/:burrow/agent/command-allowances/:allowanceId',
    });
    expect(COMMAND_ALLOWANCES_COPY.remove).toBe('Remove');
    expect(EVENT_TYPES['command.allowance_removed']).toBe('Keys');
  });
});

describe('the runner’s command API (AC-30, AC-31, AC-40…AC-42; 3.0 CT-1531, CT-1532, CT-1538)', () => {
  const lease = { dispatchId: 'dsp_1', attempt: 1, runnerId: 'rnr_1' };

  it('authorizes commands and waits for a person', () => {
    expect(runnerApi.authorizeCommand).toMatchObject({
      method: 'POST',
      path: '/commands/authorize',
      auth: 'runner',
    });
    expect(runnerApi.authorizeWait).toMatchObject({ method: 'GET', path: '/commands/authorize/:approvalId' });
    expect(
      AuthorizeCommandBody.parse({ ...lease, command: 'fly deploy', category: 'deploy', target: null }),
    ).toMatchObject({ category: 'deploy' });
    expect(
      AuthorizeCommandBody.safeParse({ ...lease, command: 'fly deploy', category: 'x', target: null })
        .success,
    ).toBe(false);
    expect(
      AuthorizeCommandReply.parse({
        outcome: 'run',
        approvalId: null,
        message: '',
        open: [{ host: '203.0.113.10', port: 22 }],
      }).open,
    ).toHaveLength(1);
    expect(
      AuthorizeWaitReply.parse({ outcome: 'declined', scope: null, message: 'no', open: [] }).outcome,
    ).toBe('declined');
    expect(AuthorizeWaitQuery.parse({ dispatchId: 'dsp_1', attempt: '2', runnerId: 'rnr_1' })).toEqual({
      dispatchId: 'dsp_1',
      attempt: 2,
      runnerId: 'rnr_1',
      waitMs: 25_000,
    });
  });

  it('hands over the turn’s keys with safe paths, and takes a background job’s notice', () => {
    expect(runnerApi.turnKeys).toMatchObject({ method: 'GET', path: '/dispatches/:dispatchId/turn-keys' });
    expect(runnerApi).not.toHaveProperty('computerKeys');
    expect(runnerApi).not.toHaveProperty('computerReport');
    for (const ok of ['id_web', 'ssh/config', 'ssh/known_hosts', 'a/b/c/d', '.hidden'])
      expect(CommandKeyPath.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['/etc/passwd', '../x', 'a/../b', '.', '..', 'a//b', 'a/b/c/d/e', 'a b', ''])
      expect(CommandKeyPath.safeParse(bad).success, bad).toBe(false);
    const keys = TurnKeys.parse({
      files: [{ path: 'ssh/id_web', mode: '600', base64: 'AAAA' }],
      env: [{ name: 'CLOUDFLARE_API_TOKEN', value: 'secret' }],
      entries: [{ entryId: 'vlt_cf', name: 'Cloudflare' }],
    });
    expect(keys.files[0]?.mode).toBe('600');
    expect(TurnKeys.safeParse({ ...keys, env: [{ name: 'lower', value: 'x' }] }).success).toBe(false);
    expect(
      DispatchCommandsContext.parse({
        productionServers: [
          { entryId: 'vlt_ssh', name: 'web-1', host: 'web1.example.com', port: 22, addresses: [] },
        ],
        homeNetworks: ['192.168.1.0/24'],
        lan: false,
      }).productionServers[0]?.name,
    ).toBe('web-1');
    expect(runnerApi.notify).toMatchObject({ method: 'POST', path: '/notify', auth: 'runner' });
    const notice = {
      fromDispatchId: 'dsp_1',
      attempt: 1,
      runnerId: 'rnr_1',
      eventId: 'job-1-done',
      text: 'Done.',
    };
    expect(RunnerNotifyBody.parse(notice).eventId).toBe('job-1-done');
    expect(RunnerNotifyBody.safeParse({ ...notice, text: '' }).success).toBe(false);
    expect(RunnerNotifyBody.safeParse({ ...notice, eventId: 'x' }).success).toBe(false);
    expect(EVENT_TYPES).not.toHaveProperty('vault.swept');
    expect(EVENT_TYPES).not.toHaveProperty('agent.computer');
  });
});

describe('a command’s why', () => {
  it('is the comment lines it starts with, and the rest is what runs', () => {
    expect(commandWhy('# why: stop the soak test first\nsudo systemctl stop soak')).toEqual({
      why: 'stop the soak test first',
      command: 'sudo systemctl stop soak',
    });
    expect(commandWhy('  # Why:  read the\n#   error counters\n\nethtool -S eth0\n# not this one')).toEqual({
      why: 'read the error counters',
      command: 'ethtool -S eth0\n# not this one',
    });
  });

  it('is null without a leading comment; a #! line is none', () => {
    expect(commandWhy('fly deploy # why: late')).toEqual({ why: null, command: 'fly deploy # why: late' });
    expect(commandWhy('#!/bin/sh\nfly deploy')).toEqual({ why: null, command: '#!/bin/sh\nfly deploy' });
    expect(commandWhy('# why:\nfly deploy')).toEqual({ why: null, command: 'fly deploy' });
  });

  it('is asked for by name of the key, with the line to add', () => {
    const text = commandWhyNeededText('destructive');
    expect(text).toContain(KEY_CATALOG['commands.destructive'].label);
    expect(text).toContain('# why:');
  });
});
