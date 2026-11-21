/**
 * Tolerant decoding within one session major (CT-136, CT-1262): an answer of a newer minor carrying union members and
 * enum values this version doesn't know decodes with the carrying item left out.
 */
import { bootstrap, msg_pr482_dusty_1122, PR482_MESSAGES } from '@whombat/fixtures';
import {
  API_OPERATIONS,
  decodeApplianceMessage,
  decodeTolerant,
  isTolerableIssue,
  parseRealtimeEvent,
  TOLERANT_MAX_REPAIRS,
  utf8Encode,
} from '@whombat/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const output = (op: string) => {
  const spec = API_OPERATIONS.get(op);
  if (!spec) throw new Error(`no ${op}`);
  return spec.output;
};

const T = '2026-09-28T09:00:00.000Z';
const workItem = (id: string, kind: string, actions: string[] = ['open']) => ({
  id,
  kind,
  section: 'running',
  title: 'Build the export endpoint',
  where: 'Chat',
  agentId: null,
  ownerId: null,
  status: { text: 'RUNNING', tone: 'neutral' },
  detail: null,
  since: T,
  health: null,
  activity: null,
  link: { type: 'work' },
  actions,
  refs: { conversationId: null },
});

describe('a newer minor’s answer through these schemas', () => {
  it('drops a card of a new kind to null, keeping the message', () => {
    const page = {
      messages: [
        ...PR482_MESSAGES.slice(0, 1),
        {
          ...msg_pr482_dusty_1122,
          card: { kind: 'poll', question: 'Ship Friday?', options: ['yes', 'no'] },
        },
        ...PR482_MESSAGES.slice(2),
      ],
      before: null,
      hasMore: false,
    };
    const schema = output('messages.list');
    expect(schema.safeParse(page).success).toBe(false);
    const r = decodeTolerant(schema, page);
    if (!r.ok) throw r.error;
    expect(r.skipped).toEqual([{ path: ['messages', 1, 'card'], value: 'poll', action: 'nulled' }]);
    const messages = (r.data as { messages: { id: string; card: unknown }[] }).messages;
    expect(messages).toHaveLength(page.messages.length);
    expect(messages[1]).toMatchObject({ id: msg_pr482_dusty_1122.id, card: null });
  });

  it('drops a work item of a new kind and a new action, keeping the rest', () => {
    const overview = {
      sections: [
        {
          section: 'running',
          title: 'RUNNING',
          items: [
            workItem('run:1', 'run'),
            workItem('review:2', 'review_request'),
            workItem('run:3', 'run', ['open', 'escalate']),
            workItem('audit:4', 'audit'),
          ],
        },
      ],
      counts: { needs_you: 0, running: 4, queued: 0, blocked: 0, failed: 0, done: 0 },
      generatedAt: T,
    };
    const schema = output('work.overview');
    expect(schema.safeParse(overview).success).toBe(false);
    const r = decodeTolerant(schema, overview);
    if (!r.ok) throw r.error;
    const items = (r.data as { sections: { items: { id: string; actions: string[] }[] }[] }).sections[0]
      ?.items;
    expect(items?.map((i) => i.id)).toEqual(['run:1', 'run:3']);
    expect(items?.[1]?.actions).toEqual(['open']);
    // Reported where they were in the answer as received.
    expect(r.skipped).toEqual([
      { path: ['sections', 0, 'items', 3], value: 'audit', action: 'dropped' },
      { path: ['sections', 0, 'items', 2, 'actions', 1], value: 'escalate', action: 'dropped' },
      { path: ['sections', 0, 'items', 1], value: 'review_request', action: 'dropped' },
    ]);
  });

  it('drops a principal of a new kind from the bootstrap', () => {
    const boot = bootstrap();
    const answer = {
      ...boot,
      principals: [...boot.principals, { ...boot.principals[0], id: 'prn_robot', kind: 'robot' }],
    };
    const at = boot.principals.length;
    const r = decodeTolerant(output('conversations.bootstrap'), answer);
    if (!r.ok) throw r.error;
    expect((r.data as { principals: unknown[] }).principals).toHaveLength(at);
    expect(r.skipped).toEqual([{ path: ['principals', at], value: 'robot', action: 'dropped' }]);
  });

  it('skips an event of a new type, and repairs a known event carrying a new card kind', () => {
    const event = (e: { type: string; [k: string]: unknown }) => ({
      t: 'event' as const,
      ephemeral: false as const,
      sub: 's1',
      cursor: 'c1',
      topic: 'conv:cnv_pr482',
      event: e,
    });
    expect(parseRealtimeEvent(event({ type: 'poll.closed', pollId: 'p1' }))).toBeNull();
    const created = parseRealtimeEvent(
      event({ type: 'message.created', message: { ...msg_pr482_dusty_1122, card: { kind: 'poll' } } }),
    );
    expect(created).toMatchObject({ type: 'message.created', message: { card: null } });
    // A list of events drops the unknown one.
    const r = decodeTolerant(z.array(z.any().pipe(z.object({ type: z.enum(['a', 'b']) }))), [
      { type: 'a' },
      { type: 'c' },
    ]);
    expect(r.ok && r.data).toEqual([{ type: 'a' }]);
  });

  it('leaves unknown top-level messages to the codec and keeps other failures', () => {
    const unknown = decodeApplianceMessage(utf8Encode(JSON.stringify({ t: 'maintenance', at: T })));
    expect(unknown).toEqual({ ok: false, kind: 'unknown_type', t: 'maintenance' });
    // Not a tolerable issue: a wrong type fails as a plain parse does.
    const schema = z.object({ items: z.array(z.object({ kind: z.enum(['a']), n: z.number() })) });
    const bad = {
      items: [
        { kind: 'x', n: 1 },
        { kind: 'a', n: 'two' },
      ],
    };
    const r = decodeTolerant(schema, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues).toEqual(schema.safeParse(bad).error?.issues);
    // The top of the value can't be left out.
    expect(decodeTolerant(z.enum(['a']), 'b').ok).toBe(false);
    expect(decodeTolerant(z.object({ kind: z.enum(['a']) }), { kind: 'b' }).ok).toBe(false);
  });

  it('unsets optional members and nulls nullable ones, walking up to the nearest', () => {
    const E = z.enum(['a', 'b']);
    const schema = z.object({
      opt: E.optional(),
      nul: E.nullable(),
      nested: z.object({ must: E }).optional(),
      union: z.union([z.object({ t: z.literal('x') }), z.object({ t: z.literal('y') })]).optional(),
      list: z.array(E),
    });
    const r = decodeTolerant(schema, {
      opt: 'c',
      nul: 'd',
      nested: { must: 'e' },
      union: { t: 'z' },
      list: ['a', 'f', 'b'],
    });
    if (!r.ok) throw r.error;
    expect(r.data).toEqual({ nul: null, list: ['a', 'b'] });
    expect(r.skipped.map((s) => [s.path.join('.'), s.value, s.action]).sort()).toEqual(
      [
        ['list.1', 'f', 'dropped'],
        ['nested', 'e', 'unset'],
        ['nul', 'd', 'nulled'],
        ['opt', 'c', 'unset'],
        ['union', 'z', 'unset'],
      ].sort(),
    );
  });

  it('leaves out a whole optional member when a list inside it can’t be repaired alone', () => {
    const schema = z.object({
      box: z.object({ list: z.array(z.enum(['a'])), kind: z.enum(['k']) }).optional(),
      keep: z.literal(1),
    });
    const r = decodeTolerant(schema, { box: { list: ['a', 'x'], kind: 'new' }, keep: 1 });
    expect(r.ok && r.data).toEqual({ keep: 1 });
  });

  it('is bounded', () => {
    const many = Array.from({ length: TOLERANT_MAX_REPAIRS + 1 }, () => 'x');
    expect(decodeTolerant(z.array(z.enum(['a'])), many).ok).toBe(false);
    expect(decodeTolerant(z.array(z.enum(['a'])), many.slice(1)).ok).toBe(true);
    expect(decodeTolerant(z.array(z.enum(['a'])), ['a', 'x', 'x'], { maxRepairs: 1 }).ok).toBe(false);
  });

  it('names what it repairs', () => {
    const schema = z.object({ k: z.enum(['a']), n: z.number() });
    const input = { k: 'b', n: 'x' };
    const issues = schema.safeParse(input).error?.issues ?? [];
    expect(issues.map((i) => isTolerableIssue(i, input))).toEqual([true, false]);
  });
});

describe('one Whombat (0.80, CT-336…CT-343) for a client a minor behind', () => {
  it('carries a device_skill card, which an older client nulls like any card kind it doesn’t know', () => {
    const card = {
      kind: 'device_skill',
      proposalId: 'dvp_heatpump1',
      name: 'Heat pump',
      model: 'Ecoforest ecoGEO',
      readings: [{ key: 'flow_temp', label: 'Flow temperature', value: '38.5', unit: '°C' }],
      moreReadings: 14,
      actions: [
        {
          key: 'set_flow_temp',
          label: 'Set the flow temperature',
          description: 'Sets the flow temperature the heat pump aims for.',
          proposed: { tier: 'ask', limits: { min: 16, max: 24 } },
        },
      ],
      testedAt: T,
      status: 'proposed',
    };
    const page = {
      messages: [{ ...msg_pr482_dusty_1122, card }],
      before: null,
      hasMore: false,
    };
    expect(output('messages.list').safeParse(page).success).toBe(true);
  });

  it('drops a Needs you item of a kind this version doesn’t know, keeping Home', () => {
    const item = (id: string, kind: string) => ({
      id,
      ref: { kind: 'approval', id },
      kind,
      severity: 'warn',
      title: 'Restart pve-02 to finish its updates',
      body: 'Its updates are installed; they take effect after a restart.',
      at: T,
      actions: [{ id: 'later', label: 'Tonight at 03:00', style: 'primary', kind: 'approve_later', at: T }],
    });
    const home = {
      summary: { needsYou: 2, working: 0, problems: 0 },
      needsYou: [item('1', 'approval'), item('2', 'teleport')],
      chats: [],
      things: [],
      automationsToday: [],
      widgets: [],
      doneRecently: [],
      generatedAt: T,
    };
    const schema = output('home.overview');
    expect(schema.safeParse(home).success).toBe(false);
    const r = decodeTolerant(schema, home);
    if (!r.ok) throw r.error;
    expect((r.data as { needsYou: unknown[] }).needsYou).toHaveLength(1);
  });

  it('subscribes to the hosts topic and reads its events', () => {
    expect(
      parseRealtimeEvent({
        t: 'event',
        ephemeral: false,
        sub: 's1',
        cursor: 'c1',
        topic: 'hosts:bur_hq',
        event: { type: 'hosts.guest', serverId: 'pve-02', guestId: 'pve:101', state: 'running' },
      }),
    ).not.toBeNull();
  });
});

describe('more connections (0.97, CT-484)', () => {
  const view = (id: string, transport: string) => ({
    id,
    catalogId: 'truenas',
    label: 'TrueNAS',
    handle: 'truenas',
    connectedBy: { id: null, name: 'Mara' },
    detail: 'nas.lan',
    signIn: 'token',
    transport,
    fields: { url: 'https://nas.lan' },
    status: 'active',
    reauthReason: null,
    checks: [],
    checkedAt: null,
    toolCount: 1,
    createdAt: T,
    lastUsedAt: null,
  });
  const account = (id: string, provider: string) => ({
    id,
    provider,
    email: 'mara@example.org',
    name: 'Mara',
    services: ['mail'],
    status: 'active',
    reauthReason: null,
    checks: [],
    createdAt: T,
    updatedAt: T,
    lastUsedAt: null,
  });

  it('reads socket connections and IMAP accounts', () => {
    const list = {
      connections: [view('con_a', 'socket')],
      count: 1,
    };
    expect(output('connections.list').safeParse(list).success).toBe(true);
    const status = {
      mode: 'real',
      google: {
        app: {
          provider: 'google',
          configured: false,
          source: null,
          clientIdHint: null,
          secretSet: false,
          userType: null,
          updatedAt: null,
        },
        setup: {
          redirectUri: 'https://w.example/api/v1/connectors/google/callback',
          enableApisUrl: 'https://console.cloud.google.com/flows/enableapi',
          links: {
            createProject: 'https://console.cloud.google.com/projectcreate',
            consentScreen: 'https://console.cloud.google.com/auth/branding',
            audience: 'https://console.cloud.google.com/auth/audience',
            createClient: 'https://console.cloud.google.com/auth/clients/create',
          },
          scopes: [],
          appName: 'Whombat',
          supportEmail: null,
          authorizedDomain: 'w.example',
        },
        tested: false,
      },
      imap: { available: true },
      connections: [
        {
          ...account('con_m', 'imap'),
          mail: { imapHost: 'imap.example.org', smtpHost: 'smtp.example.org', username: 'mara@example.org' },
        },
      ],
    };
    expect(output('connectors.status').safeParse(status).success).toBe(true);
    // As an older app meets them: a transport or provider it doesn't know leaves that one row out.
    const newer = { ...list, connections: [view('con_a', 'carrier_pigeon'), view('con_b', 'rest')] };
    const r = decodeTolerant(output('connections.list'), newer);
    if (!r.ok) throw r.error;
    expect((r.data as { connections: { id: string }[] }).connections.map((c) => c.id)).toEqual(['con_b']);
    const later = {
      ...status,
      connections: [account('con_x', 'carrier_pigeon'), account('con_g', 'google')],
    };
    const s = decodeTolerant(output('connectors.status'), later);
    if (!s.ok) throw s.error;
    expect((s.data as { connections: { id: string }[] }).connections.map((c) => c.id)).toEqual(['con_g']);
  });

  it('keeps the IMAP password out of receipts', () => {
    expect(API_OPERATIONS.get('connectors.imapConnect')?.secret).toBe(true);
    expect(API_OPERATIONS.get('connectors.imapDiscover')?.retry).toBe('receipt');
  });
});
