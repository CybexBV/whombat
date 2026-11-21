import { WhombatAvatar } from '@whombat/avatars/react';
import type { LookResearchView } from '@whombat/client';
import type { AgentFace } from '@whombat/core';
import { cx } from '../../components/cx';
import styles from './LookSays.module.css';

/**
 * What the assistant says about a look (Whombat look-research.md LR-09; app look-research-web.md AP-5905), as the mock's
 * cards draw it: its head, a spinner while it works on it, and its words (“I’m looking into it.”, its summary, “I’m on
 * it.”). Home's Needs you and a thing's page share it.
 */
export function LookSays({
  view,
  face,
  name,
  size = 20,
  className,
}: {
  /** What it says, and whether it is working on it (a plan's view says the same). */
  view: Pick<LookResearchView, 'busy' | 'text'> & { state: string };
  face: AgentFace;
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <p className={cx(styles.says, className)} data-look-says={view.state}>
      <WhombatAvatar face={face} crop="head" size={size} label={name} className={styles.face} />
      <span>
        {view.busy ? <span className={styles.spin} aria-hidden="true" /> : null}
        {view.text}
      </span>
    </p>
  );
}
