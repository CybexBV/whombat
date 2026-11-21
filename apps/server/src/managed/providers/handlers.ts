/**
 * Session handlers of the provider sign-in ops (contracts 0.5.0 CT-26 `providers.*`). The dispatcher parses each input
 * with the op's spec first; every handler acts for the session's own account, the person's (one-person.md OP-S09).
 */
import type { SessionOpContext } from '../dispatcher';
import { providerLogins } from './service';

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type Handler = (c: Pick<SessionOpContext, 'services' | 'principal'>, input: any) => Promise<unknown>;

export const PROVIDER_SESSION_HANDLERS: Readonly<Record<string, Handler>> = {
  'providers.list': (c) => providerLogins(c.services).list(c.principal),
  'providers.login.start': (c, i) => providerLogins(c.services).start(c.principal, i),
  'providers.login.submit': (c, i) => providerLogins(c.services).submit(c.principal, i),
  'providers.login.status': async (c, i) => providerLogins(c.services).status(c.principal, i),
  'providers.login.cancel': async (c, i) => providerLogins(c.services).cancel(c.principal, i),
  'providers.logout': (c, i) => providerLogins(c.services).logout(c.principal, i),
};
