/** What the editor's node views read from the screen: people, the live Plan and the provenance line. */
import type { Plan } from '@whombat/core/domain';
import { createContext, useContext } from 'react';
import type { PrincipalLite } from '../principals';

export interface CanvasViewValue {
  principals: Map<string, PrincipalLite>;
  /** The Plan bound to the plan block (live: `plan.updated` frames patch it). */
  plan: Plan | null;
  /** "Drafted by Toffee from Mara’s request · edited by Mara, Dusty · 12 min ago" */
  provenance: string;
}

const EMPTY: CanvasViewValue = { principals: new Map(), plan: null, provenance: '' };

export const CanvasViewContext = createContext<CanvasViewValue>(EMPTY);

export function useCanvasView(): CanvasViewValue {
  return useContext(CanvasViewContext);
}
