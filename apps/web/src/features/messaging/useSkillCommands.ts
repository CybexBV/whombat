import { useEnabledSkills, useTheAgent } from '@whombat/client/react';
import { useMemo } from 'react';
import type { SkillCommand } from './model';

/**
 * The skills `/` offers (skills-library.md SL-09; AP-212, AP-248, AP-4108, AP-5235): the agent's skills (`/name `). There
 * is one agent, so no row names who has it (Whombat one-agent.md OA-18; app one-agent.md AP-4949). Nothing is fetched
 * until `enabled` (a draft started with `/`).
 */
export function useSkillCommands(
  burrow: string,
  enabled: boolean,
): { skills: SkillCommand[]; loading: boolean; known: boolean } {
  const { agent } = useTheAgent(burrow);
  const { skills: enabledSkills, known, loading } = useEnabledSkills(burrow, enabled && !!agent);
  const skills = useMemo(
    () =>
      agent
        ? enabledSkills.map((s) => ({
            name: s.name,
            description: s.description,
            agentId: agent.id,
            agentName: agent.name,
            insert: `/${s.name} `,
          }))
        : [],
    [enabledSkills, agent],
  );
  // Still loading only while asked; `known` once the agent's skills have answered (an error isn't “none”, WX-08).
  return { skills, loading: enabled && !!agent && loading, known: enabled && known };
}
