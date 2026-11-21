/**
 * The selection bar of the guest tables (ported from Rackoon's `BulkBar`): “3 selected: Start · Shut down · Restart ·
 * Stop… · Clear”. Everything but Start is asked first with the guests' names; the actions run three at a time and end
 * in one toast (`@whombat/client/hosts`' `bulkPlan`, `bulkDoneText`).
 */
import {
  BULK_KINDS,
  BULK_WORDS,
  type BulkGuest,
  type BulkKind,
  type BulkPlan,
  bulkConfirms,
  bulkDoneText,
  bulkPlan,
  bulkQuestion,
  commitOutcomeText,
  hostErrorInfo,
  isDestructiveAction,
  runLimited,
} from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import { useState } from 'react';
import { cx } from '../../../components/cx';
import { useToast } from '../../../components/Toast';
import wc from '../HostFleet.module.css';
import { ConfirmDialog } from '../parts';

/** Names listed in the question; the rest are counted. */
const SHOWN = 12;

export function BulkBar({
  burrow,
  items,
  withServer = false,
  onClear,
}: {
  burrow: string;
  items: readonly BulkGuest[];
  /** Name the server beside each guest (the fleet's list). */
  withServer?: boolean;
  onClear: () => void;
}) {
  const change = useHostsChange(api.hosts.guestAction);
  const toast = useToast();
  const [ask, setAsk] = useState<{ kind: BulkKind; plan: BulkPlan } | null>(null);
  const label = (x: BulkGuest) => (withServer ? `${x.guest.name} on ${x.server}` : x.guest.name);

  const run = async (kind: BulkKind, plan: BulkPlan) => {
    setAsk(null);
    onClear();
    const failed: { name: string; message: string }[] = [];
    await runLimited(plan.run, 3, async ({ item, action }) => {
      try {
        const r = await change.mutateAsync({
          params: { burrow, serverId: item.server, guestId: item.guest.id },
          body: { action, ...(isDestructiveAction(action) ? { confirm: true } : {}) },
        });
        if (r.status !== 'ok') failed.push({ name: label(item), message: commitOutcomeText(r) ?? '' });
      } catch (err) {
        failed.push({ name: label(item), message: hostErrorInfo(err).message });
      }
    });
    toast.show(bulkDoneText(kind, plan.run.length, failed), failed.length ? { duration: 12_000 } : undefined);
  };

  const choose = (kind: BulkKind) => {
    const plan = bulkPlan(kind, items);
    if (!plan.run.length) return;
    if (bulkConfirms(kind)) setAsk({ kind, plan });
    else void run(kind, plan);
  };

  const q = ask ? bulkQuestion(ask.kind, ask.plan.run.length) : null;
  return (
    <>
      {items.length ? (
        <fieldset className={wc.wcBulk} aria-label="Selected guests">
          <b aria-live="polite">{items.length} selected</b>
          {BULK_KINDS.map((k) => {
            const n = bulkPlan(k, items).run.length;
            return (
              <button
                key={k}
                type="button"
                className={cx(wc.wcBulkBtn, k === 'stop' && n > 0 && wc.wcBulkSerious)}
                aria-disabled={n === 0 || undefined}
                title={n === 0 ? BULK_WORDS[k].none : n < items.length ? `For ${n} of them.` : undefined}
                onClick={() => choose(k)}
              >
                {BULK_WORDS[k].label}
              </button>
            );
          })}
          <button type="button" className={cx(wc.wcBulkBtn, wc.wcBulkClear)} onClick={onClear}>
            Clear
          </button>
        </fieldset>
      ) : null}
      <ConfirmDialog
        open={ask !== null}
        title={q?.title ?? ''}
        body={q?.body}
        confirm={q?.action ?? ''}
        serious={ask?.kind === 'stop'}
        onConfirm={() => ask && void run(ask.kind, ask.plan)}
        onClose={() => setAsk(null)}
      >
        {ask ? (
          <>
            <ul className={wc.wcNames} aria-label="Guests">
              {ask.plan.run.slice(0, SHOWN).map(({ item }) => (
                <li key={`${item.server}/${item.guest.id}`}>{label(item)}</li>
              ))}
              {ask.plan.run.length > SHOWN ? <li>and {ask.plan.run.length - SHOWN} more</li> : null}
            </ul>
            {ask.plan.skipped.length ? (
              <p className={wc.wcNote}>
                {ask.plan.skipped.length === 1
                  ? '1 selected guest is left out: this doesn’t apply to it.'
                  : `${ask.plan.skipped.length} selected guests are left out: this doesn’t apply to them.`}
              </p>
            ) : null}
          </>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
