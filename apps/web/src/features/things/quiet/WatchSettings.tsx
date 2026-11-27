/**
 * What Whombat watches (Whombat quiet-notices.md QN-13…QN-15; contracts 0.122.0 CT-1062, `things.watch`,
 * `things.setWatch`; app quiet-notices.md AP-4826, AP-4827; the quiet mock's panel 4): on a connection's and device's
 * Settings tab and a server's System tab, one switch per check in plain words, “Off since 20 Oct (John)” under one
 * switched off, and what is excepted (“Not for: Garage AP until it’s back · Attic AP always”), each with Undo. Look only
 * and guests see the same list with the switches greyed and no Undo (`mayChange` false). Nothing on a Whombat without
 * `things.quiet`. A server's check with a limit says it under its name (“Warns above 85 %”, a disk with its own beside
 * it) with Change the limit.
 */
import {
  LIMIT_WORDS,
  limitLine,
  limitView,
  QUIET_TOASTS,
  thingWatchView,
  type WatchCheckView,
} from '@whombat/client';
import { type QuietActions, useThingWatch } from '@whombat/client/react';
import { type NoticeSubject, quietWords, type ThingWatchCheck } from '@whombat/core';
import { type ReactNode, useId } from 'react';
import { LoadErrorNote } from '../../../app/runtime';
import { SkeletonRows } from '../../../components/ListState';
import { Toggle } from '../../../components/Toggle';
import { useLocaleWords } from '../../../i18n/words';
import { useBurrowContext, useNow } from '../../messaging/useRoom';
import { Card } from '../parts';
import { useLimitSheet } from './ChangeLimit';
import styles from './Quiet.module.css';
import { useThingQuiet } from './useQuiet';

export function WatchSettings({ burrow, thing }: { burrow: string; thing: string }) {
  const QUIET_WORDS = useLocaleWords(quietWords);
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const q = useThingWatch({ params: { burrow, thing } }, { retry: false });
  const actions = useThingQuiet(burrow, thing);
  const limits = useLimitSheet(burrow, thing);
  const checks = new Map((q.data?.checks ?? []).map((c) => [c.check, c]));
  let body: ReactNode;
  if (q.error && !q.data)
    body = (
      <LoadErrorNote
        error={q.error}
        message="This list couldn’t load. Try again."
        onRetry={() => void q.refetch()}
      />
    );
  else if (!q.data) body = <SkeletonRows count={3} />;
  else {
    const view = thingWatchView(q.data, timeZone, now);
    body = view.empty ? (
      <p className={styles.empty}>{view.empty}</p>
    ) : (
      <div>
        {view.rows.map((r) => (
          <WatchRow
            key={r.check}
            row={r}
            actions={view.mayChange ? actions : null}
            mayChange={view.mayChange}
            check={checks.get(r.check) ?? null}
            onLimit={
              view.mayChange
                ? (c, subject) => {
                    const v = limitView(c, subject);
                    if (v) limits.openFor(v);
                  }
                : null
            }
          />
        ))}
      </div>
    );
  }
  return (
    <Card title={QUIET_WORDS.watchTitle} id="watching">
      {body}
      {limits.sheet}
    </Card>
  );
}

function WatchRow({
  row,
  actions,
  mayChange,
  check,
  onLimit,
}: {
  row: WatchCheckView;
  actions: QuietActions | null;
  mayChange: boolean;
  /** The check as the server sent it: its limit, when it has one. */
  check: ThingWatchCheck | null;
  /** Change the limit, for the whole server or one item; none for who may not. */
  onLimit: ((check: ThingWatchCheck, subject?: NoticeSubject) => void) | null;
}) {
  const QUIET_WORDS = useLocaleWords(quietWords);
  const id = useId();
  const busy = actions?.busy({ check: row.check }) ?? false;
  const limit = check && row.on ? limitLine(check) : null;
  return (
    <div className={styles.watchRow} data-check={row.check}>
      <div className={styles.watchText}>
        <span id={`${id}-name`} className={styles.watchName}>
          {row.name}
        </span>
        {row.offLine ? <small className={styles.watchOff}>{row.offLine}</small> : null}
        {limit && check ? (
          <div className={styles.except} data-limit={row.check}>
            <span className={styles.exceptLabel}>{limit.words}</span>
            {limit.items.map((i) => (
              <span key={i.subject.id} className={styles.chip}>
                {i.subject.name}
                <span className={styles.chipWords}>{i.words}</span>
                {onLimit ? (
                  <button
                    type="button"
                    className={styles.chipUndo}
                    aria-label={`${LIMIT_WORDS.menu}: ${i.subject.name}`}
                    onClick={() => onLimit(check, i.subject)}
                  >
                    Change
                  </button>
                ) : null}
              </span>
            ))}
            {onLimit ? (
              <button
                type="button"
                className={styles.limitBtn}
                aria-label={`${LIMIT_WORDS.menu}: ${row.name}`}
                onClick={() => onLimit(check)}
              >
                {LIMIT_WORDS.menu}
              </button>
            ) : null}
          </div>
        ) : null}
        {row.exceptions.length ? (
          <div className={styles.except}>
            <span className={styles.exceptLabel}>{QUIET_WORDS.watchNot}</span>
            {row.exceptions.map((e) => (
              <span key={e.key} className={styles.chip} title={e.who ?? undefined}>
                {e.name}
                {e.words ? <span className={styles.chipWords}>{e.words}</span> : null}
                {actions ? (
                  <button
                    type="button"
                    className={styles.chipUndo}
                    aria-label={e.undoLabel}
                    onClick={() => {
                      const u = e.undo;
                      if (u.kind === 'quiet') actions.undo(u.ref);
                      else actions.watch(u.check, u.subject, true, u.subject?.name ?? `“${row.name}”`);
                    }}
                  >
                    {QUIET_TOASTS.undo}
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <Toggle
        size="sm"
        checked={row.on}
        disabled={!mayChange || !actions || busy}
        aria-labelledby={`${id}-name`}
        onCheckedChange={(on) => actions?.watch(row.check, undefined, on, `“${row.name}”`)}
      />
    </div>
  );
}
