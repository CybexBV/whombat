/**
 * Connector secrets at rest (docs/decisions/connectors.md CN-02, CN-05): the provider app's client secret and
 * each connection's refresh and access tokens are sealed with AES-256-GCM under `WHOMBAT_MASTER_KEY`, in key
 * custody's `v1:` format (`KeyCustody.seal`). The additional authenticated data binds each ciphertext to its
 * row and purpose, so a value copied onto another row, or from the refresh to the access column, does not
 * decrypt:
 * - app secret: `connector_app:<provider>` (`connector_app:google`), also for a catalog `app_oauth` entry's app, whose
 *   provider is its catalog id; stored secrets stop opening if this label ever changes;
 * - tokens: `connection:<connection id>:refresh` and `connection:<connection id>:access`;
 * - an Email (IMAP) account's password: `connection:<connection id>:password` (in the refresh column, so an older
 *   binary that reads the row as an OAuth one can't open it, connections-more-mail.md).
 */
import type { KeyCustody } from '../keys/custody';

export type ConnectionTokenKind = 'refresh' | 'access' | 'password';

/** `provider` is `connector_apps.provider`: a connector provider (`google`) or an `app_oauth` catalog entry's id. */
export function appSecretAad(provider: string): string {
  return `connector_app:${provider}`;
}

export function connectionTokenAad(connectionId: string, kind: ConnectionTokenKind): string {
  return `connection:${connectionId}:${kind}`;
}

export function sealAppSecret(custody: KeyCustody, provider: string, secret: string): string {
  return custody.seal(appSecretAad(provider), secret);
}

export function openAppSecret(custody: KeyCustody, provider: string, stored: string): string {
  return custody.open(appSecretAad(provider), stored);
}

export function sealConnectionToken(
  custody: KeyCustody,
  connectionId: string,
  kind: ConnectionTokenKind,
  token: string,
): string {
  return custody.seal(connectionTokenAad(connectionId, kind), token);
}

export function openConnectionToken(
  custody: KeyCustody,
  connectionId: string,
  kind: ConnectionTokenKind,
  stored: string,
): string {
  return custody.open(connectionTokenAad(connectionId, kind), stored);
}
