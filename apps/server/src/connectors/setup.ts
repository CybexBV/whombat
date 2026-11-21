/**
 * What the guided Google setup shows and copies (docs/decisions/connectors.md CN-03): the redirect URI, the
 * enable-APIs link, the console links, every scope and the consent screen's values. The redirect goes to the hosted
 * UI's `/connect/google` and the authorized domain is the app origin's (AG-14).
 */
import {
  CONNECTOR_SERVICES,
  GOOGLE_APP_NAME,
  GOOGLE_CONSOLE_LINKS,
  type GoogleSetupFacts,
  googleEnableApisUrl,
  googleScopesFor,
  managedGoogleRedirectUri,
} from '@whombat/core';
import { type Config, managedAppOrigin } from '../config';

/** Second-level labels under which registries sell names (`example.co.uk`), for the authorized domain. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

/**
 * The consent screen's authorized domain for a host: Google wants the registrable (“top private”) domain,
 * so `dev.whombat.com` → `whombat.com` and `app.example.co.uk` → `example.co.uk`. IPs and single-label
 * hosts (`localhost`) are returned as they are (Google needs no authorized domain for them).
 */
export function authorizedDomainOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':')) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const [sld, tld] = labels.slice(-2) as [string, string];
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

type SetupConfig = Pick<Config, 'WHOMBAT_APP_URL'>;

/**
 * The authorized redirect URI of this Whombat's Google client: the hosted UI's `{WHOMBAT_APP_URL}/connect/google`
 * (the app hands the code over the session, AG-14).
 */
export function googleRedirectUriFor(config: SetupConfig): string {
  return managedGoogleRedirectUri(managedAppOrigin(config));
}

/** The setup facts for this Whombat; `supportEmail` is the person's own address. */
export function googleSetupFacts(config: SetupConfig, supportEmail: string | null): GoogleSetupFacts {
  const origin = managedAppOrigin(config);
  return {
    redirectUri: googleRedirectUriFor(config),
    enableApisUrl: googleEnableApisUrl(),
    links: {
      createProject: GOOGLE_CONSOLE_LINKS.createProject,
      consentScreen: GOOGLE_CONSOLE_LINKS.consentScreen,
      audience: GOOGLE_CONSOLE_LINKS.audience,
      createClient: GOOGLE_CONSOLE_LINKS.createClient,
    },
    scopes: googleScopesFor(CONNECTOR_SERVICES),
    appName: GOOGLE_APP_NAME,
    supportEmail,
    authorizedDomain: authorizedDomainOf(new URL(origin).hostname),
  };
}
