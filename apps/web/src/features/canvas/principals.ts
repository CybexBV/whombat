import { agentFaceOf } from '@whombat/client';
import { useBootstrap } from '@whombat/client/react';
import type { AgentFace } from '@whombat/core';
import { initialsOf, shortNameOf } from '@whombat/core/domain';
import { useMemo } from 'react';

/** Just enough of a principal to show a name and an avatar, keyed by id. */
export interface PrincipalLite {
  id: string;
  kind: 'person' | 'agent';
  name: string;
  shortName: string;
  initials: string;
  /** The agent only: the face it wears (OA-08), whose colour tints its highlights and caret. */
  face?: AgentFace;
  /** People only. */
  tone?: string;
  /** People only: their photo (CT-265). */
  avatarUrl?: string | null;
}

/**
 * The agent and the person of a burrow, in one id → display-info map (canvas provenance, comments): the bootstrap's
 * principals (less-is-more.md AP-1749, AP-1805). System actors (GitHub, automations) show by name.
 */
export function usePrincipals(burrow: string): { byId: Map<string, PrincipalLite>; isLoading: boolean } {
  const { data: bootstrap, isLoading } = useBootstrap({ params: { burrow } });

  const byId = useMemo(() => {
    const map = new Map<string, PrincipalLite>();
    for (const p of bootstrap?.principals ?? [])
      map.set(
        p.id,
        p.kind === 'person'
          ? {
              id: p.id,
              kind: 'person',
              name: p.name,
              shortName: shortNameOf(p),
              initials: p.initials,
              tone: p.tone,
              avatarUrl: p.avatarUrl ?? null,
            }
          : {
              id: p.id,
              kind: 'agent',
              name: p.name,
              shortName: shortNameOf(p),
              initials: initialsOf(p.name),
              ...(p.kind === 'agent' ? { face: agentFaceOf(p) } : {}),
            },
      );
    return map;
  }, [bootstrap?.principals]);

  return { byId, isLoading };
}
