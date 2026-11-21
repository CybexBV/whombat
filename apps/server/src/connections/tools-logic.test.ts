/**
 * The tools side's pure logic (docs/decisions/connections-catalog.md CX-18, CX-20, CX-31, CX-33): merging a refreshed
 * tool list, MCP hints, the `request` tool's arguments and answers, and the tier of a call (Look only too:
 * connections-setup.md CS-10).
 */
import { CATALOG, CONNECTION_TOOLS_MAX, catalogEntry, FILES_TOOLS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { callTier } from './call';
import { canonicalPath, dockerStreamText, normaliseRequestArgs, renderBody, requestToolDef } from './request';
import {
  mcpDefinition,
  mergeTools,
  ownDefinitions,
  type ToolDefinition,
  toolHash,
  toolRowAlwaysAsks,
} from './sync';
import { afterYesOf, missingArgsText, pendingApprovalText, textRepeatsStructured, toolViewAt } from './tools';
import type { ConnectionToolRow } from './types';

const entry = (id: string) => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

const def = (name: string, access: 'read' | 'write' = 'read', description = name): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object' },
  access,
  origin: 'mcp',
});

describe('what an agent hears while a yes is pending (task-feedback.md TF-05, TF-12, TF-S10)', () => {
  it('promises a card and a wake at a task’s end, a wake with the result, or Whombat’s own words', () => {
    const task = pendingApprovalText(null, 'task');
    expect(task).toContain('when it ends');
    expect(task).toContain('card');
    expect(task).toContain('woken');
    expect(pendingApprovalText(null, 'wake')).toContain('woken with its result');
    const said = pendingApprovalText(null, 'said');
    expect(said).not.toContain('woken');
    expect(said).toContain('Whombat says');
    // The person by name.
    expect(pendingApprovalText('Mara', 'task')).toMatch(/^Mara has /);
    expect(pendingApprovalText('Mara', 'wake')).toContain('woken');
  });

  it('knows which from the connection’s words', () => {
    const words = {
      startsTask: (tool: string) => tool === 'server_update',
      saysItself: (tool: string) => tool === 'server_power',
    };
    expect(afterYesOf(words, 'server_update', {})).toBe('task');
    expect(afterYesOf(words, 'server_power', {})).toBe('said');
    expect(afterYesOf(words, 'guest_power', {})).toBe('wake');
    expect(afterYesOf(null, 'anything', {})).toBe('wake');
  });
});

describe('merging a refreshed tool list (CX-18)', () => {
  it('gives new tools their default tier, marks them New only after the first sync, and removes vanished ones', () => {
    const first = mergeTools([], [def('Get'), def('Set', 'write')], { firstSync: true });
    expect(first.upsert.map((t) => [t.name, t.tier, t.isNew])).toEqual([
      ['Get', 'can', false],
      // Every tool starts Allowed (CX-20a).
      ['Set', 'can', false],
    ]);
    const stored = first.upsert.map((t) => ({ ...t }));
    const later = mergeTools(stored, [def('Get'), def('Other', 'write')], { firstSync: false });
    expect(later.upsert.map((t) => [t.name, t.tier, t.isNew, t.changed])).toEqual([
      ['Get', 'can', false, false],
      ['Other', 'can', true, true],
    ]);
    expect(later.remove).toEqual(['Set']);
  });

  it('marks none of an MCP server’s first listing New, even after the first sync (CX-18a)', () => {
    const request: ToolDefinition = { ...def('request', 'write'), origin: 'request' };
    const before = mergeTools([], [request], { firstSync: true }).upsert.map((t) => ({ ...t }));
    const turnedOn = mergeTools(before, [def('GetLiveContext'), def('HassTurnOn', 'write'), request], {
      firstSync: false,
      firstMcp: true,
    });
    expect(turnedOn.upsert.map((t) => [t.name, t.tier, t.isNew])).toEqual([
      ['GetLiveContext', 'can', false],
      ['HassTurnOn', 'can', false],
      ['request', 'can', false],
    ]);
  });

  it('keeps a person’s tier across a changed definition unless read became write', () => {
    const stored = [
      { name: 'A', hash: toolHash(def('A')), tier: 'off' as const, access: 'read' as const, isNew: false },
      { name: 'B', hash: toolHash(def('B')), tier: 'can' as const, access: 'read' as const, isNew: false },
      {
        name: 'C',
        hash: toolHash(def('C', 'write')),
        tier: 'can' as const,
        access: 'write' as const,
        isNew: false,
      },
    ];
    const next = mergeTools(
      stored,
      [def('A', 'write', 'new words'), def('B', 'write', 'x'), def('C', 'write', 'y')],
      {
        firstSync: false,
      },
    );
    expect(next.upsert.map((t) => [t.name, t.tier, t.isNew])).toEqual([
      ['A', 'off', true],
      ['B', 'ask', true],
      ['C', 'can', true],
    ]);
  });

  it('keeps at most 128 tools', () => {
    const many = Array.from({ length: CONNECTION_TOOLS_MAX + 5 }, (_, i) => def(`T${i}`));
    const merged = mergeTools([], many, { firstSync: true });
    expect(merged.upsert).toHaveLength(CONNECTION_TOOLS_MAX);
    expect(merged.truncated).toBe(true);
  });

  it('hashes canonically: key order doesn’t matter, a changed schema does', () => {
    const a = { ...def('X'), inputSchema: { type: 'object', properties: { a: { type: 'string' } } } };
    const b = { ...def('X'), inputSchema: { properties: { a: { type: 'string' } }, type: 'object' } };
    expect(toolHash(a)).toBe(toolHash(b));
    expect(toolHash(a)).not.toBe(toolHash({ ...a, inputSchema: { type: 'object' } }));
    expect(toolHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('MCP tool hints', () => {
  it('reads readOnlyHint as read, anything else as write; destructiveHint alone doesn’t ask (CX-31a)', () => {
    expect(mcpDefinition({ name: 'GetLiveContext', annotations: { readOnlyHint: true } })?.access).toBe(
      'read',
    );
    expect(mcpDefinition({ name: 'HassTurnOn' })?.access).toBe('write');
    const erase = mcpDefinition({ name: 'Erase', annotations: { destructiveHint: true } });
    expect(erase?.origin).toBe('mcp-destructive');
    expect(toolRowAlwaysAsks(entry('custom_mcp'), { name: 'SetLight' })).toBe(false);
    // Named for deleting: it asks, hint or not.
    expect(toolRowAlwaysAsks(entry('custom_mcp'), { name: 'Erase' })).toBe(true);
    expect(
      mcpDefinition({ name: 'Read', annotations: { readOnlyHint: true, destructiveHint: true } })?.origin,
    ).toBe('mcp');
    expect(mcpDefinition({ name: 'bad name with spaces' })).toBeNull();
  });

  it('never serves what the entry hides, and takes the reads it names (t3code.md T3-04)', () => {
    const t3 = entry('t3code');
    for (const name of ['preview_open', 'delegate_task', 't3_attachment_prepare_upload', 'create_threads'])
      expect(mcpDefinition({ name }, t3), name).toBeNull();
    // Other entries serve a tool of that name.
    expect(mcpDefinition({ name: 'preview_open' }, entry('custom_mcp'))).not.toBeNull();
    const read = mcpDefinition({ name: 't3_thread_read', annotations: { readOnlyHint: false } }, t3);
    expect(read).toMatchObject({ access: 'read', origin: 'mcp' });
    // Read by its arguments only: stored as the change it can be.
    const pending = mcpDefinition({ name: 't3_pending_request', annotations: { destructiveHint: true } }, t3);
    expect(pending).toMatchObject({ access: 'write', origin: 'mcp-destructive' });
  });
});

describe('own tools of an entry (CX-33, CX-34)', () => {
  it('gives Nextcloud files_* and request, Home Assistant only request next to its server, Notion OAuth none', () => {
    const nc = ownDefinitions(entry('nextcloud'), {
      baseUrl: 'https://cloud.example.com',
      fields: { url: 'https://cloud.example.com', username: 'mara' },
      signIn: 'token',
    });
    expect(nc.map((d) => d.name)).toEqual([...FILES_TOOLS.map((t) => t.name), 'request']);
    const ha = ownDefinitions(entry('homeassistant'), {
      baseUrl: 'http://ha.local:8123',
      fields: { url: 'http://ha.local:8123' },
      signIn: 'token',
    });
    expect(ha.map((d) => d.name)).toEqual(['request']);
    expect(
      ownDefinitions(entry('notion'), { baseUrl: 'https://api.notion.com', fields: {}, signIn: 'mcp_oauth' }),
    ).toEqual([]);
    expect(
      ownDefinitions(entry('notion'), { baseUrl: 'https://api.notion.com', fields: {}, signIn: 'token' }).map(
        (d) => d.name,
      ),
    ).toEqual(['request']);
  });

  it('describes request with the base, the prefixes and the reads, and offers other bases', () => {
    const dropbox = requestToolDef(entry('dropbox'), { baseUrl: 'https://api.dropboxapi.com', fields: {} });
    expect(dropbox.description).toContain('https://api.dropboxapi.com');
    expect(dropbox.description).toContain('/2/');
    expect((dropbox.inputSchema.properties as Record<string, unknown>).base).toEqual(
      expect.objectContaining({ enum: ['content'] }),
    );
    const mb = requestToolDef(entry('moneybird'), {
      baseUrl: 'https://moneybird.com/api/v2',
      fields: { administration: '123' },
    });
    expect(mb.description).toContain('/123/');
    for (const e of CATALOG.filter((x) => x.request))
      expect(
        requestToolDef(e, { baseUrl: 'https://x.example', fields: {} }).description.length,
      ).toBeLessThanOrEqual(1000);
  });
});

describe('request arguments (CX-33)', () => {
  it('upper-cases the method and makes the path canonical', () => {
    expect(normaliseRequestArgs({ method: 'post', path: '/api/services/%6Cock/unlock' })).toEqual({
      method: 'POST',
      path: '/api/services/lock/unlock',
    });
    expect(canonicalPath('/a%2fb')).toBe('/a%2Fb');
    expect(canonicalPath('/caf%c3%a9')).toBe('/caf%C3%A9');
  });

  it('refuses paths that escape or hide', () => {
    for (const path of ['/api/../secret', '//evil.example/x', '/a%2e%2e/b', '/api/states?x=1', 'api/states'])
      expect(() => normaliseRequestArgs({ method: 'GET', path })).toThrow();
    expect(() => normaliseRequestArgs({ method: 'G E T', path: '/api/' })).toThrow();
  });

  it('answers text up to 64 KiB and binary as a note', () => {
    const big = Buffer.from('a'.repeat(70 * 1024));
    const text = renderBody({ headers: { 'content-type': 'text/plain' }, body: big });
    expect(text.truncated).toBe(true);
    expect(text.text).toContain('[answer cut at 65536 bytes]');
    const pdf = renderBody({ headers: { 'content-type': 'application/pdf' }, body: Buffer.alloc(2048, 1) });
    expect(pdf).toEqual({ text: '[binary application/pdf, 2 048 bytes; not shown]', truncated: false });
  });

  it('reads Docker’s log streams as text, stderr marked (Portainer, CT-313)', () => {
    const frame = (stream: number, text: string) => {
      const payload = Buffer.from(text);
      const head = Buffer.alloc(8);
      head[0] = stream;
      head.writeUInt32BE(payload.length, 4);
      return Buffer.concat([head, payload]);
    };
    const body = Buffer.concat([
      frame(1, 'listening on :80\n'),
      frame(2, 'warn: slow disk\n'),
      frame(1, 'ok\n'),
    ]);
    const logs = renderBody({
      headers: { 'content-type': 'application/vnd.docker.multiplexed-stream' },
      body,
    });
    expect(logs.text).toBe('listening on :80\nstderr: warn: slow disk\nok\n');
    // An engine before API 1.42 sends the same frames as raw-stream; a TTY container's output is plain.
    expect(renderBody({ headers: { 'content-type': 'application/vnd.docker.raw-stream' }, body }).text).toBe(
      logs.text,
    );
    const tty = Buffer.from('\u001b[32mready\u001b[0m\n');
    expect(
      renderBody({ headers: { 'content-type': 'application/vnd.docker.raw-stream' }, body: tty }).text,
    ).toBe(tty.toString());
    expect(dockerStreamText('application/octet-stream', body)).toBeNull();
    expect(
      renderBody({
        headers: { 'content-type': 'application/vnd.docker.multiplexed-stream' },
        body: Buffer.from('x'),
      }).text,
    ).toMatch(/^\[binary/);
  });
});

describe('the tier of a call (CX-20, CX-31)', () => {
  const ha = entry('homeassistant');
  const tool = (name: string, tier: 'can' | 'ask' | 'off', access: 'read' | 'write', origin = 'mcp') => ({
    name,
    tier,
    access,
    origin,
  });

  it('is the stricter of the key and the tool', () => {
    expect(callTier(ha, tool('GetLiveContext', 'can', 'read'), {}, 'can').tier).toBe('can');
    expect(callTier(ha, tool('HassTurnOn', 'can', 'write'), { name: 'kitchen' }, 'ask').tier).toBe('ask');
    expect(callTier(ha, tool('HassTurnOn', 'ask', 'write'), { name: 'kitchen' }, 'can').tier).toBe('ask');
    expect(callTier(ha, tool('HassTurnOn', 'can', 'write'), {}, 'cannot').tier).toBe('off');
    expect(callTier(ha, tool('HassTurnOn', 'off', 'write'), {}, 'can').tier).toBe('off');
  });

  it('asks for a sensitive call whatever both say, unless either is Off', () => {
    const lock = callTier(ha, tool('HassTurnOn', 'can', 'write'), { name: 'lock.front_door' }, 'can');
    expect(lock).toMatchObject({ sensitive: true, tier: 'ask' });
    expect(callTier(ha, tool('HassTurnOn', 'off', 'write'), { name: 'lock.front_door' }, 'can').tier).toBe(
      'off',
    );
  });

  it('decides a request by method and path: reads allowed unless Off, writes under the tool’s tier and the write key', () => {
    const req = tool('request', 'ask', 'write', 'request');
    const keys = (id: string) => (id === 'connections.read' ? 'can' : 'ask');
    expect(callTier(ha, req, { method: 'GET', path: '/api/states' }, keys)).toMatchObject({
      access: 'read',
      keyId: 'connections.read',
      tier: 'can',
    });
    expect(callTier(ha, req, { method: 'POST', path: '/api/services/light/turn_on' }, keys)).toMatchObject({
      access: 'write',
      keyId: 'connections.write',
      tier: 'ask',
    });
    expect(
      callTier(
        ha,
        { ...req, tier: 'can' },
        { method: 'POST', path: '/api/services/lock/unlock' },
        () => 'can',
      ),
    ).toMatchObject({ sensitive: true, tier: 'ask' });
    expect(callTier(ha, { ...req, tier: 'off' }, { method: 'GET', path: '/api/states' }, keys).tier).toBe(
      'off',
    );
    expect(callTier(ha, req, { method: 'DELETE', path: '/api/states/x' }, () => 'can').sensitive).toBe(true);
  });

  it('makes every write Off on a connection that looks only, and leaves reads at their tier (CS-10)', () => {
    const req = tool('request', 'can', 'write', 'request');
    const read = callTier(ha, req, { method: 'GET', path: '/api/states' }, 'can', 'read');
    expect(read).toMatchObject({ access: 'read', tier: 'can', lookOnly: false });
    const write = callTier(ha, req, { method: 'POST', path: '/api/services/light/turn_on' }, 'can', 'read');
    expect(write).toMatchObject({ access: 'write', tier: 'off', lookOnly: true });
    expect(callTier(ha, tool('HassTurnOn', 'can', 'write'), {}, 'can', 'read')).toMatchObject({
      tier: 'off',
      lookOnly: true,
    });
    expect(callTier(ha, tool('GetLiveContext', 'ask', 'read'), {}, 'can', 'read').tier).toBe('ask');
    expect(callTier(ha, tool('HassTurnOn', 'can', 'write'), {}, 'can', 'manage').lookOnly).toBe(false);
  });

  it('runs T3 Code’s reads by their arguments on Look only and while the tool asks; its answers stay changes', () => {
    const t3 = entry('t3code');
    const pending = tool('t3_pending_request', 'ask', 'write', 'mcp-destructive');
    const list = { action: 'list', threadId: 'thread-1' };
    const respond = { action: 'respond', threadId: 'thread-1', requestId: 'r', answers: { q: 'Yes' } };
    expect(callTier(t3, pending, list, 'can', 'read')).toMatchObject({
      access: 'read',
      tier: 'can',
      lookOnly: false,
    });
    expect(callTier(t3, pending, respond, 'can', 'read')).toMatchObject({
      access: 'write',
      tier: 'off',
      lookOnly: true,
    });
    expect(callTier(t3, pending, respond, 'can', 'manage')).toMatchObject({ access: 'write', tier: 'ask' });
    expect(callTier(t3, { ...pending, tier: 'off' }, list, 'can', 'manage').tier).toBe('off');
    // The key for a read is the read key.
    expect(callTier(t3, pending, list, (k) => (k === 'connections.read' ? 'can' : 'cannot')).tier).toBe(
      'can',
    );
    expect(callTier(t3, tool('t3_thread_read', 'can', 'read'), { threadId: 't' }, 'can', 'read').tier).toBe(
      'can',
    );
    // Stopping a thread is allowed; deleting a project always asks.
    expect(callTier(t3, tool('t3_thread_interrupt', 'can', 'write'), { threadId: 't' }, 'can').tier).toBe(
      'can',
    );
    expect(callTier(t3, tool('t3_project_delete', 'can', 'write'), { projectId: 'p' }, 'can').tier).toBe(
      'ask',
    );
  });

  it('lists T3 Code’s questions tool as the read it still is on Look only', () => {
    const t3 = entry('t3code');
    const row = {
      name: 't3_pending_request',
      description: 'Pending user questions in a thread.',
      inputSchema: { type: 'object' },
      access: 'write',
      tier: 'can',
      origin: 'mcp-destructive',
      isNew: false,
      limits: null,
    } as unknown as ConnectionToolRow;
    expect(toolViewAt(t3, row, 'read')).toMatchObject({ access: 'read', tier: 'can' });
    expect(toolViewAt(t3, row, 'manage')).toMatchObject({ access: 'write', tier: 'can' });
    expect(toolViewAt(t3, { ...row, name: 't3_thread_launch' }, 'read')).toMatchObject({ tier: 'off' });
  });

  it('asks for files_delete always (a typed tool marked sensitive)', () => {
    const nc = entry('nextcloud');
    expect(callTier(nc, tool('files_delete', 'can', 'write', 'adapter'), { path: '/a' }, 'can').tier).toBe(
      'ask',
    );
    expect(callTier(nc, tool('files_read', 'can', 'read', 'adapter'), { path: '/a' }, 'can').tier).toBe(
      'can',
    );
  });
});

describe('a call’s answer as the agent reads it', () => {
  it('reads an answer once when its text is its structured content written out (T3 Code sends both)', () => {
    const structured = { projects: [{ id: 'p1', title: 'Demo site' }], nextCursor: null };
    expect(textRepeatsStructured(JSON.stringify(structured), structured)).toBe(true);
    expect(
      textRepeatsStructured('{"nextCursor":null,"projects":[{"title":"Demo site","id":"p1"}]}', structured),
    ).toBe(true);
    expect(textRepeatsStructured('Found 2 projects.', structured)).toBe(false);
    expect(textRepeatsStructured('{"projects":[]}', structured)).toBe(false);
    expect(textRepeatsStructured('{"projects":[', structured)).toBe(false);
  });
});

describe('a call that leaves out a required argument', () => {
  const command = {
    name: 'server_command',
    origin: 'adapter' as const,
    inputSchema: { type: 'object', required: ['server', 'command', 'reason'] },
  };

  it('is refused before anything is asked, naming what is missing', () => {
    const text = missingArgsText(command, { server: 'the-falcon', command: 'systemctl status x' });
    expect(text).toMatch(/^reason: server_command /);
    expect(missingArgsText(command, { command: 'uptime', reason: '  ' })).toMatch(/^server, reason: /);
  });

  it('lets a complete call through', () => {
    expect(missingArgsText(command, { server: 'the-falcon', command: 'uptime', reason: 'load' })).toBeNull();
    expect(missingArgsText({ ...command, inputSchema: null }, {})).toBeNull();
  });

  it('takes an empty text as given for a service’s own tools', () => {
    const mcp = { ...command, origin: 'mcp' as const };
    expect(missingArgsText(mcp, { server: 'a', command: 'b', reason: '' })).toBeNull();
    expect(missingArgsText(mcp, { server: 'a', command: 'b' })).toMatch(/^reason: /);
  });
});
