/**
 * Copy and small logic for Settings → Connections and the Connect Google callout
 * (docs/decisions/connectors.md CN-03…CN-06; not in the mocks, B-05).
 */

/**
 * The accounts' words (REAUTH_TEXT, CONNECT_ERROR_TEXT, connectErrorText, checkText, serviceList) are shared with the
 * phone's account screens (`@whombat/client/connections`, phone-connect.md PC-02, AP-2909); re-exported here.
 */
export {
  CONNECT_ERROR_TEXT,
  checkText,
  connectErrorText,
  REAUTH_TEXT,
  serviceList,
} from '@whombat/client/connections';

/* The downloaded client_secret JSON (CN-03 step 5) ---------------------------------------------- */

export type ClientSecretFile =
  | { ok: true; clientId: string; clientSecret: string; redirectUris: string[] }
  | { ok: false; error: string };

export const DESKTOP_CLIENT_ERROR = 'This is a Desktop app client. Create one of type Web application.';
const NOT_A_CLIENT_FILE = 'That isn’t the client_secret JSON file Google lets you download.';

/**
 * Reads Google's `client_secret_*.json` in the browser (it never goes anywhere else): a Web application
 * client has a `web` key; a Desktop client has `installed` and doesn't work with a redirect URI.
 */
export function parseClientSecretFile(text: string): ClientSecretFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: NOT_A_CLIENT_FILE };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: NOT_A_CLIENT_FILE };
  const record = data as Record<string, unknown>;
  if ('installed' in record && !('web' in record)) return { ok: false, error: DESKTOP_CLIENT_ERROR };
  const web = record.web as Record<string, unknown> | undefined;
  const clientId = typeof web?.client_id === 'string' ? web.client_id.trim() : '';
  const clientSecret = typeof web?.client_secret === 'string' ? web.client_secret.trim() : '';
  if (!clientId || !clientSecret) return { ok: false, error: NOT_A_CLIENT_FILE };
  const redirectUris = Array.isArray(web?.redirect_uris)
    ? web.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];
  return { ok: true, clientId, clientSecret, redirectUris };
}

/** The warning when the file's client does not list this Whombat's redirect URI (Google would refuse). */
export function redirectMismatchText(redirectUri: string): string {
  return `This client doesn’t list ${redirectUri} as an authorized redirect URI. Add it in Google Cloud (step 4), or Google will answer redirect_uri_mismatch.`;
}
