/**
 * Connections in fixture mode (`VITE_FIXTURE_CONNECTORS`, AP-673): this Whombat's Google app set up and tested, and —
 * with `connected` — Mara's Google account connected for Gmail, Calendar and Drive and her Fastmail over IMAP, so the
 * overview, Google's page and Email (IMAP)'s page can be looked at without a server. Off by default: the shared world
 * serves no `/connectors`.
 *
 * Email (IMAP) (connections-more-web.md AP-2764…): `imapDiscover` finds Fastmail's and iCloud's servers with their
 * app-password hints, Gmail's and Outlook's with the hint to use Google or Microsoft 365 instead, `burrowhq.example`'s through
 * its MX, and guesses `imap.<domain>` / `smtp.<domain>` for anything else. Connecting refuses the password `wrong`
 * (the IMAP side) and `smtp` (the SMTP side), can't reach a server with `down` in its name, and otherwise connects; Check
 * again and Disconnect work on every connection. State lives in the closure.
 */
import type { Connection, ConnectorsStatus } from '@whombat/core';
import { api, type ImapDiscoverResponse, matchPath } from '@whombat/core/contracts';
import {
  GOOGLE_CONSOLE_LINKS,
  googleEnableApisUrl,
  imapProviderFor,
  imapProviderHint,
} from '@whombat/core/domain';

const REDIRECT = 'https://whombat.example/api/v1/connectors/google/callback';
const API_BASE = '/api/v1';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function connectorsFixture(connected: boolean): ConnectorsStatus {
  const now = new Date().toISOString();
  const mara: Connection = {
    id: 'con_mara',
    provider: 'google',
    email: 'mara@burrowhq.example',
    name: 'Mara Oduya',
    services: ['mail', 'calendar', 'files'],
    status: 'active',
    reauthReason: null,
    checks: [
      { service: 'mail', state: 'ok' },
      { service: 'calendar', state: 'ok' },
      { service: 'files', state: 'ok' },
    ],
    checkedAt: now,
    createdAt: '2026-09-24T08:00:00.000Z',
    updatedAt: now,
    lastUsedAt: now,
  };
  const status = {
    mode: 'real',
    google: {
      app: {
        provider: 'google',
        configured: true,
        source: 'settings',
        clientIdHint: '1234567890-a…',
        secretSet: true,
        userType: 'external',
        updatedAt: '2026-09-24T08:00:00.000Z',
      },
      setup: {
        redirectUri: REDIRECT,
        enableApisUrl: googleEnableApisUrl(),
        links: GOOGLE_CONSOLE_LINKS,
        scopes: ['openid', 'email', 'profile'],
        appName: 'Whombat',
        supportEmail: 'mara@burrowhq.example',
        authorizedDomain: 'whombat.example',
      },
      tested: true,
    },
    microsoft: {
      app: {
        provider: 'microsoft',
        configured: false,
        source: null,
        clientIdHint: null,
        secretSet: false,
        userType: null,
        updatedAt: null,
      },
      redirectUri: 'https://whombat.example/api/v1/connectors/microsoft/callback',
      canConfigure: true,
    },
    imap: { available: true },
    canConfigure: true,
    connections: connected
      ? [mara, mailConnection('mara@fastmail.com', 'imap.fastmail.com', 'smtp.fastmail.com')]
      : [],
  };
  return status as ConnectorsStatus;
}

function mailConnection(email: string, imapHost: string, smtpHost: string, username: string | null = null) {
  const now = new Date().toISOString();
  return {
    id: `con_mail_${email.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`,
    provider: 'imap',
    email,
    name: '',
    services: ['mail'],
    status: 'active',
    reauthReason: null,
    checks: [{ service: 'mail', state: 'ok' }],
    checkedAt: now,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: now,
    lastUsedAt: null,
    // The username both servers sign in with: the address unless the person gave another.
    mail: { imapHost, smtpHost, username: username ?? email },
  } as unknown as Connection;
}

/** A known provider's hint as the contracts word it (CM-21), or null. */
function knownHint(email: string) {
  const provider = imapProviderFor(email);
  return provider ? imapProviderHint(provider) : null;
}

/** What Whombat finds for an address (CM-20, CM-21), as a fixture. */
export function imapDiscoverFixture(email: string): ImapDiscoverResponse {
  const domain = email.split('@').pop()?.toLowerCase() ?? '';
  const both = (imap: string, smtp: string, smtpPort = 465, smtpSecurity: 'tls' | 'starttls' = 'tls') => ({
    imap: { host: imap, port: 993, security: 'tls' as const },
    smtp: { host: smtp, port: smtpPort, security: smtpSecurity },
    username: null,
  });
  switch (domain) {
    case 'fastmail.com':
      return {
        settings: both('imap.fastmail.com', 'smtp.fastmail.com'),
        source: 'ispdb',
        hint: {
          name: 'Fastmail',
          text: 'Fastmail needs an app password: make one in Settings → Privacy & Security → App passwords.',
          url: 'https://app.fastmail.com/settings/security/apps',
          useInstead: null,
        },
      };
    case 'icloud.com':
    case 'me.com':
      return {
        settings: both('imap.mail.me.com', 'smtp.mail.me.com', 587, 'starttls'),
        source: 'ispdb',
        hint: {
          name: 'iCloud',
          text: 'iCloud needs an app password: make one at account.apple.com, under Sign-In and Security.',
          url: 'https://account.apple.com',
          useInstead: null,
        },
      };
    case 'gmail.com':
      return {
        settings: both('imap.gmail.com', 'smtp.gmail.com'),
        source: 'ispdb',
        // The contracts' own (0.111, CT-747): the Google connection, and its app password for mail only (AP-3915).
        hint: knownHint(email),
      };
    case 'outlook.com':
    case 'hotmail.com':
      return {
        settings: both('outlook.office365.com', 'smtp-mail.outlook.com', 587, 'starttls'),
        source: 'ispdb',
        // The contracts' own (0.111, CT-747): no password at all, Microsoft 365 instead.
        hint: knownHint(email),
      };
    case 'burrowhq.example':
      return {
        settings: both('mail.burrowhq.example', 'mail.burrowhq.example', 587, 'starttls'),
        source: 'mx',
        hint: null,
      };
    default:
      return {
        settings: {
          imap: { host: `imap.${domain}`, port: 993, security: 'tls' },
          smtp: { host: `smtp.${domain}`, port: 587, security: 'starttls' },
          username: null,
        },
        source: 'guess',
        hint: null,
      };
  }
}

/** A refused connect, as the server answers it (`error.details.reason`, CM-22). */
function refuse(reason: string, message: string): Response {
  return json({ error: { code: 'bad_request', message, details: { reason } } }, 409);
}

/**
 * `GET /connectors`, Email (IMAP)'s discover and connect, and Check again and Disconnect on any connection: null for
 * anything else.
 */
export function createConnectorFixtures(connected: boolean) {
  const status = connectorsFixture(connected);
  const own = [
    api.connectors.status,
    api.connectors.imapDiscover,
    api.connectors.imapConnect,
    api.connections.check,
    api.connections.remove,
  ];
  return {
    status,
    async handle(req: Request): Promise<Response | null> {
      const url = new URL(req.url, 'http://fixture.local');
      if (!url.pathname.startsWith(API_BASE)) return null;
      const path = url.pathname.slice(API_BASE.length);
      for (const ep of own) {
        if (ep.method !== req.method) continue;
        const params = matchPath(ep.path, path);
        if (!params) continue;
        const body =
          req.method === 'GET' || req.method === 'DELETE' ? {} : await req.json().catch(() => ({}));
        return answer(ep.id, params as Record<string, string>, body as Record<string, unknown>);
      }
      return null;
    },
  };

  function answer(id: string, params: Record<string, string>, body: Record<string, unknown>): Response {
    switch (id) {
      case api.connectors.status.id:
        return json(status);
      case api.connectors.imapDiscover.id:
        return json(imapDiscoverFixture(String(body.email ?? '')));
      case api.connectors.imapConnect.id:
        return connectImap(body);
      case api.connections.check.id: {
        const found = status.connections.find((c) => c.id === params.connectionId);
        if (!found) return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
        found.checkedAt = new Date().toISOString();
        return json(found);
      }
      case api.connections.remove.id:
        status.connections = status.connections.filter((c) => c.id !== params.connectionId);
        return json({ ok: true });
      default:
        return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
    }
  }

  function connectImap(body: Record<string, unknown>): Response {
    const email = String(body.email ?? '');
    const password = String(body.password ?? '');
    type Side = { host: string; port: number };
    const settings = (body.settings as { imap: Side; smtp: Side; username: string | null } | undefined) ??
      imapDiscoverFixture(email).settings ?? {
        imap: { host: '', port: 993 },
        smtp: { host: '', port: 587 },
        username: null,
      };
    if (settings.imap.host.includes('down'))
      return refuse(
        'imap_unreachable',
        `Whombat couldn’t reach ${settings.imap.host} on port ${settings.imap.port}.`,
      );
    if (password === 'wrong')
      return refuse(
        'imap_refused',
        'The mail server refused the password. If your provider uses app passwords, make one and use that.',
      );
    if (settings.smtp.host.includes('down'))
      return refuse(
        'smtp_unreachable',
        `Whombat couldn’t reach ${settings.smtp.host} on port ${settings.smtp.port}.`,
      );
    if (password === 'smtp')
      return refuse(
        'smtp_refused',
        `${settings.smtp.host} refused the password for sending. Check the username, or ask your provider.`,
      );
    const made = mailConnection(email, settings.imap.host, settings.smtp.host, settings.username);
    status.connections = [...status.connections.filter((c) => c.provider !== 'imap'), made];
    return json(made, 201);
  }
}
