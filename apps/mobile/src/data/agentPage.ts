/**
 * Settings → the assistant on the phone (Whombat one-agent.md OA-09; the web's `?tab=agent`): its page, by its name, in
 * the shared parts as tabs along the top — Name and face, AI sign-in, Memory (what it remembers about you and the notes
 * it reads in every chat), What it may do, Looks ahead and Council. The model, keys, what it runs, its schedules, skills and spend are
 * Advanced's (`settings/groups.ts`); an old link to one of them opens there. You change it all (Whombat one-person.md
 * OP-01). Pure.
 */
import { type AgentGroupPart, agentGroupParts, settingsGroupText } from '@whombat/client';
import { mobileTranslator } from '../i18n/translate';

export type AgentPart = AgentGroupPart;

/**
 * The parts in their order, named with the assistant's name (“What Dusty may do”); Looks ahead only on a Whombat that
 * has it (`hasLooksAhead`).
 */
export function agentParts(
  name: string,
  here: { looksAhead?: boolean } = {},
  locale?: string,
): { key: AgentPart; label: string }[] {
  const labels = settingsGroupText(locale).agent(name);
  return agentGroupParts(here).map((key) => ({ key, label: labels[key] }));
}

/** `?key=`: a key Keys scrolls to and marks; anything that doesn't look like a key is dropped. */
export function agentKeyParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(raw) ? raw : undefined;
}

/** The page's words (the web's AgentTab). */
export function agentPageText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    /** The tabs' name for TalkBack. */
    parts: (name: string) => settingsGroupText(locale).partsLabel(name),
    loading: (name: string) => t('data.agentPage.loading', { name }),
    failed: (name: string) => t('data.agentPage.failed', { name }),
  };
}

export const AGENT_PAGE_TEXT = agentPageText();
