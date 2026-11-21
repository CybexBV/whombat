/**
 * What goes on from a thread, in one line under its row: who is at work (a little stronger), what they do now, how
 * long, and a 3px hairline that says how far along it is. Chat's rows and the thread's head read the same line
 * (`threadWorkLine`).
 */
import { BrandMark } from '@whombat/brand/react';
import { type WorkLine as WorkLineData, workClock } from '@whombat/client';
import type { ThreadWorkMember } from '@whombat/core';
import { cx } from '../../components/cx';
import { useTicker } from './useRoom';
import styles from './WorkLine.module.css';

/** Where a long count stops drawing one segment each: past this a bar of segments reads as noise. */
const MOST_SEGMENTS = 12;

export function WorkLine({ line, className }: { line: WorkLineData; className?: string }) {
  const now = useTicker(line.since !== null, 30_000);
  return (
    <span
      className={cx(styles.line, className)}
      data-tone={line.tone}
      data-work-line=""
      role="img"
      aria-label={line.spoken}
    >
      <span className={styles.top} aria-hidden="true">
        {line.members.length > 0 ? (
          <Marks members={line.members} />
        ) : (
          <span className={styles.dot} data-tone={line.tone} />
        )}
        <span className={styles.words}>
          <span className={styles.who}>{line.who}</span>
          <span className={styles.sep}> · </span>
          {line.text}
        </span>
        {line.since !== null && <span className={styles.clock}>{workClock(line.since, now)}</span>}
      </span>
      {line.progress && <Hairline progress={line.progress} />}
    </span>
  );
}

/** A council's members, by their providers' small marks (a letter where there is none). */
function Marks({ members }: { members: readonly ThreadWorkMember[] }) {
  return (
    <span className={styles.marks}>
      {members.map((m, i) => (
        // A council seats each provider once, but two members may share a letter: their place is their key.
        // biome-ignore lint/suspicious/noArrayIndexKey: members keep their order
        <span key={i} className={styles.mark} data-working={m.working || undefined}>
          {m.mark ? <BrandMark mark={m.mark} size={9} /> : m.letter}
        </span>
      ))}
    </span>
  );
}

function Hairline({ progress }: { progress: NonNullable<WorkLineData['progress']> }) {
  if (progress.kind === 'sweep')
    return (
      <span className={styles.track} aria-hidden="true">
        <span className={styles.sweeper} />
      </span>
    );
  const { done, working, total } = progress;
  if (total > MOST_SEGMENTS) {
    const pct = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
    return (
      <span className={styles.track} aria-hidden="true">
        <span className={styles.fill} style={{ width: pct(done) }} />
        <span className={styles.fillWorking} style={{ left: pct(done), width: pct(working) }} />
      </span>
    );
  }
  return (
    <span className={styles.segments} aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its place in the count
          key={i}
          className={styles.segment}
          data-state={i < done ? 'done' : i < done + working ? 'working' : undefined}
        />
      ))}
    </span>
  );
}
