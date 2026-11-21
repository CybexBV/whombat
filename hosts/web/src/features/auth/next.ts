// Where to go after signing in: the `next` query parameter when it is a
// same-origin path (never another origin, never the auth pages), else "/".

const AUTH_PAGES = ['/login', '/setup'];

export function safeNext(next: string | null | undefined, origin: string = typeof location !== 'undefined' ? location.origin : 'http://localhost'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  let u: URL;
  try {
    u = new URL(next, origin);
  } catch {
    return '/';
  }
  if (u.origin !== origin) return '/';
  if (AUTH_PAGES.some((p) => u.pathname === p || u.pathname.startsWith(`${p}/`))) return '/';
  return `${u.pathname}${u.search}${u.hash}`;
}
