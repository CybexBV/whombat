/**
 * Provider sign-ins as REST (contracts 0.9.0 `api.signins`, CT-70): the same capability as the session-native
 * `providers.*` ops, backed by the one sign-in service (`service.ts`), on a self-hosted server and on a managed
 * appliance alike. Over a session each endpoint is an `api` op of the same name (CT-06); the native names stay
 * served by `handlers.ts` from the same service (`PROVIDER_OP_EQUIVALENTS`).
 *
 * Every endpoint acts for the person (one-person.md OP-S09: their sign-ins are the only ones). Secrets (keys, device
 * codes, what they type into the sign-in console and what it echoes) are never logged: those routes log at `warn` only, so no request
 * line is written, and nothing here logs a body or an answer (CT-44, CT-70).
 */
import { api } from '@whombat/core';
import type { RequestAuth } from '../../auth/request';
import { unauthorized } from '../../lib/errors';
import { type RouteDef, route } from '../../routes/define';
import type { Services } from '../../services';
import { providerLogins, type SignInCaller } from './service';

/** The REST caller as the sign-in service sees it. */
export async function signInCaller(_services: Services, auth: RequestAuth): Promise<SignInCaller> {
  if (!auth.account) throw unauthorized();
  return {
    account: { id: auth.account.id, name: auth.account.name },
    endpoint: null,
  };
}

/** Routes whose input or answer may carry a secret: no request line in the log. */
const SECRET = { logLevel: 'warn' as const };

export const signInApiRoutes: RouteDef[] = [
  route(api.signins.list, async ({ auth, services }) =>
    providerLogins(services).list(await signInCaller(services, auth)),
  ),
  route(
    api.signins.loginStart,
    async ({ auth, body, services }) =>
      providerLogins(services).start(await signInCaller(services, auth), body),
    SECRET,
  ),
  route(api.signins.loginStatus, async ({ auth, params, services }) =>
    providerLogins(services).status(await signInCaller(services, auth), { loginId: params.loginId }),
  ),
  route(
    api.signins.loginSubmit,
    async ({ auth, body, params, services }) =>
      providerLogins(services).submit(await signInCaller(services, auth), {
        ...body,
        loginId: params.loginId,
      }),
    SECRET,
  ),
  route(api.signins.loginCancel, async ({ auth, params, services }) =>
    providerLogins(services).cancel(await signInCaller(services, auth), { loginId: params.loginId }),
  ),
  route(api.signins.logout, async ({ auth, params, services }) =>
    providerLogins(services).logout(await signInCaller(services, auth), { provider: params.provider }),
  ),
  route(api.signins.consoleStart, async ({ auth, body, services }) =>
    providerLogins(services).consoleStart(await signInCaller(services, auth), body),
  ),
  route(
    api.signins.consoleRead,
    async ({ auth, params, query, services }) =>
      providerLogins(services).consoleRead(await signInCaller(services, auth), params.consoleId, query),
    SECRET,
  ),
  route(
    api.signins.consoleWrite,
    async ({ auth, body, params, services }) =>
      providerLogins(services).consoleWrite(await signInCaller(services, auth), params.consoleId, body),
    SECRET,
  ),
  route(api.signins.consoleResize, async ({ auth, body, params, services }) =>
    providerLogins(services).consoleResize(await signInCaller(services, auth), params.consoleId, body),
  ),
  route(api.signins.consoleCancel, async ({ auth, params, services }) =>
    providerLogins(services).consoleCancel(await signInCaller(services, auth), params.consoleId),
  ),
];
