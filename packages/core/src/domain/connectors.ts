/**
 * Connectors (docs/decisions/connectors.md CN-01…CN-08): a person connects their own mail, calendar and files
 * account once, for their Whombat account, and the agent uses it in turns for them (Whombat one-agent.md OA-10). The vocabulary is
 * provider-neutral (tools and keys are named by service); Google is the first provider and an adapter.
 */
import { z } from 'zod';
import { ConnectionId } from '../ids.js';
import { Email, Timestamp } from './common.js';

/* ---------------------------------------------------------------------------------------------- */
/* Providers and services                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Who holds the account: Google, Microsoft 365, or (0.97, CT-480; Whombat connections-more.md CM-19) any other mailbox
 * over IMAP and SMTP, mail only.
 */
export const CONNECTOR_PROVIDERS = ['google', 'microsoft', 'imap'] as const;
export const ConnectorProvider = z.enum(CONNECTOR_PROVIDERS);
export type ConnectorProvider = z.infer<typeof ConnectorProvider>;

/** What an account offers, in display order. */
export const CONNECTOR_SERVICES = ['mail', 'calendar', 'files', 'docs', 'sheets', 'contacts'] as const;
export const ConnectorService = z.enum(CONNECTOR_SERVICES);
export type ConnectorService = z.infer<typeof ConnectorService>;

export const CONNECTOR_PROVIDER_LABELS: Record<ConnectorProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft 365',
  imap: 'Email (IMAP)',
};

/** Provider-neutral service names. */
export const SERVICE_LABELS: Record<ConnectorService, string> = {
  mail: 'Mail',
  calendar: 'Calendar',
  files: 'Drive',
  docs: 'Docs',
  sheets: 'Sheets',
  contacts: 'Contacts',
};

/**
 * What each service is called on a provider: Gmail, Google Calendar, … An IMAP account has only mail and the neutral
 * names (0.97, CT-480).
 */
export const PROVIDER_SERVICE_LABELS: Record<ConnectorProvider, Record<ConnectorService, string>> = {
  imap: SERVICE_LABELS,
  microsoft: {
    mail: 'Outlook Mail',
    calendar: 'Outlook Calendar',
    files: 'OneDrive',
    docs: 'Word',
    sheets: 'Excel',
    contacts: 'Outlook Contacts',
  },
  google: {
    mail: 'Gmail',
    calendar: 'Google Calendar',
    files: 'Google Drive',
    docs: 'Google Docs',
    sheets: 'Google Sheets',
    contacts: 'Google Contacts',
  },
};

/**
 * The services each provider can offer (0.97, CT-480; CM-19), in service order: Google all six, Microsoft 365 the four
 * Whombat asks Graph for (`MICROSOFT_SERVICES`; native Word and Excel editing isn't offered), an IMAP account mail only.
 */
export const CONNECTOR_PROVIDER_SERVICES: Record<ConnectorProvider, readonly ConnectorService[]> = {
  google: CONNECTOR_SERVICES,
  microsoft: ['mail', 'calendar', 'files', 'contacts'],
  imap: ['mail'],
};

/** “Google Drive” on Google, “Drive” without a provider. */
export function serviceLabel(service: ConnectorService, provider?: ConnectorProvider | null): string {
  return provider ? PROVIDER_SERVICE_LABELS[provider][service] : SERVICE_LABELS[service];
}

/**
 * A connector tool's error when the owner's connection is missing, not active or lacks the service:
 * “Mara hasn’t connected Google Drive. They can connect it in Settings → Connections.”
 */
export function connectorMissingText(
  ownerShortName: string,
  service: ConnectorService,
  provider: ConnectorProvider = 'google',
): string {
  return `${ownerShortName} hasn’t connected ${serviceLabel(service, provider)}. They can connect it in Settings → Connections.`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Google                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** Scopes every Google sign-in asks for (who the account is). */
export const GOOGLE_BASE_SCOPES = ['openid', 'email', 'profile'] as const;

/** The OAuth scope per service. Full Drive: Whombat keys limit what the agent does with it. */
export const GOOGLE_SCOPES: Record<ConnectorService, string> = {
  mail: 'https://www.googleapis.com/auth/gmail.modify',
  calendar: 'https://www.googleapis.com/auth/calendar',
  files: 'https://www.googleapis.com/auth/drive',
  docs: 'https://www.googleapis.com/auth/documents',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
};

/** The scopes to ask for: `openid email profile` plus each ticked service's, in service order, once each. */
export function googleScopesFor(services: readonly ConnectorService[]): string[] {
  const picked = CONNECTOR_SERVICES.filter((s) => services.includes(s));
  return [...GOOGLE_BASE_SCOPES, ...new Set(picked.map((s) => GOOGLE_SCOPES[s]))];
}

/** The services a set of granted scopes covers (a scope Google did not grant drops its service). */
export function googleServicesGranted(scopes: readonly string[]): ConnectorService[] {
  return CONNECTOR_SERVICES.filter((s) => scopes.includes(GOOGLE_SCOPES[s]));
}

/** The Google APIs Whombat uses, as the Cloud console names them (step 2 turns all of them on). */
export const GOOGLE_API_IDS = [
  'gmail.googleapis.com',
  'calendar-json.googleapis.com',
  'drive.googleapis.com',
  'docs.googleapis.com',
  'sheets.googleapis.com',
  'people.googleapis.com',
] as const;

/** One link that turns on every API Whombat uses in the person's Google Cloud project (CN-03 step 2). */
export function googleEnableApisUrl(): string {
  return `https://console.cloud.google.com/flows/enableapi?apiid=${GOOGLE_API_IDS.join(',')}`;
}

/** Links of the guided setup (CN-03). */
export const GOOGLE_CONSOLE_LINKS = {
  createProject: 'https://console.cloud.google.com/projectcreate',
  enableApis: googleEnableApisUrl(),
  consentScreen: 'https://console.cloud.google.com/auth/branding',
  audience: 'https://console.cloud.google.com/auth/audience',
  createClient: 'https://console.cloud.google.com/auth/clients/create',
} as const;

/** Where Google sends the browser back after consent, relative to `PUBLIC_URL`. */
export const googleRedirectPath = '/api/v1/connectors/google/callback';

/** The authorized redirect URI to paste into the OAuth client: `{PUBLIC_URL}/api/v1/connectors/google/callback`. */
export function googleRedirectUri(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${googleRedirectPath}`;
}

/** `.` / `..` path segments, also percent-encoded: `/.//evil.com` normalizes to `//evil.com` (IN-19). */
const DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(?=\/|$)/i;

function pathOnThisWhombat(max: number) {
  return z
    .string()
    .max(max)
    .regex(/^\/(?!\/)[^\s\\]*$/, 'Expected a path on this Whombat')
    .refine((path) => !DOT_SEGMENT.test(path.split(/[?#]/)[0] ?? ''), 'Expected a path on this Whombat');
}

/** A path inside this Whombat to come back to (`/burrow-hq/settings?tab=connections`); never another origin. */
export const ReturnPath = pathOnThisWhombat(500);

/** A `ReturnPath` with the connect result added (`connected=google`, `connect_error=…`): room for the query. */
export const ReturnLocation = pathOnThisWhombat(1000);

/**
 * The redirect URI of a managed appliance's Google client (AG-14): a hosted-UI route, `{WHOMBAT_APP_URL}/connect/google`.
 * The app takes `code` and `state` off the address bar at once and finishes with `connections.finishGoogle`.
 */
export const managedGoogleRedirectPath = '/connect/google';

export function managedGoogleRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${managedGoogleRedirectPath}`;
}

/** The query parameter on the return path when connecting failed: `connect_error=<ConnectErrorCode>`. */
export const CONNECT_ERROR_PARAM = 'connect_error';

/** The app name the consent screen should show (a copy button in step 3). */
export const GOOGLE_APP_NAME = 'Whombat';

/** Consent screen audience: `external` (personal Gmail: publish the app) or `internal` (a Workspace domain). */
export const GoogleUserType = z.enum(['external', 'internal']);
export type GoogleUserType = z.infer<typeof GoogleUserType>;

/** Which Google the server talks to (`WHOMBAT_GOOGLE`): the real one, the in-memory fake, or none. */
export const GoogleMode = z.enum(['real', 'fake', 'off']);
export type GoogleMode = z.infer<typeof GoogleMode>;

/** What a client may know about a client id: its first 12 characters and `…`. */
export function clientIdHint(clientId: string): string {
  return clientId.length <= 12 ? clientId : `${clientId.slice(0, 12)}…`;
}

/** A secret belongs to its client: replacing the Client ID needs the new client's secret (IN-27). */
export const NEW_CLIENT_NEEDS_SECRET_TEXT = 'A new Client ID needs its client secret too.';

/* ---------------------------------------------------------------------------------------------- */
/* Connections                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export const ConnectionStatus = z.enum(['active', 'needs_reauth']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/**
 * Why a connection needs the person to connect again (CN-05, CN-02); `password_refused` (0.97, CT-482; CM-D03): an IMAP
 * or SMTP server refused the stored password.
 */
export const ReauthReason = z.enum([
  'revoked',
  'testing_expired',
  'app_removed',
  'scope_missing',
  'password_refused',
]);
export type ReauthReason = z.infer<typeof ReauthReason>;

export const ConnectionCheckState = z.enum(['ok', 'api_disabled', 'no_scope', 'error']);
export type ConnectionCheckState = z.infer<typeof ConnectionCheckState>;

/** One service's check (CN-06). `enableUrl`: Google's activation link when the API is turned off. */
export const ConnectionCheck = z.object({
  service: ConnectorService,
  state: ConnectionCheckState,
  enableUrl: z.string().url().max(2048).optional(),
  message: z.string().max(500).optional(),
  /** An IMAP account's failed check (0.97, CT-482; CM-22): which server it is about, receiving or sending. */
  side: z.enum(['imap', 'smtp']).optional(),
});
export type ConnectionCheck = z.infer<typeof ConnectionCheck>;

/** A person's connected account as their clients see it. Tokens never leave the server (CN-05). */
export const Connection = z.object({
  id: ConnectionId,
  provider: ConnectorProvider,
  /** The account's address (`mara@example.com`). */
  email: Email,
  /** The account's display name at the provider. */
  name: z.string().max(200),
  /** Services connected, in service order. */
  services: z.array(ConnectorService),
  status: ConnectionStatus,
  reauthReason: ReauthReason.nullable(),
  checks: z.array(ConnectionCheck),
  /** When `checks` last ran (“Checked 5 minutes ago”, IN-29); null until they have. */
  checkedAt: Timestamp.nullable().default(null),
  /**
   * An IMAP account's servers (0.97, CT-482; CM-29), for “imap.fastmail.com and smtp.fastmail.com” on its page, and
   * the username it signs in with (the address unless the person gave another). Null or absent for Google and
   * Microsoft 365. Never the password.
   */
  mail: z
    .object({ imapHost: z.string().max(253), smtpHost: z.string().max(253), username: z.string().max(320) })
    .nullable()
    .optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export type Connection = z.infer<typeof Connection>;

/** Codes the callback redirects with (`?connect_error=`) when connecting fails (CN-04). */
export const ConnectErrorCode = z.enum(['access_denied', 'invalid_state', 'exchange_failed', 'no_app']);
export type ConnectErrorCode = z.infer<typeof ConnectErrorCode>;

/* ---------------------------------------------------------------------------------------------- */
/* The provider app and the Connections tab                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The OAuth app this Whombat uses for a provider (CN-02). The secret never reaches a client: `clientIdHint`
 * and `secretSet` only. `source`: saved in Settings, or set in this Whombat's config (the panel is
 * read-only then: “Set in this Whombat’s config”).
 */
export const ConnectorAppStatus = z.object({
  provider: ConnectorProvider,
  configured: z.boolean(),
  source: z.enum(['settings', 'config']).nullable(),
  clientIdHint: z.string().max(40).nullable(),
  secretSet: z.boolean(),
  userType: GoogleUserType.nullable(),
  updatedAt: Timestamp.nullable(),
});
export type ConnectorAppStatus = z.infer<typeof ConnectorAppStatus>;

/** What the guided setup (CN-03) shows and copies. */
export const GoogleSetupFacts = z.object({
  /** `{PUBLIC_URL}/api/v1/connectors/google/callback` (step 4). */
  redirectUri: z.string().url(),
  /** `googleEnableApisUrl()` (step 2). */
  enableApisUrl: z.string().url(),
  links: z.object({
    createProject: z.string().url(),
    consentScreen: z.string().url(),
    audience: z.string().url(),
    createClient: z.string().url(),
  }),
  /** Every scope Whombat may ask for (`googleScopesFor` of all services). */
  scopes: z.array(z.string()),
  /** Copy buttons in step 3: app name, support email (the person's), authorized domain (`PUBLIC_URL`'s host). */
  appName: z.string(),
  supportEmail: Email.nullable(),
  authorizedDomain: z.string(),
});
export type GoogleSetupFacts = z.infer<typeof GoogleSetupFacts>;

/** `GET /connectors`: the provider apps, the setup facts and the connections. */
export const ConnectorsStatus = z.object({
  microsoft: z.object({ app: ConnectorAppStatus, redirectUri: z.string().url() }).optional(),
  /**
   * Email (IMAP) on this Whombat (0.97, CT-482; CM-19): whether people can connect a mailbox over IMAP and SMTP. Absent
   * from an older Whombat, which has no such connection: clients leave its tile out.
   */
  imap: z.object({ available: z.boolean() }).optional(),
  mode: GoogleMode,
  google: z.object({
    app: ConnectorAppStatus,
    setup: GoogleSetupFacts,
    /** Any connection on this Whombat works (step 6 turns green). */
    tested: z.boolean(),
  }),
  /** The connections (Google, Microsoft 365, mail). An app set in config (`app.source`) can't be changed here. */
  connections: z.array(Connection),
});
export type ConnectorsStatus = z.infer<typeof ConnectorsStatus>;

/** Microsoft delegated permissions, requested only for connected services. Native Word/Excel editing is not advertised. */
export const MICROSOFT_SERVICES = ['mail', 'calendar', 'files', 'contacts'] as const;
export const MICROSOFT_SCOPES: Partial<Record<ConnectorService, readonly string[]>> = {
  mail: ['Mail.ReadWrite', 'Mail.Send'],
  calendar: ['Calendars.ReadWrite'],
  files: ['Files.ReadWrite'],
  contacts: ['Contacts.Read'],
};
export function microsoftScopesFor(services: readonly ConnectorService[]): string[] {
  return [
    ...new Set([
      'openid',
      'profile',
      'email',
      'offline_access',
      'User.Read',
      ...services.flatMap((s) => MICROSOFT_SCOPES[s] ?? []),
    ]),
  ];
}
export function microsoftServicesGranted(scopes: readonly string[]): ConnectorService[] {
  const normalized = scopes.map((s) => s.replace('https://graph.microsoft.com/', '').toLowerCase());
  return MICROSOFT_SERVICES.filter((s) =>
    MICROSOFT_SCOPES[s]?.every((scope) => normalized.includes(scope.toLowerCase())),
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Email over IMAP and SMTP (0.97, CT-480…CT-485; Whombat connections-more.md CM-19…CM-27)        */
/* ---------------------------------------------------------------------------------------------- */

/** How a mail server's connection is protected (CM-22): TLS from the start (993, 465) or STARTTLS (143, 587). */
export const MAIL_SECURITIES = ['tls', 'starttls'] as const;
export const MailSecurity = z.enum(MAIL_SECURITIES);
export type MailSecurity = z.infer<typeof MailSecurity>;

/** A mail server: its host (a name or an address), port and security. Plain text without TLS isn't offered. */
export const MailServer = z.object({
  host: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/, 'Write the server’s name, like imap.example.com.'),
  port: z.number().int().min(1).max(65535),
  security: MailSecurity,
});
export type MailServer = z.infer<typeof MailServer>;

/**
 * Where an IMAP account's mail is read and sent (CM-20): the IMAP and SMTP servers, and the username both sign in with
 * when it isn't the email address (null: the address).
 */
export const ImapServerSettings = z.object({
  imap: MailServer,
  smtp: MailServer,
  username: z.string().trim().min(1).max(320).nullable().default(null),
});
export type ImapServerSettings = z.infer<typeof ImapServerSettings>;

/**
 * Where `connectors.imapDiscover` found the servers (CM-20): the Thunderbird ISPDB, the domain's own autoconfig, the
 * ISPDB for its MX host's domain, SRV records (RFC 6186/8314), or `guess` (CM-D02: nothing found, `imap.<domain>` and
 * `smtp.<domain>`; the form opens the server fields).
 */
export const IMAP_SETTINGS_SOURCES = ['ispdb', 'autoconfig', 'mx', 'srv', 'guess'] as const;
export const ImapSettingsSource = z.enum(IMAP_SETTINGS_SOURCES);
export type ImapSettingsSource = z.infer<typeof ImapSettingsSource>;

/**
 * What the connect form says about a known provider (CM-21): its name, a sentence, a link (where its app password is
 * made), and the connection to use instead (Google, Microsoft 365) when there is a better one.
 */
export const ImapProviderHint = z.object({
  name: z.string().min(1).max(60),
  text: z.string().min(1).max(300),
  url: z.string().url().max(500).nullable(),
  useInstead: z.enum(['google', 'microsoft']).nullable(),
});
export type ImapProviderHint = z.infer<typeof ImapProviderHint>;

/** One known provider (CM-21): how it is recognised (address domains, MX host suffixes) and what Whombat does. */
export interface ImapProvider extends ImapProviderHint {
  id: string;
  /** Address domains, lower case (`gmail.com`); a subdomain doesn't count. */
  domains: readonly string[];
  /** MX host suffixes, lower case, starting with a dot (`.google.com`): a custom domain hosted there. */
  mx: readonly string[];
  /** The provider saves a copy of what its SMTP server sends in Sent itself, so Whombat doesn't append one (CM-26). */
  savesSent: boolean;
}

/**
 * Known providers (CM-21), checked against their help pages on 2026-10-19 and again on 2026-10-21 (0.111, CT-747;
 * Whombat connection-signin.md SG-18). Gmail points at the Google connection and, for mail only, at its app password;
 * Outlook and Microsoft 365 take no password over IMAP at all, not even an app password, so they point at Microsoft 365;
 * the others say where the app password is made and what else is in the way; Proton can't be connected yet (its Bridge
 * only answers on its own computer). `savesSent` only where the provider says so: where it doesn't say, Whombat
 * appends its own copy (a missing Sent copy is worse than a double one).
 */
export const IMAP_PROVIDER_HINTS: readonly ImapProvider[] = [
  {
    id: 'google',
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    mx: ['.google.com', '.googlemail.com'],
    text: 'Use the Google connection instead: it can also do your calendar and files. Or, for mail only, turn on 2-Step Verification and make an app password at myaccount.google.com/apppasswords.',
    url: 'https://myaccount.google.com/apppasswords',
    useInstead: 'google',
    savesSent: true,
  },
  {
    id: 'microsoft',
    name: 'Outlook',
    domains: [
      'outlook.com',
      'hotmail.com',
      'live.com',
      'msn.com',
      'passport.com',
      'windowslive.com',
      'hotmail.co.uk',
      'hotmail.fr',
      'hotmail.de',
      'hotmail.it',
      'hotmail.es',
      'hotmail.be',
      'hotmail.nl',
      'live.co.uk',
      'live.fr',
      'live.de',
      'live.nl',
      'live.ca',
      'live.com.au',
      'outlook.de',
      'outlook.fr',
      'outlook.es',
      'outlook.it',
      'outlook.be',
      'outlook.com.au',
      'outlook.jp',
    ],
    mx: ['.outlook.com', '.mx.microsoft'],
    text: 'Outlook and Microsoft 365 no longer let mail apps sign in with a password, not even an app password. Connect Microsoft 365 instead.',
    url: null,
    useInstead: 'microsoft',
    savesSent: true,
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    mx: ['.mail.icloud.com'],
    text: 'iCloud needs an app-specific password: make one at account.apple.com → Sign-In and Security → App-Specific Passwords. With your own domain on iCloud, use your @icloud.com address as the username (Change → Username).',
    url: 'https://account.apple.com',
    useInstead: null,
    savesSent: false,
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    domains: [
      'fastmail.com',
      'fastmail.fm',
      'fastmail.net',
      'fastmail.org',
      'fastmail.us',
      'fastmail.de',
      'fastmail.co.uk',
      'fastmail.ca',
      'fastmail.com.au',
      'fastmail.jp',
      'messagingengine.com',
      'sent.com',
    ],
    mx: ['.messagingengine.com'],
    text: 'Fastmail needs an app password: Settings → Privacy & Security → Connected apps & API tokens → Manage app passwords and access → New app password. The Basic plan has no IMAP.',
    url: 'https://app.fastmail.com/settings/security',
    useInstead: null,
    savesSent: false,
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: [
      'yahoo.com',
      'ymail.com',
      'rocketmail.com',
      'yahoo.co.uk',
      'yahoo.fr',
      'yahoo.de',
      'yahoo.it',
      'yahoo.es',
      'yahoo.ie',
      'yahoo.nl',
      'yahoo.ca',
      'yahoo.com.au',
      'yahoo.co.nz',
      'yahoo.co.in',
      'yahoo.in',
      'yahoo.com.br',
      'yahoo.com.mx',
    ],
    // Whole hosts: yahoodns.net also carries AT&T's and AOL's mail.
    mx: [
      '.mta5.am0.yahoodns.net',
      '.mta6.am0.yahoodns.net',
      '.mta7.am0.yahoodns.net',
      '.mx-eu.mail.am0.yahoodns.net',
      '.mx-apac.mail.gm0.yahoodns.net',
      '.mx-biz.mail.am0.yahoodns.net',
    ],
    text: 'Yahoo needs an app password: your Yahoo account → Account security → External connections → Create app password. If Yahoo doesn’t offer it, sign in on the web in the same browser for a few days first.',
    url: 'https://login.yahoo.com/account/security',
    useInstead: null,
    savesSent: false,
  },
  {
    id: 'aol',
    name: 'AOL Mail',
    domains: ['aol.com', 'aim.com', 'aol.co.uk', 'aol.de', 'aol.fr'],
    mx: ['.mx-aol.mail.gm0.yahoodns.net'],
    text: 'AOL needs an app password: your AOL account → Account security → Generate and manage app passwords.',
    url: 'https://login.aol.com/account/security',
    useInstead: null,
    savesSent: false,
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    domains: [
      'zoho.com',
      'zohomail.com',
      'zoho.eu',
      'zohomail.eu',
      'zoho.in',
      'zohomail.in',
      'zoho.com.au',
      'zohomail.com.au',
    ],
    mx: ['.zoho.com', '.zoho.eu', '.zoho.in', '.zoho.com.au', '.zoho.jp', '.zohocloud.ca', '.zoho.sa'],
    text: 'Turn on IMAP in Zoho Mail first (Settings → Mail Accounts → IMAP). With two-step sign-in, make an app password in Zoho Accounts → Security → App Passwords.',
    url: 'https://accounts.zoho.com',
    useInstead: null,
    savesSent: true,
  },
  {
    id: 'gmx',
    name: 'GMX',
    domains: [
      'gmx.com',
      'gmx.us',
      'gmx.co.uk',
      'gmx.fr',
      'gmx.es',
      'gmx.ca',
      'gmx.it',
      'gmx.net',
      'gmx.de',
      'gmx.at',
      'gmx.ch',
    ],
    mx: ['.gmx.net'],
    text: 'Turn on IMAP in GMX first: Settings → POP3 & IMAP. With two-step sign-in, use an app-specific password. GMX turns IMAP off again after a long time unused.',
    url: null,
    useInstead: null,
    savesSent: false,
  },
  {
    id: 'proton',
    name: 'Proton Mail',
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    mx: ['.protonmail.ch'],
    text: 'Proton Mail can’t be connected yet: its Bridge only answers on the computer it runs on.',
    url: null,
    useInstead: null,
    savesSent: true,
  },
];

/** An address's domain, lower case, or null when it has none. */
export function emailDomain(email: string): string | null {
  const at = email.trim().lastIndexOf('@');
  const domain =
    at < 0
      ? ''
      : email
          .trim()
          .slice(at + 1)
          .toLowerCase()
          .replace(/\.$/, '');
  return domain === '' ? null : domain;
}

/** The known provider of an address (CM-21): by its domain, else by one of its domain's MX hosts. Null: none known. */
export function imapProviderFor(email: string, mxHosts: readonly string[] = []): ImapProvider | null {
  const domain = emailDomain(email);
  if (domain) {
    const byDomain = IMAP_PROVIDER_HINTS.find((p) => p.domains.includes(domain));
    if (byDomain) return byDomain;
  }
  for (const raw of mxHosts) {
    const host = `.${raw.trim().toLowerCase().replace(/\.$/, '')}`;
    const byMx = IMAP_PROVIDER_HINTS.find((p) => p.mx.some((suffix) => host.endsWith(suffix)));
    if (byMx) return byMx;
  }
  return null;
}

/** A known provider as the connect form shows it (CM-21). */
export function imapProviderHint(provider: ImapProvider): ImapProviderHint {
  return { name: provider.name, text: provider.text, url: provider.url, useInstead: provider.useInstead };
}

/** The servers to try when nothing is found (CM-D02): `imap.<domain>` on 993 with TLS, `smtp.<domain>` on 587. */
export function imapGuessSettings(email: string): ImapServerSettings | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  return {
    imap: { host: `imap.${domain}`, port: 993, security: 'tls' },
    smtp: { host: `smtp.${domain}`, port: 587, security: 'starttls' },
    username: null,
  };
}

/** The usual port of a server with this security (CM-22): IMAP 993 or 143, SMTP 465 or 587. */
export function mailDefaultPort(side: 'imap' | 'smtp', security: MailSecurity): number {
  if (side === 'imap') return security === 'tls' ? 993 : 143;
  return security === 'tls' ? 465 : 587;
}

/** The found servers in one line (CM-20): “imap.fastmail.com and smtp.fastmail.com”, one name when both are the same. */
export function imapServersLine(servers: { imapHost: string; smtpHost: string }): string {
  return servers.imapHost === servers.smtpHost
    ? servers.imapHost
    : `${servers.imapHost} and ${servers.smtpHost}`;
}

/**
 * Why connecting a mailbox failed (CM-22), in `error.details.reason`: the IMAP or the SMTP side refused the password or
 * couldn't be reached, the address isn't allowed (`not_allowed`: the destination policy, a home-network server not on
 * the list), or a server's certificate isn't valid (`certificate`; self-signed ones aren't taken in this version).
 */
export const IMAP_CONNECT_FAILURES = [
  'imap_refused',
  'imap_unreachable',
  'smtp_refused',
  'smtp_unreachable',
  'not_allowed',
  'certificate',
] as const;
export const ImapConnectFailure = z.enum(IMAP_CONNECT_FAILURES);
export type ImapConnectFailure = z.infer<typeof ImapConnectFailure>;

/** `error.details` of a refused `connectors.imapConnect` (CT-483): why, and the server it is about. */
export const ImapConnectErrorDetails = z.object({
  reason: ImapConnectFailure,
  host: z.string().max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type ImapConnectErrorDetails = z.infer<typeof ImapConnectErrorDetails>;

/** The connect form's sentence for a failure (CM-22), the server's message unless it has better words. */
export function imapConnectFailureText(
  reason: ImapConnectFailure,
  server: { host?: string; port?: number } = {},
): string {
  const where = server.host
    ? `${server.host}${server.port ? ` on port ${server.port}` : ''}`
    : 'the mail server';
  switch (reason) {
    case 'imap_refused':
      return 'The mail server refused the password. If your provider uses app passwords, make one and use that.';
    case 'smtp_refused':
      return 'The server for sending mail refused the password. If your provider uses app passwords, make one and use that.';
    case 'imap_unreachable':
    case 'smtp_unreachable':
      return `Whombat couldn’t reach ${where}.`;
    case 'not_allowed':
      return `Whombat isn’t allowed to reach ${server.host ?? 'that server'}. A server on your network needs to be on the home network list first.`;
    case 'certificate':
      return `${server.host ?? 'The mail server'} didn’t show a valid certificate, so Whombat didn’t send the password.`;
  }
}
