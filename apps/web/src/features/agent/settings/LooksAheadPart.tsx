/**
 * Settings → the assistant → **Looks ahead** (Whombat looks-ahead.md; `looksAhead.get`, `looksAhead.update`): the
 * afternoon before something on the person's calendar, the assistant checks it against their mail and the web and says
 * something only when it doesn't match. Its switch with how the last week went, the calendars it reads (each its own
 * switch, resting while Looks ahead is off) and the kinds of finding the person stopped, each with Check again. Every
 * change saves at once and says so in a note. Not in the mocks: Settings' rows and cards.
 */
import { looksAheadCalendarMeta, looksAheadSavedText, LOOKS_AHEAD_TEXT as T } from '@whombat/client';
import { commitOutcomeText, hostErrorInfo } from '@whombat/client/hosts';
import { useLooksAhead, useTheAgent, useUpdateLooksAhead } from '@whombat/client/react';
import { AHEAD_KIND_WORDS, type LooksAheadUpdate } from '@whombat/core';
import { useId } from 'react';
import { LoadErrorNote } from '../../../app/runtime';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { SkeletonRows } from '../../../components/ListState';
import { SectionLabel } from '../../../components/SectionLabel';
import { useToast } from '../../../components/Toast';
import { Toggle } from '../../../components/Toggle';
import styles from '../../settings/SettingsScreen.module.css';
import own from './LooksAhead.module.css';

export function LooksAheadPart({ burrow }: { burrow: string }) {
  const ids = useId();
  const toast = useToast();
  const { words } = useTheAgent(burrow);
  const query = useLooksAhead({ params: { burrow } }, { retry: false });
  const update = useUpdateLooksAhead(burrow);
  const view = query.data;

  if (!view) {
    return query.error ? (
      <LoadErrorNote error={query.error} message={T.failed} onRetry={() => void query.refetch()} />
    ) : (
      <SkeletonRows count={3} lines={1} />
    );
  }

  const busy = update.isPending;
  const save = (change: LooksAheadUpdate) => {
    const said = looksAheadSavedText(view, change);
    update.mutateAsync(change).then(
      (result) => toast.show(result.status === 'ok' ? said : (commitOutcomeText(result) ?? T.notSaved)),
      (error) => toast.show(hostErrorInfo(error).message || T.notSaved),
    );
  };
  const week = T.week(view.week.checked, view.week.told);

  return (
    <>
      <p className={own.intro}>{T.explainFor(words.Name)}</p>

      <div className={styles.card}>
        <div className={cx(styles.row, styles.lastRow)} data-row="looks-ahead">
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-on`}>
              {T.title}
            </label>
            <span className={styles.rowMeta} id={`${ids}-week`}>
              {week}
            </span>
          </span>
          <Toggle
            id={`${ids}-on`}
            checked={view.on}
            disabled={busy}
            aria-describedby={`${ids}-week`}
            onCheckedChange={(on) => save({ on })}
          />
        </div>
      </div>

      <section className={styles.section} aria-labelledby={`${ids}-calendars`} data-ahead="calendars">
        <SectionLabel as="h2" id={`${ids}-calendars`}>
          {T.calendars}
        </SectionLabel>
        {!view.hasCalendar ? (
          <p className={own.note}>{T.noCalendar}</p>
        ) : !view.calendarsRead ? (
          <p className={own.note}>{T.calendarsUnread}</p>
        ) : view.calendars.length ? (
          <div className={styles.card}>
            {view.calendars.map((c, i) => (
              <div
                key={c.key}
                className={cx(styles.row, i === view.calendars.length - 1 && styles.lastRow)}
                data-calendar={c.key}
              >
                <span className={cx(styles.rowMain, !view.on && own.resting)}>
                  <label className={styles.rowTitle} htmlFor={`${ids}-cal-${i}`}>
                    {c.name}
                  </label>
                  <span className={styles.rowMeta} id={`${ids}-cal-${i}-meta`}>
                    {looksAheadCalendarMeta(c)}
                  </span>
                </span>
                <Toggle
                  id={`${ids}-cal-${i}`}
                  checked={c.on}
                  disabled={busy || !view.on}
                  aria-describedby={`${ids}-cal-${i}-meta`}
                  onCheckedChange={(on) => save({ calendar: c.key, on })}
                />
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {view.stopped.length ? (
        <section className={styles.section} aria-labelledby={`${ids}-stopped`} data-ahead="stopped">
          <SectionLabel as="h2" id={`${ids}-stopped`}>
            {T.stopped}
          </SectionLabel>
          <ul className={cx(styles.card, own.list)}>
            {view.stopped.map((kind, i) => (
              <li
                key={kind}
                className={cx(styles.row, i === view.stopped.length - 1 && styles.lastRow)}
                data-kind={kind}
              >
                <span className={cx(styles.rowMain, styles.rowTitle)}>{AHEAD_KIND_WORDS[kind]}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  aria-label={T.turnBackOnLabel(kind)}
                  onClick={() => save({ kind, on: true })}
                >
                  {T.turnBackOn}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
