/** The connections catalog (Whombat connections-catalog.md CX-01…CX-62, contracts 0.48.0). */
import { describe, expect, it } from 'vitest';
import { actionCopy } from '../approvals/copy.js';
import {
  CONNECTION_MCP_TOOLS,
  ConnectionCallInput,
  CreateConnectionBody,
  destinationRefusedText,
  MCP_TOOLS,
  mcpRequiredKey,
  SetConnectorAppBody,
  UpdateConnectionBody,
} from '../contracts/index.js';
import { actionKey, describeAction } from '../keys/actions.js';
import { KEY_CATALOG, KEY_GROUP_LABELS } from '../keys/catalog.js';
import { ApprovalAction, SERVER_ONLY_ACTION_TYPES } from './approval.js';
import { EVENT_TYPES } from './audit.js';
import {
  accessText,
  accessTier,
  CATALOG,
  CATALOG_CONNECTABLE,
  CATALOG_IDS,
  type CatalogEntry,
  CatalogEntry as CatalogEntrySchema,
  CatalogEntryStatus,
  CatalogField,
  ConnectionView,
  callAccess,
  catalogEntry,
  catalogSignIn,
  connectionCallKey,
  connectionGuide,
  connectionHost,
  connectionPromptLine,
  connectionTransport,
  cookieHeaderValue,
  cutsOffReason,
  defaultConnectionLabel,
  defaultToolTier,
  deletesByName,
  discoveredUrl,
  effectiveTier,
  FILES_TOOLS,
  fieldProblem,
  fieldsFor,
  fieldsProblems,
  handleFor,
  hasRequestTool,
  isAgentConnection,
  isReadRequest,
  isSensitiveCall,
  isSensitiveRequest,
  jsonPathValue,
  jsonPathValues,
  lookOnlyText,
  mcpToolHidden,
  mcpToolReads,
  mcpToolReadsByArgs,
  pasteValues,
  probeMatches,
  probeVersion,
  REQUEST_TOOL_NAME,
  requestAllowed,
  requestCallTier,
  resolveBaseUrl,
  resolveCheckPath,
  resolveMcpUrl,
  resolveRequestPrefixes,
  resolveTokenUrl,
  sensitiveReason,
  sessionAnswerExpiresAt,
  sessionAnswerToken,
  sessionCredential,
  sessionLoginFailure,
  sessionLoginRequest,
  TASKS_TOOLS,
  TokenAuth,
  templateFields,
  tokenAuthProblem,
  tokenCredential,
  toolAlwaysAsks,
  toolOffText,
} from './connections-catalog.js';

const entry = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(`no entry ${id}`);
  return e;
};

describe('catalog integrity (CX-01, CX-50…CX-62)', () => {
  it('lists every entry of the spec once, in CATALOG_IDS order, each valid', () => {
    expect(CATALOG.map((e) => e.id)).toEqual([...CATALOG_IDS]);
    expect(new Set(CATALOG.map((e) => e.handle)).size).toBe(CATALOG.length);
    for (const e of CATALOG) expect(CatalogEntrySchema.safeParse(e).success, e.id).toBe(true);
    expect(CATALOG.filter((e) => e.transport === 'builtin').map((e) => e.id)).toEqual([
      'github',
      'google',
      'microsoft',
      'imap',
      'feedback',
      'whombat_servers',
      'device',
    ]);
  });

  it('gives every entry copy without straight apostrophes and a guide of at most 1 500 characters', () => {
    for (const e of CATALOG) {
      expect(Object.hasOwn(e, 'scopes') || Object.hasOwn(e, 'defaultScope'), e.id).toBe(false);
      expect(e.guide.length, e.id).toBeLessThanOrEqual(1500);
      expect(e.description, e.id).not.toMatch(/'/);
      for (const f of e.fields)
        expect(`${f.label} ${f.help ?? ''} ${f.placeholder ?? ''}`, e.id).not.toMatch(/'/);
      for (const m of e.signIn) {
        expect(m.label, e.id).not.toMatch(/'/);
        if (m.kind === 'token') expect(`${m.secretLabel} ${m.secretHelp}`, e.id).not.toMatch(/'/);
      }
    }
  });

  it('gives every connectable entry a sign-in, a base, a check and a guide; builtins none', () => {
    for (const e of CATALOG_CONNECTABLE) {
      expect(e.signIn.length, e.id).toBeGreaterThan(0);
      expect(e.baseUrl, e.id).not.toBeNull();
      expect(e.check, e.id).not.toBeNull();
      expect(e.guide.length, e.id).toBeGreaterThan(50);
      // A connection through a Mac (Find My) has no address of its own: the Servers connection's base, never requested.
      if (e.check?.kind === 'mac') {
        expect(e.baseUrl, e.id).toBe('whombat-hosts:');
        expect(e.request, e.id).toBeNull();
        expect(
          e.signIn.map((m) => m.kind),
          e.id,
        ).toEqual(['none']);
      } else if (e.check?.kind === 'onepassword') {
        // 1Password is reached only through its own SDK: a base that is never requested, and nothing to request.
        expect(e.baseUrl, e.id).toBe('onepassword:');
        expect(e.request, e.id).toBeNull();
      } else expect(e.baseUrl, e.id).toMatch(/^(https?:\/\/|\{url\})/);
      if (e.transport === 'mcp')
        expect(e.signIn.some((m) => m.kind === 'mcp_oauth') || e.mcpPath !== null, e.id).toBe(true);
      // REST entries offer typed adapter tools, an allowed request, or both. Automation-only entries are not callable.
      if (e.transport === 'rest' && isAgentConnection(e))
        expect(e.request !== null || e.tools.length > 0, e.id).toBe(true);
    }
    for (const e of CATALOG.filter((x) => x.transport === 'builtin')) {
      expect(e.signIn, e.id).toEqual([]);
      expect(e.check, e.id).toBeNull();
      expect(e.request, e.id).toBeNull();
    }
  });

  it('only names fields that exist, in every template and header shape', () => {
    for (const e of CATALOG) {
      const ids = new Set(e.fields.map((f) => f.id));
      const templates = [
        e.baseUrl ?? '',
        e.tokenUrl ?? '',
        ...(e.request?.prefixes ?? []),
        e.check?.kind === 'request' ? e.check.path : '',
      ];
      for (const t of templates)
        for (const id of templateFields(t)) expect(ids.has(id), `${e.id} {${id}}`).toBe(true);
      // A select's own choices (Find My's Read in the background): never with the service's, each once, and the
      // default one of them.
      for (const f of e.fields) {
        if (!f.options) continue;
        const values = f.options.map((o) => o.value);
        expect([f.kind, f.fromService ?? false], `${e.id}.${f.id}`).toEqual(['select', false]);
        expect(new Set(values).size, `${e.id}.${f.id}`).toBe(values.length);
        if (f.default !== undefined) expect(values, `${e.id}.${f.id}`).toContain(f.default);
      }
      for (const m of e.signIn) {
        if (m.kind !== 'token') continue;
        expect(tokenAuthProblem(e, m.auth), e.id).toBeNull();
        if (m.auth.type === 'header')
          for (const id of templateFields(m.auth.template))
            expect(id === 'secret' || ids.has(id), `${e.id} {${id}}`).toBe(true);
      }
      for (const f of e.fields) expect(CatalogField.safeParse(f).success, `${e.id}.${f.id}`).toBe(true);
    }
  });

  it('compiles every pattern and keeps typed tools to object schemas with unique names', () => {
    for (const e of CATALOG) {
      for (const r of e.request?.readPaths ?? []) expect(() => new RegExp(r.path, 'i'), e.id).not.toThrow();
      for (const r of e.sensitive) {
        if (r.path) expect(() => new RegExp(r.path as string, 'i'), e.id).not.toThrow();
        if (r.argValue) expect(() => new RegExp(r.argValue as string, 'i'), e.id).not.toThrow();
      }
      for (const f of e.fields)
        if (f.validation)
          expect(() => new RegExp(f.validation?.pattern as string), `${e.id}.${f.id}`).not.toThrow();
      expect(new Set(e.tools.map((t) => t.name)).size, e.id).toBe(e.tools.length);
      for (const t of e.tools) {
        expect(t.inputSchema.type, `${e.id}.${t.name}`).toBe('object');
        expect(t.name, e.id).not.toBe(REQUEST_TOOL_NAME);
      }
    }
    expect(FILES_TOOLS.map((t) => t.name)).toEqual([
      'files_list',
      'files_search',
      'files_read',
      'files_write',
      'files_move',
      'files_delete',
    ]);
    expect(TASKS_TOOLS.map((t) => t.name)).toEqual([
      'tasks_list',
      'tasks_add',
      'tasks_update',
      'tasks_complete',
      'projects_list',
    ]);
    expect(entry('dropbox').tools).toEqual(entry('nextcloud').tools);
  });

  it('follows the spec’s sign-ins', () => {
    expect(entry('homeassistant').signIn.map((m) => m.kind)).toEqual(['password', 'token', 'ha_oauth']);
    // Whombat adds Home Assistant's MCP Server integration itself (CX-54a, CT-310); nothing else sets one up.
    expect(entry('homeassistant').mcpSetup).toEqual({ kind: 'ha_config_flow', handler: 'mcp_server' });
    // What agents see through it is in the guide (they tell the person); the check just says it works (CT-311).
    expect(entry('homeassistant').mcpReadyNote).toBeNull();
    expect(entry('homeassistant').guide).toContain('exposed to Assist');
    expect(CATALOG.filter((e) => e.mcpSetup).map((e) => e.id)).toEqual(['homeassistant']);
    expect(entry('notion').signIn.map((m) => m.kind)).toEqual(['mcp_oauth', 'token']);
    expect(entry('nextcloud').signIn.map((m) => m.kind)).toEqual(['nextcloud_login', 'password', 'token']);
    expect(entry('dropbox').signIn.map((m) => m.kind)).toEqual(['app_oauth']);
    expect(entry('custom_mcp').signIn.map((m) => m.kind)).toEqual(['none', 'token', 'token', 'mcp_oauth']);
    expect(catalogEntry('nope')).toBeNull();
  });
});

describe('fields, bases and labels', () => {
  it('fills the base from the fields, without a trailing slash, and refuses what isn’t a usable URL', () => {
    const ha = entry('homeassistant');
    expect(resolveBaseUrl(ha, { url: 'http://homeassistant.local:8123/' })).toBe(
      'http://homeassistant.local:8123',
    );
    expect(resolveBaseUrl(ha, {})).toBeNull();
    expect(resolveBaseUrl(ha, { url: 'ftp://x' })).toBeNull();
    expect(resolveBaseUrl(entry('todoist'), {})).toBe('https://api.todoist.com');
    expect(resolveBaseUrl(entry('gitlab'), {})).toBe('https://gitlab.com');
    expect(resolveBaseUrl(entry('github'), {})).toBeNull();
  });

  it('finds the MCP server: the base plus its path, a fixed sign-in URL, none for REST connections', () => {
    expect(resolveMcpUrl(entry('homeassistant'), { url: 'http://ha.lan:8123' }, 'token')).toBe(
      'http://ha.lan:8123/api/mcp',
    );
    expect(resolveMcpUrl(entry('notion'), {}, 'mcp_oauth')).toBe('https://mcp.notion.com/mcp');
    expect(resolveMcpUrl(entry('notion'), {}, 'token')).toBeNull();
    expect(resolveMcpUrl(entry('custom_mcp'), { url: 'https://mcp.example.com/mcp' }, 'none')).toBe(
      'https://mcp.example.com/mcp',
    );
    expect(connectionTransport(entry('notion'), 'token')).toBe('rest');
    expect(hasRequestTool(entry('notion'), 'token')).toBe(true);
    expect(hasRequestTool(entry('notion'), 'mcp_oauth')).toBe(false);
    expect(hasRequestTool(entry('homeassistant'), 'token')).toBe(true);
    expect(hasRequestTool(entry('custom_mcp'), 'none')).toBe(false);
  });

  it('fills path prefixes and token links', () => {
    expect(resolveRequestPrefixes(entry('moneybird'), { administration: '123456789012345678' })).toEqual([
      '/123456789012345678/',
    ]);
    expect(resolveRequestPrefixes(entry('moneybird'), {})).toEqual([]);
    expect(resolveTokenUrl(entry('homeassistant'), { url: 'http://ha.lan:8123/' })).toBe(
      'http://ha.lan:8123/profile/security',
    );
    expect(resolveTokenUrl(entry('dropbox'), {})).toBeNull();
    expect(resolveCheckPath(entry('plausible'), { url: 'https://plausible.io', site: 'a b.example' })).toBe(
      '/api/v1/stats/realtime/visitors?site_id=a%20b.example',
    );
    expect(resolveCheckPath(entry('custom_mcp'), {})).toBeNull();
  });

  it('labels a connection by name and host (CX-05)', () => {
    expect(defaultConnectionLabel(entry('homeassistant'), { url: 'http://home.lan:8123' })).toBe(
      'Home Assistant · home.lan:8123',
    );
    expect(defaultConnectionLabel(entry('nextcloud'), { url: 'https://cloud.example.com/' })).toBe(
      'Nextcloud · cloud.example.com',
    );
    expect(defaultConnectionLabel(entry('todoist'), {})).toBe('Todoist');
    expect(connectionHost(entry('todoist'), {})).toBeNull();
  });

  it('asks only the fields of the sign-in method, and says what is wrong with each', () => {
    const nc = entry('nextcloud');
    expect(fieldsFor(nc, 'nextcloud_login').map((f) => f.id)).toEqual(['url', 'fingerprint']);
    expect(fieldsFor(nc, 'token').map((f) => f.id)).toEqual(['url', 'username', 'fingerprint']);
    expect(fieldsProblems(nc, 'token', { url: 'https://cloud.example.com' })).toEqual({
      username: 'Username is needed.',
    });
    expect(fieldsProblems(nc, 'nextcloud_login', { url: 'cloud' })).toEqual({
      url: 'That isn’t a web address. Write it like https://api.example.com.',
    });
    expect(fieldsProblems(nc, 'token', { url: 'https://c.example', username: 'mara', bogus: 'x' })).toEqual({
      bogus: 'This connection has no such field.',
    });
    const pve = entry('proxmox');
    const tokenId = pve.fields.find((f) => f.id === 'tokenId') as CatalogField;
    expect(fieldProblem(tokenId, 'root@pam!whombat')).toBeNull();
    expect(fieldProblem(tokenId, 'root')).toBe('Write it like root@pam!whombat.');
    // A field the service fills (Moneybird's administration) may be empty when connecting.
    const adm = entry('moneybird').fields[0] as CatalogField;
    expect(fieldProblem(adm, '')).toBeNull();
  });

  it('gives a Custom API’s own notes as its guide (CX-62)', () => {
    const api = entry('custom_api');
    expect(connectionGuide(api, { url: 'https://x.example', description: 'Our CRM. GET /contacts.' })).toBe(
      'Our CRM. GET /contacts.',
    );
    expect(connectionGuide(api, { url: 'https://x.example' })).toBe(api.guide);
    expect(connectionGuide(entry('todoist'), {})).toBe(entry('todoist').guide);
  });
});

describe('handles (CX-05)', () => {
  it('uses the entry’s handle, then -2, -3', () => {
    expect(handleFor('homeassistant', [])).toBe('homeassistant');
    expect(handleFor('homeassistant', ['homeassistant'])).toBe('homeassistant-2');
    expect(handleFor('homeassistant', ['homeassistant', 'homeassistant-2'])).toBe('homeassistant-3');
    expect(handleFor('custom_mcp', [], null)).toBe('mcp');
  });

  it('names a Custom connection after its label', () => {
    expect(handleFor('custom_api', [], 'Our CRM (prod)')).toBe('our-crm-prod');
    expect(handleFor('custom_api', ['our-crm'], 'Our CRM')).toBe('our-crm-2');
    expect(handleFor('custom_api', [], '!!!')).toBe('api');
    // Not a Custom entry: the label doesn't matter.
    expect(handleFor('todoist', [], 'My tasks')).toBe('todoist');
  });
});

describe('credentials (CX-10)', () => {
  it('signs a request as each header shape says', () => {
    expect(tokenCredential(entry('todoist'), { type: 'bearer' }, 'tok', {})).toEqual({
      headers: { Authorization: 'Bearer tok' },
      query: {},
    });
    const pve = entry('proxmox');
    const pveAuth = catalogSignIn(pve, 'token');
    if (pveAuth?.kind !== 'token') throw new Error('token');
    expect(
      tokenCredential(pve, pveAuth.auth, 'uuid', { url: 'https://pve:8006', tokenId: 'root@pam!wb' }),
    ).toEqual({
      headers: { Authorization: 'PVEAPIToken=root@pam!wb=uuid' },
      query: {},
    });
    expect(tokenCredential(pve, pveAuth.auth, 'uuid', { url: 'https://pve:8006' })).toBeNull();
    const nc = entry('nextcloud');
    expect(
      tokenCredential(nc, { type: 'basic', usernameField: 'username' }, 'pw', { username: 'mara' }),
    ).toEqual({
      headers: { Authorization: 'Basic bWFyYTpwdw==' },
      query: {},
    });
    expect(tokenCredential(entry('custom_api'), { type: 'query', name: 'key' }, 's', {})).toEqual({
      headers: {},
      query: { key: 's' },
    });
    // A secret that looks like a placeholder stays as it is.
    expect(
      tokenCredential(
        entry('paperless'),
        { type: 'header', name: 'Authorization', template: 'Token {secret}' },
        '{url}',
        {
          url: 'http://p.lan',
        },
      ),
    ).toEqual({ headers: { Authorization: 'Token {url}' }, query: {} });
  });

  it('refuses a person’s own header shape that can’t work', () => {
    const api = entry('custom_api');
    expect(tokenAuthProblem(api, { type: 'header', name: 'X-Key', template: 'k' })).toBe(
      'The header value needs {secret} exactly once.',
    );
    expect(tokenAuthProblem(api, { type: 'header', name: 'X-Key', template: '{secret}{nope}' })).toBe(
      'There is no field {nope}.',
    );
    expect(tokenAuthProblem(api, { type: 'header', name: 'Cookie', template: '{secret}' })).toBe(
      'Whombat can’t send the token in that header.',
    );
    expect(tokenAuthProblem(entry('todoist'), { type: 'basic', usernameField: 'username' })).toBe(
      'There is no username field.',
    );
  });
});

describe('reads, writes and paths (CX-33)', () => {
  it('counts GET and HEAD as reads, plus each entry’s read methods and paths', () => {
    const notion = entry('notion');
    expect(isReadRequest(notion, 'GET', '/v1/pages/abc')).toBe(true);
    expect(isReadRequest(notion, 'post', '/v1/search')).toBe(true);
    expect(isReadRequest(notion, 'POST', '/v1/data_sources/ds1/query')).toBe(true);
    expect(isReadRequest(notion, 'POST', '/v1/pages')).toBe(false);
    expect(isReadRequest(entry('nextcloud'), 'PROPFIND', '/remote.php/dav/files/mara/')).toBe(true);
    expect(isReadRequest(entry('nextcloud'), 'MOVE', '/remote.php/dav/files/mara/a')).toBe(false);
    const dbx = entry('dropbox');
    expect(isReadRequest(dbx, 'POST', '/2/files/list_folder')).toBe(true);
    expect(isReadRequest(dbx, 'POST', '/2/files/upload')).toBe(false);
    expect(isReadRequest(entry('immich'), 'POST', '/api/search/smart')).toBe(true);
    expect(isReadRequest(entry('github'), 'GET', '/')).toBe(false);
  });

  it('keeps requests under the connection’s prefixes and methods', () => {
    const ha = entry('homeassistant');
    expect(requestAllowed(ha, {}, 'GET', '/api/states')).toBe(true);
    expect(requestAllowed(ha, {}, 'GET', '/api')).toBe(true);
    expect(requestAllowed(ha, {}, 'GET', '/auth/token')).toBe(false);
    expect(requestAllowed(ha, {}, 'PROPFIND', '/api/')).toBe(false);
    const mb = entry('moneybird');
    expect(requestAllowed(mb, { administration: '42' }, 'GET', '/42/contacts.json')).toBe(true);
    expect(requestAllowed(mb, { administration: '42' }, 'GET', '/43/contacts.json')).toBe(false);
    expect(requestAllowed(entry('dropbox'), {}, 'GET', '/2/files/list_folder')).toBe(false);
  });

  it('decides a call’s access and the key it needs', () => {
    const todo = entry('todoist');
    expect(callAccess(todo, 'tasks_list', {})).toBe('read');
    expect(callAccess(todo, 'tasks_add', {})).toBe('write');
    expect(callAccess(todo, REQUEST_TOOL_NAME, { method: 'GET', path: '/api/v1/tasks' })).toBe('read');
    expect(callAccess(todo, REQUEST_TOOL_NAME, { method: 'POST', path: '/api/v1/tasks' })).toBe('write');
    expect(callAccess(entry('homeassistant'), 'GetLiveContext', {}, 'read')).toBe('read');
    expect(callAccess(entry('homeassistant'), 'HassTurnOn', {})).toBe('write');
    expect(connectionCallKey('read')).toBe('connections.read');
    expect(connectionCallKey('write')).toBe('connections.write');
    expect(defaultToolTier('read')).toBe('can');
    // Every tool starts Allowed since 0.57 (CT-310); the sensitive rules still ask.
    expect(defaultToolTier('write')).toBe('can');
  });
});

describe('sensitive calls (CX-31)', () => {
  const ha = entry('homeassistant');

  it('makes Home Assistant’s locks, alarms, gates and doors ask, by domain, entity id or name (CT-311)', () => {
    expect(isSensitiveCall(ha, 'HassTurnOff', { domain: ['lock'] })).toBe(true);
    expect(isSensitiveCall(ha, 'HassTurnOn', { name: 'Front door lock' })).toBe(true);
    expect(isSensitiveCall(ha, 'HassTurnOn', { name: 'Garage' })).toBe(true);
    expect(isSensitiveCall(ha, 'SomeTool', { entity_id: 'cover.garage_door' })).toBe(true);
    expect(
      isSensitiveCall(ha, 'SomeTool', { target: { entity_id: ['light.x', 'alarm_control_panel.home'] } }),
    ).toBe(true);
    expect(isSensitiveCall(ha, 'HassTurnOn', { name: 'Kitchen light', domain: ['light'] })).toBe(false);
    expect(isSensitiveRequest(ha, 'POST', '/api/services/lock/unlock')).toBe(true);
    expect(isSensitiveRequest(ha, 'POST', '/api/services/light/turn_on')).toBe(false);
    // Prefixed names (“All LLM APIs”), Dutch names, scripts named for a gate or the alarm, raw KNX writes.
    expect(isSensitiveCall(ha, 'assist__intent__HassTurnOff', { name: 'Voordeur' })).toBe(true);
    expect(isSensitiveCall(ha, 'assist__intent__HassTurnOn', { name: 'Garagepoort' })).toBe(true);
    expect(isSensitiveCall(ha, 'assist__intent__HassTurnOn', { name: 'Keuken', domain: ['light'] })).toBe(
      false,
    );
    expect(isSensitiveCall(ha, 'assist__intent__HassTurnOn', { name: 'Klok' })).toBe(false);
    expect(isSensitiveCall(ha, 'assist__intent__HassSetPosition', { name: 'Rolluik woonkamer' })).toBe(false);
    expect(isSensitiveCall(ha, 'assist__script__doorbell_script', {})).toBe(false);
    for (const name of ['poort_openen', 'hek_openen', 'alarm_uitschakelen', 'alarm_toggle_away'])
      expect(toolAlwaysAsks(ha, `assist__script__${name}`), name).toBe(true);
    for (const name of ['basis_scene_1', 'bioscoop_netflix', 'zwembad_led_inschakelen', 'doorbell_script'])
      expect(toolAlwaysAsks(ha, `assist__script__${name}`), name).toBe(false);
    expect(toolAlwaysAsks(ha, 'knx__send_group_value_write')).toBe(true);
    expect(toolAlwaysAsks(ha, 'assist__intent__HassTurnOn')).toBe(false);
    // Reading a lock's state doesn't ask.
    expect(
      isSensitiveCall(ha, 'assist__homeassistant__GetLiveContext', { domain: ['lock'] }, { access: 'read' }),
    ).toBe(false);
  });

  it('makes every DELETE ask, and each entry’s money and power actions', () => {
    for (const e of CATALOG_CONNECTABLE.filter((x) => x.request))
      expect(isSensitiveRequest(e, 'DELETE', `${e.request?.prefixes[0] ?? '/'}x`), e.id).toBe(true);
    const mb = entry('moneybird');
    expect(isSensitiveRequest(mb, 'PATCH', '/42/sales_invoices/7/send_invoice.json')).toBe(true);
    expect(isSensitiveRequest(mb, 'POST', '/42/sales_invoices.json')).toBe(false);
    expect(isSensitiveRequest(entry('mollie'), 'POST', '/v2/payments/tr_1/refunds')).toBe(true);
    expect(isSensitiveRequest(entry('mollie'), 'GET', '/v2/payments')).toBe(false);
    expect(isSensitiveRequest(entry('proxmox'), 'POST', '/api2/json/nodes/pve/qemu/100/status/stop')).toBe(
      true,
    );
    expect(isSensitiveRequest(entry('proxmox'), 'POST', '/api2/json/nodes/pve/qemu/100/status/start')).toBe(
      false,
    );
    expect(isSensitiveRequest(entry('hetzner'), 'POST', '/v1/servers/1/actions/poweroff')).toBe(true);
    expect(isSensitiveRequest(entry('gitlab'), 'PUT', '/api/v4/projects/1/merge_requests/2/merge')).toBe(
      true,
    );
    expect(isSensitiveRequest(entry('forgejo'), 'POST', '/api/v1/repos/a/b/pulls/3/merge')).toBe(true);
    expect(isSensitiveRequest(entry('dropbox'), 'POST', '/2/files/delete_v2')).toBe(true);
  });

  it('marks typed tools and tools named for deleting, not a server’s destructive hint, and says why (CT-311)', () => {
    expect(isSensitiveCall(entry('nextcloud'), 'files_delete', { path: '/a' })).toBe(true);
    expect(isSensitiveCall(entry('nextcloud'), 'files_write', { path: '/a', content: 'x' })).toBe(false);
    expect(isSensitiveCall(entry('custom_mcp'), 'set_light', {}, { destructive: true })).toBe(false);
    for (const name of [
      'delete_page',
      'notion-delete-block',
      'EraseEverything',
      'HassShoppingListRemoveItem',
      'wipe',
    ])
      expect(toolAlwaysAsks(entry('custom_mcp'), name), name).toBe(true);
    for (const name of ['update_page', 'Timeremover', 'list_deleted', 'HassTurnOn'])
      expect(deletesByName(name), name).toBe(false);
    expect(
      sensitiveReason(entry('mollie'), REQUEST_TOOL_NAME, { method: 'POST', path: '/v2/payments' }),
    ).toBe('Moves money');
    expect(toolAlwaysAsks(entry('dropbox'), 'files_delete')).toBe(true);
    expect(toolAlwaysAsks(entry('dropbox'), 'files_list')).toBe(false);
    expect(toolAlwaysAsks(ha, 'HassTurnOn')).toBe(false);
  });

  it('asks before service reads that return passwords, private keys or tokens, while keeping normal reads automatic', () => {
    const readReason = (id: string, path: string, method: 'GET' | 'HEAD' | 'POST' = 'GET') => {
      const e = entry(id);
      return sensitiveReason(
        e,
        REQUEST_TOOL_NAME,
        { method, path },
        { access: callAccess(e, REQUEST_TOOL_NAME, { method, path }) },
      );
    };
    const secretReads: [string, string, ('GET' | 'HEAD' | 'POST')?][] = [
      ['qbittorrent', '/api/v2/app/preferences'],
      ['qbittorrent', '/api/v2/app/preferences/', 'HEAD'],
      ['qbittorrent', '/api/v2/app/cookies'],
      ['qbittorrent', '/api/v2/app/setCookies', 'POST'],
      ['qbittorrent', '/api/v2/app/rotateAPIKey', 'POST'],
      ['qbittorrent', '/api/v2/app/deleteAPIKey', 'POST'],
      ['jellyfin', '/System/Configuration'],
      ['jellyfin', '/System/Configuration/Network'],
      ['jellyfin', '/Plugins/abc123/Configuration'],
      ['frigate', '/api/config'],
      ['frigate', '/api/config/raw', 'HEAD'],
      ['frigate', '/api/ffprobe'],
      ['immich', '/api/system-config'],
      ['immich', '/api/admin/config'],
      ['immich', '/api/admin/database-backups/immich-db-backup.sql.gz'],
      ['immich', '/api/api-keys', 'POST'],
      ['pihole', '/api/teleporter'],
      ['pihole', '/api/config'],
      ['pihole', '/api/config/webserver'],
      ['pihole', '/api/config/webserver/api/pwhash'],
      ['pihole', '/api/auth/app'],
      ['pihole', '/api/auth/totp'],
      ['adguard', '/control/tls/status'],
      ['plex', '/:/prefs'],
      ['nginx_proxy_manager', '/api/nginx/certificates/3/download'],
      ['opnsense', '/api/core/backup/download/this'],
      ['opnsense', '/api/trust/cert/get/uuid-1'],
      ['opnsense', '/api/trust/ca/raw_dump/uuid-1'],
      ['opnsense', '/api/auth/user/get/uuid-1'],
      ['opnsense', '/api/auth/user/newOtpSeed'],
      ['opnsense', '/api/wireguard/server/getServer/uuid-1'],
      ['opnsense', '/api/wireguard/server/keyPair'],
      ['opnsense', '/api/wireguard/client/psk'],
      ['opnsense', '/api/openvpn/instances/get/uuid-1'],
      ['opnsense', '/api/ipsec/pre_shared_keys/getItem/uuid-1'],
      ['cloudflare', '/client/v4/accounts/a1/cfd_tunnel/t1/token'],
      ['sonarr', '/api/v3/config/host'],
      ['radarr', '/api/v3/config/host'],
    ];
    for (const [id, path, method] of secretReads) {
      expect(readReason(id, path, method ?? 'GET'), `${id} ${method ?? 'GET'} ${path}`).not.toBeNull();
      // Guarding individual paths never marks the whole `request` tool as "Always asks".
      expect(toolAlwaysAsks(entry(id), REQUEST_TOOL_NAME), id).toBe(false);
    }

    const safeReads: [string, string][] = [
      ['qbittorrent', '/api/v2/sync/maindata'],
      ['qbittorrent', '/api/v2/torrents/info'],
      ['qbittorrent', '/api/v2/app/version'],
      ['jellyfin', '/System/Info'],
      ['jellyfin', '/Plugins'],
      ['jellyfin', '/Users'],
      ['frigate', '/api/stats'],
      ['frigate', '/api/events'],
      ['immich', '/api/albums'],
      ['immich', '/api/admin/database-backups'],
      ['pihole', '/api/config/dns'],
      ['pihole', '/api/stats/summary'],
      ['adguard', '/control/status'],
      ['adguard', '/control/filtering/status'],
      ['plex', '/library/sections'],
      ['nginx_proxy_manager', '/api/nginx/certificates'],
      ['nginx_proxy_manager', '/api/nginx/proxy-hosts'],
      ['opnsense', '/api/core/system/status'],
      ['opnsense', '/api/wireguard/service/show'],
      ['opnsense', '/api/openvpn/service/searchSessions'],
      ['cloudflare', '/client/v4/zones'],
      ['cloudflare', '/client/v4/accounts/a1/cfd_tunnel'],
    ];
    for (const [id, path] of safeReads) {
      expect(readReason(id, path), `${id} GET ${path}`).toBeNull();
    }
  });
});
describe('changes that can cut the person off', () => {
  const call = (id: string, method: string, path: string, body?: unknown) =>
    cutsOffReason(entry(id), 'request', { method, path, ...(body !== undefined ? { body } : {}) });

  it('names DNS, DHCP, firewall and network changes, which outsiders’ runs can’t propose', () => {
    expect(
      call('pihole', 'PATCH', '/api/config', { config: { dns: { upstreams: ['203.0.113.9'] } } }),
    ).toContain('DNS');
    expect(call('pihole', 'PUT', '/api/config/dns/hosts/203.0.113.9%20bank.example.com')).toContain('DNS');
    expect(call('adguard', 'POST', '/control/dns_config', { upstream_dns: ['203.0.113.9'] })).toContain(
      'DNS',
    );
    expect(
      call('adguard', 'POST', '/control/rewrite/add', { domain: 'a.example.com', answer: '203.0.113.9' }),
    ).toBeTruthy();
    expect(call('adguard', 'POST', '/control/filtering/set_rules', { rules: [] })).toBeTruthy();
    expect(call('tailscale', 'POST', '/api/v2/tailnet/-/dns/nameservers', { dns: [] })).toContain('DNS');
    expect(call('tailscale', 'POST', '/api/v2/device/n1/expire')).toBeTruthy();
    expect(call('opnsense', 'POST', '/api/unbound/settings/add_host_override', {})).toContain('DNS');
    expect(call('opnsense', 'POST', '/api/core/service/stop/unbound', {})).toBeTruthy();
    expect(call('unifi_network', 'PATCH', '/v1/sites/s1/networks/n1', {})).toBeTruthy();
    expect(call('cloudflare', 'POST', '/client/v4/zones/z1/dns_records', { type: 'A' })).toContain('DNS');
    expect(call('hetzner', 'POST', '/v1/firewalls/1/actions/apply_to_resources', {})).toBeTruthy();
    expect(call('nginx_proxy_manager', 'PUT', '/api/nginx/proxy-hosts/3', {})).toBeTruthy();
  });

  it('leaves ordinary changes alone, and the person’s own calls don’t ask for them', () => {
    expect(
      call('adguard', 'POST', '/control/filtering/add_url', { name: 'x', url: 'https://example.com/l.txt' }),
    ).toBeNull();
    expect(call('pihole', 'POST', '/api/domains/deny/exact', { domain: 'ads.example.com' })).toBeNull();
    expect(call('opnsense', 'POST', '/api/unbound/settings/search_host_override', {})).toBeNull();
    expect(call('cloudflare', 'GET', '/client/v4/zones/z1/dns_records')).toBeNull();
    // The rules only ever keep an outsiders' run out: they don't make the person's own call ask.
    expect(
      isSensitiveCall(entry('tailscale'), 'request', {
        method: 'POST',
        path: '/api/v2/tailnet/-/dns/nameservers',
      }),
    ).toBe(false);
    expect(
      isSensitiveCall(entry('cloudflare'), 'request', {
        method: 'POST',
        path: '/client/v4/zones/z1/dns_records',
      }),
    ).toBe(false);
    // Every entry has them, if only as none.
    for (const e of CATALOG) expect(Array.isArray(e.cutsOff)).toBe(true);
  });
});

describe('tiers (CX-20)', () => {
  it('runs a call at the stricter of key and tool, sensitive ones at Ask, Off whenever either is', () => {
    expect(effectiveTier('can', 'can', false)).toBe('can');
    expect(effectiveTier('ask', 'can', false)).toBe('ask');
    expect(effectiveTier('can', 'ask', false)).toBe('ask');
    expect(effectiveTier('can', 'can', true)).toBe('ask');
    expect(effectiveTier('cannot', 'can', false)).toBe('off');
    expect(effectiveTier('can', 'off', true)).toBe('off');
    expect(effectiveTier('cannot', 'ask', true)).toBe('off');
  });

  it('lets reads through the request tool unless it is Off', () => {
    expect(requestCallTier('ask', 'read')).toBe('can');
    expect(requestCallTier('ask', 'write')).toBe('ask');
    expect(requestCallTier('off', 'read')).toBe('off');
    expect(toolOffText('HassTurnOn', 'Home Assistant · home.lan')).toBe(
      'HassTurnOn is turned off for Home Assistant · home.lan.',
    );
  });

  it('writes one prompt line per connection (CX-35), naming nobody (CT-1551)', () => {
    const active = connectionPromptLine({
      handle: 'homeassistant',
      label: 'Home Assistant',
      status: 'active',
    });
    expect(active.startsWith('homeassistant — Home Assistant.')).toBe(true);
    expect(active).toContain('connection_tools');
    expect(
      connectionPromptLine({ handle: 'notion', label: 'Notion', status: 'active', access: 'read' }),
    ).toContain('Notion (look only)');
    const reauth = connectionPromptLine({ handle: 'todoist', label: 'Todoist', status: 'needs_reauth' });
    expect(reauth).toContain('Settings → Connections');
    expect(reauth).not.toMatch(/shared|personal|owner/);
  });
});

describe('contracts around the catalog', () => {
  it('adds the keys, audit types and the server-only approval', () => {
    expect(KEY_GROUP_LABELS.connections).toBe('Connected services');
    expect(KEY_CATALOG['connections.read'].agentMaxTier).toBe('can');
    expect(KEY_CATALOG['connections.write'].agentMaxTier).toBe('can');
    for (const t of [
      'connection.added',
      'connection.changed',
      'connection.removed',
      'connection.needs_reauth',
      'connection.tool_called',
      'connection.tool_finished',
      'connection.tool_tier_changed',
    ])
      expect(t in EVENT_TYPES, t).toBe(true);
    expect(SERVER_ONLY_ACTION_TYPES).toContain('connection_call');
  });

  it('describes a connection call', () => {
    const params = {
      connectionId: 'con_ha1',
      handle: 'homeassistant',
      tool: 'HassTurnOn',
      toolHash: 'a'.repeat(64),
    };
    const call = ApprovalAction.parse({ type: 'connection_call', params });
    expect(actionKey(call)).toBe('connections.write');
    expect(describeAction(call)).toBe('use HassTurnOn on homeassistant');
    expect(actionCopy(call)).toMatchObject({
      title: 'Use HassTurnOn on homeassistant',
      target: 'homeassistant · HassTurnOn',
    });
    expect(
      ApprovalAction.safeParse({ type: 'connection_call', params: { ...params, toolHash: 'x' } }).success,
    ).toBe(false);
  });

  it('lists two fixed tools under the read key', () => {
    expect(Object.keys(CONNECTION_MCP_TOOLS)).toEqual(['connection_tools', 'connection_call']);
    expect(MCP_TOOLS.connection_call.requiredKey).toBe('connections.read');
    expect(mcpRequiredKey('connection_tools', { connection: 'notion' })).toEqual({
      keyId: 'connections.read',
      scope: {},
    });
    expect(ConnectionCallInput.parse({ connection: 'homeassistant', tool: 'HassTurnOn' }).arguments).toEqual(
      {},
    );
    expect(ConnectionCallInput.safeParse({ connection: 'Home Assistant', tool: 'x' }).success).toBe(false);
  });

  it('checks connect bodies', () => {
    const ok = CreateConnectionBody.parse({ catalogId: 'todoist', secret: 'abc' });
    expect(ok).toMatchObject({ fields: {}, signIn: 'token' });
    expect(
      'scope' in CreateConnectionBody.parse({ catalogId: 'todoist', scope: 'personal', secret: 'abc' }),
    ).toBe(false);
    expect(CreateConnectionBody.safeParse({ catalogId: 'todoist', secret: '' }).success).toBe(false);
    expect(UpdateConnectionBody.safeParse({}).success).toBe(false);
    expect(SetConnectorAppBody.safeParse({ clientSecret: null }).success).toBe(true);
    expect(SetConnectorAppBody.safeParse({}).success).toBe(false);
    const refused = destinationRefusedText('192.168.1.0/24', 8123);
    expect(refused).toContain('192.168.1.0/24 port 8123');
    expect(refused).not.toContain('admin');
  });
});

describe('homelab and infrastructure entries (CT-313)', () => {
  const asks = (id: string, method: string, path: string) => isSensitiveRequest(entry(id), method, path);
  const tokenAuth = (id: string) => {
    const m = entry(id).signIn.find((s) => s.kind === 'token');
    if (m?.kind !== 'token') throw new Error(`${id} has no token sign-in`);
    return m.auth;
  };
  const reads = (id: string, method: string, path: string) => isReadRequest(entry(id), method, path);

  it('signs each in as its API wants', () => {
    const fields = { url: 'https://192.168.1.1' };
    expect(tokenCredential(entry('unifi_network'), tokenAuth('unifi_network'), 'k', fields)).toEqual({
      headers: { 'X-API-KEY': 'k' },
      query: {},
    });
    const opn = entry('opnsense');
    expect(
      tokenCredential(opn, tokenAuth('opnsense'), 'the-secret', { ...fields, apiKey: 'the-key' })?.headers,
    ).toEqual({ Authorization: 'Basic dGhlLWtleTp0aGUtc2VjcmV0' });
    expect(resolveBaseUrl(entry('unifi_protect'), fields)).toBe(
      'https://192.168.1.1/proxy/protect/integration',
    );
    for (const id of [
      'proxmox',
      'proxmox_backup',
      'unifi_network',
      'unifi_protect',
      'opnsense',
      'portainer',
      'unraid',
    ])
      expect(
        entry(id).fields.some((f) => f.id === 'fingerprint'),
        id,
      ).toBe(true);
  });

  it('asks for doors, keys and power on UniFi, not for everyday actions', () => {
    expect(asks('unifi_network', 'POST', '/v1/sites/s1/firewall/policies')).toBe(true);
    expect(asks('unifi_network', 'PUT', '/v1/sites/s1/wifi/broadcasts/w1')).toBe(true);
    expect(asks('unifi_network', 'POST', '/v1/sites/s1/devices/d1/actions')).toBe(true);
    expect(asks('unifi_network', 'POST', '/v1/sites/s1/clients/c1/actions')).toBe(false);
    expect(asks('unifi_network', 'POST', '/v1/sites/s1/hotspot/vouchers')).toBe(false);
    expect(asks('unifi_protect', 'POST', '/v1/arm-profiles/a1/enable')).toBe(true);
    expect(asks('unifi_protect', 'POST', '/v1/relays/r1/outputs/1/activate')).toBe(true);
    expect(asks('unifi_protect', 'POST', '/v1/cameras/c1/disable-mic-permanently')).toBe(true);
    expect(asks('unifi_protect', 'POST', '/v1/sirens/s1/play')).toBe(false);
    expect(asks('unifi_protect', 'PATCH', '/v1/lights/l1')).toBe(false);
  });

  it('reads OPNsense searches and logs, and asks for firewall, users, VPN and power', () => {
    expect(reads('opnsense', 'POST', '/api/firewall/filter/search_rule')).toBe(true);
    expect(reads('opnsense', 'POST', '/api/firewall/filter/searchRule')).toBe(true);
    expect(reads('opnsense', 'POST', '/api/diagnostics/log/core/system')).toBe(true);
    expect(reads('opnsense', 'POST', '/api/core/service/restart/unbound')).toBe(false);
    expect(asks('opnsense', 'POST', '/api/firewall/filter/add_rule')).toBe(true);
    expect(asks('opnsense', 'POST', '/api/firewall/d_nat/setRule/abc')).toBe(true);
    expect(asks('opnsense', 'POST', '/api/firewall/filter/del_rule/abc')).toBe(true);
    expect(asks('opnsense', 'POST', '/api/auth/user/add_api_key/1')).toBe(true);
    expect(asks('opnsense', 'POST', '/api/wireguard/client/add_client')).toBe(true);
    expect(asks('opnsense', 'POST', '/api/core/system/reboot')).toBe(true);
    expect(asks('opnsense', 'POST', '/api/diagnostics/log/core/system/clear')).toBe(true);
    expect(asks('opnsense', 'POST', '/api/firewall/filter/apply')).toBe(false);
    expect(asks('opnsense', 'POST', '/api/core/service/restart/unbound')).toBe(false);
    expect(asks('opnsense', 'POST', '/api/unbound/settings/add_host_override')).toBe(false);
  });

  it('asks for Tailscale’s policy file, keys, device approval and people', () => {
    expect(reads('tailscale', 'POST', '/api/v2/tailnet/-/acl/validate')).toBe(true);
    expect(asks('tailscale', 'POST', '/api/v2/tailnet/-/acl/validate')).toBe(false);
    expect(asks('tailscale', 'POST', '/api/v2/tailnet/-/acl')).toBe(true);
    expect(asks('tailscale', 'POST', '/api/v2/tailnet/-/keys')).toBe(true);
    expect(asks('tailscale', 'POST', '/api/v2/device/n1/authorized')).toBe(true);
    expect(asks('tailscale', 'POST', '/api/v2/users/u1/delete')).toBe(true);
    expect(asks('tailscale', 'PATCH', '/api/v2/tailnet/-/settings')).toBe(true);
    expect(asks('tailscale', 'POST', '/api/v2/device/n1/name')).toBe(false);
    expect(asks('tailscale', 'POST', '/api/v2/tailnet/-/dns/nameservers')).toBe(false);
    expect(entry('tailscale').request?.headers).toEqual({ Accept: 'application/json' });
  });

  it('asks for Cloudflare tokens, members, Access and tunnels; DNS and purges are allowed', () => {
    expect(reads('cloudflare', 'POST', '/client/v4/graphql')).toBe(true);
    expect(asks('cloudflare', 'POST', '/client/v4/accounts/a1/tokens')).toBe(true);
    expect(asks('cloudflare', 'PUT', '/client/v4/user/tokens/t1/value')).toBe(true);
    expect(asks('cloudflare', 'POST', '/client/v4/accounts/a1/members')).toBe(true);
    expect(asks('cloudflare', 'POST', '/client/v4/accounts/a1/access/apps')).toBe(true);
    expect(asks('cloudflare', 'PUT', '/client/v4/accounts/a1/cfd_tunnel/t1/configurations')).toBe(true);
    expect(asks('cloudflare', 'POST', '/client/v4/zones/z1/dns_records')).toBe(false);
    expect(asks('cloudflare', 'POST', '/client/v4/zones/z1/purge_cache')).toBe(false);
    expect(asks('cloudflare', 'DELETE', '/client/v4/zones/z1/dns_records/r1')).toBe(true);
  });

  it('asks for pruning, wiping, access and power on Proxmox Backup Server', () => {
    const pbs = entry('proxmox_backup');
    expect(
      tokenCredential(pbs, tokenAuth('proxmox_backup'), 's3cret', {
        url: 'https://pbs.local:8007',
        tokenId: 'root@pam!whombat',
      })?.headers,
    ).toEqual({ Authorization: 'PBSAPIToken=root@pam!whombat:s3cret' });
    expect(asks('proxmox_backup', 'POST', '/api2/json/admin/datastore/main/prune')).toBe(true);
    expect(asks('proxmox_backup', 'POST', '/api2/json/admin/prune/daily/run')).toBe(true);
    expect(asks('proxmox_backup', 'POST', '/api2/json/nodes/localhost/status')).toBe(true);
    expect(asks('proxmox_backup', 'PUT', '/api2/json/access/acl')).toBe(true);
    expect(asks('proxmox_backup', 'POST', '/api2/json/admin/verify/v1/run')).toBe(false);
    expect(asks('proxmox_backup', 'POST', '/api2/json/admin/datastore/main/gc')).toBe(false);
    expect(reads('proxmox_backup', 'PUT', '/api2/json/admin/s3/r2/check')).toBe(true);
  });

  it('asks for Docker prune, users and restores on Portainer; containers and stacks are allowed', () => {
    expect(asks('portainer', 'POST', '/api/endpoints/2/docker/containers/prune')).toBe(true);
    expect(asks('portainer', 'POST', '/api/endpoints/2/docker/v1.47/images/prune')).toBe(true);
    expect(asks('portainer', 'POST', '/api/endpoints/delete')).toBe(true);
    expect(asks('portainer', 'PUT', '/api/users/3')).toBe(true);
    expect(asks('portainer', 'POST', '/api/users/3/tokens')).toBe(true);
    expect(asks('portainer', 'POST', '/api/endpoints/2/docker/containers/abc/restart')).toBe(false);
    expect(asks('portainer', 'PUT', '/api/stacks/4/git/redeploy')).toBe(false);
    expect(asks('portainer', 'DELETE', '/api/endpoints/2/docker/containers/abc')).toBe(true);
  });

  it('reads Unraid’s check from its answer, and asks for the array, VMs, deletes, keys and access by mutation', () => {
    const check = entry('unraid').check;
    expect(check?.kind === 'request' && check.okJsonPath).toBe('data.me.name');
    expect(jsonPathValue({ data: { me: { name: 'whombat' } } }, 'data.me.name')).toBe('whombat');
    expect(
      jsonPathValue({ data: null, errors: [{ message: 'Unauthorized' }] }, 'data.me.name'),
    ).toBeUndefined();
    expect(jsonPathValue({ data: [1] }, 'data.0')).toBeUndefined();
    const call = (query: string, variables: Record<string, unknown> = {}) =>
      isSensitiveCall(entry('unraid'), REQUEST_TOOL_NAME, {
        method: 'POST',
        path: '/graphql',
        body: { query, variables },
      });
    expect(call('mutation { array { setState(input: {desiredState: STOP}) { state } } }')).toBe(true);
    expect(
      call(
        'mutation($s: ArrayStateInputState!) { array { setState(input: {desiredState: $s}) { state } } }',
        { s: 'STOP' },
      ),
    ).toBe(true);
    expect(call('mutation { vm { forceStop(id: "v1") } }')).toBe(true);
    expect(call('mutation { docker { removeContainer(id: "c1") } }')).toBe(true);
    expect(call('mutation { apiKey { create(input: {name: "x", roles: [ADMIN]}) { key } } }')).toBe(true);
    expect(call('mutation { connect { setupRemoteAccess(input: {accessType: ALWAYS}) } }')).toBe(true);
    expect(call('mutation { docker { restart(id: "c1") { state } } }')).toBe(false);
    expect(call('mutation { vm { start(id: "v1") } }')).toBe(false);
    expect(call('{ docker { containers { id names state } } }')).toBe(false);
    expect(isReadRequest(entry('unraid'), 'POST', '/graphql')).toBe(false);
  });

  it('reads Grafana queries and asks for service accounts, people and sharing', () => {
    expect(reads('grafana', 'POST', '/api/ds/query')).toBe(true);
    expect(asks('grafana', 'POST', '/api/serviceaccounts/1/tokens')).toBe(true);
    expect(asks('grafana', 'POST', '/api/folders/f1/permissions')).toBe(true);
    expect(asks('grafana', 'POST', '/api/org/users')).toBe(true);
    expect(asks('grafana', 'POST', '/api/dashboards/uid/d1/public-dashboards/')).toBe(true);
    expect(asks('grafana', 'POST', '/api/dashboards/db')).toBe(false);
    expect(asks('grafana', 'POST', '/api/annotations')).toBe(false);
  });
});

describe('setting up (CT-314)', () => {
  const method = (id: string, kind: 'token' | 'client_credentials' = 'token') => {
    const m = entry(id).signIn.find((x) => x.kind === kind);
    if (m?.kind !== kind) throw new Error(`${id} has no ${kind}`);
    return m as Extract<typeof m, { kind: 'token' | 'client_credentials' }>;
  };

  const tokenOf = (id: string) => {
    const m = entry(id).signIn.find((x) => x.kind === 'token');
    if (m?.kind !== 'token') throw new Error(`${id} has no token sign-in`);
    return m;
  };

  it('offers sign in once where the service can make its own key, first, stored as one of the entry’s tokens', () => {
    const once = CATALOG.filter((e) => e.signIn.some((m) => m.kind === 'password')).map((e) => e.id);
    expect(once).toEqual([
      'homeassistant',
      'nextcloud',
      'paperless',
      'immich',
      'proxmox',
      'proxmox_backup',
      'unifi_network',
      'unifi_protect',
      'opnsense',
      'portainer',
      'unraid',
      'grafana',
      'forgejo',
      't3code',
    ]);
    for (const id of once) {
      const e = entry(id);
      // Nextcloud's own login page comes first since 0.111 (CT-741; SG-15f): it needs no password.
      const m = e.signIn.find((x) => x.kind === 'password');
      expect(e.signIn.indexOf(m as (typeof e.signIn)[number]), id).toBe(id === 'nextcloud' ? 1 : 0);
      if (m?.kind !== 'password') continue;
      expect(e.signIn.filter((x) => x.kind === 'token')[m.tokenMethod], id).toBeDefined();
      // The key Whombat makes fills these: the person isn't asked.
      expect(
        fieldsFor(e, 'password').map((f) => f.id),
        id,
      ).not.toContain('tokenId');
      expect(m.creates, id).not.toMatch(/'/);
    }
    expect(fieldsFor(entry('proxmox'), 'password').map((f) => f.id)).toEqual(['url', 'fingerprint']);
    expect(fieldsFor(entry('proxmox'), 'token').map((f) => f.id)).toEqual(['url', 'tokenId', 'fingerprint']);
    const unraid = entry('unraid').signIn[0];
    expect(unraid?.kind === 'password' && unraid.account?.fixed).toBe('root');
    // T3 Code's pairing code needs no account (T3-02).
    const t3 = entry('t3code').signIn[0];
    expect(t3?.kind === 'password' && t3.account).toBeNull();
  });

  it('reads what a service shows into the form: Proxmox’s token dialog, OPNsense’s key file, a bare token', () => {
    expect(
      pasteValues(
        method('proxmox'),
        'Token ID\troot@pam!whombat\nSecret\t3f1c2b7a-1d2e-4f60-8a9b-0c1d2e3f4a5b\nPlease copy the secret value now.',
      ),
    ).toEqual({ tokenId: 'root@pam!whombat', secret: '3f1c2b7a-1d2e-4f60-8a9b-0c1d2e3f4a5b' });
    expect(
      pasteValues(
        method('opnsense'),
        'key=w86XNZob/8Oq8aC5r0kbNarNtdpoQU781fyoeaOBQsBwkXUt\nsecret=XeD26XVrJ5ilAc/EmglCRC+0j2e57tRsjHwFepOseySWLM53pJASeTA3\n',
      ),
    ).toEqual({
      apiKey: 'w86XNZob/8Oq8aC5r0kbNarNtdpoQU781fyoeaOBQsBwkXUt',
      secret: 'XeD26XVrJ5ilAc/EmglCRC+0j2e57tRsjHwFepOseySWLM53pJASeTA3',
    });
    expect(
      pasteValues(
        method('tailscale', 'client_credentials'),
        'Client secret: tskey-client-kXGGkt7CNTRL-abc123',
      ),
    ).toEqual({
      secret: 'tskey-client-kXGGkt7CNTRL-abc123',
    });
    expect(pasteValues(method('hetzner'), 'nothing here')).toEqual({});
    for (const e of CATALOG)
      for (const m of e.signIn) {
        if (m.kind !== 'token' && m.kind !== 'client_credentials') continue;
        for (const p of m.paste) {
          expect(
            p.target === 'secret' || e.fields.some((f) => f.id === p.target),
            `${e.id} ${p.target}`,
          ).toBe(true);
          expect(new RegExp(`${p.pattern}|`).exec('')?.length, `${e.id} ${p.pattern}`).toBe(2);
        }
        for (const link of m.kind === 'token' && m.links ? [m.links.read, m.links.manage] : [])
          for (const id of templateFields(link))
            expect(
              e.fields.some((f) => f.id === id),
              `${e.id} {${id}}`,
            ).toBe(true);
      }
  });

  it('pre-fills Cloudflare’s and GitLab’s token forms per level', () => {
    const cf = tokenOf('cloudflare').links;
    expect(decodeURIComponent(cf?.read ?? '')).toContain('{"key":"dns","type":"read"}');
    expect(decodeURIComponent(cf?.manage ?? '')).toContain('{"key":"dns","type":"edit"}');
    expect(decodeURIComponent(cf?.manage ?? '')).toContain('{"key":"access","type":"read"}');
    expect(tokenOf('gitlab').links?.read).toContain('scopes=read_api,read_repository');
    expect(tokenOf('gitlab').links?.manage).toContain('scopes=api,write_repository');
  });

  it('recognises services on the home network by one unauthenticated answer', () => {
    const probe = (id: string, i = 0) => {
      const p = entry(id).discovery?.probes[i];
      if (!p) throw new Error(`${id} has no probe ${i}`);
      return p;
    };
    const answer = (body: string, status = 200, headers: Record<string, string> = {}) => ({
      status,
      headers,
      body,
    });
    const domains = (type: string) =>
      answer(`{"data":[{"realm":"pam","type":"pam"},{"realm":"${type}","type":"${type}","comment":"x"}]}`);
    expect(probeMatches(probe('proxmox'), domains('pve'))).toBe(true);
    expect(probeMatches(probe('proxmox'), domains('pbs'))).toBe(false);
    expect(probeMatches(probe('proxmox_backup'), domains('pbs'))).toBe(true);
    const pveIndex = answer(
      '<title>pve - Proxmox Virtual Environment</title><link href="/pve2/css/ext6-pve.css?ver=9.0.10">',
    );
    expect(probeVersion(probe('proxmox', 1), pveIndex)).toBe('9.0.10');
    const portainer = answer('{"Version":"2.33.2","InstanceID":"9b1e"}');
    expect(probeMatches(probe('portainer'), portainer)).toBe(true);
    expect(probeVersion(probe('portainer'), portainer)).toBe('2.33.2');
    const grafana = answer('{"database":"ok","version":"12.2.0","commit":"abc"}');
    expect(probeMatches(probe('grafana'), grafana)).toBe(true);
    expect(probeMatches(probe('forgejo'), grafana)).toBe(false);
    expect(probeVersion(probe('forgejo'), answer('{"version":"13.0.1+gitea-1.22.0"}'))).toBe(
      '13.0.1+gitea-1.22.0',
    );
    expect(
      probeVersion(
        probe('nextcloud'),
        answer('{"installed":true,"versionstring":"31.0.2","extendedSupport":false}'),
      ),
    ).toBe('31.0.2');
    expect(probeMatches(probe('opnsense'), answer('<html>', 200, { server: 'OPNsense' }))).toBe(true);
    expect(
      probeMatches(probe('unifi_network'), answer('{"hardware":{"shortname":"UDMPRO"},"name":"Home"}')),
    ).toBe(true);
    expect(probeMatches(probe('unifi_protect', 1), answer('', 401))).toBe(true);
    expect(
      probeMatches(probe('homeassistant'), answer('{"name": "Home Assistant","short_name":"Assistant"}')),
    ).toBe(true);
    expect(discoveredUrl('https', '192.168.1.10', 8006)).toBe('https://192.168.1.10:8006');
    expect(discoveredUrl('https', '192.168.1.1', 443)).toBe('https://192.168.1.1');
    expect(discoveredUrl('http', 'fd00::5', 8123)).toBe('http://[fd00::5]:8123');
    for (const e of CATALOG)
      for (const p of e.discovery?.probes ?? []) {
        if (p.bodyPattern) expect(() => new RegExp(p.bodyPattern as string, 'i'), e.id).not.toThrow();
        if (p.version?.pattern)
          expect(() => new RegExp(p.version?.pattern as string, 'i'), e.id).not.toThrow();
      }
    expect(jsonPathValues({ data: [{ type: 'pam' }, { type: 'pve' }] }, 'data.*.type')).toEqual([
      'pam',
      'pve',
    ]);
  });

  it('keeps a connection that looks only to reads, and says so', () => {
    expect(accessTier('read', 'write', 'can')).toBe('off');
    expect(accessTier('read', 'read', 'can')).toBe('can');
    expect(accessTier('manage', 'write', 'ask')).toBe('ask');
    expect(lookOnlyText('Proxmox VE · pve.local')).toContain('set up to look only');
    expect(accessText(entry('proxmox'), 'read')).toContain('change nothing');
    expect(accessText(entry('custom_api'), 'manage')).toContain('asks you first');
    expect(
      connectionPromptLine({
        handle: 'proxmox',
        label: 'Proxmox VE',
        status: 'active',
        access: 'read',
      }),
    ).toContain('Proxmox VE (look only).');
  });
});

describe('a report tracker (report-trackers.md, TA-01, TA-02)', () => {
  it('connects a tracker’s address with an API token, read and checked by the driver it names', () => {
    const e = entry('tracker');
    expect(e).toMatchObject({
      name: 'Report tracker',
      category: 'developer',
      use: 'automations',
      transport: 'rest',
      baseUrl: '{url}',
      check: { kind: 'driver' },
      tools: [],
      request: null,
      discovery: null,
      handle: 'tracker',
    });
    expect(e.signIn.map((m) => m.kind)).toEqual(['token']);
    const token = catalogSignIn(e, 'token');
    if (token?.kind !== 'token') throw new Error('token');
    expect(token.auth).toEqual({ type: 'bearer' });
    expect(fieldsFor(e, 'token').map((f) => f.id)).toEqual(['url', 'driver', 'releaseFor']);
    // Reporters whose bug fixes go straight to production (TA-135): optional, email addresses only.
    const releaseFor = e.fields.find((f) => f.id === 'releaseFor');
    if (!releaseFor) throw new Error('releaseFor');
    expect(releaseFor.required).toBe(false);
    expect(fieldProblem(releaseFor, '')).toBeNull();
    expect(fieldProblem(releaseFor, 'ann@acme.example, Bo@Acme.example')).toBeNull();
    expect(fieldProblem(releaseFor, 'ann@acme.example; bo')).toBe('Email addresses, separated by commas.');
    expect(resolveBaseUrl(e, { url: 'https://desk.acme.example/', driver: 'acme-desk' })).toBe(
      'https://desk.acme.example',
    );
    expect(defaultConnectionLabel(e, { url: 'https://desk.acme.example' })).toBe(
      'Report tracker · desk.acme.example',
    );
    expect(handleFor('tracker', ['tracker'])).toBe('tracker-2');
  });

  it('is for automations only: no agent uses it, no request tool', () => {
    expect(isAgentConnection('tracker')).toBe(false);
    expect(isAgentConnection(entry('tracker'))).toBe(false);
    // The AI gateways aren't agents' connections either, nor is the Vault's 1Password sync.
    expect(CATALOG.filter((e) => !isAgentConnection(e)).map((e) => e.id)).toEqual([
      'onepassword',
      'tracker',
      'fusebox',
      'ai_gateway',
    ]);
    for (const id of ['homeassistant', 'gitlab', 'custom_api', 'github'])
      expect(isAgentConnection(id), id).toBe(true);
    // An entry of a newer catalog counts as an agents' entry, as every entry did before 0.69.
    expect(isAgentConnection('newer_service')).toBe(true);
    expect(hasRequestTool(entry('tracker'), 'token')).toBe(false);
  });

  it('shows how its poller is doing (TA-03), null from older runtimes', () => {
    const view = {
      id: 'con_trackerdev',
      catalogId: 'tracker',
      label: 'Acme Desk dev',
      handle: 'tracker',
      connectedBy: { id: 'prn_mara', name: 'Mara' },
      detail: 'dev.tracker.example',
      signIn: 'token',
      transport: 'rest',
      fields: { url: 'https://dev.tracker.example' },
      status: 'active',
      reauthReason: null,
      checks: [],
      checkedAt: null,
      toolCount: 0,
      createdAt: '2026-10-10T08:00:00.000Z',
      lastUsedAt: null,
    };
    expect(ConnectionView.parse(view).poller).toBeNull();
    const poller = {
      checkedAt: '2026-10-10T08:01:00.000Z',
      succeededAt: '2026-10-10T07:59:00.000Z',
      problem: 'couldn’t reach Acme Desk',
    };
    // Older runtimes don't say which installation it is (0.75, TA-32).
    expect(ConnectionView.parse({ ...view, poller }).poller).toEqual({
      ...poller,
      environment: null,
      version: null,
    });
    const health = { ...poller, environment: 'development', version: '0.1.174' };
    expect(ConnectionView.parse({ ...view, poller: health }).poller).toEqual(health);
  });
});

describe('T3 Code’s MCP tools as the entry corrects them (T3-04)', () => {
  const t3 = () => {
    const e = CATALOG.find((x) => x.id === 't3code');
    if (!e) throw new Error('t3code');
    return e;
  };

  it('hides the tools that only work inside a T3 Code thread', () => {
    for (const name of [
      'preview_open',
      't3_preview_list',
      'device_list',
      'html_render',
      'delegate_task',
      'task_status',
    ])
      expect(mcpToolHidden(t3(), name), name).toBe(true);
    for (const name of ['t3_thread_launch', 't3_thread_list', 'list_thread_pull_requests'])
      expect(mcpToolHidden(t3(), name), name).toBe(false);
  });

  it('reads a thread always, and its questions and queue only by the action', () => {
    expect(mcpToolReads(t3(), 't3_thread_read')).toBe(true);
    expect(mcpToolReads(t3(), 't3_pending_request')).toBe(false);
    expect(callAccess(t3(), 't3_pending_request', { action: 'list' })).toBe('read');
    expect(callAccess(t3(), 't3_pending_request', { action: 'respond' })).toBe('write');
    expect(callAccess(t3(), 't3_queue', { action: 'cancel' })).toBe('write');
    expect(callAccess(t3(), 't3_thread_transfer', { action: 'status' })).toBe('read');
    expect(callAccess(t3(), 't3_thread_launch', {})).toBe('write');
    // A tool the server marks as a read stays one.
    expect(callAccess(t3(), 't3_thread_list', {}, 'read')).toBe('read');
    // Questions and the queue hold reads and writes in one tool; reading a thread is only a read.
    expect(mcpToolReadsByArgs(t3(), 't3_pending_request')).toBe(true);
    expect(mcpToolReadsByArgs(t3(), 't3_queue')).toBe(true);
    expect(mcpToolReadsByArgs(t3(), 't3_thread_read')).toBe(false);
    expect(mcpToolReadsByArgs(t3(), 't3_thread_launch')).toBe(false);
  });

  it('asks only before deleting: starting, stopping and scheduling work are what it is for', () => {
    expect(isSensitiveCall(t3(), 't3_thread_launch', { projectId: 'p', title: 't' })).toBeFalsy();
    expect(isSensitiveCall(t3(), 't3_thread_interrupt', { threadId: 'thread:1' })).toBeFalsy();
    expect(
      isSensitiveCall(t3(), 't3_thread_send', { threadId: 'thread:1', message: 'go', mode: 'restart' }),
    ).toBeFalsy();
    expect(isSensitiveCall(t3(), 'schedule_task', { projectId: 'p' })).toBeFalsy();
    expect(isSensitiveCall(t3(), 't3_environment_preferences_update', {})).toBeFalsy();
    expect(isSensitiveCall(t3(), 't3_project_delete', { projectId: 'p' })).toBeTruthy();
    expect(isSensitiveCall(t3(), 'delete_scheduled_task', { taskId: 't' })).toBeTruthy();
  });
});

describe('why an entry is not offered (contracts 4.5)', () => {
  it('says a sign-in needs a secure address or the hosted page', () => {
    for (const reason of [
      'needs_secure_address',
      'hosted_only',
      'app_not_configured',
      'off',
      'no_driver',
      'needs_mac',
      null,
    ])
      expect(CatalogEntryStatus.safeParse({ catalogId: 'dropbox', available: false, reason }).success).toBe(
        true,
      );
    expect(
      CatalogEntryStatus.safeParse({ catalogId: 'dropbox', available: false, reason: 'later' }).success,
    ).toBe(false);
  });
});

describe('cookie-based session sign-ins', () => {
  const cookieAuth = TokenAuth.parse({
    type: 'session',
    login: {
      method: 'POST',
      path: '/api/v2/auth/login',
      encoding: 'form',
      body: { username: '{username}', password: '{secret}' },
    },
    tokenCookie: 'SID',
    ttlSeconds: 3600,
    apply: { type: 'cookie', name: 'SID' },
    logout: { method: 'POST', path: '/api/v2/auth/logout' },
    failures: [
      { status: [200], bodyPattern: '^\\s*Fails\\.?\\s*$', reason: 'refused' },
      { status: [403], bodyPattern: 'banned', reason: 'locked' },
    ],
  });

  it('extracts a named cookie from Set-Cookie headers, ignoring cleared or malformed values', () => {
    expect(cookieHeaderValue('SID=abc123; HttpOnly; Path=/; SameSite=Strict', 'SID')).toBe('abc123');
    expect(cookieHeaderValue(['other=1; Path=/', 'SID="quoted-tok"; Path=/'], 'SID')).toBe('quoted-tok');
    expect(cookieHeaderValue(['SID=old; Path=/', 'SID=; Max-Age=0'], 'SID')).toBeNull();
    expect(cookieHeaderValue(['SID=old; Path=/', 'SID=fresh; HttpOnly'], 'SID')).toBe('fresh');
    expect(cookieHeaderValue('sid=wrongcase; Path=/', 'SID')).toBeNull();
    expect(cookieHeaderValue(undefined, 'SID')).toBeNull();
  });

  it('reads cookie tokens, sends them in the Cookie header, and matches bodyPattern login failures', () => {
    if (cookieAuth.type !== 'session') throw new Error('expected session');
    expect(sessionAnswerToken(cookieAuth, 'Ok.', ['SID=qbt-sid-1; HttpOnly; Path=/'])).toBe('qbt-sid-1');
    expect(sessionAnswerToken(cookieAuth, 'Ok.', undefined)).toBeNull();
    expect(sessionAnswerExpiresAt(cookieAuth, 'Ok.', 1_000)).toBe(3_601_000);
    expect(sessionCredential(cookieAuth.apply, 'qbt-sid-1')).toEqual({
      headers: { Cookie: 'SID=qbt-sid-1' },
      query: {},
    });
    const req = sessionLoginRequest(entry('nginx_proxy_manager'), cookieAuth, 'pw', { username: 'admin' });
    expect(req).toEqual({
      method: 'POST',
      path: '/api/v2/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: '*/*' },
      body: 'username=admin&password=pw',
    });
    expect(sessionLoginFailure({ name: 'qBittorrent' }, cookieAuth, 'Fails.', 200)?.reason).toBe('refused');
    expect(sessionLoginFailure({ name: 'qBittorrent' }, cookieAuth, 'Ok.', 200)).toBeNull();
    expect(sessionLoginFailure({ name: 'qBittorrent' }, cookieAuth, 'User IP is banned', 403)?.reason).toBe(
      'locked',
    );
    expect(TokenAuth.safeParse({ ...cookieAuth, tokenJsonPath: 'token' }).success).toBe(false);
    expect(
      tokenAuthProblem(entry('nginx_proxy_manager'), { ...cookieAuth, tokenJsonPath: 'token' }),
    ).toContain('one of them');
  });
});
