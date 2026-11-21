/**
 * Signing in on the service's own page (docs/decisions/connection-signin.md SG-01…SG-05): one adapter per catalog id
 * starts the service's sign-in (Plex's PIN), and polls it until the service gives Whombat a token. The rest is generic
 * (`index.ts`): the address checked first, the flow kept sealed in `connection_pending`, the token checked as the entry's
 * token sign-in and stored as that token.
 */
import type { CatalogEntry } from '@whombat/core';
import type { OutboundInit, OutboundResponse } from '../../lib/outbound';
import type { CheckOutcome } from '../checks';

/** What an adapter works with: the connection's entry and address, and requests under the destination policy. */
export interface ServiceLoginContext {
  entry: CatalogEntry;
  /** The connection's base URL, from its fields (the server the token will be checked against). */
  baseUrl: string;
  fields: Readonly<Record<string, string>>;
  /** What Whombat is called in the service (`Whombat`, as sign in once names what it makes, CS-06). */
  name: string;
  /** This Whombat's stable id in the burrow (`provisionClientId`, CM-06): one device in the account, not one per try. */
  clientId: string;
  /**
   * One request under the connection destination policy (a sign-in service is public https like any other), unsigned,
   * no redirects followed. Throws `OutboundError`.
   */
  fetch(url: string, init: OutboundInit): Promise<OutboundResponse>;
}

/** A started sign-in: the page to open, a code to show (device-code services), and what the poll needs (sealed). */
export interface ServiceLoginStarted {
  loginUrl: string;
  /** A code the person types on that page; null for Plex. */
  userCode: string | null;
  /** How long the service keeps it (the flow lives at most `SERVICE_LOGIN_MAX_MS`). */
  ttlMs: number;
  pollEveryMs: number;
  /** The adapter's own state for the poll (JSON; sealed with the flow, never shown). */
  state: Record<string, unknown>;
}

/** One poll's answer: still waiting, gone, refused (in the person's words), or the token. */
export type ServiceLoginPolled =
  | { state: 'pending' }
  | { state: 'expired' }
  | { state: 'failed'; message: string }
  | {
      state: 'token';
      /** The secret of the entry's token sign-in (`tokenMethod`), as if the person had pasted it. */
      secret: string;
      /** Who the service says the account is, for the connection's row. */
      externalName?: string | null;
      /** Fields the token fills, as sign in once's. */
      fields?: Record<string, string>;
    };

export interface ServiceLoginAdapter {
  /** The origins it signs in at besides the connection's own address (plex.tv), checked first like the address. */
  origins: readonly string[];
  start(ctx: ServiceLoginContext): Promise<ServiceLoginStarted>;
  poll(ctx: ServiceLoginContext, state: Record<string, unknown>): Promise<ServiceLoginPolled>;
  /** The person's words when the token arrived but the entry's check with it failed; null: the check's own. */
  checkFailedText?(entry: CatalogEntry, outcome: CheckOutcome): string | null;
}

/** A start the service refused or answered oddly, in the person's words (never the service's text). */
export class ServiceLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceLoginError';
  }
}
