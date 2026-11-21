/**
 * Contracts 0.111.0, the copy and the vendors' own sign-ins (Whombat connection-signin.md SG-08, SG-18d, SG-20, SG-21;
 * CT-746…CT-749): the facts each entry's words carry, not the sentences.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  type CatalogEntry,
  catalogEntry,
  connectionTransport,
  fieldsFor,
  hasRequestTool,
  pasteValues,
  resolveMcpUrl,
  sessionLoginFailure,
} from './connections-catalog.js';
import { IMAP_PROVIDER_HINTS, imapProviderFor } from './connectors.js';

const must = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};
const token = (id: string) => {
  const m = must(id).signIn.find((s) => s.kind === 'token');
  if (m?.kind !== 'token') throw new Error(`${id} token`);
  return m;
};
const words = (id: string) => {
  const m = token(id);
  return [m.secretHelp, ...m.steps.map((s) => s.text)].join(' ');
};

describe('the vendors’ own MCP servers first (CT-748; SG-20)', () => {
  const MCP = {
    todoist: 'https://ai.todoist.net/mcp',
    airtable: 'https://mcp.airtable.com/mcp',
    mollie: 'https://mcp.mollie.com/mcp',
    cloudflare: 'https://mcp.cloudflare.com/mcp',
  } as const;

  it('signs in there first, as Notion does, and keeps the token on REST', () => {
    for (const [id, url] of [...Object.entries(MCP), ['notion', 'https://mcp.notion.com/mcp']] as const) {
      const e = must(id);
      expect(
        e.signIn.map((m) => m.kind),
        id,
      ).toEqual(['mcp_oauth', 'token']);
      expect(e.signIn[0]?.label, id).toBe(`Sign in with ${e.name}`);
      expect(e.transport, id).toBe('mcp');
      expect(resolveMcpUrl(e, {}, 'mcp_oauth'), id).toBe(url);
      expect(connectionTransport(e, 'token'), id).toBe('rest');
      expect(hasRequestTool(e, 'token'), id).toBe(true);
      expect(hasRequestTool(e, 'mcp_oauth'), id).toBe(false);
      expect(fieldsFor(e, 'mcp_oauth'), id).toEqual([]);
      expect(e.guide, id).toContain(`Signed in with ${e.name}`);
    }
    // Todoist's typed tools are the token's (the server offers them on REST connections only).
    expect(must('todoist').tools.map((t) => t.name)).toContain('tasks_list');
  });
});

describe('UniFi’s account help (CT-746; SG-08)', () => {
  it('points to a local admin first on Network and Protect', () => {
    for (const id of ['unifi_network', 'unifi_protect']) {
      const m = must(id).signIn[0];
      if (m?.kind !== 'password') throw new Error(id);
      for (const phrase of ['local admin', 'Restrict to local access only', 'Super Admin', 'UI.com'])
        expect(m.account?.help, `${id} ${phrase}`).toContain(phrase);
    }
  });
});

describe('mail providers’ hints (CT-747; SG-18)', () => {
  const hint = (email: string) => imapProviderFor(email);

  it('gives each provider what it needs', () => {
    const gmail = hint('mara@gmail.com');
    expect([gmail?.useInstead, gmail?.url]).toEqual(['google', 'https://myaccount.google.com/apppasswords']);
    expect(gmail?.text).toContain('2-Step Verification');
    const outlook = hint('mara@outlook.com');
    expect(outlook?.useInstead).toBe('microsoft');
    expect(outlook?.text).toContain('not even an app password');
    expect(hint('mara@icloud.com')?.text).toContain('@icloud.com');
    const proton = hint('mara@proton.me');
    expect([proton?.url, proton?.text.includes('can’t be connected yet')]).toEqual([null, true]);
    expect(hint('mara@yahoo.com')?.text).toContain('External connections');
    expect(hint('mara@fastmail.com')?.text).toContain('Basic plan');
    expect(hint('mara@gmx.de')?.text).toContain('IMAP off again');
  });

  it('writes every hint with curly quotes, at most 300 characters', () => {
    for (const p of IMAP_PROVIDER_HINTS) {
      expect(p.text, p.id).not.toMatch(/'/);
      expect(p.text.length, p.id).toBeLessThanOrEqual(300);
    }
  });
});

describe('guided steps brought up to date (CT-749; SG-21)', () => {
  it('says what each service now calls things', () => {
    expect(words('unifi_access')).toContain('Never expires');
    expect(words('moneybird')).toContain('Instellingen → Koppelingen → Externe applicaties');
    expect(token('moneybird').secretHelp).toContain('Ontwikkelaars');
    expect(must('moneybird').tokenUrl).toBeNull();
    const tailscale = must('tailscale').signIn.find((m) => m.kind === 'client_credentials');
    expect(
      tailscale?.kind === 'client_credentials' && tailscale.steps.map((s) => s.text).join(' '),
    ).toContain('All row');
    expect(words('gitlab')).toContain('Edit profile → Access → Personal access tokens');
    expect(words('hubspot')).toContain('super admin');
    expect(token('hubspot').secretHelp).toContain('26 October 2026');
    expect(token('plausible').secretHelp).toContain('Business plan');
    expect(words('pterodactyl')).toContain('Profile → API Keys');
    expect(words('overseerr')).toContain('Seerr');
    expect(words('pipedrive')).toContain('Company settings');
    expect(token('airtable').secretHelp).toContain('Enterprise');
    expect(words('nginx_proxy_manager')).toContain('Two-Factor Auth');
    const esphomeUrl = must('esphome').fields.find((f) => f.id === 'url');
    expect(esphomeUrl?.help).toContain('2026.7');
    expect(esphomeUrl?.help).toContain('“Leave front door open”');
  });

  it('makes Cloudflare account tokens and reads older tokens', () => {
    const m = token('cloudflare');
    for (const link of [m.links?.read, m.links?.manage])
      expect(link).toMatch(
        /^https:\/\/dash\.cloudflare\.com\/\?to=\/:account\/api-tokens&permissionGroupKeys=/,
      );
    const legacy = 'Ab3_dE-fGhIjKlMnOpQrStUvWxYz0123456789ab';
    expect(legacy).toHaveLength(40);
    expect(pasteValues(m, `Your token\n${legacy}\nCopy`)).toEqual({ secret: legacy });
    const cfut = `cfut_${'a'.repeat(44)}`;
    expect(pasteValues(m, `token: ${cfut}`)).toEqual({ secret: cfut });
  });

  it('keeps GitLab’s instance prefix and reads Pelican’s keys', () => {
    const gl = `mycompany-glpat-${'x'.repeat(20)}`;
    expect(pasteValues(token('gitlab'), `New token: ${gl}`)).toEqual({ secret: gl });
    const plain = `glpat-${'y'.repeat(20)}`;
    expect(pasteValues(token('gitlab'), plain)).toEqual({ secret: plain });
    const pacc = `pacc_${'a1'.repeat(21)}b`;
    expect(pasteValues(token('pterodactyl'), pacc)).toEqual({ secret: pacc });
  });

  it('tells Nginx Proxy Manager’s Two-Factor Auth apart', () => {
    const e = must('nginx_proxy_manager');
    const auth = token('nginx_proxy_manager').auth;
    if (auth.type !== 'session') throw new Error('session');
    const r = sessionLoginFailure(e, auth, '{"requires_2fa":true,"challenge_token":"x.y.z"}', 200);
    expect(r?.reason).toBe('two_step');
    expect(r?.text).toContain('Add User');
    expect(sessionLoginFailure(e, auth, '{"token":"t","expires":"2026-10-22T10:00:00Z"}', 200)).toBeNull();
  });

  it('writes the changed entries’ words with curly quotes', () => {
    for (const e of CATALOG)
      for (const m of e.signIn) {
        if (m.kind !== 'token' && m.kind !== 'client_credentials') continue;
        for (const step of m.steps) expect(step.text, e.id).not.toMatch(/'/);
      }
    for (const e of CATALOG)
      for (const f of e.fields) expect(f.help ?? '', `${e.id}.${f.id}`).not.toMatch(/'/);
  });
});
