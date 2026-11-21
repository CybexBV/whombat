/**
 * An OAuth scope in plain words, for the card and the connection page that ask the person to allow more
 * (“change DNS”, “see tunnels”). Services name scopes `<thing>.<action>` or `<thing>:<action>` (Cloudflare's
 * `dns.write`, `argotunnel.read`, `cache.purge`); what isn't known reads as its own words.
 */

/** Words for the thing a scope is about, where its own name isn't plain. */
const THINGS: Record<string, string> = {
  argotunnel: 'tunnels',
  'teams-connector-cloudflared': 'tunnel connectors',
  'teams-networks': 'private networks',
  teams: 'Zero Trust',
  access: 'Access apps and policies',
  'access-acct': 'Access groups and sign-in methods',
  zone: 'domains',
  'zone-settings': 'domain settings',
  'zone-dns-settings': 'DNS settings',
  page: 'Pages',
  'workers-scripts': 'Workers',
  'workers-tail': 'Workers logs',
  'workers-r2': 'R2 storage',
  'registrar-domains': 'domain registrations',
  memberships: 'account members',
  'account-api-tokens': 'API tokens',
};

/** Short words written in capitals. */
const CAPITALS = new Set(['dns', 'ssl', 'r2', 'd1', 'kv', 'waf', 'api', 'ai', 'ip', 'bgp', 'dex', 'url']);

/** Words for what the scope lets Whombat do. */
const ACTIONS: Record<string, string> = {
  read: 'see',
  metadata_read: 'see',
  content_read: 'see',
  monitoring: 'see',
  report: 'see',
  write: 'change',
  edit: 'change',
  admin: 'manage',
};

function thingWords(thing: string): string {
  const known = THINGS[thing];
  if (known) return known;
  return thing
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (CAPITALS.has(w) ? w.toUpperCase() : w))
    .join(' ');
}

/** One scope in words: `dns.write` → “change DNS”, `cache.purge` → “purge cache”. */
export function scopeWords(scope: string): string {
  const cut = Math.max(scope.lastIndexOf('.'), scope.lastIndexOf(':'));
  if (cut <= 0) return thingWords(scope);
  const thing = thingWords(scope.slice(0, cut));
  const action = scope.slice(cut + 1);
  return `${ACTIONS[action] ?? action.replace(/_/g, ' ')} ${thing}`;
}

/** Several scopes in one line: “change DNS, see tunnels and change tunnels”; at most `max` named, then “and 3 more”. */
export function scopeListWords(scopes: readonly string[], max = 4): string {
  const words = [...new Set(scopes.map(scopeWords))];
  const named = words.slice(0, max);
  const rest = words.length - named.length;
  if (rest > 0) return `${named.join(', ')} and ${rest} more`;
  if (named.length <= 1) return named[0] ?? '';
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}
