/**
 * Email (IMAP) end to end (docs/decisions/connections-more.md CM-19…CM-27, connections-more-mail.md): finding and
 * connecting a mailbox over REST, the agent's mail tools over MCP on it in the person's turns (one-person.md OP-S51), sending only after the person's yes,
 * a refused password, Home's unread count and disconnecting. It needs Postgres for what it checks: the connections row
 * (sealed password, settings, licence), the commit pipeline's keys and approvals, and the executor running as the person.
 *
 * The servers are fakes: an in-memory IMAP account behind the mail network seam, and a real SMTP server in process with
 * the `mail.home.test` certificate. `mail.home.test` resolves to a public address that the Vault's seam dials on
 * 127.0.0.1, so the destination policy runs as in production.
 */
import { readFileSync } from 'node:fs';
import { agentDefaultGrants, api, buildPath } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { approvals, connections } from '../db/schema/index';
import { mailThings, pollMailGlances } from '../home/mail-glance';
import { loadPrincipalRow } from '../read/principals';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { type FakeSmtp, startFakeSmtp } from '../test/mail';
import { mcpClient, type TestMcp } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { MAIL_CERT } from '../test/self-signed';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { ISPDB_URL } from './imap/discover';
import { MemoryMailServer } from './imap/memory';
import { useMailNetForTests } from './imap/net';
import type { ImapConnectOptions } from './imap/session';

// The local network closed: a home-network mail server needs the home network list (VT-12).
const t = useTestServer({ seed: true, listen: true, env: { WHOMBAT_LOCAL_NETWORK: 'off' } });
const PASSWORD = 'app-password-for-jo';
const EMAIL = 'mara@okafor.example';
const PUBLIC = '198.51.200.10';
const HOME = '192.168.50.20';

let smtp: FakeSmtp;
/** The sending server's account: its password changes with the mailbox's (read at each sign-in). */
const smtpAccount = { user: EMAIL, pass: PASSWORD, security: 'tls' as const };
let server: MemoryMailServer;
let maraChat: PersonalSetup;
const opened: ImapConnectOptions[] = [];
const clients: TestMcp[] = [];

const recorded = (domain: string) =>
  readFileSync(new URL(`./imap/fixtures/ispdb-${domain}.xml`, import.meta.url), 'utf8');

async function rest<B>(endpoint: { method: string; base: string; path: string }, body?: B, params = {}) {
  const { cookie } = await sessionFor(t.services, IDS.mara);
  return t.api.inject({
    method: endpoint.method as 'POST',
    url: endpoint.base + buildPath(endpoint.path, params),
    headers: { cookie },
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

const settings = () => ({
  imap: { host: 'mail.home.test', port: 993, security: 'tls' as const },
  smtp: { host: 'mail.home.test', port: smtp.port, security: 'tls' as const },
  username: null,
});

beforeAll(async () => {
  smtp = await startFakeSmtp(smtpAccount);
  server = new MemoryMailServer({ user: EMAIL, pass: PASSWORD });
  server.add(
    'INBOX',
    'From: Bo <bo@example.com>\r\nTo: mara@okafor.example\r\nSubject: Quarterly numbers\r\nMessage-ID: <q3@example.com>\r\n\r\nThe numbers are in.\r\n',
  );
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      if (host === 'mail.home.test') return [{ address: PUBLIC, family: 4 }];
      if (host === 'nas.home.test') return [{ address: HOME, family: 4 }];
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    },
    dialAddress: (address) => (address === PUBLIC ? '127.0.0.1' : address),
  });
  useMailNetForTests(t.services, {
    ca: MAIL_CERT,
    openImap: async (o) => {
      opened.push(o);
      return server.connect(o);
    },
    discover: {
      fetchText: async (url) =>
        url === `${ISPDB_URL}messagingengine.com` ? recorded('messagingengine.com') : null,
      mx: async (domain) =>
        domain === 'smith.example' ? [{ exchange: 'in1-smtp.messagingengine.com', priority: 10 }] : [],
      srv: async () => [],
    },
  });
  // Dusty with the keys a new Whombat's agent holds, a person's account keys among them (one-agent.md OA-05); the
  // test world's Dusty holds the mock crew's.
  maraChat = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    services: null,
    grants: agentDefaultGrants(IDS.dusty),
  });
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await smtp.close();
});

describe('finding and connecting a mailbox (CM-20, CM-22)', () => {
  it('finds the servers and says what it knows about the provider', async () => {
    const res = await rest(api.connectors.imapDiscover, { email: 'jo@smith.example' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      source: 'mx',
      settings: { imap: { host: 'imap.fastmail.com', port: 993 }, smtp: { host: 'smtp.fastmail.com' } },
      hint: { name: 'Fastmail', useInstead: null },
    });
    const gmail = (await rest(api.connectors.imapDiscover, { email: 'mara@gmail.com' })).json();
    expect(gmail).toMatchObject({ source: 'guess', hint: { useInstead: 'google' } });
  });

  it('refuses a wrong password, and a home-network server not on the list, keeping nothing', async () => {
    const wrong = await rest(api.connectors.imapConnect, {
      email: EMAIL,
      password: 'nope',
      settings: settings(),
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.details).toMatchObject({ reason: 'imap_refused', host: 'mail.home.test' });
    expect(wrong.json().error.message).toContain('app password');

    const home = await rest(api.connectors.imapConnect, {
      email: EMAIL,
      password: PASSWORD,
      settings: { ...settings(), imap: { host: 'nas.home.test', port: 993, security: 'tls' } },
    });
    expect(home.statusCode).toBe(403);
    expect(home.json().error.details.reason).toBe('not_allowed');
    expect(home.json().error.message).toContain('192.168.50.0/24 port 993');

    // Microsoft's own servers take no password at all: said before one is sent (SG-18b).
    const signIns = opened.length;
    const outlook = await rest(api.connectors.imapConnect, {
      email: 'mara@outlook.com',
      password: PASSWORD,
      settings: { ...settings(), imap: { host: 'outlook.office365.com', port: 993, security: 'tls' } },
    });
    expect(outlook.statusCode).toBe(409);
    expect(outlook.json().error.details).toMatchObject({
      reason: 'imap_refused',
      host: 'outlook.office365.com',
    });
    expect(outlook.json().error.message).toContain('Connect Microsoft 365 instead');
    expect(opened).toHaveLength(signIns);

    const accountId = await accountOf(t.services, IDS.mara);
    expect(
      await t.services.db
        .select()
        .from(connections)
        .where(and(eq(connections.accountId, accountId), eq(connections.provider, 'imap'))),
    ).toEqual([]);
  });

  it('connects after both sides signed in, keeps the password sealed and never shows it', async () => {
    const res = await rest(api.connectors.imapConnect, {
      email: EMAIL,
      password: PASSWORD,
      settings: settings(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(PASSWORD);
    expect(res.json()).toMatchObject({
      provider: 'imap',
      email: EMAIL,
      services: ['mail'],
      status: 'active',
      mail: { imapHost: 'mail.home.test', smtpHost: 'mail.home.test', username: EMAIL },
      checks: [{ service: 'mail', state: 'ok' }],
    });
    // The socket went to the checked address, with the host name for TLS.
    expect(opened.at(-1)).toMatchObject({
      address: '127.0.0.1',
      host: 'mail.home.test',
      port: 993,
      security: 'tls',
    });
    expect(smtp.logins.at(-1)).toEqual({ user: EMAIL, ok: true });

    const [row] = await t.services.db.select().from(connections).where(eq(connections.id, res.json().id));
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    expect(row?.mailSettings).toMatchObject({ imap: { host: 'mail.home.test' }, savesSent: false });

    const checked = await rest(api.connections.check, undefined, { connectionId: res.json().id });
    expect(checked.json()).toMatchObject({ status: 'active', checks: [{ service: 'mail', state: 'ok' }] });

    const status = (await rest(api.connectors.status)).json();
    expect(status.imap).toEqual({ available: true });
    expect(status.connections.map((c: { provider: string }) => c.provider)).toContain('imap');
  });
});

describe('the mail tools on it (CM-19, CM-26)', () => {
  async function asMara() {
    const { token } = await agentTokenFor(t.services, t.burrowId, maraChat.agentId, maraChat.dmId);
    const mcp = await mcpClient(t.baseUrl, token);
    clients.push(mcp);
    return mcp;
  }

  it('lists only the mail tools, searches and reads the inbox', async () => {
    const mcp = await asMara();
    const tools = (await mcp.client.listTools()).tools.map((x) => x.name);
    expect(tools).toContain('mail_search');
    expect(tools).not.toContain('calendar_events');
    const found = await mcp.call('mail_search', { query: 'subject:quarterly is:unread' });
    expect(found.body).toMatchObject({
      status: 'ok',
      messages: [{ subject: 'Quarterly numbers', unread: true }],
    });
    const id = (found.body.messages as { id: string }[])[0]?.id ?? '';
    const read = await mcp.call('mail_read', { messageId: id });
    expect(read.body).toMatchObject({ status: 'ok', messages: [{ body: 'The numbers are in.' }] });
    // The calendar isn't there: the tool says so instead of calling a server.
    const calendar = await mcp.call('calendar_events', {});
    expect(calendar.body).toMatchObject({ error: { code: 'not_allowed' } });
  });

  it('sends only after the person’s yes, through SMTP, and files the copy in Sent', async () => {
    const mcp = await asMara();
    const asked = await mcp.call('mail_send', {
      to: ['bo@example.com'],
      subject: 'Re: Quarterly numbers',
      body: 'Thanks, Bo.',
    });
    expect(asked.body).toMatchObject({ status: 'pending_approval' });
    const before = smtp.messages.length;
    const [approval] = await t.services.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, asked.body.approvalId as string));
    expect(approval?.action).toMatchObject({
      type: 'mail_send',
      params: { provider: 'imap', to: ['bo@example.com'] },
    });
    expect(smtp.messages.length).toBe(before);
    await t.commit(IDS.mara, decideApproval, { number: approval?.number as number, decision: 'approve' });
    expect(smtp.messages.at(-1)).toMatchObject({ from: EMAIL, to: ['bo@example.com'] });
    expect(server.folder('Sent').messages.at(-1)?.raw.toString()).toContain('Subject: Re: Quarterly numbers');
    expect(server.folder('Drafts').messages).toEqual([]);
  });

  it('counts the inbox’s unread mail on Home, for its person', async () => {
    expect(await pollMailGlances(t.services)).toBeGreaterThan(0);
    const mara = await loadPrincipalRow(t.services.db, IDS.mara);
    const things = await mailThings(t.services, t.services.db, mara as NonNullable<typeof mara>);
    const email = things.find((x) => x.catalogId === 'imap');
    expect(email).toMatchObject({ name: 'Email', status: 'ok', line: `1 unread · ${EMAIL}` });
    // It opens its own page.
    expect(email?.href).toBe(`/things/${encodeURIComponent(email?.id ?? '')}`);
  });

  it('asks for a new password when the server refuses it, keeps the servers when it gets one, and Disconnect forgets the account', async () => {
    server.options.pass = 'changed-elsewhere';
    const mcp = await asMara();
    const refused = await mcp.call('mail_search', { query: '' });
    expect(refused.body).toMatchObject({
      error: { code: 'not_allowed', message: expect.stringContaining('new password') },
    });
    const accountId = await accountOf(t.services, IDS.mara);
    const [row] = await t.services.db
      .select()
      .from(connections)
      .where(and(eq(connections.accountId, accountId), eq(connections.provider, 'imap')));
    expect(row).toMatchObject({ status: 'needs_reauth', reauthReason: 'password_refused' });

    // “Change password”: the same address, a new password and no servers. The ones it has stay (CM-M18): looking them
    // up again would guess imap.okafor.example, which isn't there.
    server.options.pass = 'new-app-password';
    smtpAccount.pass = 'new-app-password';
    const changed = await rest(api.connectors.imapConnect, { email: EMAIL, password: 'new-app-password' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      id: row?.id,
      status: 'active',
      mail: { imapHost: 'mail.home.test' },
    });
    const [kept] = await t.services.db
      .select()
      .from(connections)
      .where(eq(connections.id, row?.id ?? ''));
    expect(kept?.mailSettings).toEqual({ ...settings(), savesSent: false });
    expect((await (await asMara()).call('mail_search', { query: '' })).body).toMatchObject({ status: 'ok' });

    const removed = await rest(api.connections.remove, undefined, { connectionId: row?.id });
    expect(removed.statusCode).toBe(200);
    expect(
      await t.services.db
        .select()
        .from(connections)
        .where(eq(connections.id, row?.id ?? '')),
    ).toEqual([]);
  });
});
