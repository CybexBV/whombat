/**
 * What Whombat watches (Whombat quiet-notices.md QN-13…QN-15; contracts 0.122.0 CT-1062, `things.watch`,
 * `things.setWatch`; app quiet-notices.md AP-4826, AP-4827; the quiet mock's panel 4): on a connection's and device's
 * Settings tab and a server's System tab, one switch per check in plain words, “Off since 20 Oct (John)” under one
 * switched off, and what is excepted (“Not for: Garage AP until it’s back · Attic AP always”), each with Undo. Look only
 * and guests see the same list with the switches greyed and no Undo (`mayChange` false). Nothing on a Whombat without
 * `things.quiet`.
 */
import { QUIET_TOASTS, thingWatchView, type WatchCheckView } from '@whombat/client';
import { type QuietActions, useThingWatch } from '@whombat/client/react';
import { QUIET_WORDS } from '@whombat/core';
import { type ReactNode, useId } from 'react';
import { LoadErrorNote } from '../../../app/runtime';
import { SkeletonRows } from '../../../components/ListState';
import { Toggle } from '../../../components/Toggle';
import { useBurrowContext, useNow } from '../../messaging/useRoom';
import { Card } from '../parts';
import styles from './Quiet.module.css';
import { useThingQuiet } from './useQuiet';

export function WatchSettings({ burrow, thing }: { burrow: string; thing: string }) {
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const q = useThingWatch({ params: { burrow, thing } }, { retry: false });
  const actions = useThingQuiet(burrow, thing);
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
          />
        ))}
      </div>
    );
  }
  return (
    <Card title={QUIET_WORDS.watchTitle} id="watching">
      {body}
    </Card>
  );
}

function WatchRow({
  row,
  actions,
  mayChange,
}: {
  row: WatchCheckView;
  actions: QuietActions | null;
  mayChange: boolean;
}) {
  const id = useId();
  const busy = actions?.busy({ check: row.check }) ?? false;
  return (
    <div className={styles.watchRow} data-check={row.check}>
      <div className={styles.watchText}>
        <span id={`${id}-name`} className={styles.watchName}>
          {row.name}
        </span>
        {row.offLine ? <small className={styles.watchOff}>{row.offLine}</small> : null}
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
