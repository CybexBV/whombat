/**
 * The numbered steps of a guided sign-in (AP-62): onboarding's step dots at 22px (sf2 and a mono number; the current
 * step in the primary button's colors; a done step ok with a check), each followed by its content.
 */
import type { ReactNode } from 'react';
import styles from './ai.module.css';

export type StepState = 'todo' | 'active' | 'done';

export function Steps({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ol className={styles.steps} aria-label={label}>
      {children}
    </ol>
  );
}

export function Step({
  n,
  state,
  align = 'start',
  children,
}: {
  n: number;
  state: StepState;
  /** `center`: the step is one row (a button), the dot sits in its middle. */
  align?: 'start' | 'center';
  children: ReactNode;
}) {
  return (
    <li
      className={styles.step}
      data-state={state}
      data-align={align}
      aria-current={state === 'active' ? 'step' : undefined}
    >
      <span className={styles.stepDot} data-state={state} aria-hidden="true">
        {state === 'done' ? '✓' : n}
      </span>
      <div className={styles.stepBody}>
        {children}
        {state === 'done' ? <span className={styles.srOnly}> (done)</span> : null}
      </div>
    </li>
  );
}

/** Focus `el` unless the person is busy somewhere else on the page (focus is on the page itself, or in `root`). */
export function focusIfFree(el: HTMLElement | null, root: HTMLElement | null) {
  const active = document.activeElement;
  if (!el || (active && active !== document.body && !root?.contains(active))) return;
  el.focus();
}
