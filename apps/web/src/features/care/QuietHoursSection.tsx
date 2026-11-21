import { ApiError } from '@whombat/client';
import { useChangeWindowView, useSetChangeWindow, useTheAgent } from '@whombat/client/react';
import { CHANGE_WINDOW_WORDS, type ChangeWindow, minutesClock } from '@whombat/core';
import { useId } from 'react';
import { cx } from '../../components/cx';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import styles from '../settings/SettingsScreen.module.css';
import q from './QuietHours.module.css';

/** The section's label and its words (Whombat care-plan.md). */
export const QUIET_HOURS_TEXT = {
  label: 'CHANGES',
  ...CHANGE_WINDOW_WORDS,
} as const;

/** Every half hour of the day: what the two times offer. */
const TIMES = Array.from({ length: 48 }, (_, i) => minutesClock(i * 30));

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/**
 * Settings → This Whombat → **Quiet hours for changes** (Whombat care-plan.md; contracts `changeWindow.get`/`.set`): the
 * one change window of this Whombat, 03:00–05:00 in its time zone until the person moves it, when the assistant installs
 * updates and restarts things and when an approval's *Tonight* runs. Saved at once, signed. A Whombat without it (an
 * older one) shows nothing. Not in the mocks: Settings' rows (a title, the hint, the control on the right).
 */
export function QuietHoursSection({ burrow }: { burrow: string }) {
  const ids = useId();
  const toast = useToast();
  const { words } = useTheAgent(burrow);
  const view = useChangeWindowView({ params: { burrow } }, { retry: false, staleTime: 60_000 });
  const set = useSetChangeWindow(burrow);
  if (!view.data) return null;
  const { window, timeZone } = view.data;
  const save = (next: ChangeWindow) => {
    if (next.start === next.end) return;
    set.mutateAsync(next).then(
      (result) =>
        toast.show(
          result.status === 'ok'
            ? fill(QUIET_HOURS_TEXT.saved, { start: next.start, end: next.end })
            : result.status === 'blocked'
              ? result.message
              : QUIET_HOURS_TEXT.failed,
        ),
      (e) => toast.show(e instanceof ApiError && e.message ? e.message : QUIET_HOURS_TEXT.failed),
    );
  };
  const select = (which: 'start' | 'end', label: string) => (
    <label className={q.time}>
      {label}
      <select
        className={q.select}
        value={window[which]}
        disabled={set.isPending}
        aria-describedby={`${ids}-hint`}
        onChange={(e) => save({ ...window, [which]: e.target.value })}
      >
        {/* A time the person chose before that isn't on the half hour stays choosable. */}
        {TIMES.includes(window[which]) ? null : <option value={window[which]}>{window[which]}</option>}
        {TIMES.map((t) => (
          <option key={t} value={t} disabled={which === 'end' ? t === window.start : t === window.end}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`} data-quiet-hours="">
      <SectionLabel as="h2" id={`${ids}-label`}>
        {QUIET_HOURS_TEXT.label}
      </SectionLabel>
      <div className={styles.card}>
        <div className={cx(styles.row, styles.lastRow, q.row)}>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{QUIET_HOURS_TEXT.title}</span>
            <span className={styles.rowMeta} id={`${ids}-hint`}>
              {fill(QUIET_HOURS_TEXT.about, { assistant: words.Name })} {timeZone.replace(/_/g, ' ')} time.
            </span>
          </span>
          <span className={q.times}>
            {select('start', QUIET_HOURS_TEXT.from)}
            <span className={q.dash} aria-hidden="true">
              –
            </span>
            {select('end', QUIET_HOURS_TEXT.to)}
          </span>
        </div>
      </div>
    </section>
  );
}
