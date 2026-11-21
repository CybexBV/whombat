/**
 * Contracts 0.97.0, more connections (Whombat connections-more.md CM-01…CM-30, CT-470…CT-487): a session sign-in, a
 * socket transport with its `call` tool, reads by a query parameter, and mail over IMAP and SMTP.
 */
import { describe, expect, it } from 'vitest';
import { api, ImapConnectBody, ImapDiscoverResponse } from '../contracts/index.js';
import { ApprovalAction } from './approval.js';
import {
  CATALOG,
  CatalogCheck,
  CatalogEntry,
  type CatalogEntryInput,
  callAccess,
  catalogEntry,
  catalogSignIn,
  fieldProblem,
  fieldsFor,
  fillLoginTemplate,
  hasRequestTool,
  hasSocketTool,
  isReadRequest,
  pasteValues,
  probeMatches,
  probeVersion,
  queryReadDecision,
  REQUEST_TOOL_NAME,
  SOCKET_STREAM_SECONDS_MAX,
  SOCKET_TOOL_NAME,
  sensitiveReason,
  sessionCredential,
  sessionExpiresAt,
  sessionToken,
  socketReads,
  socketRefused,
  socketStreams,
  socketToolDef,
  TokenAuth,
  tokenAuthProblem,
  tokenCredential,
} from './connections-catalog.js';
import {
  CONNECTOR_PROVIDER_LABELS,
  CONNECTOR_PROVIDER_SERVICES,
  CONNECTOR_PROVIDERS,
  Connection,
  ConnectorsStatus,
  connectorMissingText,
  IMAP_CONNECT_FAILURES,
  IMAP_PROVIDER_HINTS,
  ImapServerSettings,
  imapConnectFailureText,
  imapGuessSettings,
  imapProviderFor,
  imapProviderHint,
  imapServersLine,
  MailServer,
  mailDefaultPort,
  ReauthReason,
  serviceLabel,
} from './connectors.js';

const base: CatalogEntryInput = {
  id: 'sample',
  name: 'Sample',
  category: 'home',
  description: 'A sample.',
  signIn: [],
  fields: [
    { id: 'url', label: 'Address', kind: 'url', required: true },
    { id: 'username', label: 'Email', kind: 'text', required: false },
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'reach' },
  tools: [],
  request: { prefixes: ['/api/'] },
  guide: 'A sample entry for the tests.',
  sensitive: [],
  docsUrl: null,
  tokenUrl: null,
  handle: 'sample',
};
const make = (over: Partial<CatalogEntryInput>) => CatalogEntry.parse({ ...base, ...over });

const piholeAuth = TokenAuth.parse({
  type: 'session',
  login: { path: '/api/auth', body: { password: '{secret}' } },
  tokenJsonPath: 'session.sid',
  expiresJsonPath: 'session.validity',
  apply: { type: 'header', name: 'X-FTL-SID' },
  logout: { method: 'DELETE', path: '/api/auth' },
});

describe('a session sign-in (CT-470, CM-10)', () => {
  it('parses with its defaults and leaves the credential to the server', () => {
    if (piholeAuth.type !== 'session') throw new Error('session');
    expect(piholeAuth.login.method).toBe('POST');
    expect(piholeAuth.ttlSeconds).toBe(1800);
    expect(piholeAuth.apply).toEqual({ type: 'header', name: 'X-FTL-SID', template: '{token}' });
    expect(tokenCredential(make({}), piholeAuth, 'pw', { url: 'http://pi.hole' })).toBeNull();
    expect(TokenAuth.safeParse({ ...piholeAuth, ttlSeconds: 90_000 }).success).toBe(false);
    expect(TokenAuth.safeParse({ ...piholeAuth, tokenJsonPath: 'session..sid' }).success).toBe(false);
  });

  it('fills the sign-in from the secret and the fields, and puts the token where it goes', () => {
    const e = make({});
    expect(
      fillLoginTemplate(e, { identity: '{username}', secret: '{secret}' }, 'p{url}w', {
        url: 'http://npm.lan:81',
        username: 'whombat@example.com',
      }),
    ).toEqual({ identity: 'whombat@example.com', secret: 'p{url}w' });
    expect(fillLoginTemplate(e, ['{secret}', { nested: ['{username}'] }, 3], 's', { username: 'u' })).toEqual(
      ['s', { nested: ['u'] }, 3],
    );
    expect(fillLoginTemplate(e, { identity: '{username}' }, 's', {})).toBeNull();
    expect(sessionCredential({ type: 'bearer' }, 't')).toEqual({
      headers: { Authorization: 'Bearer t' },
      query: {},
    });
    expect(
      sessionCredential({ type: 'header', name: 'X-FTL-SID', template: '{token}' }, 't').headers,
    ).toEqual({
      'X-FTL-SID': 't',
    });
    expect(sessionCredential({ type: 'query', name: 'sid' }, 't').query).toEqual({ sid: 't' });
  });

  it('reads the token and its lifetime from the answer, at most a day', () => {
    if (piholeAuth.type !== 'session') throw new Error('session');
    const now = Date.parse('2026-10-19T10:00:00Z');
    const answer = { session: { valid: true, sid: 'abc', validity: 300 } };
    expect(sessionToken(piholeAuth, answer)).toBe('abc');
    expect(sessionToken(piholeAuth, { session: { valid: false, sid: null } })).toBeNull();
    expect(sessionExpiresAt(piholeAuth, answer, now)).toBe(now + 300_000);
    expect(sessionExpiresAt(piholeAuth, {}, now)).toBe(now + 1_800_000);
    const npm = TokenAuth.parse({
      type: 'session',
      login: { path: '/api/tokens', body: { identity: '{username}', secret: '{secret}' } },
      tokenJsonPath: 'token',
      expiresJsonPath: 'expires',
      ttlSeconds: 86_400,
      apply: { type: 'bearer' },
    });
    if (npm.type !== 'session') throw new Error('session');
    expect(sessionExpiresAt(npm, { token: 't', expires: '2026-10-19T12:00:00.000Z' }, now)).toBe(
      Date.parse('2026-10-19T12:00:00Z'),
    );
    expect(sessionExpiresAt(npm, { token: 't', expires: '2027-01-01T00:00:00Z' }, now)).toBe(
      now + 86_400_000,
    );
    expect(sessionExpiresAt(npm, { token: 't', expires: '2020-01-01T00:00:00Z' }, now)).toBe(now);
  });

  it('refuses a session shape that can’t work', () => {
    const e = make({});
    expect(tokenAuthProblem(e, piholeAuth)).toBeNull();
    const without = TokenAuth.parse({ ...piholeAuth, login: { path: '/api/auth', body: { password: 'x' } } });
    expect(tokenAuthProblem(e, without)).toContain('{secret}');
    const unknown = TokenAuth.parse({
      ...piholeAuth,
      login: { path: '/api/auth', body: { password: '{secret}', user: '{nope}' } },
    });
    expect(tokenAuthProblem(e, unknown)).toContain('{nope}');
    const cookie = TokenAuth.parse({
      ...piholeAuth,
      apply: { type: 'header', name: 'Cookie', template: 'sid={token}' },
    });
    expect(tokenAuthProblem(e, cookie)).toContain('header');
    const noToken = TokenAuth.parse({
      ...piholeAuth,
      apply: { type: 'header', name: 'X-FTL-SID', template: 'x' },
    });
    expect(tokenAuthProblem(e, noToken)).toContain('{token}');
  });
});

const socketEntry = make({
  transport: 'socket',
  request: null,
  check: { kind: 'socket', method: 'system.info', version: 'version' },
  socket: {
    dialect: 'jsonrpc',
    path: '/api/current',
    login: { method: 'auth.login_with_api_key', params: ['{secret}'], when: 'always' },
    reads: ['[a-z_.]+\\.query', 'system\\.info', 'devices/logs'],
    streams: ['devices/logs'],
    refused: ['auth\\..*', 'core\\.(un)?subscribe'],
    missing: 'This sample is too old: update it, then connect it.',
  },
  sensitive: [
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^system\\.(reboot|shutdown)$',
      reason: 'Restarts it',
    },
  ],
});

describe('a socket transport and its call tool (CT-471, CT-472, CM-13…CM-16)', () => {
  it('parses a socket entry and a socket check; REST entries get none', () => {
    expect(socketEntry.socket?.dialect).toBe('jsonrpc');
    expect(make({}).socket).toBeNull();
    expect(hasSocketTool(socketEntry, 'token')).toBe(true);
    expect(hasRequestTool(socketEntry, 'token')).toBe(false);
    expect(hasSocketTool(make({}), 'token')).toBe(false);
    expect(CatalogCheck.safeParse({ kind: 'socket', method: 'config/version', params: {} }).success).toBe(
      true,
    );
    expect(CatalogCheck.safeParse({ kind: 'socket', method: '' }).success).toBe(false);
  });

  it('reads, streams and refuses methods by their whole name', () => {
    expect(socketReads(socketEntry, 'pool.query')).toBe(true);
    expect(socketReads(socketEntry, 'pool.dataset.query')).toBe(true);
    expect(socketReads(socketEntry, 'pool.query_x')).toBe(false);
    expect(socketReads(socketEntry, 'pool.export')).toBe(false);
    expect(socketStreams(socketEntry, 'devices/logs')).toBe(true);
    expect(socketStreams(socketEntry, 'pool.query')).toBe(false);
    expect(socketRefused(socketEntry, 'auth.login_with_api_key')).toBe(true);
    expect(socketRefused(socketEntry, 'core.subscribe')).toBe(true);
    expect(socketRefused(socketEntry, 'core.get_jobs')).toBe(false);
    // A refused method is never a read, and a REST entry has no socket methods at all.
    const spec = socketEntry.socket;
    if (!spec) throw new Error('socket');
    expect(socketReads(make({ ...socketEntry, socket: { ...spec, reads: ['auth\\..*'] } }), 'auth.me')).toBe(
      false,
    );
    expect(socketRefused(make({}), 'pool.query')).toBe(true);
  });

  it('decides a call’s access by its method and asks for deleting and the entry’s rules', () => {
    expect(callAccess(socketEntry, SOCKET_TOOL_NAME, { method: 'system.info' })).toBe('read');
    expect(callAccess(socketEntry, SOCKET_TOOL_NAME, { method: 'pool.scrub.run' })).toBe('write');
    expect(callAccess(socketEntry, SOCKET_TOOL_NAME, {})).toBe('write');
    expect(
      sensitiveReason(socketEntry, SOCKET_TOOL_NAME, { method: 'pool.dataset.delete', params: ['tank/x'] }),
    ).toBe('Deletes something');
    expect(sensitiveReason(socketEntry, SOCKET_TOOL_NAME, { method: 'system.reboot' })).toBe('Restarts it');
    expect(
      sensitiveReason(socketEntry, SOCKET_TOOL_NAME, { method: 'pool.query', params: ['system.reboot'] }),
    ).toBeNull();
    expect(sensitiveReason(socketEntry, SOCKET_TOOL_NAME, { method: 'pool.scrub.run' })).toBeNull();
  });

  it('describes the call tool from the spec', () => {
    const def = socketToolDef(socketEntry, 'https://nas.lan');
    expect(def.name).toBe('call');
    expect(def.access).toBe('write');
    expect(def.description).toContain('https://nas.lan');
    expect(def.description).toContain('devices/logs');
    expect(def.description).not.toContain('\\');
    expect(def.description.length).toBeLessThanOrEqual(1000);
    expect(def.inputSchema.required).toEqual(['method']);
    const props = def.inputSchema.properties as Record<string, { maximum?: number }>;
    expect(Object.keys(props)).toEqual(['method', 'params', 'seconds']);
    expect(props.seconds?.maximum).toBe(SOCKET_STREAM_SECONDS_MAX);
  });
});

describe('reads by a query parameter (CT-473, CM-18)', () => {
  const sab = make({
    request: {
      prefixes: ['/api'],
      queryReads: [
        {
          name: 'mode',
          values: ['queue', 'history', 'version'],
          writes: [{ name: 'name', values: ['delete', 'pause'] }],
        },
      ],
    },
  });

  it('reads only with a read value and no write beside it', () => {
    expect(isReadRequest(sab, 'GET', '/api', undefined, { mode: 'queue', output: 'json' })).toBe(true);
    expect(
      isReadRequest(sab, 'GET', '/api', undefined, { mode: 'queue', name: 'delete', value: 'SABnzbd_nzo_1' }),
    ).toBe(false);
    expect(isReadRequest(sab, 'GET', '/api', undefined, { mode: 'history', name: 'DELETE' })).toBe(false);
    expect(isReadRequest(sab, 'GET', '/api', undefined, { mode: 'shutdown' })).toBe(false);
    expect(isReadRequest(sab, 'GET', '/api', undefined, { mode: 'Queue' })).toBe(false);
    expect(isReadRequest(sab, 'GET', '/api', undefined, { mode: ['queue', 'restart'] })).toBe(false);
    expect(isReadRequest(sab, 'POST', '/api', undefined, { mode: 'version' })).toBe(true);
    // Without the parameter the method decides, as before.
    expect(isReadRequest(sab, 'GET', '/api', undefined, {})).toBe(true);
    expect(isReadRequest(sab, 'POST', '/api')).toBe(false);
    expect(queryReadDecision(sab, { other: 'x' })).toBeNull();
  });

  it('passes the call’s query through callAccess', () => {
    expect(callAccess(sab, 'request', { method: 'GET', path: '/api', query: { mode: 'history' } })).toBe(
      'read',
    );
    expect(callAccess(sab, 'request', { method: 'GET', path: '/api', query: { mode: 'addurl' } })).toBe(
      'write',
    );
  });
});

describe('a url field’s own rule (CT-474)', () => {
  it('checks the address first, then the pattern', () => {
    const field = {
      id: 'url',
      label: 'Address',
      kind: 'url',
      required: true,
      validation: { pattern: 'https://.*', message: 'Use its https address.' },
    } as const;
    expect(fieldProblem(field, 'https://nas.lan')).toBeNull();
    expect(fieldProblem(field, 'http://nas.lan')).toBe('Use its https address.');
    expect(fieldProblem(field, 'nas')).not.toBe('Use its https address.');
    expect(fieldProblem({ ...field, validation: undefined }, 'http://nas.lan')).toBeNull();
  });
});

describe('mail over IMAP and SMTP (CT-480…CT-485, CM-19…CM-27)', () => {
  it('is a third provider, mail only, with neutral names', () => {
    expect(CONNECTOR_PROVIDERS).toContain('imap');
    expect(CONNECTOR_PROVIDER_LABELS.imap).toBe('Email (IMAP)');
    expect(CONNECTOR_PROVIDER_SERVICES.imap).toEqual(['mail']);
    expect(CONNECTOR_PROVIDER_SERVICES.google).toHaveLength(6);
    expect(CONNECTOR_PROVIDER_SERVICES.microsoft).not.toContain('docs');
    expect(serviceLabel('mail', 'imap')).toBe('Mail');
    expect(serviceLabel('mail', 'google')).toBe('Gmail');
    expect(connectorMissingText('Mara', 'mail', 'imap')).toContain('Mail');
    expect(ReauthReason.parse('password_refused')).toBe('password_refused');
  });

  it('keeps the servers lower case, with TLS or STARTTLS only', () => {
    expect(MailServer.parse({ host: ' IMAP.Fastmail.com ', port: 993, security: 'tls' }).host).toBe(
      'imap.fastmail.com',
    );
    expect(MailServer.safeParse({ host: 'imap.example.com', port: 143, security: 'none' }).success).toBe(
      false,
    );
    expect(MailServer.safeParse({ host: 'imap example', port: 993, security: 'tls' }).success).toBe(false);
    expect(MailServer.safeParse({ host: '[fd00::5]', port: 993, security: 'tls' }).success).toBe(true);
    const guess = imapGuessSettings('Mara@Example.org');
    expect(guess?.imap).toEqual({ host: 'imap.example.org', port: 993, security: 'tls' });
    expect(guess?.smtp).toEqual({ host: 'smtp.example.org', port: 587, security: 'starttls' });
    expect(guess?.username).toBeNull();
    expect(ImapServerSettings.parse({ imap: guess?.imap, smtp: guess?.smtp }).username).toBeNull();
    expect(imapGuessSettings('nobody')).toBeNull();
    expect([mailDefaultPort('imap', 'tls'), mailDefaultPort('imap', 'starttls')]).toEqual([993, 143]);
    expect([mailDefaultPort('smtp', 'tls'), mailDefaultPort('smtp', 'starttls')]).toEqual([465, 587]);
    expect(imapServersLine({ imapHost: 'imap.fastmail.com', smtpHost: 'smtp.fastmail.com' })).toBe(
      'imap.fastmail.com and smtp.fastmail.com',
    );
    expect(imapServersLine({ imapHost: 'mail.example.org', smtpHost: 'mail.example.org' })).toBe(
      'mail.example.org',
    );
  });

  it('knows providers by domain and by MX host, and says what to do', () => {
    expect(imapProviderFor('mara@gmail.com')?.useInstead).toBe('google');
    expect(imapProviderFor('mara@hotmail.com')?.useInstead).toBe('microsoft');
    expect(imapProviderFor('mara@example.org', ['aspmx.l.google.com.'])?.id).toBe('google');
    expect(imapProviderFor('mara@example.org', ['example-org.mail.protection.outlook.com'])?.id).toBe(
      'microsoft',
    );
    expect(imapProviderFor('mara@example.org', ['in1-smtp.messagingengine.com'])?.id).toBe('fastmail');
    expect(imapProviderFor('mara@icloud.com')?.url).toMatch(/^https:\/\//);
    expect(imapProviderFor('mara@proton.me')?.text).toContain('Bridge');
    expect(imapProviderFor('mara@example.org', ['mx.example.org'])).toBeNull();
    // A subdomain of a provider's domain isn't that provider.
    expect(imapProviderFor('mara@mail.gmail.com.example')).toBeNull();
    for (const p of IMAP_PROVIDER_HINTS) {
      expect(p.text, p.id).not.toMatch(/'/);
      expect(p.domains.length + p.mx.length, p.id).toBeGreaterThan(0);
      for (const suffix of p.mx) expect(suffix.startsWith('.'), p.id).toBe(true);
    }
    const saving = IMAP_PROVIDER_HINTS.filter((p) => p.savesSent).map((p) => p.id);
    expect(saving).toEqual(expect.arrayContaining(['google', 'microsoft']));
    const hint = imapProviderHint(IMAP_PROVIDER_HINTS[0] as (typeof IMAP_PROVIDER_HINTS)[number]);
    expect(Object.keys(hint).sort()).toEqual(['name', 'text', 'url', 'useInstead']);
    expect(
      ImapDiscoverResponse.parse({ settings: imapGuessSettings('mara@gmail.com'), source: 'guess', hint })
        .hint?.useInstead,
    ).toBe('google');
  });

  it('says which side failed, in words', () => {
    expect(IMAP_CONNECT_FAILURES).toEqual([
      'imap_refused',
      'imap_unreachable',
      'smtp_refused',
      'smtp_unreachable',
      'not_allowed',
      'certificate',
    ]);
    expect(imapConnectFailureText('imap_refused')).toContain('app password');
    expect(imapConnectFailureText('smtp_unreachable', { host: 'smtp.example.com', port: 587 })).toContain(
      'smtp.example.com on port 587',
    );
    for (const reason of IMAP_CONNECT_FAILURES) expect(imapConnectFailureText(reason)).not.toMatch(/'/);
  });

  it('connects through two account ops, the connect one a secret', () => {
    expect(api.connectors.imapDiscover.id).toBe('connectors.imapDiscover');
    expect(api.connectors.imapConnect.method).toBe('POST');
    expect(ImapConnectBody.safeParse({ email: 'mara@example.org', password: 'app-pass' }).success).toBe(true);
    expect(ImapConnectBody.safeParse({ email: 'mara', password: 'x' }).success).toBe(false);
  });

  it('shows the account’s servers and leaves them out for Google', () => {
    const T = '2026-10-19T10:00:00.000Z';
    const imap = {
      id: 'con_imap1',
      provider: 'imap',
      email: 'mara@example.org',
      name: 'Mara',
      services: ['mail'],
      status: 'active',
      reauthReason: null,
      checks: [
        {
          service: 'mail',
          state: 'error',
          side: 'smtp',
          message: 'Whombat couldn’t reach smtp.example.org.',
        },
      ],
      createdAt: T,
      updatedAt: T,
      lastUsedAt: null,
      mail: { imapHost: 'imap.example.org', smtpHost: 'smtp.example.org', username: 'mara@example.org' },
    };
    const parsed = Connection.parse(imap);
    expect(parsed.mail?.smtpHost).toBe('smtp.example.org');
    expect(parsed.checks[0]?.side).toBe('smtp');
    expect(Connection.parse({ ...imap, provider: 'google', mail: undefined }).mail).toBeUndefined();
    expect(ConnectorsStatus.shape.imap.safeParse(undefined).success).toBe(true);
  });

  it('asks the owner before sending from an IMAP account, as for Gmail', () => {
    const action = ApprovalAction.parse({
      type: 'mail_send',
      params: {
        provider: 'imap',
        connectionEmail: 'mara@example.org',
        to: ['ben@example.org'],
        subject: 'Hi',
        bodyPreview: 'Hello',
        draftId: 'ZHJhZnQ',
      },
    });
    expect(action.type === 'mail_send' && action.params.provider).toBe('imap');
  });
});

const entry = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(`no entry ${id}`);
  return e;
};

const NEW_ENTRIES = {
  unifi_access: ['home', 'rest'],
  sabnzbd: ['home', 'rest'],
  nzbhydra: ['home', 'rest'],
  plex: ['home', 'rest'],
  overseerr: ['home', 'rest'],
  adguard: ['home', 'rest'],
  pihole: ['home', 'rest'],
  nginx_proxy_manager: ['infrastructure', 'rest'],
  truenas: ['infrastructure', 'socket'],
  esphome: ['home', 'socket'],
  pterodactyl: ['infrastructure', 'rest'],
  // Signed in with Airtable's own MCP server first since 0.111 (CT-748); the token stays REST.
  airtable: ['productivity', 'mcp'],
  hubspot: ['business', 'rest'],
  pipedrive: ['business', 'rest'],
  plausible: ['business', 'rest'],
} as const;

describe('fifteen new connections and Email (IMAP) (CT-476…CT-479, CT-486; CM-01…CM-09)', () => {
  it('lists each in its group, with its transport', () => {
    for (const [id, [category, transport]] of Object.entries(NEW_ENTRIES)) {
      const e = entry(id);
      expect(e.category, id).toBe(category);
      expect(e.transport, id).toBe(transport);
      expect(e.access, id).not.toBeNull();
      expect(e.docsUrl, id).toMatch(/^https:\/\//);
      if (transport === 'socket') {
        expect(e.request, id).toBeNull();
        expect(e.socket?.missing, id).toMatch(/update/);
        expect(e.check?.kind, id).toBe('socket');
      } else expect(e.socket, id).toBeNull();
      // Pasted keys are guided (CM-02).
      for (const m of e.signIn) if (m.kind === 'token') expect(m.steps.length, id).toBeGreaterThan(0);
    }
    const imap = entry('imap');
    expect([imap.transport, imap.category]).toEqual(['builtin', 'accounts']);
    const ids = CATALOG.map((e) => e.id);
    expect(ids.indexOf('imap')).toBe(ids.indexOf('microsoft') + 1);
  });

  it('writes the steps, levels and too-old sentences in plain words with curly quotes', () => {
    for (const id of [...Object.keys(NEW_ENTRIES), 'imap']) {
      const e = entry(id);
      const words = [e.description, e.access?.read ?? '', e.access?.manage ?? '', e.socket?.missing ?? ''];
      for (const m of e.signIn) {
        words.push(m.label);
        if (m.kind === 'token') {
          words.push(m.secretLabel, m.secretHelp, ...m.steps.map((st) => st.text));
          if (m.auth.type === 'session') words.push(m.auth.missing ?? '');
        }
        if (m.kind === 'password')
          words.push(
            m.creates,
            m.account?.label ?? '',
            m.account?.help ?? '',
            m.secret?.label ?? '',
            m.secret?.help ?? '',
          );
      }
      for (const w of words) expect(w, id).not.toMatch(/'/);
      for (const r of e.sensitive) expect(r.reason, id).not.toMatch(/'/);
    }
  });

  it('signs each in as its service wants', () => {
    expect(entry('plex').signIn.map((m) => m.kind)).toEqual(['service_login', 'token']);
    expect(entry('esphome').signIn.map((m) => m.kind)).toEqual(['none', 'token']);
    expect(fieldsFor(entry('esphome'), 'none').map((f) => f.id)).toEqual(['url', 'fingerprint']);
    const auth = (id: string) => {
      const m = catalogSignIn(entry(id), 'token');
      if (m?.kind !== 'token') throw new Error(`${id} token`);
      return m.auth;
    };
    expect(auth('sabnzbd')).toEqual({ type: 'query', name: 'apikey' });
    expect(auth('nzbhydra')).toEqual({ type: 'query', name: 'apikey' });
    expect(auth('plex')).toMatchObject({ type: 'header', name: 'X-Plex-Token' });
    expect(auth('overseerr')).toMatchObject({ type: 'header', name: 'X-Api-Key' });
    expect(auth('pipedrive')).toMatchObject({ type: 'header', name: 'x-api-token' });
    expect(auth('adguard')).toEqual({ type: 'basic', usernameField: 'username' });
    for (const id of ['unifi_access', 'pterodactyl', 'airtable', 'hubspot', 'plausible'])
      expect(auth(id), id).toEqual({ type: 'bearer' });
    const pihole = auth('pihole');
    expect(pihole.type === 'session' && [pihole.login.path, pihole.tokenJsonPath, pihole.apply]).toEqual([
      '/api/auth',
      'session.sid',
      { type: 'header', name: 'X-FTL-SID', template: '{token}' },
    ]);
    expect(pihole.type === 'session' && pihole.logout).toEqual({ method: 'DELETE', path: '/api/auth' });
    expect(pihole.type === 'session' && pihole.missing).toContain('version 6');
    const npm = auth('nginx_proxy_manager');
    expect(npm.type === 'session' && [npm.login.body, npm.apply.type, npm.ttlSeconds]).toEqual([
      { identity: '{username}', secret: '{secret}' },
      'bearer',
      86_400,
    ]);
    expect(entry('truenas').socket?.login).toEqual({
      method: 'auth.login_with_api_key',
      params: ['{secret}'],
      when: 'always',
    });
    expect(entry('esphome').socket?.login?.when).toBe('asked');
    // Plex: signed in on Plex's own page since 0.111 (CT-739; SG-04), stored as the Plex token; Accept JSON always.
    const plex = entry('plex').signIn[0];
    expect(plex?.kind === 'service_login' && plex.tokenMethod).toBe(0);
    expect(entry('plex').request?.headers).toEqual({ Accept: 'application/json' });
  });

  it('reads Plex’s version from its MediaContainer, not the XML declaration', () => {
    const pattern = entry('plex').discovery?.probes[0]?.version?.pattern;
    if (!pattern) throw new Error('plex version pattern');
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="0" apiVersion="1.2.3" claimed="1" machineIdentifier="d2cc" version="1.43.4.10903-e5521bd8c">\n</MediaContainer>';
    expect(new RegExp(pattern, 'i').exec(body)?.[1]).toBe('1.43.4.10903-e5521bd8c');
  });

  it('refuses TrueNAS over plain http and reads what people paste', () => {
    const url = entry('truenas').fields.find((f) => f.id === 'url');
    if (!url) throw new Error('url');
    expect(fieldProblem(url, 'http://nas.lan')).toContain('http');
    expect(fieldProblem(url, 'https://nas.lan')).toBeNull();
    const token = (id: string) => {
      const m = catalogSignIn(entry(id), 'token');
      if (m?.kind !== 'token') throw new Error(`${id} token`);
      return m;
    };
    expect(
      pasteValues(token('plex'), 'https://app.plex.tv/library/metadata/1?X-Plex-Token=AbCdEfGhIjKlMnOpQrSt'),
    ).toEqual({ secret: 'AbCdEfGhIjKlMnOpQrSt' });
    const key = `12-${'a1B2'.repeat(16)}`;
    expect(pasteValues(token('truenas'), `API Key\n${key}\nCopy to Clipboard`)).toEqual({ secret: key });
    const ptlc = `ptlc_${'x'.repeat(43)}`;
    expect(pasteValues(token('pterodactyl'), ptlc)).toEqual({ secret: ptlc });
    expect(pasteValues(token('sabnzbd'), 'API Key 0123456789abcdef0123456789abcdef')).toEqual({
      secret: '0123456789abcdef0123456789abcdef',
    });
  });

  it('decides reads by the query, the method or the path', () => {
    const sab = entry('sabnzbd');
    expect(
      callAccess(sab, REQUEST_TOOL_NAME, { method: 'GET', path: '/api', query: { mode: 'queue' } }),
    ).toBe('read');
    expect(
      callAccess(sab, REQUEST_TOOL_NAME, {
        method: 'GET',
        path: '/api',
        query: { mode: 'queue', name: 'delete', value: 'SABnzbd_nzo_x' },
      }),
    ).toBe('write');
    expect(
      callAccess(sab, REQUEST_TOOL_NAME, { method: 'GET', path: '/api', query: { mode: 'get_config' } }),
    ).toBe('write');
    const hydra = entry('nzbhydra');
    expect(isReadRequest(hydra, 'GET', '/api', undefined, { t: 'search', q: 'ubuntu' })).toBe(true);
    expect(isReadRequest(hydra, 'GET', '/api', undefined, { t: 'get', id: 'x' })).toBe(false);
    const nas = entry('truenas');
    for (const m of [
      'pool.query',
      'pool.dataset.query',
      'system.info',
      'core.get_jobs',
      'auth.me',
      'zfs.snapshot.query',
    ])
      expect(socketReads(nas, m), m).toBe(true);
    for (const m of ['certificate.query', 'keychaincredential.query', 'pool.snapshot.create', 'pool.export'])
      expect(socketReads(nas, m), m).toBe(false);
    for (const m of [
      'auth.login_with_api_key',
      'core.subscribe',
      'core.download',
      'user.setup_local_administrator',
    ])
      expect(socketRefused(nas, m), m).toBe(true);
    expect(socketRefused(nas, 'auth.me')).toBe(false);
    const esp = entry('esphome');
    for (const m of ['devices/list', 'devices/get_config', 'devices/logs', 'config/version'])
      expect(socketReads(esp, m), m).toBe(true);
    expect(socketStreams(esp, 'devices/logs')).toBe(true);
    expect(socketReads(esp, 'firmware/install')).toBe(false);
    for (const m of [
      'auth/login',
      'auth',
      'subscribe_events',
      'firmware/follow_jobs',
      'devices/subscribe_reachability',
    ])
      expect(socketRefused(esp, m), m).toBe(true);
    expect(isReadRequest(entry('unifi_access'), 'POST', '/api/v1/developer/system/logs')).toBe(true);
    expect(isReadRequest(entry('airtable'), 'POST', '/v0/appX/Tasks/listRecords')).toBe(true);
    expect(isReadRequest(entry('hubspot'), 'POST', '/crm/objects/2026-09/contacts/search')).toBe(true);
    expect(isReadRequest(entry('plausible'), 'POST', '/api/v2/query')).toBe(true);
  });

  it('asks first for what is risky, and only that (CM-03)', () => {
    const ask = (id: string, tool: string, args: Record<string, unknown>) => {
      const e = entry(id);
      return sensitiveReason(e, tool, args, { access: callAccess(e, tool, args) });
    };
    const req = (method: string, path: string, more: Record<string, unknown> = {}) => ({
      method,
      path,
      ...more,
    });
    expect(ask('unifi_access', 'request', req('PUT', '/api/v1/developer/doors/d1/unlock'))).toContain(
      'Unlocks',
    );
    expect(
      ask('unifi_access', 'request', req('PUT', '/api/v1/developer/doors/settings/emergency')),
    ).not.toBeNull();
    expect(
      ask('unifi_access', 'request', req('POST', '/api/v1/developer/users/u1/nfc_cards')),
    ).not.toBeNull();
    expect(ask('unifi_access', 'request', req('GET', '/api/v1/developer/doors'))).toBeNull();
    expect(
      ask(
        'sabnzbd',
        'request',
        req('GET', '/api', { query: { mode: 'history', name: 'delete', value: 'all' } }),
      ),
    ).not.toBeNull();
    expect(ask('sabnzbd', 'request', req('GET', '/api', { query: { mode: 'shutdown' } }))).not.toBeNull();
    expect(ask('sabnzbd', 'request', req('GET', '/api', { query: { mode: 'get_config' } }))).not.toBeNull();
    expect(ask('sabnzbd', 'request', req('GET', '/api', { query: { mode: 'queue' } }))).toBeNull();
    expect(
      ask('sabnzbd', 'request', req('GET', '/api', { query: { mode: 'addurl', name: 'https://x/a.nzb' } })),
    ).toBeNull();
    expect(
      ask('pihole', 'request', req('POST', '/api/dns/blocking', { body: { blocking: false } })),
    ).toContain('blocking off');
    expect(
      ask('pihole', 'request', req('POST', '/api/dns/blocking', { body: '{"blocking": true}' })),
    ).toBeNull();
    expect(ask('pihole', 'request', req('POST', '/api/teleporter'))).not.toBeNull();
    expect(
      ask(
        'pihole',
        'request',
        req('PATCH', '/api/config', { body: { config: { webserver: { api: { password: 'x' } } } } }),
      ),
    ).not.toBeNull();
    expect(
      ask('pihole', 'request', req('PATCH', '/api/config', { body: { config: { dns: { upstreams: [] } } } })),
    ).toBeNull();
    expect(
      ask('adguard', 'request', req('POST', '/control/protection', { body: { enabled: false } })),
    ).not.toBeNull();
    expect(
      ask('adguard', 'request', req('POST', '/control/protection', { body: { enabled: true } })),
    ).toBeNull();
    expect(
      ask(
        'pterodactyl',
        'request',
        req('POST', '/api/client/servers/ab12cd34/power', { body: { signal: 'kill' } }),
      ),
    ).not.toBeNull();
    expect(
      ask(
        'pterodactyl',
        'request',
        req('POST', '/api/client/servers/ab12cd34/power', { body: { signal: 'stop' } }),
      ),
    ).toBeNull();
    expect(
      ask('pterodactyl', 'request', req('POST', '/api/client/servers/ab12cd34/files/delete')),
    ).not.toBeNull();
    expect(ask('nginx_proxy_manager', 'request', req('PUT', '/api/users/2/permissions'))).not.toBeNull();
    expect(ask('nginx_proxy_manager', 'request', req('POST', '/api/nginx/proxy-hosts'))).toBeNull();
    expect(ask('plex', 'request', req('PUT', '/library/sections/1/emptyTrash'))).not.toBeNull();
    expect(ask('plex', 'request', req('DELETE', '/library/metadata/42'))).toBe('Deletes something');
    expect(ask('overseerr', 'request', req('POST', '/api/v1/settings/main'))).not.toBeNull();
    expect(ask('overseerr', 'request', req('POST', '/api/v1/request'))).toBeNull();
    expect(
      ask('hubspot', 'request', req('POST', '/crm/objects/2026-09/contacts/batch/archive')),
    ).not.toBeNull();
    expect(ask('hubspot', 'request', req('POST', '/crm/v3/objects/contacts/merge'))).not.toBeNull();
    expect(ask('pipedrive', 'request', req('PUT', '/v1/persons/5/merge'))).not.toBeNull();
    expect(ask('plausible', 'request', req('DELETE', '/api/v1/sites/example.com'))).toBe('Deletes something');
    const call = (method: string, params: unknown = []) => ({ method, params });
    expect(ask('truenas', SOCKET_TOOL_NAME, call('pool.export', [1, { destroy: true }]))).not.toBeNull();
    expect(ask('truenas', SOCKET_TOOL_NAME, call('pool.dataset.delete', ['tank/old']))).toBe(
      'Deletes something',
    );
    expect(ask('truenas', SOCKET_TOOL_NAME, call('zfs.snapshot.rollback', ['tank/a@b']))).not.toBeNull();
    expect(ask('truenas', SOCKET_TOOL_NAME, call('system.reboot', ['update']))).not.toBeNull();
    expect(ask('truenas', SOCKET_TOOL_NAME, call('service.control', ['START', 'ssh']))).not.toBeNull();
    expect(ask('truenas', SOCKET_TOOL_NAME, call('filesystem.setperm', [{}]))).not.toBeNull();
    expect(
      ask('truenas', SOCKET_TOOL_NAME, call('pool.snapshot.create', [{ dataset: 'tank/a', name: 'x' }])),
    ).toBeNull();
    expect(ask('truenas', SOCKET_TOOL_NAME, call('user.query', [[['username', '=', 'root']]]))).toBeNull();
    expect(
      ask('esphome', SOCKET_TOOL_NAME, call('firmware/install', { configuration: 'kitchen.yaml' })),
    ).not.toBeNull();
    expect(
      ask('esphome', SOCKET_TOOL_NAME, call('devices/delete', { configuration: 'kitchen.yaml' })),
    ).not.toBeNull();
    expect(
      ask('esphome', SOCKET_TOOL_NAME, call('config/set_wifi_credentials', { ssid: 'x' })),
    ).not.toBeNull();
    // Reading secrets.yaml asks even though get_config is a read; another device's config doesn't.
    expect(
      ask('esphome', SOCKET_TOOL_NAME, call('devices/get_config', { configuration: 'secrets.yaml' })),
    ).not.toBeNull();
    expect(
      ask('esphome', SOCKET_TOOL_NAME, call('devices/get_config', { configuration: 'kitchen.yaml' })),
    ).toBeNull();
    expect(
      ask('esphome', SOCKET_TOOL_NAME, call('firmware/compile', { configuration: 'kitchen.yaml' })),
    ).toBeNull();
  });

  it('finds each home-network service by an answer that sends no credential (CM-04)', () => {
    const home = Object.keys(NEW_ENTRIES).filter(
      (id) => !['airtable', 'hubspot', 'pipedrive', 'plausible'].includes(id),
    );
    for (const id of home) {
      const d = entry(id).discovery;
      expect(d, id).not.toBeNull();
      for (const p of d?.probes ?? [])
        expect(
          Object.keys(p.headers ?? {}).map((h) => h.toLowerCase()),
          id,
        ).not.toContain('authorization');
    }
    const probe = (id: string, i = 0) => {
      const p = entry(id).discovery?.probes[i];
      if (!p) throw new Error(`${id} probe ${i}`);
      return p;
    };
    const answer = (body: string, status = 200, headers: Record<string, string> = {}) => ({
      status,
      headers,
      body,
    });
    const esp = answer('{"version":"2026.6.5"}');
    expect(probeMatches(probe('esphome'), esp)).toBe(true);
    expect(probeVersion(probe('esphome'), esp)).toBe('2026.6.5');
    const plex = answer(
      '<MediaContainer size="0" apiVersion="1.2.3" claimed="1" machineIdentifier="abc" version="1.43.4.10903-e5521bd8c">',
      200,
      { 'x-plex-protocol': '1.0' },
    );
    expect(probeMatches(probe('plex'), plex)).toBe(true);
    expect(probeVersion(probe('plex'), plex)).toBe('1.43.4.10903-e5521bd8c');
    const seerr = answer('{"version":"1.35.0","commitTag":"v1.35.0","updateAvailable":false}', 200, {
      'x-powered-by': 'Express',
    });
    expect(probeMatches(probe('overseerr'), seerr)).toBe(true);
    expect(probeVersion(probe('overseerr'), seerr)).toBe('1.35.0');
    const sab = answer('{"version":"4.5.5"}', 200, { server: 'CherryPy/18.10.0' });
    expect(probeMatches(probe('sabnzbd'), sab)).toBe(true);
    expect(probeVersion(probe('sabnzbd'), sab)).toBe('4.5.5');
    expect(probeMatches(probe('sabnzbd'), answer('{"version":"4.5.5"}'))).toBe(false);
    expect(
      probeMatches(
        probe('unifi_access'),
        answer(
          '{"code":"CODE_UNAUTHORIZED","msg":"You do not have permission to perform this action."}',
          401,
        ),
      ),
    ).toBe(true);
    expect(
      probeMatches(probe('pihole'), answer('{"session":{"valid":false,"totp":false,"sid":null}}', 401)),
    ).toBe(true);
    expect(probeMatches(probe('truenas'), answer('["v25.04.0","v25.04.1","v25.04.2"]'))).toBe(true);
    expect(
      probeMatches(
        probe('nginx_proxy_manager'),
        answer('{"status":"OK","setup":true,"version":{"major":2,"minor":16,"revision":0}}'),
      ),
    ).toBe(true);
  });
});
