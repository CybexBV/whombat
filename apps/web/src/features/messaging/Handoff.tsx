/**
 * Work the agent handed to T3 Code, in a thread (docs/app/decisions/t3code-handoff.md AP-6610…AP-6617): T3 Code's mark,
 * the reply row's clock, and the line at the thread's end with what T3 Code does now, its minutes, its steps folded
 * away, and “Open in T3 Code”. Not a message: nothing is posted, and it goes once the agent answered.
 */
import { BrandMark } from '@whombat/brand/react';
import {
  currentStep,
  HIDE_STEPS,
  handoffLine,
  handoffMinutes,
  OPEN_IN_T3_CODE,
  SHOW_STEPS,
  T3_CODE_NAME,
} from '@whombat/client';
import { HANDOFF_COUNCIL_STEP, type Handoff } from '@whombat/core';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { CouncilFaces } from './CouncilFaces';
import styles from './Handoff.module.css';
import { useTicker } from './useRoom';

/**
 * T3 Code's mark: its letters on an ink tile, as its own logo's white on black, in either theme. `live` breathes a
 * halo in the run line's green; `warn` adds the waiting dot. 32 is the face of a message T3 Code wrote (its report).
 */
export function T3Mark({
  size = 18,
  live = false,
  warn = false,
}: {
  size?: 18 | 26 | 32;
  live?: boolean;
  warn?: boolean;
}) {
  return (
    <span
      className={cx(styles.mark, size === 26 && styles.markLarge, size === 32 && styles.markAvatar)}
      data-live={live ? '' : undefined}
      data-warn={warn ? '' : undefined}
      aria-hidden="true"
      data-t3-mark=""
    >
      <BrandMark mark="t3code" size={size === 32 ? 20 : size === 26 ? 18 : 13} />
    </span>
  );
}

/** `· 6m` after the reply row's words, on its own minute clock. */
export function HandoffMinutes({ since }: { since: number }) {
  const now = useTicker(true, 30_000);
  return (
    <span className={styles.minutes} aria-hidden="true">
      · {handoffMinutes(since, now)}
    </span>
  );
}

/** The lines at a thread's end, one per hand-over shown (`threadHandoffs`). */
export function HandoffLines({
  handoffs,
  agentName,
  className,
}: {
  handoffs: readonly Handoff[];
  agentName: string;
  className?: string;
}) {
  if (!handoffs.length) return null;
  return (
    <div className={cx(styles.lines, className)} data-handoffs="">
      {handoffs.slice(0, 3).map((h) => (
        <HandoffLineView key={h.id} handoff={h} agentName={agentName} />
      ))}
    </div>
  );
}

function OpenLink({ url, solid = false }: { url: string | null; solid?: boolean }) {
  if (!url) return null;
  return (
    <a
      className={cx(styles.open, solid && styles.openSolid)}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-handoff-open=""
    >
      {OPEN_IN_T3_CODE}
      <Icon icon={ExternalLink} size={13} />
    </a>
  );
}

/** `running the tests` from a step's `Running the tests`. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The line as one calm row (job-result mockup, scene B): T3 Code's mark in the faces' column, “T3 Code”, what it does
 * now, the minutes, and “Open in T3 Code” at the end. What it asks or waits for goes on a line of its own under it, read
 * whole. While its council reviews, the council's faces stand in for the mark.
 */
function HandoffLineView({ handoff, agentName }: { handoff: Handoff; agentName: string }) {
  const line = handoffLine(handoff, agentName);
  const [open, setOpen] = useState(false);
  const now = useTicker(line.clockFrom !== null, 30_000);
  const step = currentStep(handoff);
  if (line.tone === 'done')
    return (
      <div className={styles.ended} role="status" data-handoff={handoff.state}>
        <span className={styles.markCell}>
          <T3Mark />
        </span>
        <span>
          {line.title}
          {handoff.url && (
            <>
              {' · '}
              <a href={handoff.url} target="_blank" rel="noopener noreferrer" className={styles.endedLink}>
                {OPEN_IN_T3_CODE}
              </a>
            </>
          )}
        </span>
      </div>
    );
  const doing = handoff.state === 'working' || handoff.state === 'finishing';
  const council = doing && !!step && !step.done && step.text.trim().toLowerCase() === HANDOFF_COUNCIL_STEP;
  // “T3 Code is working on it” reads as its name and what it does; a step says the doing more exactly.
  const rest = line.title.startsWith(T3_CODE_NAME)
    ? line.title.slice(T3_CODE_NAME.length).trim()
    : line.title;
  const what = doing && step ? lowerFirst(step.text) : rest;
  const stepsId = `handoff-steps-${handoff.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div
      className={styles.line}
      data-tone={line.tone}
      data-open={open ? '' : undefined}
      data-handoff={handoff.state}
      data-council={council || undefined}
    >
      <div className={styles.top}>
        <span className={styles.markCell}>
          {council ? (
            <CouncilFaces size={20} />
          ) : (
            <T3Mark size={26} live={line.live} warn={line.tone === 'warn'} />
          )}
        </span>
        <div className={styles.row}>
          <div className={styles.words} role="status">
            {council ? (
              <span className={styles.who}>{upperFirst(step?.text ?? HANDOFF_COUNCIL_STEP)}</span>
            ) : (
              <>
                <span className={styles.who}>{T3_CODE_NAME}</span> <span className={styles.what}>{what}</span>
              </>
            )}
            {line.clockFrom !== null && (
              <>
                {' '}
                <span className={styles.clock}>{handoffMinutes(line.clockFrom, now)}</span>
              </>
            )}
          </div>
          <div className={styles.actions}>
            <OpenLink url={handoff.url} solid={line.tone === 'warn'} />
            {line.hasSteps && (
              <button
                type="button"
                className={styles.toggle}
                aria-expanded={open}
                aria-controls={stepsId}
                aria-label={open ? HIDE_STEPS : SHOW_STEPS}
                title={open ? HIDE_STEPS : SHOW_STEPS}
                onClick={() => setOpen((o) => !o)}
              >
                <Icon icon={ChevronDown} size={16} />
              </button>
            )}
          </div>
        </div>
        {/* What T3 Code asks, or an OK it needs, is read whole, however long; what it does now is the row itself. */}
        {!doing && line.now && (
          <div className={styles.now} data-wrap={line.tone === 'warn' || undefined}>
            {line.now}
          </div>
        )}
      </div>
      {open && (
        <div className={styles.more} id={stepsId}>
          {line.meta && <div className={styles.meta}>{line.meta}</div>}
          <ul className={styles.steps}>
            {handoff.steps.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the steps of one read never reorder
              <li key={i}>
                <span className={cx(styles.tick, s === step && !s.done && styles.tickNow)} aria-hidden="true">
                  {s === step && !s.done ? '●' : '✓'}
                </span>
                <span>{s.text}</span>
                {s.detail && <code className={styles.detail}>{s.detail}</code>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
