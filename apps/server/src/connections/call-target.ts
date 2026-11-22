/**
 * Where a connection's calls go and as whom, as one fingerprint: its kind, base address, settings, how it signs in, its
 * sealed secrets and the version its credential is at (bumped by every new sign-in, token or address). A person's yes to
 * a call is bound to it, and the call is sent only while the connection the request is made with still has it: a
 * connection given another address, account or token while its card waited asks again instead
 * (docs/decisions/automation-recipes.md, approved-connection-calls.md). A refreshed access token of the same sign-in keeps it.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@whombat/core';
import { VaultCallError } from '../vault/net';
import type { CatalogConnectionRow } from './types';

export type CallTargetRow = Pick<
  CatalogConnectionRow,
  | 'id'
  | 'catalogId'
  | 'baseUrl'
  | 'fields'
  | 'signIn'
  | 'transport'
  | 'auth'
  | 'secretEnc'
  | 'clientSecretEnc'
  | 'clientId'
  | 'issuer'
  | 'resource'
  | 'credentialVersion'
>;

/** The fingerprint of where `row`'s calls go and as whom (64 hex characters). */
export function callTarget(row: CallTargetRow): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        id: row.id,
        catalogId: row.catalogId,
        baseUrl: row.baseUrl,
        fields: row.fields ?? {},
        signIn: row.signIn,
        transport: row.transport,
        auth: row.auth ?? null,
        secretEnc: row.secretEnc ?? null,
        clientSecretEnc: row.clientSecretEnc ?? null,
        clientId: row.clientId ?? null,
        issuer: row.issuer ?? null,
        resource: row.resource ?? null,
        credentialVersion: row.credentialVersion,
      }),
    )
    .digest('hex');
}

/** What is said when a connection changed after a person said yes to a call on it: nothing was sent. */
export function changedSinceYesText(label: string): string {
  return `${label} changed since you said yes (its address, account or sign-in), so nothing was sent.`;
}

/**
 * What Undo says when the connection a change went through now goes elsewhere or as someone else (another Home
 * Assistant, another account): the inverse would land there, so it isn't sent.
 */
export function changedSinceChangeText(label: string): string {
  return `${label} changed since, so this can’t be undone here.`;
}

/**
 * Whether Undo may send a change's inverse through `row`: the change kept where its calls went (`destination`, its
 * `callTarget` when it was made) and they still go there; a change recorded before it kept one is undone as before.
 */
export function undoGoesWhereChangeWent(row: CallTargetRow, destination: unknown): boolean {
  return typeof destination !== 'string' || callTarget(row) === destination;
}

/**
 * What a page's button says when its connection went elsewhere or as someone else between the press and the moment it
 * would have signed (a key, account or address replaced in between): nothing was sent.
 */
export function changedJustNowText(label: string): string {
  return `${label} changed just now (its address, account or sign-in), so nothing was sent. Try again.`;
}

/** What an agent hears when the connection changed in the moment its call started: nothing was sent. */
export function changedWhileAskedText(label: string): string {
  return `${label} changed while this call started (its address, account or sign-in), so nothing was sent. Call it again.`;
}

/**
 * The connection a request was about to be signed with no longer goes where, or as whom, its call was checked on (a
 * token, account or address replaced in between): it is thrown before anything is signed, so nothing was sent.
 */
export class ConnectionChangedError extends VaultCallError {
  /** `connectionId`: the connection that changed, when the call reached more than its own (a TrueNAS through Servers). */
  constructor(readonly connectionId?: string) {
    super('not_allowed', 'The connection changed while the call started, so nothing was sent.');
    this.name = 'ConnectionChangedError';
  }
}

/** Throws `ConnectionChangedError` unless `row` is there and its calls still go to `target` (`callTarget`). */
export function keepTarget(
  row: CallTargetRow | null | undefined,
  target: string,
  connectionId?: string,
): void {
  if (!row || callTarget(row) !== target) throw new ConnectionChangedError(row?.id ?? connectionId);
}
