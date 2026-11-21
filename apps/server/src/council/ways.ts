/**
 * Where a council's builder reaches the box to send its pictures (docs/decisions/council.md CNL-31): the box's own ways
 * in (its addresses on the local network, its Tailscale name, the development box's loopback page), best first for the
 * computer T3 Code runs on — an address on that computer's own network first. Set by the managed boot; none elsewhere.
 */
import { isIP } from 'node:net';

type Ways = () => readonly { way: string; web: string }[];

const registry = new WeakMap<object, Ways>();

export function setCouncilWays(owner: object, ways: Ways): void {
  registry.set(owner, ways);
}

/** The first three octets of an IPv4 address, or null. */
function net24(host: string): string | null {
  return isIP(host) === 4 ? host.split('.').slice(0, 3).join('.') : null;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
};

/**
 * The box's page addresses (`http://10.0.0.5:4480`) for the builder, best first: an IPv4 address in the same /24 as T3
 * Code's computer, then the Tailscale name when the computer is on the tailnet, then the rest. At most three.
 */
export function councilWays(owner: object, t3Address: string): string[] {
  const routes = registry.get(owner)?.() ?? [];
  const t3 = hostOf(t3Address) ?? '';
  const near = net24(t3);
  const onTailnet = /\.ts\.net$/i.test(t3) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(t3);
  const rank = (r: { way: string; web: string }) => {
    const host = hostOf(r.web) ?? '';
    if (near && net24(host) === near) return 0;
    if (r.way === 'tailscale' && onTailnet) return 1;
    return 2;
  };
  return [...routes]
    .sort((a, b) => rank(a) - rank(b))
    .map((r) => r.web.replace(/\/+$/, ''))
    .filter((v, i, all) => all.indexOf(v) === i)
    .slice(0, 3);
}
