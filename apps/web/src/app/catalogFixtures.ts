/**
 * The connections catalog in fixture mode (`VITE_FIXTURE_CONNECTORS=connected|none`, AP-764): `connections.*` and
 * `connectors.setApp/removeApp` for the overview, a connect page and a connection page without a server. With
 * `connected`: Mara's Home Assistant (with tools — one new, one that always asks), her Todoist, and her Nextcloud that
 * needs connecting again; Dropbox's app isn't set up. Connecting answers like a
 * server would: an address in 192.168.0.0/16 is refused until “Add this network” (CX-41), Moneybird asks which
 * administration (CT-268), the token `wrong` fails the check, an OAuth sign-in comes straight back connected, a
 * Nextcloud login connects on the second poll, a Custom MCP probe reads the address (`/oauth` wants a sign-in), and an
 * https address of an entry with a certificate fingerprint presents a self-signed certificate until pinned. State
 * lives in the closure; every answer is built to the contracts' schemas.
 *
 * Setting up (CT-314, AP-843…): `connections.identify` knows an address with `pve` in it as Proxmox VE 9.0.10 on its
 * own certificate, one with `ha` or `homeassistant` as Home Assistant over http, one with `down` as unreachable, and
 * anything else as not recognised; `connections.discover` scans for two polls, then finds Proxmox VE, Home Assistant
 * (connected), Portainer, Grafana, Synology DSM and QNAP. Sign in once refuses the account `wrong`, asks for a code when
 * the password is `2fa` (any code goes), sends Nextcloud's `2fa` to its login, and otherwise connects at the level asked;
 * `update` takes `access`. A session's password (Pi-hole, Nginx Proxy Manager, Synology, QNAP; AP-3806) is refused in
 * its entry's words when it is `wrong`, `disabled`, `denied`, `2fa`, `locked` or `expired`.
 *
 * Signing in properly (Whombat connection-signin.md SG-01…SG-09; AP-3913): Sign in with Plex opens Plex's PIN page and
 * connects on the second poll at the level asked (an address with `notowner` fails then in SG-05's words; Sign in again
 * on its page connects that connection again); UniFi's sign in once with the password `2fa` asks for a code with a
 * challenge, and a code sent without that challenge is asked for again with a new one (`000000` is refused with a new
 * one too); Synology's password `2fa` asks for its two-step code once (connect and Replace password), `000000` is
 * refused. A sign-in with a code and no account (T3 Code's pairing code) refuses the code `wrong`, on connect and on Sign
 * in again.
 *
 * Nobody looks after a connection: there is one agent (Whombat one-agent.md OA-07; app one-agent.md AP-4944).
 *
 * A report tracker, the made-up Acme Desk (Whombat report-trackers.md TA-01…TA-03): two shared connections only
 * automations use, read by its `acme-desk` driver — “Acme Desk dev” (`con_fixture_tracker`, its poller checked 2 min
 * before the mock world's moment) and “Acme Desk” (`con_fixture_tracker_prod`, its poller can't reach it, last reached
 * an hour before that). No tools. The automation
 * fixtures refer to both by id.
 *
 * Found on your network (Whombat connections-setup.md CS-52, CS-53; CT-316, AP-871…): a found service is connected when
 * a connection of its entry has its host (the seeded Home Assistant is the one at 192.168.1.20), `connections.hideFound`
 * hides one or shows it again (kept across scans), and a scan running again keeps what the last one found until it is
 * done.
 */

import {
  createFindMyTimelineFixture,
  findMyConnectionView,
  MAC_SERVER,
  macFixtureListed,
} from '@whombat/client/hosts/fixtures';
import type { ConnectionDiscovery, DiscoveredService } from '@whombat/core/contracts';
import { type AnyEndpoint, API_ENDPOINTS, api, matchPath } from '@whombat/core/contracts';
import {
  CATALOG_CONNECTABLE,
  type CatalogEntryStatus,
  CONNECTIONS_MAX,
  type ConnectionAccessLevel,
  type ConnectionsCatalogStatus,
  type ConnectionToolView,
  type ConnectionView,
  catalogEntry,
  catalogSignIn,
  defaultConnectionLabel,
  discoveredUrl,
  FOUND_SERVER_ID,
  foundServerUrl,
  handleFor,
  type SessionLoginFailureReason,
  type SignInKind,
  SOCKET_TOOL_NAME,
  sessionLoginFailureText,
} from '@whombat/core/domain';
import { burrow, mara } from '@whombat/fixtures';

const API_BASE = '/api/v1';
/** The fingerprint a fixture home server's self-signed certificate presents (CT-313). */
const FIXTURE_CERTIFICATE =
  '3B:9C:51:0E:A7:42:D8:16:6F:C3:20:8B:E4:71:95:0D:2A:CC:58:B1:07:E9:64:3F:D2:8A:1C:75:B0:4E:93:6D';
const NOW = '2026-09-23T09:15:00.000Z';
/**
 * The tracker pollers' last check, 2 min before the mock world's moment (11:22 in Amsterdam, as the tests and the visual
 * suite pin it), and the production one's last success an hour before that.
 */
const TRACKER_CHECKED = '2026-09-23T09:20:00.000Z';
const TRACKER_REACHED = '2026-09-23T08:20:00.000Z';

const HA_TOOLS: ConnectionToolView[] = [
  {
    name: 'GetLiveContext',
    description: 'What is on, off, open or playing in the house right now, by area.',
    access: 'read',
    tier: 'can',
    sensitive: false,
    isNew: false,
  },
  {
    name: 'HassTurnOn',
    description: 'Turns on a light, switch, fan or media player by name or area.',
    access: 'write',
    tier: 'can',
    sensitive: false,
    isNew: false,
  },
  {
    name: 'HassTurnOff',
    description: 'Turns off a light, switch, fan or media player by name or area.',
    access: 'write',
    tier: 'can',
    sensitive: false,
    isNew: false,
  },
  {
    name: 'HassLightSet',
    description: 'Sets a light’s brightness or colour.',
    access: 'write',
    tier: 'ask',
    sensitive: false,
    isNew: true,
  },
  {
    name: 'HassSetPosition',
    description: 'Opens or closes a cover, valve or garage door to a position.',
    access: 'write',
    tier: 'ask',
    sensitive: true,
    isNew: false,
  },
  {
    name: 'request',
    description:
      'Any call to the Home Assistant REST API under /api/ (GET reads; POST /api/services/… changes things).',
    access: 'write',
    tier: 'ask',
    sensitive: false,
    isNew: false,
  },
];

/** Typed tools from the catalog entry, at their default tiers (CX-18), then `request` where the entry has one. */
function entryTools(catalogId: string): ConnectionToolView[] {
  if (catalogId === 'homeassistant') return HA_TOOLS.map((t) => ({ ...t }));
  const entry = catalogEntry(catalogId);
  if (!entry) return [];
  const typed = entry.tools.map(
    (t): ConnectionToolView => ({
      name: t.name,
      description: t.description,
      access: t.access,
      tier: t.access === 'read' ? 'can' : 'ask',
      sensitive: t.sensitive === true,
      isNew: false,
    }),
  );
  // REST entries get the generic `request` tool, socket ones (TrueNAS, ESPHome; 0.97 CT-472) the `call` tool.
  const generic = entry.request ? 'request' : entry.socket ? SOCKET_TOOL_NAME : null;
  return generic
    ? [
        ...typed,
        {
          name: generic,
          description: `Any call to the ${entry.name} API (reads are allowed; changes follow this tier).`,
          access: 'write',
          tier: 'ask',
          sensitive: false,
          isNew: false,
        },
      ]
    : typed;
}

function view(
  id: string,
  catalogId: string,
  fields: Record<string, string>,
  extra: Partial<ConnectionView> = {},
): ConnectionView {
  const entry = catalogEntry(catalogId);
  // The sign-in's own transport where it names one (contracts 0.111: Todoist's token is REST beside its MCP sign-in).
  const transport = (entry && catalogSignIn(entry, extra.signIn ?? 'token')?.transport) ?? entry?.transport;
  return {
    id,
    catalogId,
    label: entry ? defaultConnectionLabel(entry, fields) : catalogId,
    handle: handleFor(catalogId, []),
    connectedBy: { id: mara.id, name: mara.name },
    detail: null,
    signIn: 'token',
    transport: transport === 'mcp' ? 'mcp' : 'rest',
    fields,
    status: 'active',
    reauthReason: null,
    checks: [
      { id: 'credential', state: 'ok', message: null },
      { id: 'tools', state: 'ok', message: null },
    ],
    checkedAt: NOW,
    toolCount: entryTools(catalogId).length,
    access: 'manage',
    poller: null,
    createdAt: '2026-09-21T14:02:00.000Z',
    lastUsedAt: NOW,
    ...extra,
  };
}

function seed(connected: boolean): { connection: ConnectionView; tools: ConnectionToolView[] }[] {
  if (!connected) return [];
  return [
    {
      connection: view(
        'con_fixture_ha',
        'homeassistant',
        { url: 'http://homeassistant.local:8123' },
        {
          checks: [
            { id: 'credential', state: 'ok', message: null },
            { id: 'mcp', state: 'ok', message: null },
            {
              id: 'destination',
              state: 'warning',
              message: 'On your home network over http: the token isn’t encrypted.',
            },
            { id: 'tools', state: 'ok', message: '6 tools' },
          ],
        },
      ),
      tools: entryTools('homeassistant'),
    },
    {
      connection: view('con_fixture_todoist', 'todoist', {}, { detail: 'mara@burrowhq.example' }),
      tools: entryTools('todoist'),
    },
    {
      connection: view(
        'con_fixture_nextcloud',
        'nextcloud',
        { url: 'https://cloud.burrowhq.example' },
        {
          signIn: 'nextcloud_login',
          detail: 'mara',
          status: 'needs_reauth',
          reauthReason: 'revoked',
          checks: [
            {
              id: 'credential',
              state: 'error',
              message: 'Nextcloud answered 401: the app password was revoked.',
            },
          ],
        },
      ),
      tools: entryTools('nextcloud'),
    },
    // A report tracker, which only automations use (TA-01…TA-03): development reached 2 min ago, production not
    // reachable.
    {
      connection: view(
        'con_fixture_tracker',
        'tracker',
        { url: 'https://dev.desk.acme.example', driver: 'acme-desk' },
        {
          label: 'Acme Desk dev',
          handle: 'tracker',
          checks: [{ id: 'credential', state: 'ok', message: null }],
          toolCount: 0,
          // Which installation it is: “Development · version 0.1.174”.
          poller: {
            checkedAt: TRACKER_CHECKED,
            succeededAt: TRACKER_CHECKED,
            problem: null,
            environment: 'development',
            version: '0.1.174',
          },
        },
      ),
      tools: [],
    },
    {
      connection: view(
        'con_fixture_tracker_prod',
        'tracker',
        { url: 'https://desk.acme.example', driver: 'acme-desk' },
        {
          label: 'Acme Desk',
          handle: 'tracker-2',
          checks: [{ id: 'credential', state: 'ok', message: null }],
          toolCount: 0,
          poller: {
            checkedAt: TRACKER_CHECKED,
            succeededAt: TRACKER_REACHED,
            problem: 'Acme Desk didn’t answer within 15 s',
            environment: 'production',
            version: '0.1.170',
          },
        },
      ),
      tools: [],
    },
    // Find My through studio, when the servers' world lists the Mac (findmy-connection.md): read every 15 minutes.
    ...(macFixtureListed()
      ? [
          {
            connection: findMyConnectionView(NOW, { connectedBy: { id: mara.id, name: mara.name } }),
            tools: entryTools('findmy'),
          },
        ]
      : []),
  ];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refuse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return json(
    { error: { code: status === 403 ? 'not_allowed' : 'conflict', message, details: { code, ...details } } },
    status,
  );
}

/**
 * What a fixture scan finds (CS-14): Proxmox VE, Home Assistant, Portainer, Grafana, two NAS and a Debian server. Connected (CS-52): a connection
 * of the same entry on that host; the seeded Home Assistant (`homeassistant.local`) is the one at 192.168.1.20. Hidden
 * (CS-53): its entry and address are in `hidden`.
 */
function foundServices(rows: readonly { connection: ConnectionView }[], hidden: ReadonlySet<string>) {
  const found: Omit<DiscoveredService, 'connectionIds' | 'hidden'>[] = [
    {
      catalogId: 'proxmox',
      url: discoveredUrl('https', '192.168.1.10', 8006),
      host: '192.168.1.10',
      version: '9.0.10',
      certificate: { sha256: FIXTURE_CERTIFICATE, trusted: false },
    },
    {
      catalogId: 'homeassistant',
      url: discoveredUrl('http', '192.168.1.20', 8123),
      host: '192.168.1.20',
      version: '2026.10.1',
      certificate: null,
    },
    {
      catalogId: 'portainer',
      url: discoveredUrl('https', '192.168.1.30', 9443),
      host: '192.168.1.30',
      version: '2.33.1',
      certificate: { sha256: FIXTURE_CERTIFICATE, trusted: false },
    },
    {
      catalogId: 'grafana',
      url: discoveredUrl('http', '192.168.1.40', 3000),
      host: '192.168.1.40',
      version: '12.2.0',
      certificate: null,
    },
    // The two NAS (Whombat desk-found.md NS-01; AP-3806), each on its own certificate.
    {
      catalogId: 'synology',
      url: discoveredUrl('https', '192.168.1.50', 5001),
      host: '192.168.1.50',
      version: '7.2.2',
      certificate: { sha256: FIXTURE_CERTIFICATE, trusted: false },
    },
    {
      catalogId: 'qnap',
      url: discoveredUrl('https', '192.168.1.60', 443),
      host: '192.168.1.60',
      version: '5.2.4',
      certificate: { sha256: FIXTURE_CERTIFICATE, trusted: false },
    },
    // A computer that answers SSH (Whombat connect-in-chat.md): a server to add.
    {
      catalogId: FOUND_SERVER_ID,
      url: foundServerUrl('192.168.1.70', 22),
      host: '192.168.1.70',
      version: 'Debian',
      certificate: null,
    },
  ];
  return found.map(
    (s): DiscoveredService => ({
      ...s,
      connectionIds: rows
        .map((r) => r.connection)
        .filter(
          (c) =>
            c.catalogId === s.catalogId &&
            (c.id === 'con_fixture_ha' || hostOf(c.fields.url ?? '') === s.host),
        )
        .map((c) => c.id),
      hidden: hidden.has(foundKey(s.catalogId, s.url)),
    }),
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** A hidden found service: its entry and address (the server keeps host and port). */
function foundKey(catalogId: string, url: string): string {
  return `${catalogId}@${url}`;
}

/** A token sign-in that is a password Whombat signs in with for a session (Pi-hole, Synology, QNAP; CT-470). */
function sessionOf(catalogId: string) {
  const method = catalogEntry(catalogId)?.signIn.find((m) => m.kind === 'token');
  return method?.kind === 'token' && method.auth.type === 'session' ? method.auth : null;
}

/** A token sign-in whose session asks for a two-step code once (`twoStep`, CT-732: Synology). */
function twoStepOf(catalogId: string) {
  return sessionOf(catalogId)?.twoStep ?? null;
}

/**
 * A session's two-step code (SG-09) as the server answers it: the password `2fa` asks for one, `000000` is refused, any
 * other code goes. Null when nothing is in the way.
 */
function twoStepRefusal(catalogId: string, secret: unknown, code: unknown): Response | null {
  if (!twoStepOf(catalogId) || secret !== '2fa') return null;
  if (typeof code !== 'string' || !code.trim())
    return refuse(409, 'second_factor_needed', 'Enter the code from your authenticator app.');
  if (code.trim() === '000000')
    return refuse(
      409,
      'sign_in_refused',
      'That code didn’t work. Enter the current code from your authenticator app.',
      { reason: 'code' },
    );
  return null;
}

/** The fixture passwords a session refuses, and why (NS-04): `wrong`, `disabled`, `denied`, `2fa`, `locked`, `expired`. */
const SESSION_REFUSALS: Record<string, SessionLoginFailureReason> = {
  wrong: 'refused',
  disabled: 'disabled',
  denied: 'denied',
  '2fa': 'two_step',
  locked: 'locked',
  expired: 'expired',
};

/**
 * A session's sign-in refused as the server says it (`check_failed` with the person's words, AP-3805): the entry's own
 * words for the reason, else the catalog's (`sessionLoginFailureText`); status 200 where the service answers its refusals
 * so (Synology, QNAP: the entry reads `failures`; a reason it doesn't tell apart is its “refused”), else 401.
 */
function sessionRefusal(catalogId: string, secret: unknown): Response | null {
  const entry = catalogEntry(catalogId);
  const auth = sessionOf(catalogId);
  const reason = typeof secret === 'string' ? SESSION_REFUSALS[secret] : undefined;
  if (!entry || !auth || !reason) return null;
  // A service that tells fewer reasons apart says “refused” for the rest (QNAP's `authPassed` 0).
  const failures = auth.failures ?? [];
  const failure = failures.length
    ? (failures.find((f) => f.reason === reason) ?? failures.find((f) => f.reason === 'refused'))
    : undefined;
  const text = failure ? (failure.text ?? sessionLoginFailureText(entry, failure.reason)) : null;
  return refuse(409, 'check_failed', text ?? sessionLoginFailureText(entry, reason), {
    status: failures.length ? 200 : 401,
  });
}

/**
 * A code's sign-in (T3 Code's pairing code, no account): the code `wrong` is refused as the server refuses a sign in
 * once's password, on connect and on Sign in again. Null otherwise.
 */
function codeRefusal(catalogId: string, code: unknown): Response | null {
  const entry = catalogEntry(catalogId);
  const once = entry?.signIn.find((m) => m.kind === 'password');
  if (!entry || once?.kind !== 'password' || once.account !== null || code !== 'wrong') return null;
  return refuse(
    409,
    'sign_in_refused',
    `That pairing code didn’t work: it’s used or more than 5 minutes old. Make a new one in ${entry.name}.`,
    { reason: 'password' },
  );
}

/** The scan's addresses: the Whombat's own /24 and the home network list's, as the server would count them. */
const SCAN_TOTAL = 1016;

/** What answers on its own certificate (CT-313): Proxmox VE and the two NAS (AP-3806). */
const OWN_CERTIFICATE: ReadonlySet<string> = new Set(['proxmox', 'synology', 'qnap']);

/**
 * What a fixture address is (CS-13): `pve` → Proxmox VE 9.0.10, `synology` / `diskstation` → Synology DSM 7.2.2 and
 * `qnap` → QNAP 5.2.4 (AP-3806), each on its own certificate; `ha` / `homeassistant` → Home Assistant over http; `down` →
 * nothing answering; anything else not recognised. A bare host gets the entry's scheme and port, as the server adds them.
 */
function identifyAddress(catalogId: string | undefined, raw: string) {
  const entry = catalogId ? catalogEntry(catalogId) : null;
  const text = raw.trim();
  const host = (
    /^[a-z]+:\/\//i.test(text) ? new URL(text).hostname : (text.split(/[/:]/)[0] ?? '')
  ).toLowerCase();
  const seen: { catalogId: string; version: string } | null = host.includes('pve')
    ? { catalogId: 'proxmox', version: '9.0.10' }
    : /(^|[.-])ha([.-]|$)|homeassistant/.test(host)
      ? { catalogId: 'homeassistant', version: '2026.10.1' }
      : /synology|diskstation/.test(host)
        ? { catalogId: 'synology', version: '7.2.2' }
        : host.includes('qnap')
          ? { catalogId: 'qnap', version: '5.2.4' }
          : null;
  const target =
    catalogEntry(seen?.catalogId ?? '')?.discovery?.targets[0] ?? entry?.discovery?.targets[0] ?? null;
  let url = text.replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(url))
    url = target ? discoveredUrl(target.scheme, url.split(/[/:]/)[0] ?? url, target.port) : `https://${url}`;
  const https = url.startsWith('https://');
  return {
    url,
    reachable: !host.includes('down'),
    catalogId: host.includes('down')
      ? null
      : seen && (!entry || entry.id === seen.catalogId)
        ? seen.catalogId
        : null,
    version: host.includes('down') ? null : (seen?.version ?? null),
    certificate:
      https && !host.includes('down')
        ? {
            sha256: FIXTURE_CERTIFICATE,
            trusted: !OWN_CERTIFICATE.has(seen?.catalogId ?? '') && !/^192\.168\./.test(host),
          }
        : null,
    message: host.includes('down') ? 'No answer within 3 seconds.' : null,
  };
}

const ENDPOINTS: AnyEndpoint[] = API_ENDPOINTS.filter(
  (e) => e.id.startsWith('connections.') || e.id === 'connectors.setApp' || e.id === 'connectors.removeApp',
);

export function createCatalogFixtures({ connected }: { connected: boolean }) {
  const rows = seed(connected);
  const allowed = new Set<string>();
  // Find My's timeline (findmy-timeline.md §1): Noor and Ruben kept; the assistant reads it while its tool is Allowed.
  const timeline = createFindMyTimelineFixture({
    clock: () => Date.now(),
    assistantReads: () =>
      rows.find((r) => r.connection.catalogId === 'findmy')?.tools.find((t) => t.name === 'findmy_timeline')
        ?.tier === 'can',
  });
  let dropboxApp: { clientIdHint: string; secretSet: boolean } | null = null;
  const flows = new Map<string, { polls: number; fields: Record<string, string>; label?: string }>();
  /** Sign-ins on the service's own page (SG-01): Plex's PIN, connected on the second poll. */
  const serviceFlows = new Map<
    string,
    {
      polls: number;
      catalogId: string;
      fields: Record<string, string>;
      label?: string;
      access: ConnectionAccessLevel;
      connectionId: string | null;
    }
  >();
  /** The challenges UniFi's fixture made (SG-06): the code answers the newest. */
  let challenges = 0;
  let n = 0;
  /**
   * The last scan (CS-14): how many polls it has had, the networks asked for, when it started, and whether an earlier
   * scan finished (what it found stays until this one is done).
   */
  let scan: {
    polls: number;
    networks: string[];
    startedAt: string;
    finishedAt: string | null;
    kept: boolean;
  } | null = null;
  /** Found services hidden from the list (CS-53), by `foundKey`. */
  const hiddenFound = new Set<string>();

  function discovery(): ConnectionDiscovery {
    if (!scan)
      return { state: 'idle', progress: null, startedAt: null, finishedAt: null, networks: [], found: [] };
    const done = scan.polls >= 3;
    const networks = ['192.168.1.0/24', '10.0.10.0/24', ...scan.networks];
    return {
      state: done ? 'done' : 'scanning',
      progress: { done: done ? SCAN_TOTAL : Math.min(SCAN_TOTAL, 312 * scan.polls), total: SCAN_TOTAL },
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      networks,
      found: done || scan.kept ? foundServices(rows, hiddenFound) : [],
    };
  }

  function status(): ConnectionsCatalogStatus {
    const entries: CatalogEntryStatus[] = API_CATALOG.map((id) =>
      id === 'dropbox'
        ? {
            catalogId: id,
            available: dropboxApp !== null,
            reason: dropboxApp ? null : 'app_not_configured',
            app: {
              configured: dropboxApp !== null,
              source: dropboxApp ? 'settings' : null,
              clientIdHint: dropboxApp?.clientIdHint ?? null,
              secretSet: dropboxApp?.secretSet ?? false,
              redirectUri: 'https://whombat.example/api/v1/connections/dropbox/callback',
              updatedAt: dropboxApp ? NOW : null,
            },
          }
        : id === 'findmy' && !macFixtureListed()
          ? // Find My reads through a Mac: without studio in the servers' world, Add a Mac first.
            { catalogId: id, available: false, reason: 'needs_mac' }
          : { catalogId: id, available: true, reason: null },
    );
    return { mode: 'real', entries, limit: CONNECTIONS_MAX };
  }

  function list() {
    const connections = rows.map((r) => r.connection).sort((a, b) => a.label.localeCompare(b.label));
    return { connections, count: connections.length };
  }

  function add(
    catalogId: string,
    fields: Record<string, string>,
    signIn: SignInKind,
    label?: string,
  ): ConnectionView {
    const entry = catalogEntry(catalogId);
    const id = `con_fixture_${++n}`;
    const taken = rows.map((r) => r.connection.handle);
    const connection = view(id, catalogId, fields, {
      label: label ?? (entry ? defaultConnectionLabel(entry, fields) : catalogId),
      handle: handleFor(catalogId, taken, label),
      signIn,
      createdAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    rows.push({ connection, tools: entryTools(catalogId) });
    return connection;
  }

  /** A home-network address not on the list (CX-41): 192.168.x.y, with its /24 and port. */
  function refused(fields: Record<string, string>): Response | null {
    const m = /^https?:\/\/(192\.168\.(\d+))\.\d+(?::(\d+))?/.exec(fields.url ?? '');
    if (!m) return null;
    const cidr = `${m[1]}.0/24`;
    const port = Number(m[3] ?? (fields.url?.startsWith('https') ? 443 : 80));
    if (allowed.has(`${cidr}:${port}`)) return null;
    return refuse(403, 'destination_refused', 'That address is on your network.', {
      problem: 'private_unlisted',
      cidr,
      port,
      canAdd: true,
    });
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
    let ep: AnyEndpoint | undefined;
    let params: Record<string, string> | null = null;
    for (const e of ENDPOINTS) {
      if (e.method !== req.method) continue;
      params = matchPath(e.path, path);
      if (params) {
        ep = e;
        break;
      }
    }
    if (!ep || !params) return null;
    const text = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const row = params.connectionId ? rows.find((r) => r.connection.id === params?.connectionId) : undefined;
    const fields = (body.fields ?? {}) as Record<string, string>;

    switch (ep.id) {
      case api.connections.catalog.id:
        return json(status());
      case api.connections.list.id:
        return json(list());
      case api.connections.create.id: {
        const catalogId = String(body.catalogId);
        const no = refused(fields);
        if (no) return no;
        // Sign in once (CT-314): a wrong account, a code asked for, Nextcloud's two-step sign-in, then as a token.
        const login = (body.login ?? null) as {
          account?: string;
          password?: string;
          code?: string;
          challenge?: string;
        } | null;
        if (body.signIn === 'password') {
          if (!login) return refuse(400, 'validation_failed', 'Sign in with an account and its password.');
          const code = codeRefusal(catalogId, login.password);
          if (code) return code;
          if (login.account === 'wrong')
            return refuse(409, 'sign_in_refused', 'Wrong username, password or realm.', {
              reason: 'password',
            });
          if (login.password === '2fa' && catalogId === 'nextcloud')
            return refuse(
              409,
              'sign_in_refused',
              'This account uses two-step sign-in. Sign in with Nextcloud instead.',
              {
                reason: 'second_factor',
                method: 'nextcloud_login',
              },
            );
          // UniFi's code belongs to the challenge it made (SG-06, SG-07): without that challenge it asks again.
          const unifi = catalogId.startsWith('unifi');
          const current = `fixture-challenge-${challenges}`;
          if (
            login.password === '2fa' &&
            (!login.code || (unifi && (challenges === 0 || login.challenge !== current)))
          )
            return refuse(
              409,
              'second_factor_needed',
              unifi
                ? 'Enter the code from your authenticator app, or the one UniFi just emailed to m•••@burrowhq.example.'
                : 'Enter the code from your authenticator app.',
              unifi ? { challenge: `fixture-challenge-${++challenges}` } : {},
            );
          if (login.code === '000000')
            return refuse(
              409,
              'sign_in_refused',
              unifi
                ? 'That code didn’t work. Enter the newest code.'
                : 'That code didn’t work. Enter the newest one.',
              { reason: 'code', ...(unifi ? { challenge: `fixture-challenge-${++challenges}` } : {}) },
            );
        }
        const session = sessionOf(catalogId);
        if (body.secret === 'wrong' && !session)
          return refuse(
            409,
            'check_failed',
            'Whombat couldn’t sign in with that. Check the address and the token.',
            {
              status: 401,
            },
          );
        // A home server's own certificate (CT-313): the check names the fingerprint until it is pinned.
        if (
          catalogEntry(catalogId)?.fields.some((f) => f.id === 'fingerprint') &&
          fields.url?.startsWith('https://') &&
          fields.fingerprint !== FIXTURE_CERTIFICATE
        )
          return refuse(
            409,
            'check_failed',
            `Its certificate can’t be verified: it’s self-signed, expired or for another name. It presents ${FIXTURE_CERTIFICATE}; if ${catalogEntry(catalogId)?.name} shows the same fingerprint, use it as the certificate fingerprint.`,
            { certificateSha256: FIXTURE_CERTIFICATE },
          );
        // A session's two-step code (SG-09), then its password refused in the entry's words (NS-04, AP-3806), once the
        // certificate is trusted.
        const twoStep = twoStepRefusal(catalogId, body.secret, body.code);
        if (twoStep) return twoStep;
        const refusedPassword =
          twoStepOf(catalogId) && body.secret === '2fa' ? null : sessionRefusal(catalogId, body.secret);
        if (refusedPassword) return refusedPassword;
        // Find My picks the only Mac by itself, and one Mac has one Find My (findmy-connection.md §1.1).
        if (catalogId === 'findmy') {
          if (!macFixtureListed())
            return refuse(409, 'check_failed', 'Add your Mac as a server first, then connect Find My.');
          fields.mac ||= MAC_SERVER;
          if (rows.some((r) => r.connection.catalogId === 'findmy' && r.connection.fields.mac === fields.mac))
            return refuse(409, 'check_failed', `Find My on ${fields.mac} is already connected.`);
        }
        // 1Password's token sees two vaults: the person picks the one Whombat keeps in step (onepassword-sync.md OPW-01).
        if (catalogId === 'onepassword' && !fields.vault)
          return refuse(
            409,
            'field_choice_needed',
            'This token can see two vaults. Choose the one for Whombat.',
            {
              field: 'vault',
              options: [
                { value: 'k3ntq6b7f2x4yhd5wzmuv9cj8a', label: 'Whombat' },
                { value: 'm4pqr7c8g3y5zje6xanw0dk9b1', label: 'Shared with Whombat' },
              ],
            },
          );
        if (catalogId === 'moneybird' && !fields.administration)
          return refuse(
            409,
            'field_choice_needed',
            'This token reaches two administrations. Choose one to go on.',
            {
              field: 'administration',
              options: [
                { value: '123456789', label: 'Burrow HQ B.V.' },
                { value: '987654321', label: 'Mara Oduya (eenmanszaak)' },
              ],
            },
          );
        const made =
          body.signIn === 'password' && catalogId === 'proxmox'
            ? {
                ...fields,
                tokenId: `${login?.account?.includes('@') ? login.account : `${login?.account}@pam`}!whombat`,
              }
            : fields;
        const connection = add(
          catalogId,
          made,
          body.signIn === 'none'
            ? 'none'
            : body.signIn === 'client_credentials'
              ? 'client_credentials'
              : 'token',
          typeof body.label === 'string' ? body.label : undefined,
        );
        connection.access = body.access === 'read' ? 'read' : 'manage';
        return json({ connection, eventId: null }, 201);
      }
      case api.connections.update.id: {
        if (!row) return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
        if (typeof body.label === 'string') row.connection.label = body.label;
        // As the server: the fields sent replace those, the rest stay (an empty value removes one).
        if (body.fields) {
          const next = { ...row.connection.fields, ...(body.fields as Record<string, string>) };
          for (const [k, v] of Object.entries(body.fields as Record<string, string>))
            if (!v.trim()) delete next[k];
          row.connection.fields = next;
        }
        if (body.access === 'read' || body.access === 'manage')
          row.connection.access = body.access as ConnectionAccessLevel;
        return json({ connection: row.connection, eventId: null });
      }
      case api.connections.setSecret.id: {
        if (!row) return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
        const twoStep = twoStepRefusal(row.connection.catalogId, body.secret, body.code);
        if (twoStep) return twoStep;
        const refusedPassword =
          twoStepOf(row.connection.catalogId) && body.secret === '2fa'
            ? null
            : sessionRefusal(row.connection.catalogId, body.secret);
        if (refusedPassword) return refusedPassword;
        const code = codeRefusal(row.connection.catalogId, body.secret);
        if (code) return code;
        if (body.secret === 'wrong')
          return refuse(409, 'check_failed', 'Whombat couldn’t sign in with that.', { status: 401 });
        row.connection.status = 'active';
        row.connection.reauthReason = null;
        return json({ connection: row.connection, eventId: null });
      }
      case api.connections.recheck.id: {
        if (!row) return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
        row.connection.checkedAt = new Date().toISOString();
        return json({ connection: row.connection, checks: row.connection.checks });
      }
      case api.connections.disconnect.id: {
        const i = rows.findIndex((r) => r.connection.id === params?.connectionId);
        if (i >= 0) rows.splice(i, 1);
        return json({ ok: true, eventId: null });
      }
      case api.connections.tools.id: {
        if (!row) return json({ error: { code: 'not_found', message: 'That connection isn’t here.' } }, 404);
        return json({
          connection: row.connection,
          tools: row.tools,
          guide: catalogEntry(row.connection.catalogId)?.guide ?? '',
          truncated: false,
        });
      }
      case api.connections.setTool.id: {
        if (!row) return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
        const tool = row.tools.find((t) => t.name === decodeURIComponent(params.tool ?? ''));
        if (!tool) return refuse(404, 'unknown_tool', 'That tool isn’t one of this connection’s.');
        tool.tier = body.tier as ConnectionToolView['tier'];
        tool.isNew = false;
        return json({
          connection: row.connection,
          tools: row.tools,
          guide: catalogEntry(row.connection.catalogId)?.guide ?? '',
          truncated: false,
        });
      }
      case api.connections.startOAuth.id: {
        const no = refused(fields);
        if (no) return no;
        const catalogId = String(body.catalogId);
        if (catalogId === 'dropbox' && !dropboxApp)
          return refuse(409, 'app_not_configured', 'Dropbox needs to be set up on this Whombat first.');
        const existing = rows.find((r) => r.connection.id === body.connectionId);
        let id: string;
        if (existing) {
          existing.connection.status = 'active';
          existing.connection.reauthReason = null;
          id = existing.connection.id;
        } else
          id = add(
            catalogId,
            fields,
            body.method as SignInKind,
            typeof body.label === 'string' ? body.label : undefined,
          ).id;
        const back = new URL(String(body.returnTo), 'http://fixtures.local');
        back.searchParams.set('connected', catalogId);
        back.searchParams.set('connection', id);
        return json({ authorizeUrl: `${window.location.origin}${back.pathname}${back.search}` });
      }
      case api.connections.startNextcloud.id: {
        const no = refused(fields);
        if (no) return no;
        const flowId = `oas_fixture_${++n}`;
        const existing = rows.find((r) => r.connection.id === body.connectionId);
        flows.set(flowId, {
          polls: 0,
          fields: existing?.connection.fields ?? fields,
          label: typeof body.label === 'string' ? body.label : undefined,
        });
        return json({
          loginUrl: `${(existing?.connection.fields.url ?? fields.url ?? 'https://cloud.example').replace(/\/+$/, '')}/index.php/login/v2/flow/fixture`,
          flowId,
          pollEveryMs: 2000,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
      }
      case api.connections.pollNextcloud.id: {
        const flow = flows.get(params.flowId ?? '');
        if (!flow) return json({ state: 'expired' });
        flow.polls += 1;
        if (flow.polls < 2) return json({ state: 'pending' });
        flows.delete(params.flowId ?? '');
        const existing = rows.find(
          (r) => r.connection.fields.url === flow.fields.url && r.connection.catalogId === 'nextcloud',
        );
        if (existing) {
          existing.connection.status = 'active';
          existing.connection.reauthReason = null;
          existing.connection.checks = [{ id: 'credential', state: 'ok', message: null }];
          return json({ state: 'connected', connection: existing.connection, eventId: null });
        }
        const connection = add('nextcloud', flow.fields, 'nextcloud_login', flow.label);
        connection.detail = 'mara';
        return json({ state: 'connected', connection, eventId: null });
      }
      case api.connections.startServiceLogin.id: {
        const existing = rows.find((r) => r.connection.id === body.connectionId);
        const flowFields = existing?.connection.fields ?? fields;
        const no = refused(flowFields);
        if (no) return no;
        const flowId = `oas_fixture_${++n}`;
        serviceFlows.set(flowId, {
          polls: 0,
          catalogId: existing?.connection.catalogId ?? String(body.catalogId),
          fields: flowFields,
          label: typeof body.label === 'string' ? body.label : undefined,
          access: body.access === 'read' ? 'read' : 'manage',
          connectionId: existing?.connection.id ?? null,
        });
        // Plex's PIN page as the server names it (SG-04): its client id and the PIN's code, no forwardUrl.
        return json({
          loginUrl: `https://app.plex.tv/auth#?clientID=whombat-fixture&code=fixture${n}&context%5Bdevice%5D%5Bproduct%5D=Whombat`,
          flowId,
          pollEveryMs: 2000,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          userCode: null,
        });
      }
      case api.connections.pollServiceLogin.id: {
        const flow = serviceFlows.get(params.flowId ?? '');
        if (!flow) return json({ state: 'expired' });
        flow.polls += 1;
        if (flow.polls < 2) return json({ state: 'pending' });
        serviceFlows.delete(params.flowId ?? '');
        if (/notowner/.test(flow.fields.url ?? ''))
          return json({
            state: 'failed',
            message:
              'Plex let Whombat in, but this server didn’t accept your account. Is it the server’s owner?',
          });
        const existing = rows.find((r) => r.connection.id === flow.connectionId);
        if (existing) {
          existing.connection.status = 'active';
          existing.connection.reauthReason = null;
          existing.connection.checks = [{ id: 'credential', state: 'ok', message: null }];
          return json({ state: 'connected', connection: existing.connection, eventId: null });
        }
        // Stored as the token it gives (SG-03), at the level asked.
        const connection = add(flow.catalogId, flow.fields, 'token', flow.label);
        connection.access = flow.access;
        connection.detail = 'mara';
        return json({ state: 'connected', connection, eventId: null });
      }
      case api.connections.probe.id: {
        const no = refused(fields);
        if (no) return no;
        const u = fields.url ?? '';
        if (/oauth/.test(u))
          return json({
            needs: 'oauth',
            issuer: new URL(u).origin,
            serverName: 'Example MCP',
            message: null,
          });
        if (/token/.test(u))
          return json({ needs: 'token', issuer: null, serverName: 'Example MCP', message: null });
        if (/down/.test(u))
          return json({
            needs: 'unreachable',
            issuer: null,
            serverName: null,
            message: 'No answer within 10 seconds.',
          });
        return json({ needs: 'open', issuer: null, serverName: 'Example MCP', message: null });
      }
      case api.connections.identify.id: {
        const found = identifyAddress(
          typeof body.catalogId === 'string' ? body.catalogId : undefined,
          String(body.url ?? ''),
        );
        const no = refused({ url: found.url });
        if (no) return no;
        return json(found);
      }
      case api.connections.discover.id: {
        const networks = Array.isArray(body.networks) ? (body.networks as string[]) : [];
        if (!scan || body.rescan === true || networks.length > 0)
          scan = {
            polls: 0,
            networks: [...new Set([...(scan?.networks ?? []), ...networks])],
            startedAt: new Date().toISOString(),
            finishedAt: null,
            kept: scan !== null && (scan.kept || scan.polls >= 3),
          };
        else if (scan.polls < 3) {
          scan.polls += 1;
          if (scan.polls >= 3) scan.finishedAt = new Date().toISOString();
        }
        return json(discovery());
      }
      case api.connections.hideFound.id: {
        // CS-53: for the whole burrow and kept across scans; answers the scan as it is, without starting one.
        const key = foundKey(String(body.catalogId), String(body.url));
        if (body.hidden === false) hiddenFound.delete(key);
        else hiddenFound.add(key);
        return json(discovery());
      }
      case api.connections.allowNetwork.id: {
        allowed.add(`${String(body.cidr)}:${Number(body.port)}`);
        return json({
          networks: [...allowed].map((key, i) => {
            const [cidr, port] = key.split(':');
            return {
              id: `vnt_fixture_${i + 1}`,
              cidr: cidr ?? '',
              ports: [Number(port)],
              note: typeof body.note === 'string' ? body.note : '',
              addedBy: mara.name,
              addedAt: new Date().toISOString(),
            };
          }),
          max: 20,
        });
      }
      case api.connectors.setApp.id: {
        const clientId = typeof body.clientId === 'string' ? body.clientId : null;
        dropboxApp = {
          clientIdHint: clientId ? `${clientId.slice(0, 6)}…` : (dropboxApp?.clientIdHint ?? ''),
          secretSet: typeof body.clientSecret === 'string' || (dropboxApp?.secretSet ?? false),
        };
        return json(status());
      }
      case api.connectors.removeApp.id:
        dropboxApp = null;
        return json(status());
      case api.connections.finishOAuth.id:
        return json({ returnPath: `/${burrow.slug}/settings?tab=connections`, connectionId: null });
      case api.connections.findMyTimeline.id:
      case api.connections.findMyTimelineSet.id:
      case api.connections.findMyTimelineDelete.id:
      case api.connections.findMyTimelineMap.id: {
        if (row?.connection.catalogId !== 'findmy')
          return json({ error: { code: 'not_found', message: 'That isn’t a Find My connection.' } }, 404);
        const query = Object.fromEntries(url.searchParams);
        const answer =
          ep.id === api.connections.findMyTimeline.id
            ? timeline.timeline(query)
            : ep.id === api.connections.findMyTimelineSet.id
              ? timeline.set(body)
              : ep.id === api.connections.findMyTimelineDelete.id
                ? timeline.remove(body)
                : timeline.map(query);
        return json(answer.body, answer.status);
      }
      default:
        return null;
    }
  }

  return { handle };
}

/** Every connectable entry's id, in the catalog's order. */
const API_CATALOG = CATALOG_CONNECTABLE.map((e) => e.id);

/** A connection's view and its entry's tools as this world makes them, for the thing pages' own connections (CP-01). */
export { entryTools as fixtureEntryTools, view as fixtureConnectionView };
