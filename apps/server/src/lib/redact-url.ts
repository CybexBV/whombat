/**
 * Credentials out of URLs (security-fixes.md): the pure half of `redact.ts`, without Fastify, so the
 * `whombat` CLI's support bundle (docs/decisions/bp-distribution.md) redacts log lines with the same rule.
 */
/**
 * Query parameters whose values are credentials. `invite`: a join link (`/login?invite=inv_…`) signs a new
 * account in where the server sends no email (docs/decisions/auth-selfhost.md AS-07, AH-07).
 */
export const SECRET_PARAM =
  /^(token|access_token|code|state|secret|password|signature|sig|key|api_key|invite|invite_token|inviteToken)$/i;
export const REDACTED = '[redacted]';

/** `/ws?burrow=hq&token=ws_…` → `/ws?burrow=hq&token=%5Bredacted%5D`. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const name of new Set(params.keys())) {
    if (!SECRET_PARAM.test(name)) continue;
    params.set(name, REDACTED);
    changed = true;
  }
  return changed ? `${url.slice(0, q)}?${params.toString()}` : url;
}
