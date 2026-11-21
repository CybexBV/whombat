/**
 * Whether the phone shows the agent's skills (`skillLibraryHere`, AP-2360, AP-4150, AP-4967): wherever the agent is
 * known.
 */

import type { AgentPrincipal } from './people';
import { SKILLS_PHONE_TEXT } from './skillLibrary';
import { useTheAgentHere } from './useAgent';

/** The agent whose library the phone shows, or null where it shows none. */
export function useSkillLibraryAgent(): AgentPrincipal | null {
  return useTheAgentHere() ?? null;
}

/** What the Skills screen says where it shows no library (AP-4150). */
export function useSkillsAbsentText(): string {
  return SKILLS_PHONE_TEXT.onWeb;
}
