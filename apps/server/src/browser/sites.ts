/**
 * Sites (docs/decisions/browser.md): a site is a registrable domain from the public suffix list with its
 * private section (`tldts`, so `alice.github.io` and `bob.github.io` are two sites, as in browsers), else the IP
 * literal, else the bare host name (`localhost`, `homeassistant.local`). A Vault login's site, the websites a Feedback
 * assessment may open and the logins a turn carries are all worked out with this function.
 */
import { getDomain } from 'tldts';

/** The site of a URL or a host name, lowercase; null when it has no host. */
export function siteOf(urlOrHost: string): string | null {
  let host = urlOrHost.trim();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!host) return null;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}
