/**
 * A session's cookies for sign in once (docs/decisions/connections-setup.md CS-02): what a service sets on its
 * answers (`set-cookie`, an array of raw lines), sent back as one `Cookie` header. It lives only for one provisioner's
 * call; nothing is stored. Domain and path are ignored: every request of a provisioner goes to one origin.
 */
import type { ProvisionResponse } from './types';

export interface SetCookie {
  name: string;
  value: string;
  /** `Max-Age` of zero or less, or `Expires` in the past: the service removes the cookie. */
  expired: boolean;
}

/** One `Set-Cookie` line (`NAME=value; Path=/; HttpOnly …`), or null when it has no name. */
export function parseSetCookie(line: string, now: Date = new Date()): SetCookie | null {
  const [pair = '', ...attributes] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  if (!name) return null;
  let value = pair.slice(eq + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  let expired = false;
  for (const attribute of attributes) {
    const at = attribute.indexOf('=');
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const given = at < 0 ? '' : attribute.slice(at + 1).trim();
    if (key === 'max-age') {
      const seconds = Number(given);
      if (Number.isFinite(seconds) && seconds <= 0) expired = true;
    } else if (key === 'expires') {
      const when = Date.parse(given);
      if (Number.isFinite(when) && when <= now.getTime()) expired = true;
    }
  }
  return { name, value, expired };
}

/** The `set-cookie` lines of an answer (one string or several). */
export function setCookieLines(headers: ProvisionResponse['headers']): string[] {
  const raw = headers['set-cookie'] ?? headers['Set-Cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Keeps what an answer sets; an expired or emptied cookie is dropped. */
  take(response: Pick<ProvisionResponse, 'headers'>): void {
    for (const line of setCookieLines(response.headers)) {
      const cookie = parseSetCookie(line, this.now());
      if (!cookie) continue;
      if (cookie.expired || cookie.value === '') this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  get size(): number {
    return this.cookies.size;
  }

  /** The `Cookie` header's value, or null without cookies. */
  header(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** `headers` with this jar's `Cookie` added (when it holds any). */
  with(headers: Record<string, string> = {}): Record<string, string> {
    const cookie = this.header();
    return cookie ? { ...headers, Cookie: cookie } : headers;
  }

  clear(): void {
    this.cookies.clear();
  }
}
