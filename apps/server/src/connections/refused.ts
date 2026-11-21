/**
 * A call's credential was refused (HTTP 401 from the service, tools side, `call.ts`): the entry's check with the stored
 * credential decides, so one path a token may not use doesn't take the connection down. A refused check marks it
 * `needs_reauth` (`token_invalid`, or `revoked` for OAuth) and tells whoever can fix it once a day (CX-15, CX-D10).
 * Kept apart from `connect.ts` (the REST side) so the tools side's call path doesn't load the routes.
 */
import { catalogEntry, resolveMcpUrl, type SignInKind } from '@whombat/core';
import type { Services } from '../services';
import { type CheckOutcome, runCatalogCheck } from './checks';
import { markNeedsReauth } from './commands';
import { credentialFor } from './credentials';
import { connectionRow } from './store';
import { ConnectionAuthError } from './types';

/** True when the connection was marked `needs_reauth`. */
export async function confirmRefusedCredential(services: Services, connectionId: string): Promise<boolean> {
  const row = await connectionRow(services.db, connectionId);
  if (!row || row.status === 'needs_reauth' || row.signIn === 'none') return false;
  const entry = catalogEntry(row.catalogId);
  if (!entry || entry.transport === 'builtin') return false;
  const kind = row.signIn as SignInKind;
  const oauth = kind === 'ha_oauth' || kind === 'mcp_oauth' || kind === 'app_oauth';
  let outcome: CheckOutcome;
  try {
    const { headers, query, secret } = await credentialFor(services, row);
    outcome = await runCatalogCheck(services, {
      entry,
      signIn: kind,
      baseUrl: row.baseUrl,
      mcpUrl: resolveMcpUrl(entry, row.fields, kind),
      fields: row.fields,
      credential: { headers, query, ...(secret ? { secret } : {}) },
    });
  } catch (err) {
    // A refresh that found the grant dead has marked it already.
    if (err instanceof ConnectionAuthError) return false;
    throw err;
  }
  if (!outcome.refused) return false;
  return markNeedsReauth(services, row, oauth ? 'revoked' : 'token_invalid', {
    message: outcome.message,
    ...(oauth ? { refreshTokenEnc: row.refreshTokenEnc } : {}),
  });
}
