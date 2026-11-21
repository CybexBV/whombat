import type {
  ConnectionDiscovery,
  DiscoveredService,
  IdentifyConnectionResponse,
} from '@whombat/core/contracts';
import { CATALOG, type CatalogSignIn, catalogEntry } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { signInChoices } from './form';
import {
  accessChoices,
  asksAccess,
  cidrProblem,
  DISCOVERY_POLL_MS,
  discoveryPollDelay,
  discoveryProgressText,
  elsewhereLevelNote,
  filledText,
  fingerprintWhere,
  foundEmptyText,
  foundList,
  foundSearch,
  groupDigits,
  guidedLink,
  guidedSteps,
  guideLabel,
  hiddenToggleText,
  hideTroubleText,
  identifiedFields,
  identifies,
  identifyNote,
  limitNote,
  nameHelp,
  networksText,
  raiseNote,
  readPaste,
  recommended,
  setupSteps,
  signInNote,
  taglineOf,
  takesPaste,
  trustText,
} from './setup';

const entry = (id: string) => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

type Guided = Extract<CatalogSignIn, { kind: 'token' | 'client_credentials' }>;
const guided = (id: string, kind: 'token' | 'client_credentials' = 'token'): Guided => {
  const m = entry(id).signIn.find((s) => s.kind === kind);
  if (m?.kind !== 'token' && m?.kind !== 'client_credentials') throw new Error(id);
  return m;
};

const CERT = Array.from({ length: 32 }, () => 'AB').join(':');

const identified = (over: Partial<IdentifyConnectionResponse> = {}): IdentifyConnectionResponse => ({
  url: 'https://pve.local:8006',
  reachable: true,
  catalogId: 'proxmox',
  version: '9.0.10',
  certificate: { sha256: CERT, trusted: false },
  message: null,
  ...over,
});

describe('the connect form’s steps (CS-50, AP-843)', () => {
  it('asks where only for a service with an address, and identifies all but the Custom ones', () => {
    expect(setupSteps(entry('proxmox'))).toEqual(['where', 'access', 'signIn']);
    expect(setupSteps(entry('cloudflare'))).toEqual(['access', 'signIn']);
    expect(identifies(entry('proxmox'))).toBe(true);
    expect(identifies(entry('custom_mcp'))).toBe(false);
    expect(identifies(entry('todoist'))).toBe(false);
  });

  it('asks nothing about agents for an entry only automations use (a report tracker, TA-02)', () => {
    expect(setupSteps(entry('tracker'))).toEqual(['where', 'signIn']);
    expect(identifies(entry('tracker'))).toBe(true);
    expect(nameHelp(entry('tracker'))).toBe(
      'How it’s listed here and in automations. You can change it later.',
    );
    expect(nameHelp(entry('proxmox'))).toBe(
      'How it’s listed here and how your agent sees it. You can change it later.',
    );
  });

  it('offers sign in once with the other sign-ins', () => {
    const nextcloud = entry('nextcloud');
    // Nextcloud's own login first since contracts 0.111 (SG-15f): no password, works for every account.
    expect(signInChoices(nextcloud).map((c) => [c.index, c.kind, c.tokenIndex])).toEqual([
      [0, 'nextcloud_login', null],
      [1, 'password', null],
      [2, 'token', 0],
    ]);
    // Tailscale's OAuth client beside its API access token, which keeps its token index.
    expect(
      signInChoices(entry('tailscale'))
        .filter((c) => c.kind === 'token')
        .map((c) => [c.kind, c.tokenIndex]),
    ).toEqual([['token', 0]]);
  });

  it('offers signing in on the service’s own page first (CT-744, AP-3900)', () => {
    const plex = entry('plex');
    expect(signInChoices(plex).map((c) => [c.index, c.kind, c.tokenIndex])).toEqual([
      [0, 'service_login', null],
      [1, 'token', 0],
    ]);
  });

  it('sends the access level where connecting takes it, and says what happens to it elsewhere', () => {
    expect(asksAccess({ kind: 'password' })).toBe(true);
    expect(asksAccess({ kind: 'client_credentials' })).toBe(true);
    expect(asksAccess({ kind: 'token' })).toBe(true);
    expect(asksAccess({ kind: 'nextcloud_login' })).toBe(false);
    expect(asksAccess({ kind: 'ha_oauth' })).toBe(false);
    // The service's own page takes the level in its start (CT-738): no note about it.
    expect(asksAccess({ kind: 'service_login' })).toBe(true);
    expect(elsewhereLevelNote(entry('plex'), { kind: 'service_login' }, 'read')).toBeNull();
    const ha = entry('homeassistant');
    expect(elsewhereLevelNote(ha, { kind: 'ha_oauth' }, 'read')).toBe(
      'Signing in at Home Assistant connects it to manage: set it to Look only on its page afterwards.',
    );
    expect(elsewhereLevelNote(ha, { kind: 'ha_oauth' }, 'manage')).toBeNull();
    expect(elsewhereLevelNote(ha, { kind: 'password' }, 'read')).toBeNull();
    expect(elsewhereLevelNote(entry('nextcloud'), { kind: 'nextcloud_login' }, 'read')).toContain(
      'as soon as Nextcloud lets it in',
    );
  });

  it('recommends the first sign-in when it makes a lasting key of Whombat’s own', () => {
    expect(recommended({ index: 0, kind: 'password' })).toBe(true);
    expect(recommended({ index: 0, kind: 'client_credentials' })).toBe(true);
    expect(recommended({ index: 1, kind: 'password' })).toBe(false);
    expect(recommended({ index: 0, kind: 'token' })).toBe(false);
    expect(recommended({ index: 0, kind: 'service_login' })).toBe(true);
    expect(recommended({ index: 0, kind: 'nextcloud_login' })).toBe(false);
  });

  it('says what each sign-in does on its card', () => {
    const pve = entry('proxmox');
    expect(signInNote(pve, pve.signIn[0] as CatalogSignIn)).toContain('An API token named whombat');
    expect(signInNote(pve, guided('proxmox'))).toBe(
      'Make it in Proxmox VE with the steps below, then paste it here.',
    );
    const nc = entry('nextcloud');
    const login = nc.signIn.find((m) => m.kind === 'nextcloud_login') as CatalogSignIn;
    expect(signInNote(nc, login)).toContain('new tab');
    // The service's own page: the entry's sentence (SG-05).
    const plex = entry('plex');
    const service = plex.signIn.find((m) => m.kind === 'service_login');
    if (service?.kind !== 'service_login') throw new Error('plex service login');
    expect(signInNote(plex, service)).toBe(service.note);
    expect(service.note).toContain('Plex');
  });
});

describe('where is it (CS-13)', () => {
  it('names a recognised service with its version, and says calmly when it isn’t', () => {
    const pve = entry('proxmox');
    expect(identifyNote(pve, identified())).toEqual({
      tone: 'ok',
      title: 'Proxmox VE 9.0.10',
      text: 'Found at https://pve.local:8006.',
    });
    expect(identifyNote(pve, identified({ catalogId: null, version: null })).tone).toBe('warn');
    expect(identifyNote(pve, identified({ catalogId: 'homeassistant' })).title).toBe(
      'This looks like Home Assistant',
    );
    const down = identifyNote(pve, identified({ reachable: false, message: 'No answer within 3 seconds.' }));
    expect(down).toEqual({
      tone: 'bad',
      title: 'Nothing answered',
      text: 'Whombat couldn’t reach https://pve.local:8006. No answer within 3 seconds.',
    });
    // An entry without probes can't be recognised: answering is enough.
    expect(
      identifyNote(entry('gitlab'), identified({ url: 'https://gitlab.example', catalogId: null })).tone,
    ).toBe('ok');
  });

  it('says where to compare the certificate’s fingerprint', () => {
    expect(fingerprintWhere(entry('proxmox'))).toBe('Proxmox → node → System → Certificates');
    expect(trustText(entry('proxmox'))).toBe(
      'Compare it with what Proxmox VE shows (Proxmox → node → System → Certificates), then trust it.',
    );
    expect(fingerprintWhere(entry('tracker'))).toBeNull();
  });

  it('trusts a home-network server’s own certificate once the address is identified', () => {
    const sha256 = Array.from({ length: 32 }, () => 'AB').join(':');
    const found = { url: 'https://10.0.0.5', certificate: { sha256, trusted: false } };
    expect(identifiedFields(entry('unraid'), { url: '10.0.0.5' }, found)).toEqual({
      url: 'https://10.0.0.5',
      fingerprint: sha256,
    });
    // One that verifies is left alone (it renews); one typed stays.
    expect(
      identifiedFields(entry('unraid'), {}, { ...found, certificate: { sha256, trusted: true } }),
    ).toEqual({ url: 'https://10.0.0.5' });
    expect(identifiedFields(entry('unraid'), { fingerprint: 'mine' }, found).fingerprint).toBe('mine');
    expect(identifiedFields(entry('tracker'), {}, found)).toEqual({ url: 'https://10.0.0.5' });
  });
});

describe('a token made by hand, guided (CS-15)', () => {
  it('fills the steps’ values and picks the level’s link', () => {
    const steps = guidedSteps(entry('proxmox'), guided('proxmox'), {});
    expect(steps[1]?.values).toEqual([{ label: 'Token ID', value: 'whombat' }]);
    const cf = guided('cloudflare');
    expect(guidedLink(entry('cloudflare'), cf, 'read', {})).toContain('%22dns%22%2C%22type%22%3A%22read%22');
    expect(guidedLink(entry('cloudflare'), cf, 'manage', {})).toContain(
      '%22dns%22%2C%22type%22%3A%22edit%22',
    );
    const unraid = entry('unraid');
    expect(guidedLink(unraid, guided('unraid'), 'read', { url: 'http://tower.local/' })).toBe(
      'http://tower.local/ApiKeyAuthorize?name=Whombat&scopes=role:viewer',
    );
    expect(guidedLink(unraid, guided('unraid'), 'read', {})).toBeNull();
    // An OAuth client has no per-level link: the entry's own page.
    expect(guidedLink(entry('tailscale'), guided('tailscale', 'client_credentials'), 'read', {})).toBe(
      'https://console.tailscale.com/admin/settings/trust-credentials',
    );
  });

  it('reads Proxmox’s token dialog into the Token ID and the secret', () => {
    const text = 'Token ID\troot@pam!whombat\nSecret\t3f2a9c1e-7b4d-4e8a-9f10-2c6b5d7e8a90\n';
    expect(readPaste(entry('proxmox'), guided('proxmox'), text)).toEqual({
      fields: { tokenId: 'root@pam!whombat' },
      secret: '3f2a9c1e-7b4d-4e8a-9f10-2c6b5d7e8a90',
      filled: ['Token ID', 'Token secret'],
    });
  });

  it('reads OPNsense’s key file, takes a lone token as the secret, and gives up on prose', () => {
    const file = 'key=w86XNZob/8Oq8aC5r4kVpXdL\nsecret=Zr8bQe1Xk2Jv9Pq4Lm7Ts3Wy\n';
    expect(readPaste(entry('opnsense'), guided('opnsense'), file)).toEqual({
      fields: { apiKey: 'w86XNZob/8Oq8aC5r4kVpXdL' },
      secret: 'Zr8bQe1Xk2Jv9Pq4Lm7Ts3Wy',
      filled: ['API key', 'API secret'],
    });
    expect(readPaste(entry('immich'), guided('immich'), '  abcdef123456  ')).toEqual({
      fields: {},
      secret: 'abcdef123456',
      filled: ['API key'],
    });
    expect(readPaste(entry('immich'), guided('immich'), 'this is not a key')).toBeNull();
    expect(filledText(['Token ID', 'Token secret'])).toBe('Filled in Token ID and Token secret.');
    expect(filledText(['API key'])).toBe('Filled in API key.');
    expect(filledText(['A', 'B', 'C'])).toBe('Filled in A, B and C.');
  });
});

describe('what agents may do (CS-10, CS-11)', () => {
  it('offers Look only and Manage with the service’s own words', () => {
    expect(accessChoices(entry('proxmox')).map((c) => [c.value, c.label])).toEqual([
      ['read', 'Look only'],
      ['manage', 'Manage'],
    ]);
    expect(accessChoices(entry('proxmox'))[0]?.text).toContain('VMs, containers');
  });

  it('notes when the service can’t limit the key, and when raising one it made can’t widen it', () => {
    const ha = entry('homeassistant');
    expect(limitNote(ha, ha.signIn[0] as CatalogSignIn)).toBe(
      'Home Assistant can’t limit Whombat’s key itself, so Whombat keeps your agent to the level you choose.',
    );
    expect(limitNote(entry('proxmox'), entry('proxmox').signIn[0] as CatalogSignIn)).toBeNull();
    expect(limitNote(ha, ha.signIn[1] as CatalogSignIn)).toBeNull();
    expect(raiseNote(entry('proxmox'))).toContain('Sign in again');
    expect(raiseNote(ha)).toBeNull();
    expect(raiseNote(entry('cloudflare'))).toBeNull();
  });
});

describe('found on your network (CS-14, CS-51…CS-53)', () => {
  const scan = (over: Partial<ConnectionDiscovery> = {}): ConnectionDiscovery => ({
    state: 'done',
    progress: { done: 1016, total: 1016 },
    startedAt: '2026-10-08T10:00:00.000Z',
    finishedAt: '2026-10-08T10:00:40.000Z',
    networks: ['192.168.1.0/24'],
    found: [],
    ...over,
  });

  it('asks again while it scans, and says how far it is', () => {
    expect(discoveryPollDelay(scan({ state: 'scanning' }))).toBe(DISCOVERY_POLL_MS);
    expect(discoveryPollDelay(scan())).toBeNull();
    expect(discoveryPollDelay(null)).toBeNull();
    expect(discoveryProgressText(scan({ progress: { done: 312, total: 1016 } }))).toBe(
      'Looking at 312 of 1 016 addresses…',
    );
    expect(discoveryProgressText(scan({ progress: null }))).toBe('Looking around your network…');
    expect(groupDigits(1234567)).toBe('1 234 567');
  });

  const service = (over: Partial<DiscoveredService>): DiscoveredService => ({
    catalogId: 'proxmox',
    url: 'https://192.168.1.10:8006',
    host: '192.168.1.10',
    version: null,
    certificate: null,
    connectionIds: [],
    hidden: false,
    ...over,
  });

  it('lists what it knows and is not connected yet, the hidden ones apart (CS-52, CS-53)', () => {
    const list = foundList(
      scan({
        found: [
          service({ version: '9.0.10' }),
          service({
            catalogId: 'homeassistant',
            url: 'http://192.168.1.20:8123',
            host: '192.168.1.20',
            connectionIds: ['con_other', 'con_mine'],
          }),
          service({ catalogId: 'futureservice', url: 'http://192.168.1.30', host: '192.168.1.30' }),
          service({
            catalogId: 'portainer',
            url: 'https://192.168.1.40:9443',
            host: '192.168.1.40',
            hidden: true,
          }),
          // Connected and hidden: connected wins, it is left out and not counted as hidden.
          service({
            catalogId: 'unifi_network',
            url: 'https://192.168.1.1',
            host: '192.168.1.1',
            connectionIds: ['con_unifi'],
            hidden: true,
          }),
        ],
      }),
    );
    expect(list.rows.map((r) => [r.key, r.name, r.version, r.hidden])).toEqual([
      ['proxmox@https://192.168.1.10:8006', 'Proxmox VE', '9.0.10', false],
    ]);
    // What it is in a few words, the catalog's (DF-08, AP-3802).
    expect(list.rows[0]?.tagline).toBe(entry('proxmox').tagline);
    expect(list.hidden.map((r) => [r.name, r.url, r.hidden])).toEqual([
      ['Portainer', 'https://192.168.1.40:9443', true],
    ]);
    expect(list.connected).toBe(2);
    expect(foundSearch('proxmox', 'https://192.168.1.10:8006')).toEqual({
      tab: 'connections',
      connection: 'proxmox',
      url: 'https://192.168.1.10:8006',
    });
    expect(networksText(['192.168.1.0/24', '10.0.0.0/24'])).toBe('Looked in 192.168.1.0/24 and 10.0.0.0/24');
    expect(networksText([])).toBeNull();
  });

  it('leaves the paste box out where the secret is a password the person chose (AP-3807)', () => {
    for (const id of ['synology', 'qnap', 'nginx_proxy_manager']) {
      expect(takesPaste(guided(id)), id).toBe(false);
      expect(guideLabel(guided(id))).toContain('user for Whombat');
    }
    expect(takesPaste(guided('proxmox'))).toBe(true);
    expect(guideLabel(guided('proxmox'))).toContain(guided('proxmox').secretLabel.toLowerCase());
  });

  it('says what every service a scan can find is, in a few words (DF-08, AP-3802)', () => {
    const findable = CATALOG.filter((e) => e.discovery);
    expect(findable.length).toBeGreaterThan(10);
    for (const e of findable) expect(taglineOf(e), e.id).toMatch(/^.{1,40}$/);
    expect(taglineOf({ tagline: undefined })).toBeNull();
  });

  it('says why nothing is listed: nothing found, all connected, or connected or hidden', () => {
    const connected = service({ connectionIds: ['con_pve'] });
    const hidden = service({ catalogId: 'portainer', url: 'https://192.168.1.40:9443', hidden: true });
    expect(foundEmptyText(foundList(scan({ found: [service({})] })))).toBeNull();
    expect(foundEmptyText(foundList(scan()))).toBe(
      'Nothing Whombat knows how to connect turned up on your network.',
    );
    // An entry of a newer runtime isn't something the app knows how to connect.
    expect(foundEmptyText(foundList(scan({ found: [service({ catalogId: 'futureservice' })] })))).toBe(
      'Nothing Whombat knows how to connect turned up on your network.',
    );
    expect(foundEmptyText(foundList(scan({ found: [connected] })))).toBe(
      'Everything Whombat found on your network is connected already.',
    );
    expect(foundEmptyText(foundList(scan({ found: [connected, hidden] })))).toBe(
      'Everything Whombat found on your network is connected or hidden.',
    );
    expect(foundEmptyText(foundList(scan({ found: [hidden] })))).toBe(
      'Everything Whombat found on your network is connected or hidden.',
    );
  });

  it('names the toggle for the hidden ones and what went wrong hiding one', () => {
    expect(hiddenToggleText(2, false)).toBe('Show 2 hidden');
    expect(hiddenToggleText(2, true)).toBe('Hide 2 hidden');
    expect(hiddenToggleText(1, false)).toBe('Show 1 hidden');
    expect(hideTroubleText(true)).toBe('Couldn’t hide that just now. Try again in a moment.');
    expect(hideTroubleText(false)).toBe('Couldn’t show that again just now. Try again in a moment.');
  });

  it('takes another network only when it is private and small enough', () => {
    expect(cidrProblem('192.168.2.0/24')).toBeNull();
    expect(cidrProblem('10.20.0.0/22')).toBeNull();
    expect(cidrProblem('172.20.1.0/24')).toBeNull();
    expect(cidrProblem('172.32.1.0/24')).toContain('Only home network addresses');
    expect(cidrProblem('8.8.8.0/24')).toContain('Only home network addresses');
    expect(cidrProblem('192.168.0.0/16')).toContain('a /22 or smaller');
    expect(cidrProblem('192.168.2.0')).toBe('Write it like 192.168.2.0/24.');
    expect(cidrProblem('300.1.1.0/24')).toBe('Write it like 192.168.2.0/24.');
  });
});
