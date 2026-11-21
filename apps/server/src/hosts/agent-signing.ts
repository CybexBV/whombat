/**
 * Done recently for agent updates (agent-updates.md AU-08; agent-updates-server.md AU-S04): the process's
 * `AgentUpdateFollow`, which `startHosts` feeds the hub's `agent.update` events and Update now tells who pressed it. A
 * finished update is one `hosts.change` with its change, “Updated the agent on pve-01”, signed by the person who pressed
 * it or else by the burrow's Servers signer (“Whombat”); no message in any conversation.
 */
import type { Services } from '../services';
import { AGENT_UPDATE_TEXT, type AgentUpdated, AgentUpdateFollow } from './agent-updates';
import { committed, type HostsChangeInput, recordHostsChange } from './commands';
import { serversPrincipal } from './principal';
import { hostsFor } from './service';

const instances = new WeakMap<object, AgentUpdateFollow>();

/** The change a finished update records. */
export function updatedChange(u: Pick<AgentUpdated, 'serverId' | 'from' | 'to'>): HostsChangeInput {
  const title = AGENT_UPDATE_TEXT.updated(u.serverId);
  const ids: Record<string, string> = {};
  if (u.from) ids.from = u.from.slice(0, 500);
  if (u.to) ids.to = u.to.slice(0, 500);
  return { text: title, op: 'agent_updated', serverId: u.serverId, ids, change: { title } };
}

async function signUpdated(services: Services, u: AgentUpdated): Promise<void> {
  const burrowId = u.burrowId ?? (await hostsFor(services).homeBurrowId());
  if (!burrowId) return;
  const input = updatedChange(u);
  const commitAs = async (actorId: string) =>
    committed(await services.pipeline.commit(recordHostsChange, input, { burrowId, actorId }));
  try {
    if (u.personId) {
      // Someone who left meanwhile signs nothing more (EP-02): Whombat signs it then.
      const ok = await commitAs(u.personId).then(
        () => true,
        () => false,
      );
      if (ok) return;
    }
    await commitAs(await serversPrincipal(services, burrowId));
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.message : String(err), server: u.serverId },
      'hosts: an agent’s update was not signed',
    );
  }
}

/** The process's agent-update follow-up (one per `Services`). */
export function agentUpdatesFor(services: Services): AgentUpdateFollow {
  let f = instances.get(services);
  if (!f) {
    f = new AgentUpdateFollow((u) => signUpdated(services, u));
    instances.set(services, f);
  }
  return f;
}
