import type { VaultEntryDetail } from '@whombat/core/vault';
import {
  VAULT_ENTRIES,
  VAULT_NETWORKS,
  vaultGrafana,
  vaultHomeAssistant,
  vaultPackSecret,
  vaultPrinter,
  vaultShopLogin,
  vaultSignInEntries,
  vaultSshDeployKey,
} from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { peopleFrom } from './people';
import {
  signsInText,
  VAULT_REMOVE_COPY,
  VAULT_SSH_ON_WEB,
  vaultAccessChange,
  vaultAgentRows,
  vaultEntryRows,
  vaultEntryScreen,
  vaultEnvNameCheck,
  vaultNetworkRows,
  vaultSavedIntroFor,
} from './vault';

/** The fixture world: Mara, and Dusty, the Whombat's one agent (Whombat one-agent.md OA-01). */
const ctx = worldContext();
const DUSTY = 'prn_dusty';

/** The entry switched on for the agent (or off), as `vault.get` sends it (`key`, OA-09, CT-1240). */
function withKey(
  entry: VaultEntryDetail,
  access: 'on' | 'off',
  key: Partial<NonNullable<VaultEntryDetail['key']>> = {},
): VaultEntryDetail {
  return {
    ...entry,
    agentOn: access === 'on',
    key: access === 'off' ? null : { givenAt: entry.createdAt, servers: null, envName: null, ...key },
  };
}

describe('the Vault list', () => {
  it('shows every entry with its status dot, meta line and last use; only an entry off for the agent says so', () => {
    const rows = vaultEntryRows(VAULT_ENTRIES, ctx.now, ctx.timeZone, 'Dusty');
    expect(rows.map((r) => [r.name, r.status.tone, r.meta, r.lastUsed])).toEqual([
      ['Grafana', 'ok', 'Sign-in key · grafana.example.com', 'Used 09:12'],
      ['Home Assistant', 'ok', 'Connection · 192.168.1.10:8123', 'Used 10:48'],
      // Off for the agent (AP-4992): the one thing that differs from the usual, by name.
      ['Printer admin', 'bad', expect.stringContaining('Dusty'), null],
      // An old secret entry: nothing uses it (AP-4156).
      ['Weather API key', 'neutral', expect.stringContaining('nothing uses it'), null],
    ]);
    expect(rows[2]?.meta).toContain('off');
    expect(rows[0]?.accessibilityLabel).toContain('Grafana');
  });

  it('says what saving from chat does only where the Whombat does it (VS-08; AP-4040)', () => {
    expect(vaultSavedIntroFor('Dusty', true)).toContain('Dusty');
    expect(vaultSavedIntroFor('Dusty', false)).toBeNull();
  });

  it('reads the home network list as one line per network', () => {
    expect(vaultNetworkRows(VAULT_NETWORKS)).toEqual([
      {
        id: 'vln_home',
        cidr: '192.168.1.0/24',
        ports: 'ports 80, 8123',
        note: 'Home Assistant and the printer',
        line: '192.168.1.0/24 · ports 80, 8123 · Home Assistant and the printer',
      },
    ]);
    const [one] = vaultNetworkRows([
      { ...(VAULT_NETWORKS[0] as (typeof VAULT_NETWORKS)[number]), ports: [8123], note: ' ' },
    ]);
    expect(one).toMatchObject({ ports: 'port 8123', note: null, line: '192.168.1.0/24 · port 8123' });
  });
});

describe('a Vault entry', () => {
  it('shows an MCP entry’s connection, secret, tools, the agent’s row and recent use', () => {
    const model = vaultEntryScreen(withKey(vaultHomeAssistant, 'on'), ctx);
    // No holders' count: the row below says who uses it (AP-4036).
    expect(model.meta).toBe('Connection · 192.168.1.10:8123');
    expect(model.connection).toEqual({
      address: '192.168.1.10:8123',
      signsIn: 'Signs in with a bearer token',
      line: 'Checked 3 min ago · Reached · 5 tools',
      canCheck: true,
    });
    expect(model.secretLine).toBe('Set · replaced 2 days ago');
    expect(model.tools.map((t) => [t.name, t.enabled, t.isNew])).toEqual([
      ['HassTurnOn', true, false],
      ['HassTurnOff', true, false],
      ['HassLightSet', true, false],
      ['HassCancelAllTimers', false, false],
      ['GetLiveContext', false, true],
    ]);
    expect(model.tools[4]?.accessibilityLabel).toBe(
      'GetLiveContext, new. Provides real-time information about the CURRENT state of devices in the home.',
    );
    expect(model.toolsIgnored).toBeNull();
    // One row, the agent's (OA-09).
    expect(model.access).toMatchObject({
      agentId: DUSTY,
      name: 'Dusty',
      value: 'on',
      servers: null,
      env: null,
      // An MCP server's tools reach the agent in your chats, never its commands (CT-1241).
      offNotice: null,
    });
    expect(model.access?.options.map((o) => o.value)).toEqual(['on', 'off']);
    expect(model.access?.how).not.toBeNull();
    expect(model.unused).toBeNull();
    expect(model.access?.title).toContain('Dusty');
    // A use is one of your turns it reached the agent in (CT-1244).
    expect(model.recentUse.length).toBeGreaterThan(0);
    expect(model.recentUse.every((u) => u.agent === 'Dusty')).toBe(true);
    expect(model.recentUse[0]?.line).not.toContain('for you');
  });

  it('says Off while the agent holds no key, and each choice’s hint (VS-03, CT-1240)', () => {
    const model = vaultEntryScreen(withKey(vaultHomeAssistant, 'off'), ctx);
    expect(model.access).toMatchObject({ value: 'off', how: null });
    expect(model.access?.hints).toEqual({
      on: expect.stringContaining('Dusty'),
      off: expect.stringContaining('Dusty'),
    });
  });

  it('has no row while the agent isn’t known (no bootstrap principal of kind agent)', () => {
    const none = {
      ...ctx,
      people: peopleFrom([...ctx.people.byId.values()].filter((p) => p.kind !== 'agent')),
    };
    expect(vaultEntryScreen(vaultHomeAssistant, none).access).toBeNull();
  });

  it('switches it on for All servers, or off', () => {
    expect(vaultAccessChange('off', 'on')).toEqual({ give: { servers: null } });
    expect(vaultAccessChange('on', 'off')).toEqual({ take: true });
    expect(vaultAccessChange('on', 'on')).toBeNull();
  });

  it('has no tools for an HTTP entry, and says a failing check in the connection line', () => {
    const grafana = vaultEntryScreen(vaultGrafana, ctx);
    expect(grafana.tools).toEqual([]);
    expect(grafana.connection?.address).toBe('grafana.example.com');
    expect(grafana.recentUse[0]?.what).toContain('Dusty');
    expect(grafana.recentUse[0]?.what).not.toContain('computer');
    const printer = vaultEntryScreen(vaultPrinter, ctx);
    expect(printer.meta).toBe('Password · 192.168.1.20');
    expect(printer.connection?.signsIn).toBe('Signs in as admin with a password');
    expect(printer.status).toEqual({ tone: 'bad', label: 'Failing' });
    expect(printer.connection?.line).toBe('Checked 4 days ago · The server rejected the secret (401).');
    expect(printer.access?.value).toBe('off');
  });

  it('shows a website login: “Website login”, who it signs in as, and no check (VT-D28, CT-1235)', () => {
    const [row] = vaultEntryRows([vaultShopLogin], ctx.now, ctx.timeZone, 'Dusty');
    expect([row?.name, row?.meta]).toEqual(['Shop admin', 'Website login · shop.example.com']);
    const model = vaultEntryScreen(vaultShopLogin, ctx);
    expect(model.connection).toEqual({
      address: 'shop.example.com',
      signsIn: 'Signs in as mara@burrowhq.example in the browser',
      line: null,
      canCheck: false,
    });
    expect(model.tools).toEqual([]);
    // In its browser's sign-ins, never in its commands (CT-1230).
    expect(model.access).toMatchObject({ agentId: DUSTY, offNotice: null, env: null });
  });

  it('says how every kind of entry signs in, in the web’s words', () => {
    expect(signsInText({ type: 'header', name: 'X-Api-Key' })).toBe('Signs in with the X-Api-Key header');
    expect(signsInText({ type: 'query', name: 'token' })).toBe('Signs in with the token query parameter');
    expect(signsInText({ type: 'none' })).toBe('Signs in with nothing');
  });

  it('gives an old secret entry no connection and no keys, one line that nothing uses it (AP-4156)', () => {
    const model = vaultEntryScreen(vaultPackSecret, ctx);
    expect(model.connection).toBeNull();
    expect(model.access).toBeNull();
    expect(model.tools).toEqual([]);
    expect(model.meta).toBe('Secret · nothing uses it');
    expect(model.unused).toContain('Nothing uses this');
    expect(VAULT_REMOVE_COPY.confirm(model.name)).toContain(model.name);
  });

  it('notes ignored tools', () => {
    const model = vaultEntryScreen({ ...vaultHomeAssistant, toolsIgnored: 3 }, ctx);
    expect(model.toolsIgnored).toBe('3 more tools were ignored: an entry keeps at most 64.');
  });
});

describe('Settings → Agent → Keys’ VAULT (AP-4992)', () => {
  it('lists the viewer’s entries that are on for the agent, never an old secret entry', () => {
    const rows = vaultAgentRows([...VAULT_ENTRIES, vaultShopLogin]);
    expect(rows.map((r) => [r.entryId, r.meta])).toEqual([
      ['vlt_grafana', 'Sign-in key · grafana.example.com'],
      ['vlt_homeassistant', 'Connection · 192.168.1.10:8123'],
      ['vlt_shop', 'Website login · shop.example.com'],
    ]);
    expect(rows[0]?.accessibilityLabel).toContain('Grafana');
  });
});

describe('an SSH key on the phone (VT-S13)', () => {
  it('lists it as a server key with its servers', () => {
    const [row] = vaultEntryRows([vaultSshDeployKey], ctx.now, ctx.timeZone, 'Dusty');
    expect([row?.name, row?.meta, row?.status.label, row?.lastUsed]).toEqual([
      'Deploy key',
      'Server key · 2 servers',
      'Reached',
      'Used 10:05',
    ]);
  });

  it('shows the fingerprint, the servers read-only with their status, and the agent’s row', () => {
    const model = vaultEntryScreen(withKey(vaultSshDeployKey, 'on'), ctx);
    expect(model.connection).toBeNull();
    expect(model.tools).toEqual([]);
    expect(model.ssh).toEqual({
      fingerprint: 'SHA256:zibNZfkJQ795P2dUA9+2CmiONZBYBhGqzBdZj+lYkxY',
      keyMeta: 'ED25519 · made by Whombat · added 5 days ago',
      empty: null,
      servers: [
        {
          id: 'vss_web1',
          name: 'web-1',
          target: 'deploy@web1.example.com:22',
          status: { tone: 'ok', label: 'Reached' },
          line: 'Checked 1 hour ago · Signed in as deploy',
          hostKey: null,
          production: null,
          keptPassword: null,
          accessibilityLabel:
            'web-1, Reached. deploy@web1.example.com:22. Checked 1 hour ago · Signed in as deploy',
        },
        {
          id: 'vss_staging',
          name: 'staging',
          target: 'deploy@staging.example.com:22',
          status: { tone: 'neutral', label: 'Not checked yet' },
          line: 'Checked 1 hour ago · Not trusted yet',
          hostKey: 'Host key to confirm: SHA256:lA0GcvPK3fxFYd43pMMqq275b2pIPqT3oQfQlcC3wnU (ED25519)',
          production: null,
          keptPassword: null,
          accessibilityLabel:
            'staging, Not checked yet. deploy@staging.example.com:22. Checked 1 hour ago · Not trusted yet. Host key to confirm: SHA256:lA0GcvPK3fxFYd43pMMqq275b2pIPqT3oQfQlcC3wnU (ED25519)',
        },
      ],
    });
    // A key for All servers says nothing more; one that covers some (chosen on the web before) names them.
    expect(model.access).toMatchObject({ value: 'on', servers: null });
    const some = vaultEntryScreen(withKey(vaultSshDeployKey, 'on', { servers: ['vss_staging'] }), ctx);
    expect(some.access).toMatchObject({ value: 'on', servers: 'Servers · staging' });
    expect(model.recentUse.map((u) => [u.agent, u.outcome])).toEqual([['Dusty', 'done']]);
    expect(VAULT_SSH_ON_WEB).toBe('SSH keys and servers are set up on the web, in the Vault.');
  });

  it('says a changed host key, and an SSH key without servers', () => {
    const [web1] = vaultSshDeployKey.servers;
    if (!web1) throw new Error('fixture');
    const changed = vaultEntryScreen(
      {
        ...vaultSshDeployKey,
        servers: [
          {
            ...web1,
            seenHostKey: { algorithm: 'ssh-rsa', fingerprint: 'SHA256:new', seenAt: web1.updatedAt },
            check: {
              status: 'failing',
              outcome: 'host_key_changed',
              summary: 'This server’s host key changed. Check it before agents use it again.',
              checkedAt: null,
            },
          },
        ],
      },
      ctx,
    );
    expect(changed.ssh?.servers[0]).toMatchObject({
      status: { tone: 'bad', label: 'Failing' },
      line: 'Not checked yet',
      hostKey: 'New host key: SHA256:new (RSA)',
    });
    const none = vaultEntryScreen({ ...vaultSshDeployKey, servers: [], serverCount: 0 }, ctx);
    expect(none.ssh?.servers).toEqual([]);
    expect(none.ssh?.empty).toBe('No servers yet. Add the servers this key signs in to.');
  });
});

describe('the agent’s commands in the Vault (agent-computer.md AC-30, AC-31, AC-11; CT-1240; AP-5768)', () => {
  const [web1, staging] = vaultSshDeployKey.servers;
  if (!web1 || !staging) throw new Error('fixture');

  it('names an API’s environment variable, and says the commands may keep a copy once off', () => {
    const own = vaultEntryScreen(withKey(vaultGrafana, 'on', { envName: 'GRAFANA_TOKEN' }), ctx);
    expect(own.access?.env).toEqual({ name: 'GRAFANA_TOKEN', variables: ['GRAFANA_TOKEN'] });
    expect(own.access?.offNotice).toContain('Dusty');
    // Without a chosen name, the one the entry's name gives (AC-31).
    expect(vaultEntryScreen(withKey(vaultGrafana, 'on'), ctx).access?.env?.name).toMatch(/^GRAFANA/);
    // Basic auth sets two (`_USERNAME`, `_PASSWORD`).
    expect(
      vaultEntryScreen(withKey(vaultPrinter, 'on', { envName: 'PRINTER' }), ctx).access?.env?.variables,
    ).toEqual(['PRINTER_USERNAME', 'PRINTER_PASSWORD']);
    expect(vaultEnvNameCheck(' GRAFANA_TOKEN ')).toEqual({ ok: true, name: 'GRAFANA_TOKEN' });
    expect(vaultEnvNameCheck('PATH').ok).toBe(false);
  });

  it('gives an SSH key no variable, and marks a production server', () => {
    const entry = {
      ...withKey(vaultSshDeployKey, 'on'),
      servers: [{ ...web1, production: true }, staging],
    };
    const model = vaultEntryScreen(entry, ctx);
    expect(model.access).toMatchObject({ env: null, offNotice: expect.stringContaining('Dusty') });
    expect(model.ssh?.servers.map((s) => s.production)).toEqual(['PRODUCTION', null]);
    expect(model.ssh?.servers[0]?.accessibilityLabel).toBe(
      'web-1, Reached. Production. deploy@web1.example.com:22. Checked 1 hour ago · Signed in as deploy',
    );
  });
});

describe('asking for sign-ins on the entry screen (vault-simplify.md VLT-30, VLT-46, CT-1664)', () => {
  it('shows a website login’s authenticator key as set, never the key, and what adding one does', () => {
    const [login, ssh] = vaultSignInEntries;
    if (!login || !ssh) throw new Error('fixtures');
    expect(vaultEntryScreen(login, ctx).totp).toMatchObject({
      set: true,
      line: expect.stringMatching(/^Set · /),
    });
    const unset = vaultEntryScreen(vaultShopLogin, ctx).totp;
    expect(unset?.set).toBe(false);
    expect(unset?.line).toContain(ctx.people.agent?.name.split(' ')[0] ?? '');
    expect(vaultEntryScreen(vaultGrafana, ctx).totp).toBeNull();
  });

  it('shows a server’s kept password as set where its servers are listed', () => {
    const ssh = vaultSignInEntries[1];
    if (!ssh) throw new Error('fixtures');
    const rows = vaultEntryScreen(ssh, ctx).ssh?.servers ?? [];
    const prod = rows.find((r) => r.name === 'prod-1');
    expect(prod?.keptPassword).toMatch(/kept password/);
    expect(prod?.accessibilityLabel).toContain('kept password');
    expect(rows.find((r) => r.name === 'web-1')?.keptPassword).toBeNull();
  });

  it('notes an MCP entry that couldn’t move to Connections', () => {
    expect(vaultEntryScreen(vaultHomeAssistant, ctx).moveToConnections).toBe(true);
    expect(vaultEntryScreen(vaultGrafana, ctx).moveToConnections).toBe(false);
  });
});
