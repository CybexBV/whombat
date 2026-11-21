import type { PlanStepState } from '@whombat/core/domain';

/** Visual attributes of a plan step's marker dot, matching the mock's `stepState()`. */
export interface PlanStepMarker {
  /** Border radius: a circle for done/active/queued, a small rounded square rotated into a diamond for gate. */
  borderRadius: string;
  borderColor: string;
  background: string;
  transform: string;
  /** Color of the row title text. */
  titleColor: string;
  /** `line-through` for a cancelled step (kept for history, not counted; WS-02). */
  titleDecoration: string;
  /** Color of the state label (`stateLabel`). */
  stateColor: string;
}

/**
 * Plan step markers: done = filled ok circle, active = developer-green outline, queued = line2 outline,
 * gate = warn outlined diamond — a step that needs a person. Mirrors `stepState()` in the reference.
 * Since contracts 0.12 (WS-02, AP-84): blocked = bad outlined circle; cancelled = line2 outline, the title muted and
 * struck through.
 */
export function planStepMarker(state: PlanStepState): PlanStepMarker {
  switch (state) {
    case 'done':
      return {
        borderRadius: '50%',
        borderColor: 'var(--ok)',
        background: 'var(--ok)',
        transform: 'none',
        titleColor: 'var(--mut)',
        titleDecoration: 'none',
        stateColor: 'var(--ok)',
      };
    case 'active':
      return {
        borderRadius: '50%',
        borderColor: 'var(--face-banjo)',
        background: 'transparent',
        transform: 'none',
        titleColor: 'var(--ink)',
        titleDecoration: 'none',
        stateColor: 'var(--ink2)',
      };
    case 'queued':
      return {
        borderRadius: '50%',
        borderColor: 'var(--line2)',
        background: 'transparent',
        transform: 'none',
        titleColor: 'var(--ink)',
        titleDecoration: 'none',
        stateColor: 'var(--mut)',
      };
    case 'gate':
      return {
        borderRadius: '3px',
        borderColor: 'var(--warn)',
        background: 'transparent',
        transform: 'rotate(45deg) scale(.85)',
        titleColor: 'var(--ink)',
        titleDecoration: 'none',
        stateColor: 'var(--warn)',
      };
    case 'blocked':
      return {
        borderRadius: '50%',
        borderColor: 'var(--bad)',
        background: 'transparent',
        transform: 'none',
        titleColor: 'var(--ink)',
        titleDecoration: 'none',
        stateColor: 'var(--bad)',
      };
    case 'cancelled':
      return {
        borderRadius: '50%',
        borderColor: 'var(--line2)',
        background: 'transparent',
        transform: 'none',
        titleColor: 'var(--mut)',
        titleDecoration: 'line-through',
        stateColor: 'var(--mut)',
      };
    default: {
      const _exhaustive: never = state;
      throw new Error(`Unknown plan step state: ${_exhaustive}`);
    }
  }
}
