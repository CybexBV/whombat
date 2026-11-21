/**
 * Connecting in the demo world (phone-connect.md AP-2916): what Connect {Name}, Found on your network and Email (IMAP)
 * ask, answered as the web's fixture world answers them (`apps/web/src/app/catalogFixtures.ts`, AP-848), so the screens
 * can be looked at without a server. `connections.identify` knows an address with `pve` as Proxmox VE 9.0.10 on its own
 * certificate, `ha` / `homeassistant` as Home Assistant over http, `down` as nothing answering; an address in
 * 192.168.0.0/16 is refused until Add this network; sign in once refuses the account `wrong`, asks for a code for the
 * password `2fa` (`000000` is refused); the token `wrong` fails the check; a Proxmox VE https address presents its own
 * certificate until it is pinned; Moneybird asks which administration. A scan looks for three polls, then finds Proxmox
 * VE and Portainer. Email (IMAP) finds Fastmail's servers and refuses the password `wrong`; disconnecting Mara's mailbox
 * shows the form. What connects joins the burrow's connections. Pure state in the closure; answers built to the
 * contracts' schemas (`connect.test.ts`).
 *
 * Connections that sign in properly (connection-signin-android.md AP-3950…): addresses with `plex`, `unifi` and `nas`
 * are Plex, UniFi Network and Synology DSM; Plex signs in on its own page (`connections.startServiceLogin`, three polls,
 * then connected; an address with `wrong` fails as a server that didn't
 * accept the account, one with `link` shows a code to type, a device-code service's); UniFi's emailed code belongs to the
 * challenge it handed back (a code sent without it is asked for again, with a new email); Synology DSM's password `2fa`
 * asks for a code once, on connect and on Replace password (`000000` is refused).
 */
import {
  type CatalogEntry,
  type Connection,
  type ConnectionView,
  type ConnectorsStatus,
  catalogEntry,
  defaultConnectionLabel,
  discoveredUrl,
  handleFor,
} from '@whombat/core';
import type {
  ConnectionDiscovery,
  DiscoveredService,
  IdentifyConnectionResponse,
  ImapDiscoverResponse,
} from '@whombat/core/contracts';
import { connectionTransport, SERVICE_LOGIN_MAX_MS, SERVICE_LOGIN_POLL_MS } from '@whombat/core/domain';
import { mara } from '@whombat/fixtures';

/** The fingerprint a demo home server's own certificate presents (CT-313). */
export const DEMO_CERTIFICATE =
  '3B:9C:51:0E:A7:42:D8:16:6F:C3:20:8B:E4:71:95:0D:2A:CC:58:B1:07:E9:64:3F:D2:8A:1C:75:B0:4E:93:6D';
const SCAN_TOTAL = 1016;
/** Polls a demo service sign-in waits before the person “allowed” Whombat. */
export const DEMO_SERVICE_LOGIN_POLLS = 3;
/** A code to type a demo device-code sign-in shows (`link` in the address). */
export const DEMO_USER_CODE = 'K7QF-2MXP';

/** Whether an entry's token sign-in is a session that asks for a two-step code once (`twoStep`, CT-732: Synology). */
function asksCodeOnce(entry: CatalogEntry | null): boolean {
  return !!entry?.signIn.some((m) => m.kind === 'token' && m.auth.type === 'session' && !!m.auth.twoStep);
}

export interface ConnectFixtureOptions {
  now: () => Date;
  json: (body: unknown, status?: number) => Response;
  burrowId: string;
}

function refusal(
  json: ConnectFixtureOptions['json'],
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

/** What a demo address is (CS-13), with the entry's scheme and port added to a bare host. */
export function demoIdentify(entry: CatalogEntry | null, raw: string): IdentifyConnectionResponse {
  const text = raw.trim();
  const host =
    (/^[a-z]+:\/\//i.test(text) ? (text.split('://')[1] ?? '') : text).split(/[/:]/)[0]?.toLowerCase() ?? '';
  // The scan's finds answer as what they are (10.100.0.2 Proxmox VE, 10.100.0.30 Portainer).
  const seen =
    host.includes('pve') || host === '10.100.0.2'
      ? { catalogId: 'proxmox', version: '9.0.10' }
      : host === '10.100.0.30'
        ? { catalogId: 'portainer', version: '2.33.1' }
        : /(^|[.-])ha([.-]|$)|homeassistant/.test(host)
          ? { catalogId: 'homeassistant', version: '2026.10.1' }
          : // The sign-ins of connection-signin-android.md (AP-3959…): Plex, UniFi, Synology DSM.
            host.includes('plex')
            ? { catalogId: 'plex', version: '1.42.2' }
            : host.includes('unifi')
              ? { catalogId: 'unifi_network', version: '9.4.19' }
              : host.includes('nas') || host.includes('synology')
                ? { catalogId: 'synology', version: '7.2.2' }
                : null;
  const target =
    catalogEntry(seen?.catalogId ?? '')?.discovery?.targets[0] ?? entry?.discovery?.targets[0] ?? null;
  let url = text.replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(url))
    url = target ? discoveredUrl(target.scheme, host, target.port) : `https://${url}`;
  const down = host.includes('down');
  return {
    url,
    reachable: !down,
    catalogId: down ? null : seen && (!entry || entry.id === seen.catalogId) ? seen.catalogId : null,
    version: down ? null : (seen?.version ?? null),
    certificate:
      url.startsWith('https://') && !down
        ? {
            sha256: DEMO_CERTIFICATE,
            trusted: !host.includes('pve') && !/^192\.168\./.test(host) && !/^10\.100\.0\./.test(host),
          }
        : null,
    message: down ? 'No answer within 3 seconds.' : null,
  };
}

/** Email (IMAP)'s servers for an address: Fastmail's with its app-password hint, else a guess. */
export function demoImapDiscover(email: string): ImapDiscoverResponse {
  const domain = email.split('@').pop()?.toLowerCase() ?? '';
  if (domain === 'fastmail.com')
    return {
      settings: {
        imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
        smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
        username: null,
      },
      source: 'ispdb',
      hint: {
        name: 'Fastmail',
        text: 'Fastmail needs an app password: make one in Settings → Privacy & Security → App passwords.',
        url: 'https://app.fastmail.com/settings/security/apps',
        useInstead: null,
      },
    };
  return {
    settings: {
      imap: { host: `imap.${domain}`, port: 993, security: 'tls' },
      smtp: { host: `smtp.${domain}`, port: 465, security: 'tls' },
      username: null,
    },
    source: 'guess',
    hint: null,
  };
}

export function createConnectFixtures({ now, json, burrowId }: ConnectFixtureOptions) {
  const added: ConnectionView[] = [];
  const allowed = new Set<string>();
  const hidden = new Set<string>();
  let imapGone = false;
  let imapAdded: Connection | null = null;
  let scan: { polls: number; startedAt: string; finishedAt: string | null; networks: string[] } | null = null;
  /** Service sign-ins waiting for the person (CT-738), by flow id. */
  const flows = new Map<
    string,
    { polls: number; body: Record<string, unknown>; connectionId: string | null }
  >();
  /** The challenge UniFi's last code belongs to (SG-06). */
  let challenge: string | null = null;
  let n = 0;

  function discovery(): ConnectionDiscovery {
    if (!scan)
      return { state: 'idle', progress: null, startedAt: null, finishedAt: null, networks: [], found: [] };
    const done = scan.polls >= 3;
    const found: Omit<DiscoveredService, 'connectionIds' | 'hidden'>[] = [
      {
        catalogId: 'proxmox',
        url: discoveredUrl('https', '10.100.0.2', 8006),
        host: '10.100.0.2',
        version: '9.0.10',
        certificate: { sha256: DEMO_CERTIFICATE, trusted: false },
      },
      {
        catalogId: 'portainer',
        url: discoveredUrl('https', '10.100.0.30', 9443),
        host: '10.100.0.30',
        version: '2.33.1',
        certificate: { sha256: DEMO_CERTIFICATE, trusted: false },
      },
    ];
    return {
      state: done ? 'done' : 'scanning',
      progress: { done: done ? SCAN_TOTAL : Math.min(SCAN_TOTAL, 312 * scan.polls), total: SCAN_TOTAL },
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      networks: ['10.100.0.0/24', ...scan.networks],
      found: done
        ? found.map((s) => ({
            ...s,
            connectionIds: added
              .filter((c) => c.catalogId === s.catalogId && c.fields.url === s.url)
              .map((c) => c.id),
            hidden: hidden.has(`${s.catalogId}@${s.url}`),
          }))
        : [],
    };
  }

  /** A home-network address not on the list (CX-41): 192.168.x.y, with its /24 and port. */
  function refused(url: string | undefined): Response | null {
    const m = /^https?:\/\/(192\.168\.(\d+))\.\d+(?::(\d+))?/.exec(url ?? '');
    if (!m) return null;
    const cidr = `${m[1]}.0/24`;
    const port = Number(m[3] ?? (url?.startsWith('https') ? 443 : 80));
    if (allowed.has(`${cidr}:${port}`)) return null;
    return refusal(json, 403, 'destination_refused', 'That address is on your network.', {
      problem: 'private_unlisted',
      cidr,
      port,
      canAdd: true,
    });
  }

  function connect(body: Record<string, unknown>): Response {
    const catalogId = String(body.catalogId);
    const entry = catalogEntry(catalogId);
    const fields = (body.fields ?? {}) as Record<string, string>;
    const no = refused(fields.url);
    if (no) return no;
    const login = (body.login ?? null) as {
      account?: string;
      password?: string;
      code?: string;
      challenge?: string;
    } | null;
    if (body.signIn === 'password' && login) {
      if (login.account === 'wrong')
        return refusal(json, 409, 'sign_in_refused', 'Wrong username, password or realm.', {
          reason: 'password',
        });
      if (login.password === '2fa' && catalogId === 'unifi_network') {
        const asked = challenged(login);
        if (asked) return asked;
      } else if (login.password === '2fa' && !login.code)
        return refusal(json, 409, 'second_factor_needed', 'Enter the code from your authenticator app.');
      if (login.code === '000000')
        return refusal(json, 409, 'sign_in_refused', 'That code didn’t work. Enter the newest one.', {
          reason: 'code',
        });
    }
    if (body.signIn !== 'password' && body.signIn !== 'none' && asksCodeOnce(entry)) {
      const asked = codeOnce(body.secret, body.code);
      if (asked) return asked;
    }
    if (body.secret === 'wrong')
      return refusal(
        json,
        409,
        'check_failed',
        'Whombat couldn’t sign in with that. Check the address and the token.',
        {
          status: 401,
        },
      );
    if (
      entry?.fields.some((f) => f.id === 'fingerprint') &&
      fields.url?.startsWith('https://') &&
      (fields.url.includes('pve') || fields.url.includes('10.100.0.2:')) &&
      fields.fingerprint !== DEMO_CERTIFICATE
    )
      return refusal(
        json,
        409,
        'check_failed',
        `Its certificate can’t be verified: it’s self-signed, expired or for another name. It presents ${DEMO_CERTIFICATE}; if ${entry.name} shows the same fingerprint, use it as the certificate fingerprint.`,
        { certificateSha256: DEMO_CERTIFICATE },
      );
    if (catalogId === 'moneybird' && !fields.administration)
      return refusal(
        json,
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
    return json({ connection: make(body), eventId: null }, 201);
  }

  /** A connection made here (connected, its fields as sent), joining the burrow's. */
  function make(body: Record<string, unknown>): ConnectionView {
    const catalogId = String(body.catalogId);
    const entry = catalogEntry(catalogId);
    const fields = (body.fields ?? {}) as Record<string, string>;
    const at = now().toISOString();
    const label =
      typeof body.label === 'string' ? body.label : entry ? defaultConnectionLabel(entry, fields) : catalogId;
    const signIn =
      body.signIn === 'none' ? 'none' : body.signIn === 'client_credentials' ? 'client_credentials' : 'token';
    const connection: ConnectionView = {
      id: `con_demo_${++n}`,
      catalogId,
      label,
      handle: handleFor(
        catalogId,
        added.map((c) => c.handle),
        label,
      ),
      burrowId,
      connectedBy: { id: mara.id, name: mara.name },
      detail: null,
      signIn,
      // The sign-in's transport: a token beside an MCP sign-in calls the service’s API (Todoist’s, CT-748).
      transport: entry && connectionTransport(entry, signIn) === 'mcp' ? 'mcp' : 'rest',
      fields,
      status: 'active',
      reauthReason: null,
      checks: [],
      checkedAt: at,
      toolCount: 0,
      access: body.access === 'read' ? 'read' : 'manage',
      poller: null,
      createdAt: at,
      lastUsedAt: null,
    } as ConnectionView;
    added.push(connection);
    return connection;
  }

  /**
   * UniFi's challenge (SG-06, SG-07): the password `2fa` asks for the code UniFi “emailed” with a new challenge; the
   * code is taken only with the newest challenge (else it starts fresh: a new email), and `000000` is refused with a
   * new one.
   */
  function challenged(login: { code?: string; challenge?: string }): Response | null {
    const issue = (code: string, message: string, details: Record<string, unknown> = {}) => {
      challenge = `demo_challenge_${++n}`;
      return refusal(json, 409, code, message, { ...details, challenge });
    };
    if (!login.code || !login.challenge || login.challenge !== challenge)
      return issue('second_factor_needed', 'Enter the code UniFi just emailed to m•••@burrowhq.example.');
    if (login.code === '000000')
      return issue('sign_in_refused', 'That code didn’t work. Enter the newest code.', { reason: 'code' });
    challenge = null;
    return null;
  }

  /** A session's two-step code, asked once (SG-09): the password `2fa` wants one; `000000` is refused. */
  function codeOnce(secret: unknown, code: unknown): Response | null {
    if (secret !== '2fa') return null;
    if (!code)
      return refusal(json, 409, 'second_factor_needed', 'Enter the code from your authenticator app.');
    if (code === '000000')
      return refusal(json, 409, 'sign_in_refused', 'That code didn’t work. Enter the newest one.', {
        reason: 'code',
      });
    return null;
  }

  /** A service sign-in's start (CT-738): the address checked first, the flow the poll takes. */
  function startServiceLogin(body: Record<string, unknown>): Response {
    const existing = added.find((c) => c.id === body.connectionId) ?? null;
    const fields = existing?.fields ?? ((body.fields ?? {}) as Record<string, string>);
    const no = refused(fields.url);
    if (no) return no;
    const flowId = `oas_demo_${++n}`;
    flows.set(flowId, { polls: 0, body: { ...body, fields }, connectionId: existing?.id ?? null });
    return json({
      // Never opened by the demo itself (AP-3953): there is no Plex behind it.
      loginUrl: 'https://app.plex.tv/auth#?clientID=whombat-demo&code=demo',
      flowId,
      pollEveryMs: SERVICE_LOGIN_POLL_MS,
      // The phone counts down with its own clock, not the demo's moment.
      expiresAt: new Date(Date.now() + SERVICE_LOGIN_MAX_MS).toISOString(),
      userCode: fields.url?.includes('link') ? DEMO_USER_CODE : null,
    });
  }

  /** A service sign-in's poll (CT-738): pending, then connected, or failed for an address with `wrong`. */
  function pollServiceLogin(flowId: string): Response {
    const flow = flows.get(flowId);
    if (!flow) return json({ state: 'expired' });
    flow.polls += 1;
    if (flow.polls < DEMO_SERVICE_LOGIN_POLLS) return json({ state: 'pending' });
    flows.delete(flowId);
    const fields = flow.body.fields as Record<string, string>;
    if (fields.url?.includes('wrong'))
      return json({
        state: 'failed',
        message: 'Plex let Whombat in, but this server didn’t accept your account. Is it the server’s owner?',
      });
    const existing = added.find((c) => c.id === flow.connectionId);
    if (existing) {
      existing.status = 'active';
      existing.reauthReason = null;
      return json({ state: 'connected', connection: existing, eventId: null });
    }
    return json({ state: 'connected', connection: make({ ...flow.body, signIn: 'token' }), eventId: null });
  }

  /** Replace token on a connection made here (CX-72): a session's code asked once (SG-09), then active again. */
  function setSecret(connectionId: string, body: Record<string, unknown>): Response | null {
    const existing = added.find((c) => c.id === connectionId);
    if (!existing) return null;
    if (asksCodeOnce(catalogEntry(existing.catalogId))) {
      const no = codeOnce(body.secret, body.code);
      if (no) return no;
    }
    existing.status = 'active';
    existing.reauthReason = null;
    return json({ connection: existing, eventId: null });
  }

  return {
    /** The connections made here, for `connections.list` and `connections.tools`. */
    added: (): readonly ConnectionView[] => added,
    /** Mara's accounts as they are now: her mailbox gone once disconnected, a new one once connected. */
    accounts(status: ConnectorsStatus): ConnectorsStatus {
      const others = status.connections.filter((c) => c.provider !== 'imap' || !imapGone);
      return { ...status, connections: imapAdded ? [...others, imapAdded] : others };
    },
    async handle(
      id: string,
      params: Record<string, string>,
      init: RequestInit | undefined,
    ): Promise<Response | null> {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      switch (id) {
        case 'connections.identify': {
          const found = demoIdentify(catalogEntry(String(body.catalogId ?? '')), String(body.url ?? ''));
          return refused(found.url) ?? json(found);
        }
        case 'connections.create':
          return connect(body);
        case 'connections.startServiceLogin':
          return startServiceLogin(body);
        case 'connections.pollServiceLogin':
          return pollServiceLogin(params.flowId ?? '');
        case 'connections.setSecret':
          return setSecret(params.connectionId ?? '', body);
        case 'connections.allowNetwork': {
          allowed.add(`${String(body.cidr)}:${Number(body.port)}`);
          return json({
            networks: [...allowed].map((key, i) => {
              const [cidr, port] = key.split(':');
              return {
                id: `vnt_demo_${i + 1}`,
                cidr: cidr ?? '',
                ports: [Number(port)],
                note: typeof body.note === 'string' ? body.note : '',
                addedBy: mara.name,
                addedAt: now().toISOString(),
              };
            }),
            canManage: true,
            max: 20,
          });
        }
        case 'connections.discover': {
          const networks = Array.isArray(body.networks) ? (body.networks as string[]) : [];
          if (!scan || body.rescan === true || networks.length > 0)
            scan = { polls: 0, startedAt: now().toISOString(), finishedAt: null, networks };
          else if (scan.polls < 3) {
            scan.polls += 1;
            if (scan.polls >= 3) scan.finishedAt = now().toISOString();
          }
          return json(discovery());
        }
        case 'connections.hideFound': {
          const key = `${String(body.catalogId)}@${String(body.url)}`;
          if (body.hidden === false) hidden.delete(key);
          else hidden.add(key);
          return json(discovery());
        }
        case 'connectors.imapDiscover':
          return json(demoImapDiscover(String(body.email ?? '')));
        case 'connectors.imapConnect': {
          if (body.password === 'wrong')
            return json(
              {
                error: {
                  code: 'conflict',
                  message: 'The mail server didn’t accept that password.',
                  details: { reason: 'imap_refused' },
                },
              },
              409,
            );
          const email = String(body.email ?? '');
          const at = now().toISOString();
          imapGone = true;
          imapAdded = {
            id: 'con_imap-demo',
            provider: 'imap',
            email,
            name: email.split('@')[0] ?? email,
            services: ['mail'],
            status: 'active',
            reauthReason: null,
            checks: [],
            checkedAt: at,
            mail: {
              imapHost: `imap.${email.split('@')[1] ?? ''}`,
              smtpHost: `smtp.${email.split('@')[1] ?? ''}`,
              username: email,
            },
            createdAt: at,
            updatedAt: at,
            lastUsedAt: null,
          } as unknown as Connection;
          return json(imapAdded);
        }
        case 'connections.remove': {
          if (params.connectionId === 'con_imap-mara' || params.connectionId === 'con_imap-demo') {
            imapGone = true;
            imapAdded = null;
            return json({ ok: true });
          }
          return null;
        }
        default:
          return null;
      }
    },
  };
}

/** A connection made here, as `connections.tools` answers it (no tools until the Whombat reads them). */
export function addedTools(connection: ConnectionView) {
  return { connection, tools: [], guide: '', truncated: false };
}
