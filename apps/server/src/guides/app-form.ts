/**
 * The app setup's form in chat (docs/decisions/assistant-guides.md AG-06 step 5): a Client ID and secret, or the
 * downloaded `client_secret_*.json`, with the Settings panel's checks (CN-03: a Desktop client is refused). Pure;
 * the values are never stored, logged or echoed (AG-03) — refusals name the field, not what was in it.
 */
import { SetGoogleAppBody } from '@whombat/core';
import * as copy from './copy';
import { GuideRefusal } from './flows';

export interface AppFormResult {
  clientId: string;
  clientSecret: string;
  /** False when a dropped JSON doesn't list this Whombat's redirect URI (Google would say redirect_uri_mismatch). */
  redirectListed: boolean;
}

function invalid(field: string, message: string): GuideRefusal {
  return new GuideRefusal('invalid_values', message, { [field]: [message] });
}

/** Reads the form's values; throws `invalid_values` keyed by field id. */
export function parseAppForm(values: Readonly<Record<string, string>>, redirectUri: string): AppFormResult {
  const json = values.clientJson?.trim();
  let clientId = values.clientId?.trim() ?? '';
  let clientSecret = values.clientSecret?.trim() ?? '';
  let redirectListed = true;
  if (json) {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      throw invalid('clientJson', copy.NOT_A_CLIENT_FILE);
    }
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    if (!record) throw invalid('clientJson', copy.NOT_A_CLIENT_FILE);
    if ('installed' in record && !('web' in record)) throw invalid('clientJson', copy.DESKTOP_CLIENT_ERROR);
    const web = record.web as Record<string, unknown> | undefined;
    clientId = typeof web?.client_id === 'string' ? web.client_id.trim() : '';
    clientSecret = typeof web?.client_secret === 'string' ? web.client_secret.trim() : '';
    if (!clientId || !clientSecret) throw invalid('clientJson', copy.NOT_A_CLIENT_FILE);
    const uris = Array.isArray(web?.redirect_uris) ? web.redirect_uris : [];
    redirectListed = uris.includes(redirectUri);
  }
  if (!clientId) throw invalid('clientId', copy.CLIENT_ID_MISSING);
  if (!clientSecret) throw invalid('clientSecret', copy.CLIENT_SECRET_MISSING);
  const parsed = SetGoogleAppBody.safeParse({ clientId, clientSecret, userType: 'external' });
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'clientId');
      // A bad value inside a dropped file is the file's problem.
      const key = json ? 'clientJson' : field;
      fields[key] = [...(fields[key] ?? []), field === 'clientId' ? copy.CLIENT_ID_MISSING : issue.message];
    }
    throw new GuideRefusal('invalid_values', Object.values(fields)[0]?.[0] ?? copy.CLIENT_ID_MISSING, fields);
  }
  return { clientId, clientSecret, redirectListed };
}
