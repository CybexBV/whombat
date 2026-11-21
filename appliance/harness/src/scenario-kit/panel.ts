/**
 * Control's admin dashboard as a browser uses it (whombat-cloud CL-196, CL-200; IN-72): pages and form posts to the
 * dashboard's listener from a chosen loopback address (inside or outside its allowlist), with the cookies a browser
 * would keep (`wb_pre` before sign-in, `wb_op` after) and the page's own origin on every post.
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

export interface PanelResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  setCookie: string[];
}

export interface PanelRequest {
  method?: string;
  /** A form's fields (`application/x-www-form-urlencoded`). */
  form?: Record<string, string>;
  /** The cookies the browser holds. */
  cookies?: Record<string, string>;
  /** Send the dashboard's own origin (default: on every post, as a browser does from its page). */
  origin?: boolean;
  /** The client address control sees (TRUST_PROXY_HOPS=0 in a local environment). */
  localAddress?: string;
}

export function panelRequest(base: string, path: string, r: PanelRequest = {}): Promise<PanelResponse> {
  const method = r.method ?? (r.form ? 'POST' : 'GET');
  const body = r.form ? new URLSearchParams(r.form).toString() : undefined;
  const cookie = Object.entries(r.cookies ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const headers: Record<string, string> = {
    accept: 'text/html',
    ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    ...(cookie ? { cookie } : {}),
    ...((r.origin ?? method !== 'GET') ? { origin: new URL(base).origin } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${path}`,
      { method, headers, timeout: 15_000, ...(r.localAddress ? { localAddress: r.localAddress } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            setCookie: res.headers['set-cookie'] ?? [],
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The cookies a response sets, by name, each with its attributes in lower case. */
export function cookiesOf(setCookie: string[]): Record<string, { value: string; attributes: string[] }> {
  const out: Record<string, { value: string; attributes: string[] }> = {};
  for (const c of setCookie) {
    const [pair, ...attributes] = c.split(';').map((x) => x.trim());
    const eq = (pair ?? '').indexOf('=');
    if (eq > 0)
      out[(pair ?? '').slice(0, eq)] = {
        value: (pair ?? '').slice(eq + 1),
        attributes: attributes.map((a) => a.toLowerCase()),
      };
  }
  return out;
}

/** The token a page's forms send back (`<meta name="csrf">`). */
export function csrfOf(html: string): string {
  return /<meta name="csrf" content="([^"]+)">/.exec(html)?.[1] ?? '';
}

/** A page's heading, for notes and assertions that don't hang on its wording. */
export function headingOf(html: string): string {
  return (/<h1>([^<]*)/.exec(html)?.[1] ?? '').trim();
}
