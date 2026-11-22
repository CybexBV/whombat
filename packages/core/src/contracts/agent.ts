/** The agent (Whombat one-agent.md OA-09): Settings → Agent reads and changes the one agent. */
import { z } from 'zod';
import { CommandAllowance } from '../commands/schemas.js';
import { AgentFace, AgentModelRuntimeUpdate, AgentName } from '../domain/agent.js';
import { Count, Timestamp } from '../domain/common.js';
import { Grant, GrantInput } from '../domain/grant.js';
import { LinkRef } from '../domain/links.js';
import { AgentModelFallback } from '../domain/models.js';
import { Agent } from '../domain/principal.js';
import { RunStatus } from '../domain/run.js';
import { CommandAllowanceId, EventId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

/** “3 keys · 1 ask first” (`keysSummary`). */
export const KeysSummarySchema = z.object({ keys: Count, askFirst: Count });

export const CurrentRun = z.object({
  number: z.number().int().positive(),
  status: RunStatus,
  title: z.string(),
});

/** RECENT row: "Opened PR #482 · invoice PDF export" · "10:48". */
export const RecentActivity = z.object({
  eventId: EventId,
  text: z.string(),
  at: Timestamp,
  link: LinkRef.nullable(),
});
export type RecentActivity = z.infer<typeof RecentActivity>;

/** Settings → Agent: the agent, its keys, what it did lately and the run it is on. */
export const AgentProfile = z.object({
  agent: Agent,
  /** KEYS rows (render with `keyRows()`). */
  grants: z.array(Grant),
  keys: KeysSummarySchema,
  /** RECENT, newest first. */
  recent: z.array(RecentActivity),
  currentRun: CurrentRun.nullable(),
  /**
   * The agent's last turn ran on the tool's default because its model wasn't available there (0.77, CT-333; Whombat
   * model-effort.md ME-05): Model says so (`modelFallbackText`). Null: it ran on the agent's model.
   */
  modelFallback: AgentModelFallback.nullable(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

/** `agent.update`: only the fields present change. */
export const UpdateAgentBody = z.object({
  /** Its name (OA-08): well-formed and not reserved (`validation_failed` on `name`, `AGENT_NAME_FORM_TEXT`). */
  name: AgentName.optional(),
  /** Its face (OA-08). A rename never changes it. */
  face: AgentFace.optional(),
  /** The model (it runs on the person's own sign-in for its provider, OP-09). */
  runtime: AgentModelRuntimeUpdate.optional(),
});
export type UpdateAgentBody = z.input<typeof UpdateAgentBody>;

export const SetKeysResponse = z.object({
  grants: z.array(Grant),
  /** One signed Keys event per change ("Gave Dusty a new key: Run tests"). */
  events: z.array(z.object({ id: EventId, text: z.string() })),
});

/** The agent's commands always allowed (AC-42). */
export const CommandAllowancesResponse = z.object({ allowances: z.array(CommandAllowance) });
export type CommandAllowancesResponse = z.infer<typeof CommandAllowancesResponse>;

export const agentEndpoints = {
  get: endpoint({
    id: 'agent.get',
    method: 'GET',
    path: '/burrows/:burrow/agent',
    summary: 'Settings → Agent: the agent, its keys, recent activity and current run.',
    params: B,
    response: AgentProfile,
  }),
  update: endpoint({
    id: 'agent.update',
    method: 'PATCH',
    path: '/burrows/:burrow/agent',
    summary: 'Change the agent’s name, face or model.',
    params: B,
    body: UpdateAgentBody,
    response: z.object({ agent: Agent }),
  }),
  setKeys: endpoint({
    id: 'agent.setKeys',
    method: 'PUT',
    path: '/burrows/:burrow/agent/keys',
    summary: 'Keys: replace the agent’s grants (clamped). Every change is a Keys event.',
    params: B,
    body: z.object({ grants: z.array(GrantInput).max(60) }),
    response: SetKeysResponse,
  }),
  // Commands always allowed (Whombat agent-computer.md AC-42, contracts 0.36.0).
  commandAllowances: endpoint({
    id: 'agent.commandAllowances',
    method: 'GET',
    path: '/burrows/:burrow/agent/command-allowances',
    summary:
      'Commands a person always allowed the agent (“Always allow for {Agent}” on a command card), newest first.',
    params: B,
    response: CommandAllowancesResponse,
  }),
  removeCommandAllowance: endpoint({
    id: 'agent.removeCommandAllowance',
    method: 'DELETE',
    path: '/burrows/:burrow/agent/command-allowances/:allowanceId',
    summary:
      'Remove an allowance: the command asks again next time. People who hold `agents.manage`. Signs `command.allowance_removed`.',
    params: B.extend({ allowanceId: CommandAllowanceId }),
    response: CommandAllowancesResponse.extend({ eventId: EventId.nullable() }),
  }),
};
