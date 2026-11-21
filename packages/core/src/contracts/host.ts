/**
 * The box the agent works on: whether a deploy runs here and whether the agent's services can run (the container
 * engine), and whether the agent can reply (the runner, Hermes on it, the CLIs and their sign-ins).
 */
import { z } from 'zod';
import { AgentSetupStatus } from '../domain/providers.js';
import { BurrowParam, endpoint } from './endpoint.js';
import { ServicesHostStatus } from './services.js';

const B = z.object({ burrow: BurrowParam });

export const HostInfo = z.object({
  /**
   * Whether a deploy workflow is set up on this Whombat (Whombat runs-approvals.md MDS-05, CT-215): false → the Deploy
   * row of Settings → Agent → Keys shows `DEPLOY_NO_WORKFLOW_HINT` (“No deploy workflow is set up on this Whombat
   * yet.”) and a deploy answers that it can't deploy here; the row can be set either way.
   */
  deployWorkflow: z.boolean(),
  /**
   * Whether the agent's services can run here (3.0, CT-1534; Whombat one-person.md OP-16, OP-19): the container engine
   * is there. `available` false with the `reason` (development without Podman, or the engine isn't working) — Settings
   * → Agent says why, and `docker` in the agent's commands isn't there either.
   */
  services: ServicesHostStatus,
});
export type HostInfo = z.infer<typeof HostInfo>;

export const hostEndpoints = {
  info: endpoint({
    id: 'host.info',
    method: 'GET',
    path: '/burrows/:burrow/host',
    summary: 'Whether a deploy runs here and whether the agent’s services can run here.',
    params: B,
    response: HostInfo,
  }),
  agents: endpoint({
    id: 'host.agents',
    method: 'GET',
    path: '/burrows/:burrow/host/agents',
    summary:
      'Can the agent reply: the runner, Hermes on it, whether Claude Code is installed and logged in, and whether ChatGPT is ready.',
    params: B,
    response: AgentSetupStatus,
  }),
  recheckAgents: endpoint({
    id: 'host.recheckAgents',
    method: 'POST',
    path: '/burrows/:burrow/host/agents/recheck',
    summary: 'Ask the runner to check Claude Code and ChatGPT again.',
    params: B,
    response: AgentSetupStatus,
  }),
};
