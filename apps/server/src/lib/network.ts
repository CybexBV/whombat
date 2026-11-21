/**
 * The network of a client address for rate limits (docs/decisions/feedback-reporters.md FR-14): the IPv4 address
 * itself (also when IPv4-mapped in IPv6, `::ffff:a.b.c.d`), or the IPv6 /64 — one household or host usually gets a
 * whole /64, so keying by the full IPv6 address would give it 2^64 buckets. The same rule as control's
 * `networkPrefix` (control `src/lib/network.ts`, CL-31).
 */
import { isIPv4, isIPv6 } from 'node:net';

/** Eight 16-bit groups of an IPv6 address (zone id dropped, embedded IPv4 expanded), or null. */
function ipv6Groups(address: string): number[] | null {
  const ip = address.replace(/%.*$/, '');
  if (!isIPv6(ip)) return null;
  let text = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4?.[1]) {
    const o = v4[1].split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, -v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head = '', tail] = text.split('::') as [string, string | undefined];
  const parse = (s: string) => (s ? s.split(':').map((g) => Number.parseInt(g, 16)) : []);
  const h = parse(head);
  const t = tail === undefined ? [] : parse(tail);
  const groups =
    tail === undefined ? h : [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill(0), ...t];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/**
 * `v4:<a.b.c.d>` for IPv4 (and IPv4-mapped IPv6), `v6:<first four groups>` for the IPv6 /64; anything else (a unix
 * socket, garbage) is keyed as itself under `other:`.
 */
export function networkOf(address: string): string {
  if (isIPv4(address)) return `v4:${address.split('.').map(Number).join('.')}`;
  const g = ipv6Groups(address);
  if (!g) return `other:${address.slice(0, 100)}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [a = 0, b = 0] = g.slice(6);
    return `v4:${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return `v6:${g
    .slice(0, 4)
    .map((x) => x.toString(16).padStart(4, '0'))
    .join(':')}`;
}
