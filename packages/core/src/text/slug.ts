/** Production domain for burrows (DECISIONS D-07: `{slug}.whombat.com`; the mocks show whombat.app). */
export const BURROW_DOMAIN = 'whombat.com';

/** Slugs that cannot name a burrow (they collide with hosts or app routes). */
export const RESERVED_SLUGS: readonly string[] = [
  'www',
  'api',
  'app',
  'admin',
  'auth',
  'login',
  'logout',
  'onboarding',
  'mail',
  'static',
  'assets',
  'status',
  'help',
  'support',
  'docs',
  'staging',
  'mobile',
  'brand',
  'ws',
  'mcp',
  'collab',
  'internal',
  'webhooks',
  'slug-check',
  'burrows',
  'devices',
  'push',
  'me',
];

/** Drops combining marks after NFKD decomposition (`Café` → `Cafe`). Safe where `normalize` is missing. */
function foldAccents(text: string): string {
  const decomposed = typeof text.normalize === 'function' ? text.normalize('NFKD') : text;
  let out = '';
  for (const ch of decomposed) {
    const code = ch.codePointAt(0) ?? 0;
    // U+0300–U+036F: combining diacritical marks.
    if (code < 0x300 || code > 0x36f) out += ch;
  }
  return out;
}

/**
 * Slug of a burrow name, same rule as the mock's URL preview
 * (`Burrow HQ` → `burrow-hq`): lowercase, runs of anything but a–z/0–9 become `-`, trim dashes,
 * empty → `burrow`. Accents are folded first (`Café` → `cafe`) and the result fits a DNS label.
 */
export function slugify(name: string, fallback = 'burrow'): string {
  const slug = foldAccents(String(name ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** The public origin of the live deployment (`PUBLIC_URL` in production). */
export const DEFAULT_PUBLIC_URL = 'https://app.whombat.com';

/**
 * Where a burrow lives: `app.whombat.com/burrow-hq` — the host of the public origin and the burrow's path
 * (burrows are path-based, DECISIONS A-09). The URL preview in onboarding step 1, the invite email and the
 * log's “where” for burrow-wide events. `origin` is `PUBLIC_URL` on the server, the page's origin in the web
 * app (they are the same: one origin serves everything).
 */
export function burrowAddress(slug: string, origin: string = DEFAULT_PUBLIC_URL): string {
  return `${originHost(origin)}/${slug}`;
}

/** `https://app.whombat.com:443/x` → `app.whombat.com`, `http://localhost:5180` → `localhost:5180`. */
export function originHost(origin: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(origin.trim());
  if (!m) return origin.trim().replace(/[/?#].*$/, '');
  const scheme = (m[1] as string).toLowerCase();
  const host = (m[2] as string).replace(/^[^@]*@/, '').toLowerCase();
  if (scheme === 'https' && host.endsWith(':443')) return host.slice(0, -4);
  if (scheme === 'http' && host.endsWith(':80')) return host.slice(0, -3);
  return host;
}

/**
 * Commit author email of an agent's workspace: `banjo@agents.burrow-hq.whombat.com`. The runner sets it on
 * the worktree; the GitHub mirror maps commits (and pushes) carrying it back to the agent.
 */
export function agentCommitEmail(handle: string, burrowSlug: string, domain = BURROW_DOMAIN): string {
  return `${handle}@agents.${burrowSlug}.${domain}`;
}

/** The agent handle and burrow slug in an `agentCommitEmail`, or null for any other address. */
export function parseAgentCommitEmail(
  email: string,
  domain = BURROW_DOMAIN,
): { handle: string; burrowSlug: string } | null {
  const suffix = `.${domain}`;
  const lower = email.trim().toLowerCase();
  if (!lower.endsWith(suffix)) return null;
  const m = /^([a-z0-9][a-z0-9-]*)@agents\.([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/.exec(
    lower.slice(0, -suffix.length),
  );
  return m ? { handle: m[1] as string, burrowSlug: m[2] as string } : null;
}

/** True for a usable burrow slug: DNS label, not reserved. */
export function isValidBurrowSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.includes(slug);
}

/** Handle from a display name: `Mara Okafor` → `mara-okafor`, `Banjo` → `banjo`. */
export function handleFrom(name: string): string {
  return slugify(name, 'someone').slice(0, 32).replace(/-+$/g, '');
}
