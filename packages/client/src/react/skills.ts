/**
 * The skills the composer's `/` offers (Whombat skills-library.md SL-09; app AP-4108, AP-5206): the agent's library,
 * shared with Settings → Skills' cache, read only once a draft starts with `/`.
 */
import { useQuery } from '@tanstack/react-query';
import type { AnyEndpoint } from '@whombat/core/contracts';
import { useMemo } from 'react';
import { type EnabledSkill, enabledSkillsOf } from '../query/skills';
import { type SkillLibrary, skillLibraryEndpoints } from '../skillLibrary/contract';
import { useWhombat } from './context';

export interface EnabledSkills {
  skills: EnabledSkill[];
  /** The library answered (an error isn't “none”). */
  known: boolean;
  loading: boolean;
}

/** The skills the agent may be asked to use; nothing is fetched until `enabled`. */
export function useEnabledSkills(burrow: string, enabled: boolean): EnabledSkills {
  const { queries } = useWhombat();
  const result = useQuery({
    ...queries.endpoint(skillLibraryEndpoints.library as AnyEndpoint, { params: { burrow } }),
    staleTime: 30_000,
    enabled,
  });
  const data = result.data as SkillLibrary | undefined;
  const skills = useMemo(() => (data ? enabledSkillsOf(data) : []), [data]);
  return { skills, known: data !== undefined, loading: enabled && result.isPending };
}
