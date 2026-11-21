/**
 * Shared types of catalog connections (docs/decisions/connections-catalog.md). `credentials.ts` and `destination.ts`
 * (connect side) and `sync.ts` (tools side) meet here.
 */
import type { CatalogCheckResult } from '@whombat/core';
import type { catalogConnections, connectionTools } from '../db/schema/index';

export type CatalogConnectionRow = typeof catalogConnections.$inferSelect;
export type ConnectionToolRow = typeof connectionTools.$inferSelect;

/** How one outbound call proves who it is: headers (and query parameters for `query` auth), and the credential version. */
export interface ConnectionCredential {
  headers: Record<string, string>;
  query: Record<string, string>;
  /**
   * A token connection's secret as it is (a socket's sign-in fills its templates with it, CM-13); never sent as it is
   * otherwise.
   */
  secret?: string;
  /** `credential_version` (plus the access token's expiry for OAuth kinds): a pooled MCP client reconnects when it changes. */
  version: string;
}

/** The credential was refused or is gone; the connection has been marked `needs_reauth`. */
export class ConnectionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionAuthError';
  }
}

/** What syncing a connection's tools found (CX-18). */
export interface ToolSyncResult {
  count: number;
  checks: CatalogCheckResult[];
}
