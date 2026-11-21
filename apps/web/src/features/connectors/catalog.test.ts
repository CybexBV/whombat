import { ApiError } from '@whombat/client';
import { type ConnectionView, catalogEntry } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { validateSettingsSearch } from '../../app/routing/search';
import {
  CONNECTABLE,
  catalogRow,
  catalogRows,
  catalogTileState,
  connectableEntry,
  connectionState,
  connectProblem,
  groupByCategory,
  installationLine,
  labelName,
  matchesSearch,
  pollerNote,
  reauthText,
  sessionSecret,
  shownTier,
  tierSelectable,
  USED_BY_AUTOMATIONS,
  usedByAgents,
  usedByAutomations,
  usedByGateway,
} from './catalog';

const entry = (id: string) => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

function view(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: 'con_1',
    catalogId: 'homeassistant',
    label: 'Home Assistant · home.lan:8123',
    handle: 'homeassistant',
    connectedBy: { id: null, name: 'Mara Okafor' },
    detail: null,
    signIn: 'token',
    transport: 'mcp',
    fields: { url: 'http://home.lan:8123' },
    status: 'active',
    reauthReason: null,
    checks: [],
    checkedAt: null,
    toolCount: 6,
    access: 'manage',
    poller: null,
    createdAt: '2026-09-21T14:02:00.000Z',
    lastUsedAt: null,
    ...over,
  };
}

const apiError = (status: number, code: string, details: unknown, message = '', fields = {}) =>
  new ApiError(status, code as never, message, {}, 'connections.create', fields, details);

describe('the overview’s entries (CX-70, AP-755)', () => {
  it('writes a row: the name, where it is and its state, nothing else (AP-1177, AP-1178)', () => {
    expect(catalogRow(view())).toEqual({
      id: 'con_1',
      catalogId: 'homeassistant',
      label: 'Home Assistant · home.lan:8123',
      name: 'Home Assistant',
      address: 'home.lan:8123',
      lookOnly: false,
      state: 'Connected',
      tone: 'ok',
      reason: null,
    });
    // A label of its own keeps its words; a cloud service's place is the account it signed in as.
    const own = catalogRow(
      view({ label: 'Upstairs', catalogId: 'todoist', detail: 'mara@x.nl', fields: {} }),
    );
    expect([own.name, own.address]).toEqual(['Upstairs', 'mara@x.nl']);
    // The address wins over the account; no scheme, the port kept.
    expect(catalogRow(view({ detail: 'mara', fields: { url: 'https://10.100.0.5:8123' } })).address).toBe(
      '10.100.0.5:8123',
    );
    // A connection that looks only says so (CT-314).
    expect(catalogRow(view({ access: 'read' })).lookOnly).toBe(true);
  });

  it('takes the address off a label only where the label ends with it', () => {
    expect(labelName('Home Assistant · home.lan:8123', 'home.lan:8123')).toBe('Home Assistant');
    expect(labelName('Home Assistant', 'home.lan:8123')).toBe('Home Assistant');
    expect(labelName('Upstairs · home.lan', 'home.lan:8123')).toBe('Upstairs · home.lan');
    expect(labelName(' · home.lan', 'home.lan')).toBe(' · home.lan');
    expect(labelName('Acme Desk dev', null)).toBe('Acme Desk dev');
  });

  it('says why a connection needs connecting again, and what to do', () => {
    const row = catalogRow(view({ status: 'needs_reauth', reauthReason: 'token_invalid' }));
    expect(row.state).toBe('Needs you to sign in again');
    expect(row.tone).toBe('warn');
    expect(row.reason).toBe('Home Assistant no longer accepts the token. Replace it to keep using it.');
    expect(catalogRow(view({ status: 'error', signIn: 'ha_oauth', reauthReason: 'revoked' })).reason).toBe(
      'Home Assistant signed Whombat out. Sign in again to keep using it.',
    );
  });

  it('says “Used by automations” on a connection only automations use, never tools or a level (TA-02)', () => {
    const tracker = view({
      catalogId: 'tracker',
      label: 'Acme Desk dev',
      handle: 'tracker',
      transport: 'rest',
      fields: { url: 'https://dev.desk.acme.example', driver: 'acme-desk' },
      toolCount: 0,
      access: 'read',
    });
    // Its row is like any other (AP-1177): “Used by automations” is on its page.
    expect([catalogRow(tracker).name, catalogRow(tracker).address]).toEqual([
      'Acme Desk dev',
      'dev.desk.acme.example',
    ]);
    // A refused token reads as any token's, naming the connection: every tracker has the same entry.
    expect(catalogRow({ ...tracker, status: 'needs_reauth', reauthReason: 'token_invalid' }).reason).toBe(
      'Acme Desk dev no longer accepts the token. Replace it to keep using it.',
    );
    expect(USED_BY_AUTOMATIONS.title).toBe('Used by automations');
    expect(USED_BY_AUTOMATIONS.organization).toContain('reports:assess');
    expect(usedByAutomations('tracker')).toBe(true);
    expect(usedByAutomations(entry('homeassistant'))).toBe(false);
    // An id this app doesn't know is the agent's entry, as before 0.69.
    expect(usedByAutomations('newer_service')).toBe(false);
  });

  it('marks Fusebox and the AI gateway as the gateway’s, neither agents’ nor automations’ (AP-1117, AP-1118)', () => {
    for (const id of ['fusebox', 'ai_gateway']) {
      expect(usedByGateway(id)).toBe(true);
      expect(usedByAutomations(id)).toBe(false);
      expect(usedByAgents(id)).toBe(false);
    }
    expect(usedByGateway('homeassistant')).toBe(false);
    expect(usedByAgents('homeassistant')).toBe(true);
  });

  it('says what a gateway’s refusals mean: one per burrow, and a Fusebox too old (AIG-01, AIG-02)', () => {
    expect(
      connectProblem(
        apiError(
          409,
          'conflict',
          { code: 'gateway_exists' },
          'This Whombat already sends its AI through Fusebox. Remove that connection first.',
        ),
      ).message,
    ).toBe('This Whombat already sends its AI through Fusebox. Remove that connection first.');
    expect(connectProblem(apiError(409, 'conflict', { code: 'gateway_too_old' })).message).toBe(
      'This Fusebox is too old to add a client key for Whombat. Update Fusebox and connect again.',
    );
  });

  it('says how the poller is doing: checked, or couldn’t reach with when it last got through (TA-03)', () => {
    const now = new Date('2026-09-23T09:15:00.000Z');
    const checked = '2026-09-23T09:13:00.000Z';
    expect(pollerNote(null, 'Acme Desk dev', now, 'UTC')).toBeNull();
    expect(pollerNote(undefined, 'Acme Desk dev', now, 'UTC')).toBeNull();
    const unknown = { environment: null, version: null };
    expect(
      pollerNote(
        { checkedAt: checked, succeededAt: checked, problem: null, ...unknown },
        'Acme Desk dev',
        now,
        'UTC',
      ),
    ).toEqual({ tone: 'ok', text: 'Checked for new reports 2 min ago.' });
    expect(
      pollerNote(
        { checkedAt: null, succeededAt: null, problem: null, ...unknown },
        'Acme Desk dev',
        now,
        'UTC',
      ),
    ).toEqual({
      tone: 'ok',
      text: 'Hasn’t checked for new reports yet.',
    });
    expect(
      pollerNote(
        {
          checkedAt: checked,
          succeededAt: '2026-09-23T08:13:00.000Z',
          problem: 'Acme Desk didn’t answer within 15 s',
          ...unknown,
        },
        'Acme Desk dev',
        now,
        'UTC',
      ),
    ).toEqual({
      tone: 'warn',
      text: 'Couldn’t reach Acme Desk dev: Acme Desk didn’t answer within 15 s. Last reached 1 hour ago.',
    });
    // Never reached, and the server's own full stop isn't doubled.
    expect(
      pollerNote(
        { checkedAt: checked, succeededAt: null, problem: 'No answer.', ...unknown },
        'Acme Desk dev',
        now,
        'UTC',
      ),
    ).toEqual({ tone: 'warn', text: 'Couldn’t reach Acme Desk dev: No answer.' });
  });

  it('says which installation it is and the version it runs, in the tracker’s name when it is known', () => {
    const poller = { checkedAt: null, succeededAt: null, problem: null };
    expect(installationLine(null, 'Acme Desk')).toBeNull();
    expect(installationLine(undefined)).toBeNull();
    expect(installationLine({ ...poller, environment: null, version: null }, 'Acme Desk')).toBeNull();
    expect(installationLine({ ...poller, environment: 'development', version: '0.1.174' }, 'Acme Desk')).toBe(
      'Development · Acme Desk 0.1.174',
    );
    expect(
      installationLine({ ...poller, environment: 'development', version: '0.1.174' }, 'Beacon Helpdesk'),
    ).toBe('Development · Beacon Helpdesk 0.1.174');
    expect(installationLine({ ...poller, environment: 'development', version: '0.1.174' })).toBe(
      'Development · version 0.1.174',
    );
    expect(installationLine({ ...poller, environment: 'production', version: null }, 'Acme Desk')).toBe(
      'Production',
    );
    expect(installationLine({ ...poller, environment: null, version: ' 0.1.180 ' }, 'Acme Desk')).toBe(
      'Acme Desk 0.1.180',
    );
  });

  it('lists connections by label', () => {
    const rows = catalogRows([
      view({ id: 'con_b', label: 'B' }),
      view({ id: 'con_z', label: 'Z' }),
      view({ id: 'con_a', label: 'A' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['con_a', 'con_b', 'con_z']);
  });

  it('offers a tile unless the entry is off or a tracker has no driver here; an app not set up yet gets Set up', () => {
    expect(catalogTileState(undefined)).toEqual({ action: 'Connect', note: null });
    expect(catalogTileState({ catalogId: 'notion', available: true, reason: null })?.action).toBe('Connect');
    expect(catalogTileState({ catalogId: 'dropbox', available: false, reason: 'off' })).toBeNull();
    // A report tracker nothing here can read isn't offered.
    expect(catalogTileState({ catalogId: 'tracker', available: false, reason: 'no_driver' })).toBeNull();
    expect(catalogTileState({ catalogId: 'tracker', available: true, reason: null })?.action).toBe('Connect');
    const missing = { catalogId: 'dropbox', available: false, reason: 'app_not_configured' as const };
    expect(catalogTileState(missing)?.action).toBe('Set up');
    // No secure address to come back to: its page says what to do first.
    expect(
      catalogTileState({ catalogId: 'dropbox', available: false, reason: 'needs_secure_address' }),
    ).toEqual({ action: 'View', note: 'Needs a secure address' });
  });

  it('groups tiles in the catalog’s category order and searches name, line and category', () => {
    const groups = groupByCategory(CONNECTABLE);
    expect(groups.map((g) => g.label)).toEqual([
      'Productivity',
      'Files',
      'Home',
      'Business',
      'Developer',
      'Infrastructure',
      'Custom',
    ]);
    expect(CONNECTABLE.filter((e) => matchesSearch(e, 'home')).map((e) => e.id)).toContain('homeassistant');
    expect(CONNECTABLE.filter((e) => matchesSearch(e, 'INVOICES')).map((e) => e.id)).toContain('moneybird');
    expect(CONNECTABLE.filter((e) => matchesSearch(e, 'infrastructure')).map((e) => e.id)).toEqual([
      'proxmox',
      'proxmox_backup',
      'hetzner',
      'unifi_network',
      'opnsense',
      'nginx_proxy_manager',
      'tailscale',
      'cloudflare',
      'portainer',
      'unraid',
      'truenas',
      'synology',
      'qnap',
      'grafana',
      'pterodactyl',
    ]);
    expect(CONNECTABLE.filter((e) => matchesSearch(e, 'camera')).map((e) => e.id)).toEqual(['unifi_protect']);
    expect(CONNECTABLE.filter((e) => matchesSearch(e, 'zzz'))).toEqual([]);
  });

  it('opens connect pages only for connectable entries', () => {
    expect(connectableEntry('homeassistant')?.name).toBe('Home Assistant');
    expect(connectableEntry('github')).toBeNull();
    expect(connectableEntry('nope')).toBeNull();
    expect(connectableEntry(undefined)).toBeNull();
  });
});

describe('a refused tracker token (TA-03)', () => {
  it('needs a new token; other connections and other reasons keep their words', () => {
    const tracker = view({
      catalogId: 'tracker',
      status: 'needs_reauth',
      signIn: 'token',
      reauthReason: 'token_invalid',
    });
    expect(connectionState(tracker)).toEqual({ text: 'Needs a new token', tone: 'warn' });
    expect(connectionState({ ...tracker, reauthReason: null }).text).toBe('Needs a new token');
    expect(connectionState({ ...tracker, catalogId: 'homeassistant' }).text).toBe(
      'Needs you to sign in again',
    );
    expect(connectionState({ ...tracker, status: 'error' }).text).toBe('Needs attention');
    expect(connectionState({ ...tracker, status: 'active' }).text).toBe('Connected');
  });
});

describe('a session sign-in (Whombat CM-10, CM-11; AP-2775)', () => {
  it('names its secret, and a refused one needs a new password', () => {
    expect([sessionSecret(entry('pihole')), sessionSecret(entry('nginx_proxy_manager'))]).toEqual([
      'app password',
      'password',
    ]);
    expect(sessionSecret(entry('homeassistant'))).toBeNull();
    const pihole = view({
      catalogId: 'pihole',
      status: 'needs_reauth',
      signIn: 'token',
      reauthReason: 'token_invalid',
    });
    expect(connectionState(pihole).text).toBe('Needs a new app password');
    expect(reauthText('token_invalid', 'Pi-hole', true, 'app password')).toContain('the app password');
  });
});

describe('a tool’s tier (CX-31, CX-72, AP-757)', () => {
  it('shows a sensitive tool as Asks unless it’s off, and Allowed can’t be chosen for it', () => {
    expect(shownTier({ tier: 'can', sensitive: true })).toBe('ask');
    expect(shownTier({ tier: 'off', sensitive: true })).toBe('off');
    expect(shownTier({ tier: 'can', sensitive: false })).toBe('can');
    expect(tierSelectable({ sensitive: true }, 'can')).toBe(false);
    expect(tierSelectable({ sensitive: true }, 'off')).toBe(true);
    expect(tierSelectable({ sensitive: false }, 'can')).toBe(true);
  });
});

describe('connection addresses (AP-758)', () => {
  it('opens a catalog entry’s page and one connection; builtins keep theirs', () => {
    expect(validateSettingsSearch({ tab: 'connections', connection: 'homeassistant' })).toEqual({
      tab: 'connections',
      connection: 'homeassistant',
    });
    expect(
      validateSettingsSearch({ tab: 'connections', connection: 'homeassistant', id: 'con_abc' }),
    ).toEqual({
      tab: 'connections',
      connection: 'homeassistant',
      id: 'con_abc',
    });
    expect(validateSettingsSearch({ tab: 'connections', connection: 'google', id: 'con_abc' })).toEqual({
      tab: 'connections',
      connection: 'google',
    });
    expect(validateSettingsSearch({ tab: 'connections', connection: 'evil' })).toEqual({
      tab: 'connections',
    });
  });

  it('carries a found service’s address to its connect page, and nowhere else (AP-846)', () => {
    expect(
      validateSettingsSearch({ tab: 'connections', connection: 'proxmox', url: 'https://192.168.1.10:8006' }),
    ).toEqual({ tab: 'connections', connection: 'proxmox', url: 'https://192.168.1.10:8006' });
    expect(
      validateSettingsSearch({ tab: 'connections', connection: 'proxmox', url: 'javascript:alert(1)' }),
    ).toEqual({ tab: 'connections', connection: 'proxmox' });
    expect(
      validateSettingsSearch({ tab: 'connections', connection: 'google', url: 'https://x.example' }),
    ).toEqual({ tab: 'connections', connection: 'google' });
    expect(
      validateSettingsSearch({
        tab: 'connections',
        connection: 'proxmox',
        id: 'con_abc',
        url: 'https://x.example',
      }),
    ).toEqual({ tab: 'connections', connection: 'proxmox', id: 'con_abc' });
  });

  it('reads a sign-in’s return: connected=<entry> with the connection where the page was, or an error', () => {
    expect(
      validateSettingsSearch({ tab: 'connections', connected: 'homeassistant', connection: 'con_abc' }),
    ).toEqual({ tab: 'connections', connected: 'homeassistant', connection: 'homeassistant', id: 'con_abc' });
    expect(
      validateSettingsSearch({ tab: 'connections', connection: 'notion', connect_error: 'issuer_mismatch' }),
    ).toEqual({ tab: 'connections', connection: 'notion', connect_error: 'issuer_mismatch' });
    expect(validateSettingsSearch({ tab: 'connections', connected: 'google' })).toEqual({
      tab: 'connections',
      connected: 'google',
    });
  });
});
