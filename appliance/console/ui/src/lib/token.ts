/**
 * The per-start API token (CG-03): the kiosk opens `http://127.0.0.1:<port>/#t=<token>` and the page sends it as
 * `Authorization: Bearer <token>`. The token is taken as written (percent-decoded, no `+` → space), and only when
 * it is 8–256 visible ASCII characters, so it is always a valid header value.
 */
export function tokenFromHash(hash: string): string | null {
  for (const part of hash.replace(/^#/, '').split('&')) {
    if (!part.startsWith('t=')) continue;
    let t: string;
    try {
      t = decodeURIComponent(part.slice(2));
    } catch {
      return null;
    }
    return /^[\x21-\x7e]{8,256}$/.test(t) ? t : null;
  }
  return null;
}

export function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
