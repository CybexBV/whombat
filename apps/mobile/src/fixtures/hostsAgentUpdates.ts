/**
 * The servers' agents keeping up to date in the demo world (agent-updates-app.md AP-2993): the web's fixture world
 * (`createAgentUpdatesFixtureWorld` in `@whombat/client/hosts/fixtures`) behind the phone's endpoints — pve-02 kept up
 * to date, blackbox taking its last install (Update the agent), pve-01 needing its install command, thetitan waiting
 * for its updates, the-falcon's update gone back (Try again) — and “Keep server agents up to date”. Pure TypeScript.
 */
import { createAgentUpdatesFixtureWorld } from '@whombat/client/hosts/fixtures';
import type { HostServerDetail, HostServerSettings } from '@whombat/core';

export interface AgentUpdatesFixtureDeps {
  now: () => Date;
  json: (body: unknown, status?: number) => Response;
  bodyOf: <T>(init: RequestInit | undefined) => Promise<T>;
}

export function createAgentUpdatesFixtures(deps: AgentUpdatesFixtureDeps) {
  // The demo world's clock: an update started here ends with it.
  const world = createAgentUpdatesFixtureWorld({
    now: deps.now().getTime(),
    clock: () => deps.now().getTime(),
  });
  return {
    /** A server's settings with its agent's version and update. */
    settings: (s: HostServerSettings): HostServerSettings => world.serverSettings(s),
    /** A server's page with its agent's version. */
    detail(d: HostServerDetail): HostServerDetail {
      const version = world.version(d.server.id);
      return version ? { ...d, server: { ...d.server, agent: { ...d.server.agent, version } } } : d;
    },
    async handle(
      id: string,
      params: Record<string, string>,
      init: RequestInit | undefined,
    ): Promise<Response | null> {
      switch (id) {
        case 'hosts.agentSettings':
          return deps.json(world.settings());
        case 'hosts.updateAgentSettings':
          return deps.json(world.patchSettings(await deps.bodyOf<Record<string, unknown>>(init)));
        case 'hosts.updateAgent': {
          const out = world.start(params.serverId ?? '');
          return deps.json(out.body, out.status);
        }
        default:
          return null;
      }
    },
  };
}
