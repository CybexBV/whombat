import { z } from 'zod';
import { AgentFace, AgentProvider } from './agent.js';
import { Timestamp } from './common.js';
import { LIVE_PROVIDERS, LiveProvider } from './providers.js';

/**
 * Onboarding has three steps (SUB-08, CT-68; Whombat one-agent.md OA-13; since 3.0 without “Invite people”, Whombat
 * one-person.md OP-11, CT-1506): name your Whombat, set up your AI, meet your agent (its name and face) (step index 0–2).
 */
export const ONBOARDING_STEP_COUNT = 3;
/** “Set up your AI”: pick the clients (Claude Code, Codex or both) and sign in to each. */
export const ONBOARDING_PROVIDER_STEP = 1;
export const OnboardingStep = z
  .number()
  .int()
  .min(0)
  .max(ONBOARDING_STEP_COUNT - 1);

/** Server-side onboarding progress for a burrow being set up. */
export const OnboardingState = z.object({
  step: OnboardingStep,
  burrowName: z.string(),
  slug: z.string(),
  /** `app.whombat.com/{slug}` (`burrowAddress` of the public origin) */
  host: z.string(),
  /** “Meet your agent” (OA-13): the name chosen so far, `DEFAULT_AGENT_NAME` until then. */
  agentName: z.string().min(1).max(24),
  /** Its face, `DEFAULT_AGENT_FACE` until chosen. */
  agentFace: AgentFace,
  /**
   * “Set up your AI”: the clients the person chose (Claude Code, ChatGPT or both, in the order picked); `[]` until
   * picked. The server installs each (`clients.install`); the person signs in to each in the same step.
   */
  clients: z.array(LiveProvider).max(LIVE_PROVIDERS.length).default([]),
  /**
   * The provider the agent runs on (one of `clients` once picked); null until picked (the default applies). It uses
   * the person's sign-in (SUB-08, OP-09).
   */
  provider: AgentProvider.nullable(),
  completedAt: Timestamp.nullable(),
});
export type OnboardingState = z.infer<typeof OnboardingState>;
