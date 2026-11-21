/**
 * Sign in once (docs/decisions/connections-setup.md CS-01…CS-09, contracts CT-314): a provisioner signs in to the
 * service with the person's account and password (and a second factor's code), makes Whombat's own key at the level
 * asked, cleans up its session, and answers the key as one of the entry's token sign-ins. The password lives only in
 * this call: never logged, never stored, never put in an error.
 */
import type { CatalogEntry, ConnectionAccessLevel } from '@whombat/core';

/** One request to the service: a path under the connection's base URL, or a full URL on the same origin. */
export interface ProvisionRequest {
  method: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/** The service's answer, whole (capped at 1 MiB): status, raw headers (`set-cookie` as an array), body. */
export interface ProvisionResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text(): string;
  /** The body as JSON, or null. */
  json(): unknown;
}

/**
 * Requests under the connection destination policy for the base URL, the pinned certificate (the entry's
 * `fingerprint` field) included; unsigned (nothing of Whombat's is added but `User-Agent: Whombat`). Redirects are
 * answered, not followed. Throws `OutboundError` (unreachable, refused, certificate).
 */
export type ProvisionFetch = (pathOrUrl: string, init: ProvisionRequest) => Promise<ProvisionResponse>;

/** A WebSocket to the service (Home Assistant), under the same policy: send JSON, wait for the next JSON message. */
export interface ProvisionSocket {
  send(message: unknown): void;
  /** The next message (parsed JSON); rejects after `timeoutMs` (default 10 s) or when the socket closes. */
  next(timeoutMs?: number): Promise<unknown>;
  close(): void;
}

export interface ProvisionInput {
  entry: CatalogEntry;
  /** The connection's base URL, from its fields (no trailing slash). */
  baseUrl: string;
  /** The form's fields (the address, a pinned fingerprint). */
  fields: Readonly<Record<string, string>>;
  account: string;
  password: string;
  /** A second factor's code, when the person gave one. */
  code: string | null;
  /**
   * The challenge the service made when it asked for that code (UniFi's `UBIC_2FA`, connection-signin.md SG-06), as the
   * provisioner handed it back with `second_factor_needed`; null when there is none, or it didn't open, belongs to
   * another entry, address or account, or expired (the sign-in then starts fresh).
   */
  challenge: string | null;
  access: ConnectionAccessLevel;
  /**
   * The name of what Whombat makes: `Whombat`, or `Whombat (<this Whombat's name>)` when it has one. Services with
   * stricter names (Proxmox token ids, Forgejo token names) derive theirs from it (`whombat`, `whombat-2`).
   */
  name: string;
  /** This Whombat's own address (Home Assistant's `client_id` and `redirect_uri`). */
  publicUrl: string;
  /**
   * A stable id for this Whombat in the burrow the connection is made from, for services that list their clients by
   * one (Plex's `X-Plex-Client-Identifier`, docs/decisions/connections-more.md CM-06). Not secret, not guessable.
   */
  clientId: string;
  fetch: ProvisionFetch;
  /** Opens a WebSocket at a path under the base URL (`/api/websocket`). */
  socket(path: string): Promise<ProvisionSocket>;
  clock: () => Date;
}

/** What sign in once made: the entry's token sign-in's fields and secret, as if the person had pasted them. */
export interface Provisioned {
  /** Fields the key fills (Proxmox's `tokenId`, OPNsense's `apiKey`, Nextcloud's `username`). */
  fields: Record<string, string>;
  secret: string;
  /** The service itself limits the key to the level asked (else only Whombat does). */
  limited: boolean;
  /** Who the service says the account is, for the connection's row (“root@pam”, “mara@example.com”). */
  externalName?: string | null;
  /** A line the person should read after connecting (“The token has your account’s own rights …”), or null. */
  note?: string | null;
  /**
   * When the key itself ends, where the service gives it one Whombat can't renew (T3 Code's sign-in, 30 days,
   * docs/decisions/t3code.md T3-05); null or absent: it lasts until someone removes it.
   */
  expiresAt?: Date | null;
}

/** Why sign in once stopped (CT-314's `second_factor_needed` and `sign_in_refused` reasons). */
export type SignInRefusal =
  | 'password'
  | 'code'
  | 'rights'
  | 'locked'
  | 'single_sign_on'
  | 'unsupported'
  | 'second_factor';

/**
 * A sign-in that didn't make a key, in the person's words (never the service's text, never the password):
 * `second_factor_needed` (send the code), or `sign_in_refused` with its reason. `method` names the entry's sign-in kind
 * to use instead (`second_factor` on Nextcloud: its login flow).
 */
export class ProvisionError extends Error {
  constructor(
    readonly code: 'second_factor_needed' | 'sign_in_refused',
    message: string,
    readonly reason: SignInRefusal | null = null,
    readonly method: string | null = null,
    /**
     * The challenge the code belongs to (SG-06: UniFi's `UBIC_2FA`), with `second_factor_needed` or a `code` refusal
     * that made a new one. The server seals it for the form to send back with the code; never the password.
     */
    readonly challenge: string | null = null,
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

export const needSecondFactor = (message: string, challenge: string | null = null) =>
  new ProvisionError('second_factor_needed', message, null, null, challenge);
export const refuseSignIn = (
  reason: SignInRefusal,
  message: string,
  method: string | null = null,
  challenge: string | null = null,
) => new ProvisionError('sign_in_refused', message, reason, method, challenge);

export type Provisioner = (input: ProvisionInput) => Promise<Provisioned>;
