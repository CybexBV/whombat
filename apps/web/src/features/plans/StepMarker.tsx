import type { PlanStepState } from '@whombat/core';
import { cx } from '../../components/cx';
import styles from './Plans.module.css';

/** `done` → `Done`, for the camel-cased CSS module class names (`markerDone`). */
export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

import { MARKER_LABEL } from './planModel';

/**
 * A plan step's marker, as on the plan card: done = filled ok circle, active = developer-green outline, queued =
 * line2 outline, gate = warn outlined diamond, blocked = bad outlined circle, cancelled = line2 outline (WS-02).
 */
export function StepMarker({ state, size = 16 }: { state: PlanStepState; size?: number }) {
  return (
    <span
      className={cx(styles.marker, styles[`marker${cap(state)}`])}
      style={{ width: size, height: size }}
      role="img"
      aria-label={MARKER_LABEL[state]}
    />
  );
}
