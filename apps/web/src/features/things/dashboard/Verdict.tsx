/**
 * What a server's or a machine's page opens with (Whombat server-pages.md): the verdict, one plain sentence with its
 * tone's dot (“thetitan is fine: 33 apps and 6 machines are running.”), and, at the foot of the Summary, the page's one
 * “Technical details” fold — the versions, processor, memory, address and helper a person who runs the server looks
 * for, then the cards only they need (storage and pools, the platform's facts, the cluster).
 */
import type { ServerDetailRow, Verdict } from '@whombat/client/hosts';
import type { ThingPagePanel } from '@whombat/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Dot } from '../parts';
import { Dashboard } from './Dashboard';
import type { DashboardContext } from './Panels';
import styles from './Verdict.module.css';

const TONE_WORDS: Record<Verdict['tone'], string> = {
  ok: 'Fine',
  warn: 'Needs a look',
  bad: 'Problem',
  mut: 'Waiting',
};

export function VerdictLine({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return null;
  return (
    <p className={styles.verdict} data-verdict={verdict.tone}>
      <span className={styles.dot}>
        <Dot tone={verdict.tone} label={TONE_WORDS[verdict.tone]} />
      </span>
      <span>{verdict.sentence}</span>
    </p>
  );
}

/**
 * The page's one fold of Technical details: closed, a quiet row; open, the facts as label and value, then the cards.
 * `extra` is a tab's own internals (the System tab's clock, load and the platform's operations).
 */
export function TechnicalDetails({
  rows = [],
  panels = [],
  ctx,
  extra,
  className,
}: {
  rows?: readonly ServerDetailRow[];
  /** Cards drawn as the Summary draws them (`serverDashboardView`'s `details`). */
  panels?: readonly ThingPagePanel[];
  ctx?: DashboardContext;
  /** What else the fold holds (another tab's internals), after the facts. */
  extra?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!rows.length && !(panels.length && ctx) && !extra) return null;
  return (
    <section className={cx(styles.fold, className)} aria-label="Technical details">
      <button
        type="button"
        className={styles.foldButton}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon icon={open ? ChevronDown : ChevronRight} size={15} />
        Technical details
      </button>
      {open ? (
        <div id={id} className={styles.foldBody}>
          {rows.length ? (
            <dl className={styles.facts}>
              {rows.map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd className={r.mono ? styles.mono : undefined}>{r.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {extra}
          {panels.length && ctx ? <Dashboard panels={panels} ctx={ctx} /> : null}
        </div>
      ) : null}
    </section>
  );
}
