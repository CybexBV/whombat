/**
 * libpq's unix-socket database URL, `postgresql://user@/db?host=/run/postgresql` (how the managed appliance names its
 * PostgreSQL, appliance NX-18), for postgres.js (MR-75). postgres.js parses URLs with WHATWG `URL`, which
 * refuses an empty host after `user@`, and it would send `host` to the server as a startup parameter. Such a URL
 * becomes the same URL with host `localhost` and without `host`, plus postgres.js's `host` option: the socket
 * directory (it then connects to `<dir>/.s.PGSQL.<port>`). Any other URL is passed through unchanged.
 */
export function postgresConnection(url: string): { url: string; host?: string } {
  const m = /^(postgres(?:ql)?:\/\/(?:[^@/?#]*@)?)(\/[^?#]*)(?:\?([^#]*))?$/.exec(url);
  if (!m) return { url };
  const params = new URLSearchParams(m[3] ?? '');
  const host = params.get('host');
  if (!host?.startsWith('/')) return { url };
  params.delete('host');
  const query = params.toString();
  return { url: `${m[1]}localhost${m[2]}${query ? `?${query}` : ''}`, host };
}

/** Whether `url` names a database the server can reach: a URL, or libpq's unix-socket form. */
export function isDatabaseUrl(url: string): boolean {
  try {
    new URL(postgresConnection(url).url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The same server, role and options with another database: the URL's path replaced (libpq's unix-socket form too, whose
 * host is a `host=` option). A backup opened for reading is a database next to Whombat's own (backup-look.md).
 */
export function withDatabase(url: string, name: string): string {
  const m = /^(postgres(?:ql)?:\/\/[^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/.exec(url);
  if (!m) throw new Error('not a database URL');
  return `${m[1]}/${encodeURIComponent(name)}${m[3] ?? ''}`;
}
