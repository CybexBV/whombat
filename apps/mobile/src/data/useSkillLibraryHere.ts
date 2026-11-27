/**
 * Whether the phone shows the agent's skills (`skillLibraryHere`, AP-2360, AP-4150, AP-4967): wherever the agent is
 * known.
 */

import { useI18n } from '../i18n';
import type { AgentPrincipal } from './people';
import { skillsPhoneText } from './skillLibrary';
import { useTheAgentHere } from './useAgent';

/** The agent whose library the phone shows, or null where it shows none. */
export function useSkillLibraryAgent(): AgentPrincipal | null {
  return useTheAgentHere() ?? null;
}

/** What the Skills screen says where it shows no library (AP-4150). */
export function useSkillsAbsentText(): string {
  const { rawLocale } = useI18n();
  return skillsPhoneText(rawLocale).onWeb;
}
