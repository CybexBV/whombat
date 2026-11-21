/**
 * Which session a turn runs in (hermes-engine.md HE-18): the Hermes session (`hermes:<id>`) it was handed, as it is —
 * Hermes keeps the prompt it froze when the session began, so no prompt hash decides — or a fresh one.
 */

import { type AgentProvider, isHermesSessionId } from '@whombat/agent-runtime';
import type { DispatchContext } from '@whombat/core';
import type { BuiltTurn } from './input';
import type { TurnScope } from './scope';

/** The session a turn reports. */
export class TurnSession {
  /** The dispatch's session until the provider names its own. */
  id: string | undefined;

  constructor(id: string | undefined) {
    this.id = id;
  }

  /** What a beat says of the session. */
  forBeat(): { providerSessionId?: string } {
    return this.id ? { providerSessionId: this.id } : {};
  }

  /** What the completion says of the session. */
  reported(): { providerSessionId?: string } {
    return this.id ? { providerSessionId: this.id } : {};
  }

  /** What the turn's outcome says of it. */
  outcome(): { providerSessionId?: string } {
    return this.id ? { providerSessionId: this.id } : {};
  }
}

interface SessionPlan {
  /** The context the turn was built from (`shapeOf`). */
  turnCtx: DispatchContext;
  provider: AgentProvider;
  built: BuiltTurn;
}

/** The session the built turn runs in, set on its input. */
export function planSession(turn: Pick<TurnScope, 'ctx' | 'session'>, plan: SessionPlan): void {
  const { built } = plan;
  // Only Hermes's own sessions are resumed (HE-18).
  if (built.input.resumeSessionId && !isHermesSessionId(built.input.resumeSessionId)) {
    delete built.input.resumeSessionId;
    turn.session.id = undefined;
  }
  // A resumed session carries only what is new since its last turn (HE-40): one Hermes lost fails, and the server tries
  // the turn again on a fresh session with the whole window (BP-B17).
}
