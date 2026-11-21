/**
 * AI clients over REST (`api.clients`, CT-72) and, as `clients.*` ops, over the session: the person lists, installs and
 * removes them. Clients update themselves to newer tested
 * versions, so there is no update call.
 */
import { z } from 'zod';
import { ClientStatus } from '../domain/clients.js';
import { Timestamp } from '../domain/common.js';
import { LIVE_PROVIDERS, LiveProvider } from '../domain/providers.js';
import { endpoint } from './endpoint.js';

export const ClientsListOutput = z.object({
  /** Claude Code (ChatGPT needs no client, CT-1450; an older Whombat may still list Codex). */
  clients: z.array(ClientStatus).max(LIVE_PROVIDERS.length),
  /** When the tested versions were last checked (null: never). */
  checkedAt: Timestamp.nullable(),
});
export type ClientsListOutput = z.infer<typeof ClientsListOutput>;

const P = z.object({ provider: LiveProvider });

export const clientEndpoints = {
  list: endpoint({
    id: 'clients.list',
    method: 'GET',
    path: '/clients',
    summary:
      'The AI clients on this Whombat (Claude Code; ChatGPT needs none): installed and latest tested versions, install and update progress.',
    response: ClientsListOutput,
  }),
  install: endpoint({
    id: 'clients.install',
    method: 'POST',
    path: '/clients/:provider/install',
    summary:
      'Install the latest tested version of a client. Answers at once with `installing`; the same call while installing or installed changes nothing.',
    params: P,
    response: ClientStatus,
  }),
  remove: endpoint({
    id: 'clients.remove',
    method: 'DELETE',
    path: '/clients/:provider',
    summary:
      'Remove a client Whombat installed; an install in progress stops. The agent’s turns on it stop until it is back. Sign-ins stay.',
    params: P,
    response: ClientStatus,
  }),
};
