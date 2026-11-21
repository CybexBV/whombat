/** Contracts 0.91.0, the Home redesign (CT-400…CT-409; Whombat home-redesign.md HR-01…HR-24). */
import { describe, expect, it } from 'vitest';
import {
  CHANGE_MCP_TOOLS,
  ConnectionCallInput,
  DispatchContext,
  GRANTED_RESULT_TEXT_MAX,
  GrantedResultContext,
  MCP_POSTING_TOOLS,
  MCP_TOOLS,
  ReportChangeInput,
  ReportChangeOutput,
  UndoChangeResponse,
  UndoRequestContext,
} from '../contracts/index.js';
import {
  CATALOG,
  type CatalogEntry,
  callAccess,
  catalogEntry,
  defaultConnectionLabel,
  graphqlReadsOnly,
  isReadRequest,
  isSensitiveCall,
  REQUEST_TOOL_NAME,
  requestAllowed,
} from './connections-catalog.js';
import { DispatchTrigger, SummaryTrigger, summaryTrigger } from './dispatch.js';
import { HOME_CHATS_MAX, HomeChat, HomeOverview, ThingSummary } from './home.js';
import { DispatchSummary } from './work.js';

const entry = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(`no entry ${id}`);
  return e;
};
const request = (id: string, method: string, path: string, body?: unknown) =>
  callAccess(entry(id), REQUEST_TOOL_NAME, { method, path, ...(body === undefined ? {} : { body }) });

const T = '2026-10-18T14:15:00.000Z';

describe('reads through a POST stay reads (CT-400, HR-01)', () => {
  it('reads Home Assistant’s templates, its configuration check and its get_ services', () => {
    const ha = entry('homeassistant');
    expect(isReadRequest(ha, 'POST', '/api/template')).toBe(true);
    expect(isReadRequest(ha, 'POST', '/api/config/core/check_config')).toBe(true);
    expect(isReadRequest(ha, 'POST', '/api/services/calendar/get_events')).toBe(true);
    expect(request('homeassistant', 'POST', '/api/template', { template: '{{ 1 }}' })).toBe('read');
    expect(request('homeassistant', 'POST', '/api/config/core/check_config')).toBe('read');
    expect(request('homeassistant', 'POST', '/api/services/weather/get_forecasts')).toBe('read');
  });

  it('keeps Home Assistant’s service calls writes', () => {
    expect(request('homeassistant', 'POST', '/api/services/light/turn_on')).toBe('write');
    expect(request('homeassistant', 'POST', '/api/services/homeassistant/restart')).toBe('write');
    expect(request('homeassistant', 'POST', '/api/template/x')).toBe('write');
    expect(request('homeassistant', 'POST', '/api/services/recorder/purge_entities')).toBe('write');
    expect(request('homeassistant', 'DELETE', '/api/template')).toBe('write');
  });

  it('still asks for a lock even through a get_ path', () => {
    const args = { method: 'POST', path: '/api/services/lock/get_state' };
    expect(isSensitiveCall(entry('homeassistant'), REQUEST_TOOL_NAME, args, { access: 'read' })).toBe(true);
  });

  it('compiles every read path and names a method other than GET', () => {
    for (const e of CATALOG)
      for (const r of e.request?.readPaths ?? []) {
        expect(() => new RegExp(r.path, 'i'), `${e.id} ${r.path}`).not.toThrow();
        expect(r.method, e.id).not.toBe('GET');
      }
  });
});

describe('GraphQL read paths (CT-405)', () => {
  it('tells a query from a mutation or a subscription', () => {
    expect(graphqlReadsOnly({ query: '{ docker { containers { id } } }' })).toBe(true);
    expect(graphqlReadsOnly({ query: 'query Q($n: Int) { a(n: $n) }', variables: { n: 1 } })).toBe(true);
    expect(graphqlReadsOnly('{"query":"{ me { name } }"}')).toBe(true);
    expect(graphqlReadsOnly('{ me { name } }')).toBe(true);
    expect(graphqlReadsOnly([{ query: '{ a }' }, { query: '{ b }' }])).toBe(true);
    expect(graphqlReadsOnly({ query: 'mutation { docker { restart(id: "c1") { state } } }' })).toBe(false);
    expect(graphqlReadsOnly({ query: 'subscription { logs }' })).toBe(false);
    expect(graphqlReadsOnly('{"query":"\\u006dutation { vm { stop(id: \\"v\\") } }"}')).toBe(false);
    expect(graphqlReadsOnly([{ query: '{ a }' }, { query: 'mutation { b }' }])).toBe(false);
  });

  it('takes nothing without the query’s text for a read', () => {
    expect(graphqlReadsOnly(undefined)).toBe(false);
    expect(graphqlReadsOnly({})).toBe(false);
    expect(graphqlReadsOnly({ extensions: { persistedQuery: { sha256Hash: 'abc' } } })).toBe(false);
    expect(graphqlReadsOnly({ query: '  ' })).toBe(false);
    expect(graphqlReadsOnly([])).toBe(false);
  });

  it('reads Unraid and GitLab queries, and their mutations are writes', () => {
    expect(request('unraid', 'POST', '/graphql', { query: '{ array { state } }' })).toBe('read');
    expect(request('unraid', 'POST', '/graphql', { query: 'mutation { vm { start(id: "v1") } }' })).toBe(
      'write',
    );
    expect(request('unraid', 'POST', '/graphql')).toBe('write');
    expect(request('gitlab', 'POST', '/api/graphql', { query: '{ currentUser { username } }' })).toBe('read');
    expect(
      request('gitlab', 'POST', '/api/graphql', { query: 'mutation { createIssue { issue { id } } }' }),
    ).toBe('write');
    expect(
      requestAllowed(entry('gitlab'), { url: 'https://gitlab.example.com' }, 'POST', '/api/graphql'),
    ).toBe(true);
  });

  it('leaves Cloudflare’s read-only GraphQL a read by its path', () => {
    expect(request('cloudflare', 'POST', '/client/v4/graphql')).toBe('read');
  });
});

describe('what a change does, in the agent’s words (CT-401, HR-02)', () => {
  const base = { connection: 'homeassistant', tool: 'request' };

  it('takes one trimmed line, or nothing', () => {
    expect(ConnectionCallInput.parse({ ...base, change: '  Turned off the porch light ' }).change).toBe(
      'Turned off the porch light',
    );
    expect(ConnectionCallInput.parse(base).change).toBeUndefined();
    expect(ConnectionCallInput.safeParse({ ...base, change: '  ' }).success).toBe(false);
    expect(ConnectionCallInput.safeParse({ ...base, change: 'x'.repeat(161) }).success).toBe(false);
  });

  it('is in connection_call’s description and schema', () => {
    expect(MCP_TOOLS.connection_call.description).toContain('change');
    expect(Object.keys(MCP_TOOLS.connection_call.input.shape)).toContain('change');
  });
});

describe('report_change (CT-402, HR-03)', () => {
  const tool = MCP_TOOLS.report_change;

  it('is every agent’s, needs no key and posts nothing', () => {
    expect(CHANGE_MCP_TOOLS.report_change).toBe(tool);
    expect(tool.requiredKey).toBeNull();
    expect(tool.personal).toBeUndefined();
    expect(tool.readOnly).toBe(false);
    expect(MCP_POSTING_TOOLS.has('report_change')).toBe(false);
  });

  it('says when to call it', () => {
    for (const fact of ['connection_call', 'over SSH', 'never for reads', 'undo', 'undoes'])
      expect(tool.description).toContain(fact);
  });

  it('takes a title and optional detail, thing, private undo and the change it reverses', () => {
    const full = ReportChangeInput.parse({
      title: ' Removed 14 old Zonneplan entities ',
      detail: 'Home Assistant restarted.',
      thing: 'server:pve-02',
      undo: 'Backup in /root/ha-backup-1405.tar',
      undoes: 'chg_abc',
    });
    expect(full.title).toBe('Removed 14 old Zonneplan entities');
    expect(ReportChangeInput.safeParse({ title: 'x', thing: 'homeassistant' }).success).toBe(true);
    expect(ReportChangeInput.safeParse({ title: '' }).success).toBe(false);
    expect(ReportChangeInput.safeParse({ title: 'x'.repeat(161) }).success).toBe(false);
    expect(ReportChangeInput.safeParse({ title: 'x', detail: 'x'.repeat(301) }).success).toBe(false);
    expect(ReportChangeInput.safeParse({ title: 'x', thing: 'x'.repeat(221) }).success).toBe(false);
    expect(ReportChangeInput.safeParse({ title: 'x', undo: 'x'.repeat(1001) }).success).toBe(false);
    expect(ReportChangeInput.safeParse({ title: 'x', undoes: 'con_abc' }).success).toBe(false);
  });

  it('answers the change’s id, or a refusal', () => {
    expect(ReportChangeOutput.parse({ status: 'ok', changeId: 'chg_1' })).toEqual({
      status: 'ok',
      changeId: 'chg_1',
    });
    expect(
      ReportChangeOutput.safeParse({ status: 'refused', code: 'already_undone', reason: 'r' }).success,
    ).toBe(true);
    expect(ReportChangeOutput.safeParse({ status: 'refused', code: 'nope', reason: 'r' }).success).toBe(
      false,
    );
  });
});

describe('Undo asks the agent (CT-406, HR-03)', () => {
  const change = {
    id: 'chg_1',
    title: 'Removed 14 old Zonneplan entities',
    at: T,
    actor: { kind: 'whombat', id: 'prn_dusty', name: 'Dusty' },
    undo: { state: 'available', until: T },
  };

  it('wakes the agent with undo_requested, which clients read as mention', () => {
    expect(DispatchTrigger.options).toContain('undo_requested');
    expect(SummaryTrigger.options).not.toContain('undo_requested');
    expect(summaryTrigger('undo_requested')).toBe('mention');
    expect(summaryTrigger('mention')).toBe('mention');
    const summary = {
      id: 'dsp_1',
      agentId: 'prn_dusty',
      conversationId: 'cnv_1',
      threadRootId: null,
      state: 'queued',
      runId: null,
      createdAt: T,
      claimedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      reason: null,
    };
    expect(DispatchSummary.safeParse({ ...summary, trigger: summaryTrigger('undo_requested') }).success).toBe(
      true,
    );
    expect(DispatchSummary.safeParse({ ...summary, trigger: 'undo_requested' }).success).toBe(false);
  });

  it('gives the agent the change and its private note', () => {
    expect(
      UndoRequestContext.parse({ changeId: 'chg_1', title: change.title, undo: 'restore the backup' }),
    ).toEqual({ changeId: 'chg_1', title: change.title, undo: 'restore the backup' });
    expect(UndoRequestContext.safeParse({ changeId: 'chg_1', title: '', undo: '' }).success).toBe(false);
    expect(DispatchContext.shape.undoRequest.safeParse(undefined).success).toBe(true);
  });

  it('answers requested with the chat', () => {
    const r = UndoChangeResponse.parse({ change, state: 'requested', conversationId: 'cnv_1' });
    expect(r.state).toBe('requested');
    expect(r.conversationId).toBe('cnv_1');
  });
});

describe('an approved call answers in words (CT-407, HR-04)', () => {
  it('carries what the call returned', () => {
    expect(GrantedResultContext.parse({ outcome: 'done', text: 'HTTP 200', truncated: false }).outcome).toBe(
      'done',
    );
    expect(
      GrantedResultContext.safeParse({ outcome: 'ok', text: '', truncated: false }).success,
      'unknown outcome',
    ).toBe(false);
    expect(
      GrantedResultContext.safeParse({
        outcome: 'error',
        text: 'x'.repeat(GRANTED_RESULT_TEXT_MAX + 1),
        truncated: true,
      }).success,
    ).toBe(false);
    expect(DispatchContext.shape.grantedResult.safeParse(null).success).toBe(true);
  });
});

describe('names without addresses (CT-408, HR-07)', () => {
  it('names the only connection of a service after the service', () => {
    const ha = entry('homeassistant');
    const fields = { url: 'http://10.100.0.5:8123' };
    expect(defaultConnectionLabel(ha, fields, { onlyOne: true })).toBe('Home Assistant');
    expect(defaultConnectionLabel(ha, fields)).toBe('Home Assistant · 10.100.0.5:8123');
  });
});

describe('Home’s chats and things (CT-403, CT-404, HR-21, HR-23)', () => {
  const chat = { conversationId: 'cnv_1', title: 'Heat pump temperatures', state: 'working', at: T };
  const overview = {
    summary: { needsYou: 0, working: 1, problems: 0 },
    needsYou: [],
    things: [],
    automationsToday: [],
    widgets: [],
    doneRecently: [],
    generatedAt: '2026-10-24T09:00:00.000Z',
  };

  it('reads a chat with its progress and step, or the default chat', () => {
    expect(
      HomeChat.parse({ ...chat, progress: { done: 2, total: 4 }, step: 'Reading the sensors' }).step,
    ).toBe('Reading the sensors');
    expect(HomeChat.parse({ ...chat, state: 'recent', default: true }).default).toBe(true);
    expect(HomeChat.safeParse({ ...chat, state: 'done' }).success).toBe(false);
    expect(HomeChat.safeParse({ ...chat, title: '' }).success).toBe(false);
    expect(HomeChat.safeParse({ ...chat, step: 'x'.repeat(161) }).success).toBe(false);
  });

  it('needs the chats and caps them', () => {
    expect(HomeOverview.safeParse(overview).success).toBe(false);
    expect(HomeOverview.parse({ ...overview, chats: [chat] }).chats).toHaveLength(1);
    const many = Array.from({ length: HOME_CHATS_MAX + 1 }, () => chat);
    expect(HomeOverview.safeParse({ ...overview, chats: many }).success).toBe(false);
  });

  it('says when a connection was last used', () => {
    const thing = {
      id: 'connection:con_1',
      kind: 'connection',
      name: 'Home Assistant',
      icon: 'homeassistant',
      status: 'ok',
      facts: [],
      href: '/things/connection%3Acon_1',
    };
    expect(ThingSummary.parse(thing).usedAt).toBeUndefined();
    expect(ThingSummary.parse({ ...thing, usedAt: T }).usedAt).toBe(T);
  });
});
