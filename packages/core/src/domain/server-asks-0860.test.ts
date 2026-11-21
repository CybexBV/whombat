import { describe, expect, it } from 'vitest';
import { deployApproval, mara, NOW, names, TZ } from '../__fixtures__/world.js';
import { actionCopy, approvalAnswer, approvalView } from '../approvals/index.js';
import { Approval, type ConnectionCallAction } from './approval.js';
import { catalogEntry, SERVERS_TOOLS } from './connections-catalog.js';
import {
  HOST_ASKS_FIRST_DEFAULT,
  HOST_ASKS_FIRST_WORDS,
  HostServerSettings,
  HostServerSettingsPatch,
  serverAsksApply,
} from './hosts.js';

const BANJO = 'prn_banjo';
const PERSON = { id: mara.id, kind: 'person' as const };

function serversCall(server?: { id: string; name: string }, over: Partial<Approval> = {}): Approval {
  const action: ConnectionCallAction = {
    type: 'connection_call',
    params: {
      connectionId: 'con_servers0000001',
      handle: 'servers',
      tool: 'server_command',
      toolHash: 'a'.repeat(64),
      words: 'run “systemctl reset-failed” on the-titan',
      ...(server ? { server } : {}),
    },
  };
  const copy = actionCopy(action, names, BANJO);
  return Approval.parse(
    deployApproval({
      requesterId: BANJO,
      keyId: 'connections.write',
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
      ...over,
    }),
  );
}

const BEAST = { id: 'the-titan', name: 'The Titan' };

describe('Asks you first (CT-380, SA-01…SA-03)', () => {
  it('defaults to never, and keeps every rule on risky', () => {
    expect(HOST_ASKS_FIRST_DEFAULT).toBe('never');
    expect(serverAsksApply('server_command', {})).toBe(false);
    expect(serverAsksApply('server_power', { hostsThisWhombat: true })).toBe(true);
    expect(serverAsksApply('server_command', { asksFirst: 'risky' })).toBe(true);
  });

  it('skips the rules on never, but for powering the server this Whombat runs on', () => {
    expect(serverAsksApply('server_command', { asksFirst: 'never' })).toBe(false);
    expect(serverAsksApply('guest_delete', { asksFirst: 'never', hostsThisWhombat: true })).toBe(false);
    expect(serverAsksApply('server_command', { asksFirst: 'never', hostsThisWhombat: true })).toBe(false);
    expect(serverAsksApply('server_power', { asksFirst: 'never' })).toBe(false);
    expect(serverAsksApply('server_power', { asksFirst: 'never', hostsThisWhombat: true })).toBe(true);
  });

  it('is on the settings and their patch', () => {
    const settings = {
      id: 'the-titan',
      group: 'lab',
      location: null,
      remoteControl: { console: true, power: true },
      agentPolicy: { console: true, power: true },
    };
    expect(HostServerSettings.parse(settings).asksFirst).toBeUndefined();
    expect(HostServerSettings.parse({ ...settings, asksFirst: 'never' }).asksFirst).toBe('never');
    expect(HostServerSettingsPatch.parse({ asksFirst: 'never' })).toEqual({ asksFirst: 'never' });
    expect(HostServerSettingsPatch.safeParse({ asksFirst: 'sometimes' }).success).toBe(false);
  });

  it('says it plainly', () => {
    // The three words of everything the assistant may do (settings-groups.md).
    expect(HOST_ASKS_FIRST_WORDS.choices).toEqual({ risky: 'Ask me first', never: 'Go ahead' });
    expect(HOST_ASKS_FIRST_WORDS.confirmTitle('The Titan')).toContain('The Titan');
    // 0.98 (CT-504) names updating too.
    const self = HOST_ASKS_FIRST_WORDS.selfNote('The Titan');
    for (const fact of ['The Titan', 'restarting', 'shutting down', 'updating', 'this Whombat'])
      expect(self).toContain(fact);
  });

  it('tells the assistant the sensitive tools ask unless the server is set not to', () => {
    const command = SERVERS_TOOLS.find((t) => t.name === 'server_command');
    expect(command?.sensitive).toBe(true);
    expect(command?.description).toContain('unless the server is set not to ask');
    for (const t of SERVERS_TOOLS) expect(t.description, t.name).not.toMatch(/always asks a person/i);
    const guide = catalogEntry('whombat_servers')?.guide ?? '';
    expect(guide).toContain('Asks you first');
    expect(guide).toContain('never suggest a way around a question');
  });
});

describe('Don’t ask again on a server (CT-381, SA-07)', () => {
  const ctx = { names, now: NOW, timeZone: TZ };

  it('offers the person Approve and Don’t ask again', () => {
    const view = approvalView(serversCall(BEAST), { ...ctx, viewer: PERSON });
    expect(view.scopeChoices?.map((c) => c.scope)).toEqual(['once', 'agent']);
    expect(view.scopeChoices?.[1]?.label).toBe('Don’t ask again on The Titan');
    expect(view.toasts.always).toBe('Approved. Whombat won’t ask again on The Titan.');
  });

  it('offers nothing more without a server, or to no viewer', () => {
    expect(approvalView(serversCall(BEAST), ctx).scopeChoices).toBeNull();
    expect(approvalView(serversCall(), { ...ctx, viewer: PERSON }).scopeChoices).toBeNull();
    expect(approvalView(serversCall(), { ...ctx, viewer: PERSON }).toasts.always).toBeUndefined();
  });
});

describe('an everyday ask in plain words (handle-it.md)', () => {
  const ctx = { names, now: NOW, timeZone: TZ, viewer: PERSON };

  it('asks “{assistant} needs your OK” with Yes, now · Yes, tonight · No (Yes, do it without a later time)', () => {
    const ask = approvalView(serversCall(BEAST), ctx).ask;
    expect(ask?.needs).toMatch(/ needs your OK$/);
    expect([ask?.now, ask?.later, ask?.no, ask?.yes, ask?.details]).toEqual([
      'Yes, now',
      'Yes, tonight',
      'No',
      'Yes, do it',
      'Technical details',
    ]);
    // The shared label stays for the lists and the log.
    expect(approvalView(serversCall(BEAST), ctx).label).toBe('NEEDS A PERSON');
  });

  it('keeps the mocks’ words for code, and says nothing once decided', () => {
    expect(approvalView(deployApproval(), ctx).ask).toBeNull();
    expect(approvalView(serversCall(BEAST, { state: 'declined', decidedById: mara.id }), ctx).ask).toBeNull();
  });
});

describe('the lasting yes behind a confirmation, and the answered state', () => {
  const ctx = { names, now: NOW, timeZone: TZ, viewer: PERSON };

  it('puts “Don’t ask again” apart, with a confirmation that names the agent and the server', () => {
    const lasting = approvalView(serversCall(BEAST), ctx).lasting;
    expect(lasting?.link).toContain('The Titan');
    expect(lasting?.title).toContain('The Titan');
    expect(lasting?.confirm).toMatch(/^Let \S+ do it$/);
    expect(lasting?.keep).toBe('Keep asking');
    expect(approvalView(serversCall(), ctx).lasting).toBeNull();
    expect(
      approvalView(serversCall(BEAST, { state: 'declined', decidedById: mara.id }), ctx).lasting,
    ).toBeNull();
  });

  it('says where an answered ask is, from what the approval carries', () => {
    const decided = { state: 'approved' as const, decidedById: mara.id, decidedAt: NOW };
    expect(approvalAnswer(serversCall(BEAST), ctx)).toBeNull();
    const tonight = new Date(Date.parse(NOW) + 3_600_000 * 30).toISOString();
    const later = approvalAnswer(serversCall(BEAST, { ...decided, executeAt: tonight }), ctx);
    expect(later?.state).toBe('scheduled');
    expect(later?.text).toMatch(/^Scheduled for .+, \d\d:\d\d$/);
    const night = approvalAnswer(
      serversCall(BEAST, { ...decided, executeAt: '2026-09-24T01:00:00.000Z' }),
      ctx,
    );
    expect(night?.text).toBe('Scheduled for tonight, 03:00');
    const running = serversCall(BEAST, decided);
    running.execution = { ...running.execution, state: 'running' };
    expect(approvalAnswer(running, ctx)?.state).toBe('running');
    const done = serversCall(BEAST, { ...decided, executedAt: NOW });
    done.execution = { ...done.execution, state: 'succeeded' };
    expect(approvalAnswer(done, ctx)).toMatchObject({ state: 'done', tone: 'ok' });
    const no = approvalAnswer(serversCall(BEAST, { ...decided, state: 'declined' }), ctx);
    expect(no).toMatchObject({ state: 'declined', tone: 'mut' });
    expect(no?.text).toMatch(/^You said no/);
  });
});
