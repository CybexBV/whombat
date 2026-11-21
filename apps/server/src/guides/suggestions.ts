/**
 * Occasional suggestions (docs/decisions/assistant-guides.md AG-11), as pure rules: when a person may get one,
 * and which topic. The hourly job (`service.ts`) loads the state and posts the card.
 */
import { SUGGESTED_GUIDE_TOPICS } from '@whombat/core';
import type { GuideFacts, SuggestedTopic } from './flows';

const DAY_MS = 24 * 3_600_000;
/** At most one suggestion per account in this long. */
export const SUGGESTION_SPACING_MS = 7 * DAY_MS;
/** None this soon after the welcome. */
export const AFTER_WELCOME_MS = 3 * DAY_MS;
/** Only for people active this recently. */
export const ACTIVE_WITHIN_MS = 3 * DAY_MS;
/** Open guide cards older than this become `expired`. */
export const GUIDE_EXPIRY_MS = 7 * DAY_MS;

export interface SuggestionState {
  now: Date;
  /** `Preferences.assistant.suggestions`. */
  enabled: boolean;
  /** The account's last suggestion, in any burrow. */
  lastSuggestedAt: Date | null;
  /** The welcome in the burrow the suggestion would go to (null: not welcomed yet). */
  welcomedAt: Date | null;
  /** The person's last activity there (a read marker moved). */
  activeAt: Date | null;
  /** A guide card in their DM still waits for them. */
  openCard: boolean;
}

/** Whether the person may get a suggestion now. */
export function suggestionDue(s: SuggestionState): boolean {
  const now = s.now.getTime();
  if (!s.enabled || s.openCard) return false;
  if (!s.welcomedAt || now - s.welcomedAt.getTime() < AFTER_WELCOME_MS) return false;
  if (s.lastSuggestedAt && now - s.lastSuggestedAt.getTime() < SUGGESTION_SPACING_MS) return false;
  return !!s.activeAt && now - s.activeAt.getTime() <= ACTIVE_WITHIN_MS;
}

/**
 * The first of email → calendar → files that isn't set up and isn't in `dontAsk`. Connect topics need Google on here.
 */
export function pickSuggestion(f: GuideFacts): SuggestedTopic | null {
  const c = f.connection?.status === 'active' ? f.connection : null;
  const has = (s: string) => !!c?.services.includes(s as never);
  const canConnect = f.google.enabled;
  for (const topic of SUGGESTED_GUIDE_TOPICS) {
    if (f.dontAsk.includes(topic)) continue;
    switch (topic) {
      case 'email':
        if (canConnect && !has('mail')) return topic;
        break;
      case 'calendar':
        if (canConnect && !has('calendar')) return topic;
        break;
      case 'files':
        if (canConnect && !has('files')) return topic;
        break;
    }
  }
  return null;
}
