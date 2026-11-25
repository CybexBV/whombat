/**
 * Settings → the assistant on the phone (Whombat one-agent.md OA-09; the web's `?tab=agent`): its page, by its name, in
 * the shared parts as tabs along the top — Name and face, AI sign-in, Memory (what it remembers about you and the notes
 * it reads in every chat), What it may do, Looks ahead and Council. The model, keys, what it runs, its schedules, skills and spend are
 * Advanced's (`settings/groups.ts`); an old link to one of them opens there. You change it all (Whombat one-person.md
 * OP-01). Pure.
 */
import { type AgentGroupPart, agentGroupParts, SETTINGS_GROUP_TEXT } from '@whombat/client';

export type AgentPart = AgentGroupPart;

/**
 * The parts in their order, named with the assistant's name (“What Dusty may do”); Looks ahead only on a Whombat that
 * has it (`hasLooksAhead`).
 */
export function agentParts(
  name: string,
  here: { looksAhead?: boolean } = {},
): { key: AgentPart; label: string }[] {
  const labels = SETTINGS_GROUP_TEXT.agent(name);
  return agentGroupParts(here).map((key) => ({ key, label: labels[key] }));
}

/** `?key=`: a key Keys scrolls to and marks; anything that doesn't look like a key is dropped. */
export function agentKeyParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(raw) ? raw : undefined;
}

/** The page's words (the web's AgentTab). */
export const AGENT_PAGE_TEXT = {
  /** The tabs' name for TalkBack. */
  parts: (name: string) => SETTINGS_GROUP_TEXT.partsLabel(name),
  loading: (name: string) => `Loading ${name}’s settings`,
  failed: (name: string) => `Couldn’t load ${name}’s settings. Try again in a moment.`,
} as const;
