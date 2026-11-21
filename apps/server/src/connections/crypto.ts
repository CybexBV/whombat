/**
 * Catalog connection secrets at rest (docs/decisions/connections-catalog.md CX-10, CX-13, CX-19): sealed with key
 * custody (`KeyCustody.seal`, AES-256-GCM under the master key) with additional authenticated data that binds each value
 * to its row and purpose, so a value copied onto another row or column does not open:
 * - a token or app password: `catalog_connection:<id>:secret`;
 * - OAuth tokens: `catalog_connection:<id>:refresh` / `catalog_connection:<id>:access`;
 * - the client key Whombat made in a Fusebox: `catalog_connection:<id>:client` (ai-gateway.md AIG-02);
 * - a session service's trusted-device token: `catalog_connection:<id>:remembered` (connection-signin.md SG-09);
 * - a registered OAuth client: `connection_client:<id>` (JSON `{clientId, clientSecret?, authMethod}`);
 * - a pending sign-in's state: `connection_pending:<id>` (JSON);
 * - an `app_oauth` entry's client secret: `connector_app:<catalogId>`, sealed by the Google app's own helpers
 *   (`connectors/crypto.ts` `sealAppSecret`), since both live in `connector_apps`.
 */
import type { KeyCustody } from '../keys/custody';

/**
 * `client`: the client key Whombat made in a Fusebox (docs/decisions/ai-gateway.md AIG-02); `remembered`: the token a
 * session's service gave to skip its two-step code (connection-signin.md SG-09).
 */
export type ConnectionSecretKind = 'secret' | 'refresh' | 'access' | 'client' | 'remembered';

export function connectionSecretAad(connectionId: string, kind: ConnectionSecretKind): string {
  return `catalog_connection:${connectionId}:${kind}`;
}

export function sealConnectionSecret(
  custody: KeyCustody,
  connectionId: string,
  kind: ConnectionSecretKind,
  value: string,
): string {
  return custody.seal(connectionSecretAad(connectionId, kind), value);
}

export function openConnectionSecret(
  custody: KeyCustody,
  connectionId: string,
  kind: ConnectionSecretKind,
  stored: string,
): string {
  return custody.open(connectionSecretAad(connectionId, kind), stored);
}

export function sealJson(custody: KeyCustody, aad: string, value: unknown): string {
  return custody.seal(aad, JSON.stringify(value));
}

export function openJson<T>(custody: KeyCustody, aad: string, stored: string): T {
  return JSON.parse(custody.open(aad, stored)) as T;
}

export const clientAad = (id: string) => `connection_client:${id}`;
export const pendingAad = (id: string) => `connection_pending:${id}`;
