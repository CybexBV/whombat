/**
 * The Whombat's one agent (Whombat one-agent.md OA-01, OA-08): its name and face, its status, and the model and
 * provider its turns run on. There are no roles, no hiring and no other agents; the agent is created with the Whombat.
 */
import { z } from 'zod';
import { AgentEffort } from './models.js';

/* Name and face (OA-08) ------------------------------------------------------------------------------------------ */

/** The five drawings the agent can wear, keyed by the name each was drawn for (`AGENT_CHARACTERS`). */
export const AGENT_FACES = ['dusty', 'banjo', 'neo', 'skipper', 'hazel'] as const;
export const AgentFace = z.enum(AGENT_FACES);
export type AgentFace = z.infer<typeof AgentFace>;

/** One of the five drawings: its name and its accents (the same in both themes). */
export interface AgentCharacter {
  face: AgentFace;
  /** The name the drawing was made for: Dusty, Banjo, Neo, Skipper, Hazel. */
  name: string;
  /** The drawing's accent colour. */
  accent: string;
  /** Text or icons on a light accent background. */
  accentDeep: string;
}

/** The faces to choose from, in the picker's order (the handoff's `agents.json`, Whombat crew.md CRW-01…CRW-03). */
export const AGENT_CHARACTERS: readonly AgentCharacter[] = [
  { face: 'dusty', name: 'Dusty', accent: '#8f7fc9', accentDeep: '#6a5aa3' },
  { face: 'banjo', name: 'Banjo', accent: '#5aa37a', accentDeep: '#3e7b58' },
  { face: 'neo', name: 'Neo', accent: '#b99346', accentDeep: '#8d6d2d' },
  { face: 'skipper', name: 'Skipper', accent: '#c65d6e', accentDeep: '#a33346' },
  { face: 'hazel', name: 'Hazel', accent: '#a6ad43', accentDeep: '#74792a' },
];

/** A face's drawing. */
export function agentCharacter(face: AgentFace): AgentCharacter {
  return AGENT_CHARACTERS.find((c) => c.face === face) as AgentCharacter;
}

/** The agent's name until someone picks another (OA-08). */
export const DEFAULT_AGENT_NAME = 'Dusty';
/** The agent's face until someone picks another (OA-08): Dusty's drawing. */
export const DEFAULT_AGENT_FACE: AgentFace = 'dusty';

/** The agent's longest name. */
export const AGENT_NAME_MAX = 24;

/** The agent's name: one capitalised word of at most `AGENT_NAME_MAX` letters (“Dusty”). */
export const AGENT_NAME_PATTERN = /^[A-Z][a-z]{1,23}$/;

/**
 * Names the agent may not have (AN-03): “Whombat” is the product and the box (This Whombat, “Sent by your Whombat”).
 * Compared case-insensitively.
 */
export const RESERVED_AGENT_NAMES = ['Whombat'] as const;

/** Whether `name` is reserved (`RESERVED_AGENT_NAMES`, case-insensitively). */
export function isReservedAgentName(name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return RESERVED_AGENT_NAMES.some((n) => n.toLowerCase() === wanted);
}

/** `agent.update` or onboarding with a reserved name: `validation_failed` on `name`. */
export const AGENT_NAME_RESERVED_TEXT = 'Whombat is the name of this box, so pick another one.';

/** `agent.update` or onboarding with a name that isn't one capitalised word: `validation_failed` on `name`. */
export const AGENT_NAME_FORM_TEXT = 'Use one word with a capital first letter, like Dusty.';

/** A name for the agent as a body carries it: trimmed, well-formed and not reserved. */
export const AgentName = z
  .string()
  .trim()
  .max(AGENT_NAME_MAX)
  .regex(AGENT_NAME_PATTERN, AGENT_NAME_FORM_TEXT)
  .refine((name) => !isReservedAgentName(name), AGENT_NAME_RESERVED_TEXT);

/** The agent's name from what a person typed: trimmed, at most `AGENT_NAME_MAX` characters, empty → Dusty. */
export function agentName(typed: string | null | undefined): string {
  const name = Array.from((typed ?? '').trim())
    .slice(0, AGENT_NAME_MAX)
    .join('')
    .trim();
  return name || DEFAULT_AGENT_NAME;
}

/* Status and runtime --------------------------------------------------------------------------------------------- */

export const AGENT_STATUSES = ['working', 'waiting', 'idle'] as const;
export const AgentStatus = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** Status copy: the agent page uses `label`, the sidebar row uses `short` (empty for idle). */
export const AGENT_STATUS_COPY: Record<AgentStatus, { label: string; short: string }> = {
  working: { label: 'Working', short: 'working' },
  waiting: { label: 'Waiting', short: 'waiting' },
  idle: { label: 'Idle', short: '' },
};

/**
 * What answers the agent's turns (Whombat hermes-engine.md HE-32): every turn runs on Hermes's own loop. `claude` is
 * Claude Code (Claude on the person's own sign-in through Nous's DirectSDK), `codex` is ChatGPT (2.1, CT-1450: the
 * person's own ChatGPT sign-in through Hermes's `openai-codex` provider; Whombat hermes-native.md HN-02), either also on
 * an API key the person added or through the AI gateway; `local` is the OpenAI-compatible model on the person's network
 * (`LocalModelView`). The ids never change; only `PROVIDER_LABELS` names them.
 */
export const AGENT_PROVIDERS = ['claude', 'codex', 'local'] as const;
export const AgentProvider = z.enum(AGENT_PROVIDERS);
export type AgentProvider = z.infer<typeof AgentProvider>;

/** Which model runs the agent's turns. The person changes it (Settings → Agent). */
export const AgentModelRuntime = z.object({
  provider: AgentProvider,
  /**
   * One of the tool's models (`ProviderModel.id`, 0.77 CT-333); absent: the tool's default. With `local` (CT-1173) any
   * model the server on the person's network serves, typed or picked from `localProviderModels`; absent: the burrow's
   * own (`LocalModelView.model`).
   */
  model: z.string().min(1).optional(),
  /**
   * How hard it thinks in every turn (0.77, CT-333; Whombat model-effort.md ME-02); absent: automatic, `high` for code
   * work and `medium` for conversation (`turnEffort`). A `local` model takes none, so none is sent.
   */
  effort: AgentEffort.optional(),
  /**
   * Fast replies in every turn (0.96, CT-456; Whombat chat-runtime.md CR-06, CR-10), where the model offers them
   * (`ProviderModel.fast`, `turnFast`); absent: the model's own default.
   */
  fast: z.boolean().optional(),
});
export type AgentModelRuntime = z.infer<typeof AgentModelRuntime>;

/**
 * What the agent's turns run on (Whombat one-person.md OP-09, contracts 3.0, CT-1503): the model part. There is no
 * credential source to pick: every turn runs on the person's own sign-in for the provider, which is a subscription or
 * an API key the person added, in the one credential home per provider. Every turn runs on the person's Whombat
 * (Whombat hermes-engine.md HE-48): there is no host directory, checkout or access level to choose.
 */
export const AgentRuntime = AgentModelRuntime;
export type AgentRuntime = z.infer<typeof AgentRuntime>;

/** The agent's model when the Whombat is created: Claude Code. */
export const DEFAULT_AGENT_RUNTIME: AgentRuntime = { provider: 'claude' };
