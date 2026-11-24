/**
 * The connections catalog's REST contract (Whombat docs/decisions/connections-catalog.md CX-03…CX-75, contracts 0.48.0,
 * CT-266…). Spread into `api.connections` next to the Google and Microsoft endpoints (`./connectors.ts`), so the session
 * op names are `connections.<action>`; the app of an `app_oauth` entry is `api.connectors.setApp` / `removeApp`.
 *
 * - Burrow routes (`/burrows/:burrow/connections…`) list this Whombat's connections. Since 3.0 (CT-1550) there is one
 *   kind: no personal and shared connections, no scope, nobody else's connection to hide. The person sets up, changes
 *   and removes any of them; every write is a signed burrow event (`connection.*`, CX-22).
 * - Account routes (`/connections/…`) carry what isn't one burrow's: the catalog's availability on this Whombat, the
 *   OAuth finish (bound to the caller's state), the Nextcloud login poll and (0.111) the service-login poll, the Custom
 *   MCP probe and the home-network quick add.
 *
 * Secrets are write-only (CX-10): `connections.create` and `connections.setSecret` take one and are secret session ops
 * (CX-16), as are `connections.finishOAuth` (an authorization code) and `connectors.setApp` (a client secret).
 */
import { z } from 'zod';
import { Count, Timestamp } from '../domain/common.js';
import {
  CatalogCheckResult,
  CatalogIdText,
  CONNECTION_FIELD_VALUE_MAX,
  CONNECTION_GUIDE_MAX,
  ConnectionAccessLevel,
  ConnectionLabel,
  ConnectionSecret,
  ConnectionsCatalogStatus,
  ConnectionToolTier,
  ConnectionToolView,
  ConnectionView,
  OAuthSignInKind,
  SERVICE_LOGIN_USER_CODE_MAX,
  TokenAuth,
} from '../domain/connections-catalog.js';
import { ReturnLocation, ReturnPath } from '../domain/connectors.js';
import { ThingRunsOn } from '../domain/thing-page.js';
import { ConnectionToolLimits } from '../domain/tool-limits.js';
import { ConnectionId, EventId, OAuthStateId } from '../ids.js';
import { OnePasswordDisconnectChoice } from '../vault/onepassword-view.js';
import { VaultPort } from '../vault/schemas.js';
import { BurrowParam, endpoint } from './endpoint.js';
import type { ErrorCode } from './errors.js';
import { VaultNetworksResponse } from './vault.js';

/* Bodies ---------------------------------------------------------------------------------------- */

/** A sealed sign-in challenge handed back to the form (0.111, CT-731): opaque text, at most 4 KiB. */
export const ConnectionChallenge = z.string().min(1).max(4096);
/** A two-step code a person types (0.111, CT-733): 4 to 64 characters, trimmed. */
export const TwoStepCode = z.string().trim().min(4).max(64);

/** The form's non-secret values by field id (CX-01): `{url: 'http://homeassistant.local:8123'}`. */
export const ConnectionFields = z
  .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), z.string().max(CONNECTION_FIELD_VALUE_MAX))
  .refine((f) => Object.keys(f).length <= 8, 'At most 8 fields.');
export type ConnectionFields = z.infer<typeof ConnectionFields>;

/**
 * Connect with a token (CX-10, CX-71), an OAuth client's secret (`client_credentials`), or by signing in once
 * (`password` with `login`: Whombat signs in, makes its own key at the level `access` asks, keeps only that key and
 * forgets the password; CT-314): the entry, the label (default `defaultConnectionLabel`), the fields
 * and the token. `method` picks one of the entry's `token` sign-ins by its index among them (Custom entries offer
 * several shapes; absent: the first); a Custom entry may send its own `auth` (header name, query name) instead, checked
 * with `tokenAuthProblem`. `secret` is absent only for a Custom MCP server with no sign-in (`none`). The server checks
 * the fields (`fieldsProblems`, `validation_failed` per field), the destination (`destination_refused`), runs the
 * entry's check, picks a `fromService` field (`field_choice_needed` with the choices when there are several) and reads
 * the tools. A secret op.
 */
export const CreateConnectionBody = z.object({
  catalogId: CatalogIdText,
  label: ConnectionLabel.optional(),
  fields: ConnectionFields.default({}),
  signIn: z.enum(['token', 'none', 'password', 'client_credentials']).default('token'),
  method: z.number().int().min(0).max(3).optional(),
  auth: TokenAuth.optional(),
  secret: ConnectionSecret.optional(),
  /**
   * Sign in once (`password`, CT-314): the account, its password and a second factor's code. Never stored. The account
   * is empty for a sign-in without one (T3 Code's pairing code, Whombat t3code.md T3-02).
   */
  login: z
    .object({
      account: z.string().trim().max(200).default(''),
      password: z.string().min(1).max(1000),
      code: z.string().trim().min(4).max(64).optional(),
      /**
       * The challenge a `second_factor_needed` (or a `code` refusal) handed back as `details.challenge` (0.111, CT-731;
       * Whombat connection-signin.md SG-06: UniFi's emailed code belongs to it), sent back as it came with the code. Opaque
       * and sealed by the server; useless without the password. One that doesn't open, belongs elsewhere or expired is
       * ignored: the sign-in starts fresh.
       */
      challenge: ConnectionChallenge.optional(),
    })
    .optional(),
  /** What agents may do with it (CT-314). */
  access: ConnectionAccessLevel.default('manage'),
  /**
   * A two-step code for a session sign-in whose `auth` has `twoStep` (0.111, CT-733; SG-09: Synology DSM), sent again
   * with the same body after `second_factor_needed`. Never stored: the service's trusted-device token is.
   */
  code: TwoStepCode.optional(),
});
export type CreateConnectionBody = z.input<typeof CreateConnectionBody>;

/** Change the label or the fields (never the secret or the entry). A new address is checked again. */
export const UpdateConnectionBody = z
  .object({
    label: ConnectionLabel.optional(),
    fields: ConnectionFields.optional(),
    /** Look only or Manage (CT-314): Whombat's own limit; a key the service limited stays as it was made. */
    access: ConnectionAccessLevel.optional(),
  })
  .refine(
    (b) => b.label !== undefined || b.fields !== undefined || b.access !== undefined,
    'Nothing to change.',
  );
export type UpdateConnectionBody = z.input<typeof UpdateConnectionBody>;

/**
 * “Replace token” (CX-72): write-only, checked before it replaces the old one. A secret op. `code` (0.111, CT-733;
 * SG-09): a two-step code for a session sign-in with `twoStep` (“Replace the password and enter a code”); the server
 * answers `second_factor_needed` without one when the service asks.
 */
export const SetConnectionSecretBody = z.object({ secret: ConnectionSecret, code: TwoStepCode.optional() });
export type SetConnectionSecretBody = z.input<typeof SetConnectionSecretBody>;

/** A tool's tier on the connection (CX-72): Allowed, Asks, Off. Clears its “New” mark. */
export const SetConnectionToolBody = z.object({ tier: ConnectionToolTier });

/** A tool's limits on its arguments, or null to clear them (0.80, CT-341). */
export const SetConnectionToolLimitsBody = z.object({ limits: ConnectionToolLimits.nullable() });
export type SetConnectionToolLimitsBody = z.infer<typeof SetConnectionToolLimitsBody>;
export type SetConnectionToolBody = z.input<typeof SetConnectionToolBody>;

/**
 * Start an OAuth sign-in (CX-12…CX-15): the entry and method, the label and fields (Home Assistant's URL, a Custom MCP
 * server's), or the connection to reconnect (`connectionId`: its entry and fields are kept), and where to come back to. The state (10 minutes, single use) keeps the pending fields.
 */
export const StartConnectionOAuthBody = z.object({
  catalogId: CatalogIdText,
  method: OAuthSignInKind,
  label: ConnectionLabel.optional(),
  fields: ConnectionFields.default({}),
  connectionId: ConnectionId.optional(),
  returnTo: ReturnPath,
});
export type StartConnectionOAuthBody = z.input<typeof StartConnectionOAuthBody>;

export const StartConnectionOAuthResponse = z.object({
  /** Where the browser goes, as a full-page navigation (the service's consent page). */
  authorizeUrl: z.string().url(),
});
export type StartConnectionOAuthResponse = z.infer<typeof StartConnectionOAuthResponse>;

/**
 * Finish an OAuth sign-in from the redirect the app received (as `connections.finishGoogle`, AG-14): the state must be
 * the caller's. Lenient (bounded strings): an unknown, used or expired state answers a return path with
 * `connect_error=invalid_state`. A secret op (the input carries a code).
 */
export const FinishConnectionOAuthBody = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(200),
  error: z.string().min(1).max(200).optional(),
  /** RFC 9207's `iss`, when the authorization server sent one: checked against the issuer the state recorded. */
  iss: z.string().min(1).max(500).optional(),
});
export type FinishConnectionOAuthBody = z.infer<typeof FinishConnectionOAuthBody>;

/**
 * Where the app goes next: the start's return path with `connected=<catalogId>` and `connection=<id>`, or
 * `connect_error=<ConnectionConnectError>`.
 */
export const FinishConnectionOAuthResponse = z.object({
  returnPath: ReturnLocation,
  connectionId: ConnectionId.nullable(),
});
export type FinishConnectionOAuthResponse = z.infer<typeof FinishConnectionOAuthResponse>;

/** `connect_error=` codes after an OAuth sign-in (CX-15), besides Google's (`ConnectErrorCode`). */
export const ConnectionConnectError = z.enum([
  'access_denied',
  'invalid_state',
  'exchange_failed',
  'no_app',
  'issuer_mismatch',
  'check_failed',
  'destination_refused',
  'limit_reached',
]);
export type ConnectionConnectError = z.infer<typeof ConnectionConnectError>;

/**
 * Start Nextcloud's Login Flow v2 (CX-11): the server URL (in `fields.url`) and the label, or the connection to
 * reconnect. The server `POST`s `<url>/index.php/login/v2` and keeps the poll token.
 */
export const StartNextcloudLoginBody = z.object({
  label: ConnectionLabel.optional(),
  fields: ConnectionFields,
  connectionId: ConnectionId.optional(),
});
export type StartNextcloudLoginBody = z.input<typeof StartNextcloudLoginBody>;

export const StartNextcloudLoginResponse = z.object({
  /** Open in a new tab: Nextcloud's own login and “Grant access” page. */
  loginUrl: z.string().url(),
  /** What `connections.pollNextcloud` takes (an `oauth_states` row). */
  flowId: OAuthStateId,
  /** Poll every this many ms (`NEXTCLOUD_POLL_MS`) until `expiresAt` (at most `NEXTCLOUD_LOGIN_MAX_MS`). */
  pollEveryMs: z.number().int().min(500).max(60_000),
  expiresAt: Timestamp,
});
export type StartNextcloudLoginResponse = z.infer<typeof StartNextcloudLoginResponse>;

/** A Nextcloud login poll: still waiting, connected (the app password became the secret), expired or failed. */
export const PollNextcloudLoginResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending') }),
  z.object({ state: z.literal('connected'), connection: ConnectionView, eventId: EventId.nullable() }),
  z.object({ state: z.literal('expired') }),
  z.object({ state: z.literal('failed'), message: z.string().max(500) }),
]);
export type PollNextcloudLoginResponse = z.infer<typeof PollNextcloudLoginResponse>;

/**
 * Start signing in on the service's own page (0.111, CT-730, CT-738; Whombat connection-signin.md SG-01, SG-02): the
 * entry (one with a `service_login` sign-in), the label, the fields (Plex's server address), the level agents get (set
 * on save), or the connection to reconnect (`connectionId`: its entry and fields are kept). The
 * address is checked first (`destination_refused`); the flow is the caller's, single use, at most `SERVICE_LOGIN_MAX_MS`.
 */
export const StartServiceLoginBody = z.object({
  catalogId: CatalogIdText,
  label: ConnectionLabel.optional(),
  fields: ConnectionFields.default({}),
  access: ConnectionAccessLevel.default('manage'),
  connectionId: ConnectionId.optional(),
});
export type StartServiceLoginBody = z.input<typeof StartServiceLoginBody>;

export const StartServiceLoginResponse = z.object({
  /** Open in a new tab: the service's own sign-in page (Plex's PIN page). */
  loginUrl: z.string().url(),
  /** What `connections.pollServiceLogin` takes. */
  flowId: OAuthStateId,
  /** Poll every this many ms (Plex: `SERVICE_LOGIN_POLL_MS`) until `expiresAt` (at most `SERVICE_LOGIN_MAX_MS`). */
  pollEveryMs: z.number().int().min(500).max(60_000),
  expiresAt: Timestamp,
  /** A code the person types on that page (a device-code service), shown beside the button; null for Plex. */
  userCode: z.string().max(SERVICE_LOGIN_USER_CODE_MAX).nullable(),
});
export type StartServiceLoginResponse = z.infer<typeof StartServiceLoginResponse>;

/**
 * A service-login poll (CT-738), exactly as Nextcloud's: still waiting, connected (the token became the secret, stored
 * as the entry's token sign-in; checked and its tools read), expired or failed (`message`, the person's words).
 */
export const PollServiceLoginResponse = PollNextcloudLoginResponse;
export type PollServiceLoginResponse = PollNextcloudLoginResponse;

/** “Does this MCP server need a sign-in?” (CX-61): the URL only, never a secret. */
export const ProbeConnectionBody = z.object({
  catalogId: CatalogIdText,
  fields: ConnectionFields,
});
export type ProbeConnectionBody = z.input<typeof ProbeConnectionBody>;

/**
 * What the probe found (CX-61, CX-13): the server answers without a sign-in (`open`), wants OAuth (`oauth`: 401 with
 * protected-resource metadata; `issuer` is its authorization server), wants a token the person has (`token`: 401 without
 * metadata), or couldn't be reached (`unreachable`, `message`). A refused address is `destination_refused` (an error).
 */
export const ProbeConnectionResponse = z.object({
  needs: z.enum(['open', 'oauth', 'token', 'unreachable']),
  issuer: z.string().max(500).nullable(),
  /** The server's own name (`serverInfo.name`), when it answered. */
  serverName: z.string().max(200).nullable(),
  message: z.string().max(500).nullable(),
});
export type ProbeConnectionResponse = z.infer<typeof ProbeConnectionResponse>;

/**
 * What is at an address (CT-314), before anything is sent to it: the entry (optional: any entry's probes are tried), and
 * the address as the person typed it (`pve.local`, `192.168.1.10:8006`).
 */
export const IdentifyConnectionBody = z.object({
  catalogId: CatalogIdText.optional(),
  url: z.string().trim().min(1).max(CONNECTION_FIELD_VALUE_MAX),
});
export type IdentifyConnectionBody = z.input<typeof IdentifyConnectionBody>;

/** A certificate a server presented (CT-314): its SHA-256 fingerprint and whether it verified as is. */
export const PresentedCertificate = z.object({
  sha256: z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
  trusted: z.boolean(),
});
export type PresentedCertificate = z.infer<typeof PresentedCertificate>;

/**
 * What answered (CT-314): the address to use (scheme and the service's port added: `https://192.168.1.10:8006`), what
 * it is (an entry's id and its version, when a probe recognised it), its certificate (https), and why not, when nothing
 * did. A refused address is `destination_refused` (an error), as on connect.
 */
export const IdentifyConnectionResponse = z.object({
  url: z.string().max(CONNECTION_FIELD_VALUE_MAX),
  reachable: z.boolean(),
  catalogId: CatalogIdText.nullable(),
  version: z.string().max(60).nullable(),
  certificate: PresentedCertificate.nullable(),
  message: z.string().max(500).nullable(),
});
export type IdentifyConnectionResponse = z.infer<typeof IdentifyConnectionResponse>;

/**
 * Look for services on the home network (CT-314): start a scan, or read the one running or done. `networks` adds
 * networks to look in (IPv4 CIDRs of at most 1 024 addresses) besides this Whombat's own networks, the networks of
 * its connections and the home network list; `rescan` starts again even when a recent scan is there.
 */
export const DiscoverConnectionsBody = z.object({
  networks: z.array(z.string().max(60)).max(8).default([]),
  rescan: z.boolean().default(false),
});
export type DiscoverConnectionsBody = z.input<typeof DiscoverConnectionsBody>;

/**
 * One service found (CT-314): the entry, its address, its version and certificate, and the connections already there —
 * since 0.63 (CT-316) the caller's connections of the same entry on that host, or a Custom API on that host and port.
 * `hidden` (0.63): a manager of the burrow hid it from the list (`connections.hideFound`). A computer that answers SSH
 * is found as `FOUND_SERVER_ID` (`ssh://host`, its system in `version`), and `serverIds` names the Whombat servers
 * already at that host (Whombat connect-in-chat.md): such a find is added already, as a connected one is.
 */
export const DiscoveredService = z.object({
  catalogId: CatalogIdText,
  url: z.string().max(CONNECTION_FIELD_VALUE_MAX),
  host: z.string().max(100),
  version: z.string().max(60).nullable(),
  certificate: PresentedCertificate.nullable(),
  connectionIds: z.array(ConnectionId).max(30),
  hidden: z.boolean().default(false),
  serverIds: z.array(z.string().min(1).max(100)).max(30).optional(),
});
export type DiscoveredService = z.infer<typeof DiscoveredService>;

/**
 * A scan (CT-314): `scanning` with its progress, or `done`; the networks it looked in and what it found. `idle` before
 * the first scan. Found services stay until the next scan finishes.
 */
export const ConnectionDiscovery = z.object({
  state: z.enum(['idle', 'scanning', 'done']),
  progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }).nullable(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  networks: z.array(z.string().max(60)).max(64),
  found: z.array(DiscoveredService).max(200),
});
export type ConnectionDiscovery = z.infer<typeof ConnectionDiscovery>;

/**
 * Hide a found service from Found on your network, or show it again (CT-316): the entry and the address it was found
 * at (`DiscoveredService.url`; its host and port are what is remembered). For the whole burrow, kept across scans and
 * restarts; answers the discovery as `connections.discover` would without starting a scan.
 */
export const HideFoundServiceBody = z.object({
  catalogId: CatalogIdText,
  url: z.string().max(CONNECTION_FIELD_VALUE_MAX),
  hidden: z.boolean().default(true),
});
export type HideFoundServiceBody = z.input<typeof HideFoundServiceBody>;

/**
 * The person registers (or replaces) the OAuth app of an `app_oauth` entry (CX-14): the client id and, where the provider
 * needs one, its secret (Dropbox takes a PKCE public client: `null` clears a stored secret). Omit either to keep it.
 */
export const SetConnectorAppBody = z
  .object({
    clientId: z
      .string()
      .trim()
      .min(4)
      .max(200)
      .regex(/^[A-Za-z0-9._~-]+$/, 'Paste the app key or client ID.')
      .optional(),
    clientSecret: z.string().trim().min(8).max(500).nullable().optional(),
  })
  .refine((b) => b.clientId !== undefined || b.clientSecret !== undefined, 'Nothing to change.');
export type SetConnectorAppBody = z.input<typeof SetConnectorAppBody>;

/**
 * “Add this network” (CX-41): the network and port the `destination_refused` refusal suggested. Adds the network, or
 * the port to the network already on the list (unlike `vaultNetworks.add`, which refuses a listed network). Admins of
 * this Whombat only.
 */
export const AllowConnectionNetworkBody = z.object({
  cidr: z.string().trim().min(1).max(60),
  port: VaultPort,
  note: z.string().trim().max(200).optional(),
});
export type AllowConnectionNetworkBody = z.input<typeof AllowConnectionNetworkBody>;

/* Responses ------------------------------------------------------------------------------------- */

/** This Whombat's connections (CX-70), by label. */
export const ConnectionsListResponse = z.object({
  connections: z.array(ConnectionView),
  /** Counts toward `CONNECTIONS_MAX`. */
  count: Count,
});
export type ConnectionsListResponse = z.infer<typeof ConnectionsListResponse>;

/** A write on a connection: its view and the signed burrow event, or null when nothing changed. */
export const ConnectionWriteResponse = z.object({ connection: ConnectionView, eventId: EventId.nullable() });
export type ConnectionWriteResponse = z.infer<typeof ConnectionWriteResponse>;

/** “Check again” (CX-72): the connection with the check recorded, and its lines. Tools are read again too. */
export const ConnectionCheckResponse = z.object({
  connection: ConnectionView,
  checks: z.array(CatalogCheckResult),
});
export type ConnectionCheckResponse = z.infer<typeof ConnectionCheckResponse>;

/** The connection page's TOOLS (CX-72): every tool with its tier, and the guide agents get. */
export const ConnectionToolsResponse = z.object({
  connection: ConnectionView,
  tools: z.array(ConnectionToolView),
  guide: z.string().max(CONNECTION_GUIDE_MAX),
  /** More than `CONNECTION_TOOLS_MAX` tools were listed: the rest are ignored. */
  truncated: z.boolean().default(false),
});
export type ConnectionToolsResponse = z.infer<typeof ConnectionToolsResponse>;

/* Refusals -------------------------------------------------------------------------------------- */

/** Why a connections endpoint refused, in `error.details.code` (REST and session alike, CT-21). */
export const CONNECTION_ERROR_CODES = [
  /**
   * The address isn't allowed (CX-40, CX-41): `details.problem` (`VaultDestinationProblemCode`), and for an unlisted
   * home-network address `details.cidr` and `details.port` (“Add this network”, `connections.allowNetwork`).
   */
  'destination_refused',
  /** `CONNECTIONS_MAX` connections already (`details.max`). */
  'limit_reached',
  /** The entry doesn't allow that sign-in method or header shape, or is builtin (`details.catalogId`). */
  'not_supported',
  /** An `app_oauth` entry whose app isn't registered yet (CX-14). */
  'app_not_configured',
  /**
   * The token or the address didn't pass the entry's check (`details.status`, the HTTP status when there was one).
   * `details.certificateSha256`: a home-network server's certificate couldn't be verified or wasn't the pinned one, and
   * the entry takes a certificate fingerprint; this is the one it presents, for the form to offer (CT-313).
   */
  'check_failed',
  /** A `fromService` field has several choices (CT-268): `details.field` and `details.options`. */
  'field_choice_needed',
  /** The app of an `app_oauth` entry is set in this Whombat's config, not in Settings. */
  'app_in_config',
  /** The Nextcloud login flow, or (0.111, CT-738) a service-login flow, ended or was used (CX-11). */
  'login_expired',
  /** That tool isn't one of the connection's (any more). */
  'unknown_tool',
  /**
   * Sign in once (CT-314): the service wants a second factor's code. Send the same again with `login.code` (and, since
   * 0.111, `details.challenge` as `login.challenge` when there is one, CT-731). The message says what kind (“the code
   * from your authenticator app”). Since 0.111 (CT-733) also a session sign-in with `twoStep`: send the same again with
   * `code`.
   */
  'second_factor_needed',
  /**
   * Sign in once was refused (CT-314): `details.reason` — `password` (wrong account or password), `code` (wrong or
   * expired code), `rights` (the account may not make keys), `locked` (too many tries), `single_sign_on` (the account
   * signs in elsewhere), `unsupported` (this version or setting can't: make a token by hand), `second_factor` (the
   * service can't take a code this way: `details.method` names the sign-in to use instead).
   */
  'sign_in_refused',
  /**
   * The burrow already has an AI gateway connection (0.76, CT-332; Whombat ai-gateway.md AIG-01): at most one. The
   * message names it (`AI_GATEWAY_COPY.exists`).
   */
  'gateway_exists',
  /** This Fusebox can't take a client key for Whombat (0.76, AIG-02: it refused `named-clients`); update it first. */
  'gateway_too_old',
] as const;
export const ConnectionErrorCode = z.enum(CONNECTION_ERROR_CODES);
export type ConnectionErrorCode = z.infer<typeof ConnectionErrorCode>;

export const CONNECTION_ERROR_STATUS: Record<ConnectionErrorCode, ErrorCode> = {
  destination_refused: 'not_allowed',
  limit_reached: 'conflict',
  not_supported: 'conflict',
  app_not_configured: 'conflict',
  check_failed: 'conflict',
  field_choice_needed: 'conflict',
  app_in_config: 'conflict',
  login_expired: 'expired',
  unknown_tool: 'not_found',
  second_factor_needed: 'conflict',
  sign_in_refused: 'conflict',
  gateway_exists: 'conflict',
  gateway_too_old: 'conflict',
};

export const CONNECTION_ERROR_MESSAGES: Record<ConnectionErrorCode, string> = {
  destination_refused: 'That address isn’t allowed.',
  limit_reached: 'That’s as many connections as there can be. Remove one first.',
  not_supported: 'This connection can’t be set up that way.',
  app_not_configured: 'Set up its app first, in Settings → Connections.',
  check_failed: 'Whombat couldn’t sign in with that. Check the address and the token.',
  field_choice_needed: 'Choose one to go on.',
  app_in_config: 'This app is set in this Whombat’s config.',
  login_expired: 'The sign-in took too long. Start again.',
  unknown_tool: 'That tool isn’t one of this connection’s.',
  second_factor_needed: 'Enter the code from your authenticator app.',
  sign_in_refused: 'The service didn’t let Whombat sign in with that.',
  gateway_exists: 'This Whombat already sends its AI through a gateway. Remove that connection first.',
  gateway_too_old:
    'This Fusebox is too old to add a client key for Whombat. Update Fusebox and connect again.',
};

/**
 * The sentence the connect form shows for an unlisted home-network address (CX-41), next to the “Add this network”
 * button.
 */
export function destinationRefusedText(cidr: string, port: number): string {
  return `That address is on your network. Add ${cidr} port ${port} to the home network list to connect.`;
}

/** `error.details` of a connections refusal. */
export const ConnectionErrorDetails = z.object({
  code: ConnectionErrorCode,
  problem: z.string().optional(),
  cidr: z.string().optional(),
  port: VaultPort.optional(),
  max: Count.optional(),
  catalogId: z.string().optional(),
  status: z.number().int().optional(),
  /** `sign_in_refused` (CT-314): why. */
  reason: z
    .enum(['password', 'code', 'rights', 'locked', 'single_sign_on', 'unsupported', 'second_factor'])
    .optional(),
  /** `sign_in_refused` with `second_factor`: the entry's sign-in kind to use instead (Nextcloud's login). */
  method: z.string().max(40).optional(),
  /**
   * `second_factor_needed`, or `sign_in_refused` with `code` that made a new one (0.111, CT-731; SG-06): the sealed
   * challenge the code belongs to, for the form to send back as `login.challenge`. Opaque; never the password.
   */
  challenge: ConnectionChallenge.optional(),
  /** `check_failed`: the SHA-256 fingerprint (`AB:CD:…`) a home-network server presented (CT-313). */
  certificateSha256: z
    .string()
    .regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    .optional(),
  field: z.string().optional(),
  options: z
    .array(z.object({ value: z.string().max(200), label: z.string().max(200) }))
    .max(100)
    .optional(),
});
export type ConnectionErrorDetails = z.infer<typeof ConnectionErrorDetails>;

/* Endpoints ------------------------------------------------------------------------------------- */

const B = z.object({ burrow: BurrowParam });
const BC = B.extend({ connectionId: ConnectionId });

/**
 * What a connection runs on (0.88, CT-393; Whombat connection-pages.md CP-08): `auto` lets Whombat find it by the
 * connection's address (the default), `none` says it runs on nothing Whombat watches, `chosen` names a server or one of
 * its guests.
 */
export const SetRunsOnBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }),
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('chosen'),
    serverId: z.string().min(1).max(100),
    guestId: z.string().min(1).max(200).nullable(),
  }),
]);
export type SetRunsOnBody = z.infer<typeof SetRunsOnBody>;
export const SetRunsOnResponse = z.object({ runsOn: ThingRunsOn.nullable() });
export type SetRunsOnResponse = z.infer<typeof SetRunsOnResponse>;
/** A tool's name as the connection lists it (path-encoded). */
const ToolParam = z.string().min(1).max(200);

/** Merged into `api.connections` (op names `connections.<action>`). */
export const connectionCatalogEndpoints = {
  catalog: endpoint({
    id: 'connections.catalog',
    method: 'GET',
    path: '/connections/catalog',
    summary:
      'Which catalog entries this Whombat offers (an `app_oauth` entry needs its app) and how many connections it keeps.',
    response: ConnectionsCatalogStatus,
  }),
  list: endpoint({
    id: 'connections.list',
    method: 'GET',
    path: '/burrows/:burrow/connections',
    summary: 'This Whombat’s connections, by label, and how many there are.',
    params: B,
    response: ConnectionsListResponse,
  }),
  create: endpoint({
    id: 'connections.create',
    method: 'POST',
    path: '/burrows/:burrow/connections',
    summary:
      'Connect a catalog entry with a token (or a Custom MCP server without sign-in): fields checked, destination checked (`destination_refused`), the entry’s check run (`check_failed`), tools read. Signs `connection.added`. A secret op.',
    params: B,
    body: CreateConnectionBody,
    response: ConnectionWriteResponse,
    status: 201,
  }),
  update: endpoint({
    id: 'connections.update',
    method: 'PATCH',
    path: '/burrows/:burrow/connections/:connectionId',
    summary:
      'Change a connection’s label or fields (never its secret). A new address is checked again and ends the pooled client. Signs `connection.changed`.',
    params: BC,
    body: UpdateConnectionBody,
    response: ConnectionWriteResponse,
  }),
  setSecret: endpoint({
    id: 'connections.setSecret',
    method: 'PUT',
    path: '/burrows/:burrow/connections/:connectionId/secret',
    summary:
      '“Replace token”: checked first, then sealed and never returned; a connection that needed reconnecting is active again. A secret op.',
    params: BC,
    body: SetConnectionSecretBody,
    response: ConnectionWriteResponse,
  }),
  recheck: endpoint({
    id: 'connections.recheck',
    method: 'POST',
    path: '/burrows/:burrow/connections/:connectionId/check',
    summary:
      '“Check again” (CX-72): runs the entry’s check, reads the tools again (changed ones are marked New, CX-18) and records the result. Signs nothing unless the state changed.',
    params: BC,
    response: ConnectionCheckResponse,
  }),
  setRunsOn: endpoint({
    id: 'connections.setRunsOn',
    method: 'POST',
    path: '/burrows/:burrow/connections/:connectionId/runs-on',
    summary:
      'Say which server or guest a connection runs on, or let Whombat find it by its address (0.88, CP-08).',
    params: BC,
    body: SetRunsOnBody,
    response: SetRunsOnResponse,
  }),
  disconnect: endpoint({
    id: 'connections.disconnect',
    method: 'DELETE',
    path: '/burrows/:burrow/connections/:connectionId',
    summary:
      'Remove a connection (CX-24): its tools, pending approvals and secret go, OAuth tokens are revoked best effort, the pooled client is closed. Signs `connection.removed`. A Fusebox loses Whombat’s client key and the burrow’s gateway switches (AIG-03). A 1Password connection keeps the entries it brought in the Vault as Whombat entries, or removes them with `vaultEntries` `remove`; 1Password itself is never changed.',
    params: BC,
    /**
     * A 1Password connection only (Whombat onepassword-sync.md): what becomes of the Vault entries kept in step with it.
     * Absent: `keep`. Ignored for every other connection.
     */
    query: z.object({ vaultEntries: OnePasswordDisconnectChoice.optional() }),
    response: z.object({
      ok: z.literal(true),
      eventId: EventId.nullable(),
      /**
       * What is left to do by hand, for the page to say (0.76, CT-332; AIG-03): “Fusebox didn’t answer, so remove the
       * client “Whombat · Lumio BV” there yourself.” Null or absent: nothing.
       */
      notice: z.string().max(500).nullable().optional(),
    }),
  }),
  tools: endpoint({
    id: 'connections.tools',
    method: 'GET',
    path: '/burrows/:burrow/connections/:connectionId/tools',
    summary:
      'The connection’s tools with their tiers, “Always asks” and “New” marks (CX-72), and the guide the agent gets.',
    params: BC,
    response: ConnectionToolsResponse,
  }),
  setTool: endpoint({
    id: 'connections.setTool',
    method: 'PATCH',
    path: '/burrows/:burrow/connections/:connectionId/tools/:tool',
    summary:
      'Set one tool’s tier: Allowed, Asks or Off (clears its New mark). Signs `connection.tool_tier_changed`.',
    params: BC.extend({ tool: ToolParam }),
    body: SetConnectionToolBody,
    response: ConnectionToolsResponse,
  }),
  setToolLimits: endpoint({
    id: 'connections.setToolLimits',
    method: 'POST',
    path: '/burrows/:burrow/connections/:connectionId/tools/:tool/limits',
    summary:
      'Set or clear the limits on one tool’s arguments (numbers within a range, or one of some choices); calls outside them are refused.',
    params: BC.extend({ tool: ToolParam }),
    body: SetConnectionToolLimitsBody,
    response: ConnectionToolsResponse,
  }),
  startOAuth: endpoint({
    id: 'connections.startOAuth',
    method: 'POST',
    path: '/burrows/:burrow/connections/oauth/start',
    summary:
      'Start an OAuth sign-in (Home Assistant, MCP authorization, an entry’s own app): returns the consent URL (PKCE S256, a single-use state for 10 minutes). `app_not_configured` when an `app_oauth` entry has no app.',
    params: B,
    body: StartConnectionOAuthBody,
    response: StartConnectionOAuthResponse,
  }),
  finishOAuth: endpoint({
    id: 'connections.finishOAuth',
    method: 'POST',
    path: '/connections/oauth/finish',
    summary:
      'Finish an OAuth sign-in from the redirect the app received (the state must be the caller’s): exchanges the code, checks the connection and answers the return path with `connected=<catalogId>` or `connect_error=<code>`. A secret op.',
    body: FinishConnectionOAuthBody,
    response: FinishConnectionOAuthResponse,
  }),
  startNextcloud: endpoint({
    id: 'connections.startNextcloud',
    method: 'POST',
    path: '/burrows/:burrow/connections/nextcloud/start',
    summary:
      'Start Nextcloud’s Login Flow v2 (CX-11): returns the login link to open and the flow to poll. The address is checked first (`destination_refused`).',
    params: B,
    body: StartNextcloudLoginBody,
    response: StartNextcloudLoginResponse,
  }),
  pollNextcloud: endpoint({
    id: 'connections.pollNextcloud',
    method: 'POST',
    path: '/connections/nextcloud/:flowId/poll',
    summary:
      'Poll a Nextcloud login (the caller’s own flow): pending, connected (the app password became the secret; the connection is checked and its tools read), expired or failed.',
    params: z.object({ flowId: OAuthStateId }),
    response: PollNextcloudLoginResponse,
  }),
  startServiceLogin: endpoint({
    id: 'connections.startServiceLogin',
    method: 'POST',
    path: '/burrows/:burrow/connections/service-login/start',
    summary:
      'Start signing in on the service’s own page (CT-730, Plex’s PIN page): returns the page to open, the flow to poll and a code to show, if any. The address is checked first (`destination_refused`). Feature `connections.service_login`.',
    params: B,
    body: StartServiceLoginBody,
    response: StartServiceLoginResponse,
  }),
  pollServiceLogin: endpoint({
    id: 'connections.pollServiceLogin',
    method: 'POST',
    path: '/connections/service-login/:flowId/poll',
    summary:
      'Poll a service sign-in (the caller’s own flow): pending, connected (the token became the secret, stored as the entry’s token sign-in; the connection is checked and its tools read), expired or failed.',
    params: z.object({ flowId: OAuthStateId }),
    response: PollServiceLoginResponse,
  }),
  probe: endpoint({
    id: 'connections.probe',
    method: 'POST',
    path: '/connections/probe',
    summary:
      'Probe a Custom MCP server’s address (CX-61): does it answer without a sign-in, want OAuth, or a token? The address is checked first (`destination_refused`).',
    body: ProbeConnectionBody,
    response: ProbeConnectionResponse,
  }),
  identify: endpoint({
    id: 'connections.identify',
    method: 'POST',
    path: '/connections/identify',
    summary:
      'What is at an address (CT-314): the address to use, the entry it is and its version, its certificate. Nothing but the probes is sent; the address is checked first (`destination_refused`).',
    body: IdentifyConnectionBody,
    response: IdentifyConnectionResponse,
  }),
  discover: endpoint({
    id: 'connections.discover',
    method: 'POST',
    path: '/burrows/:burrow/connections/discover',
    summary:
      'Look for services on the home network (CT-314): starts a scan (or answers the one running or recent) of this Whombat’s networks, its connections’ networks, the home network list and the networks given, with each entry’s unauthenticated probes; only while the local network is open, otherwise only the home network list.',
    params: B,
    body: DiscoverConnectionsBody,
    response: ConnectionDiscovery,
  }),
  hideFound: endpoint({
    id: 'connections.hideFound',
    method: 'POST',
    path: '/burrows/:burrow/connections/discover/hidden',
    summary:
      'Hide a found service from Found on your network, or show it again (CT-316); a signed burrow event. Answers the running or last scan as `connections.discover` does, without starting one.',
    params: B,
    body: HideFoundServiceBody,
    response: ConnectionDiscovery,
  }),
  allowNetwork: endpoint({
    id: 'connections.allowNetwork',
    method: 'POST',
    path: '/connections/networks',
    summary:
      '“Add this network” (CX-41): adds the network, or the port to the listed network, on the home network list the Vault and Connections share.',
    body: AllowConnectionNetworkBody,
    response: VaultNetworksResponse,
  }),
};

/** Merged into `api.connectors`: the OAuth app of an `app_oauth` entry (CX-14). */
export const connectorAppEndpoints = {
  setApp: endpoint({
    id: 'connectors.setApp',
    method: 'PUT',
    path: '/connectors/apps/:catalogId',
    summary:
      'Save or replace the OAuth app of an `app_oauth` catalog entry (Dropbox); the secret is sealed and never returned (`app_in_config` when it is set in config). A secret op.',
    params: z.object({ catalogId: CatalogIdText }),
    body: SetConnectorAppBody,
    response: ConnectionsCatalogStatus,
  }),
  removeApp: endpoint({
    id: 'connectors.removeApp',
    method: 'DELETE',
    path: '/connectors/apps/:catalogId',
    summary:
      'Remove the OAuth app of an `app_oauth` entry: every connection that signed in with it needs to be connected again.',
    params: z.object({ catalogId: CatalogIdText }),
    response: ConnectionsCatalogStatus,
  }),
};
