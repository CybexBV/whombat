/**
 * Change the limit (Whombat docs/decisions/monitoring.md MON-15; `things.setWatchLimit`, session minor 9): a server
 * check with a limit (disks filling up, SSD wear, temperatures, inodes), for the whole server or one disk or mount, from
 * its line's ⋯ on the Summary or its row in What Whombat watches. A small sheet with the value and its unit, the allowed
 * range and the default under it, Use the default when it has its own, then Cancel and Save; the toast says the new
 * limit with Undo.
 */
import { LIMIT_WORDS, type LimitView, limitText, parseLimit } from '@whombat/client';
import { useSetWatchLimit, useTheAgent, type WatchLimitActions } from '@whombat/client/react';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { Modal, ModalTitle } from '../../../components/Modal';
import { useToast } from '../../../components/Toast';
import { Field } from '../../connectors/CatalogParts';
import things from '../Things.module.css';
import styles from './Hold.module.css';

/** A refusal's words stay up long enough to read. */
const FAILED_TOAST_MS = 6000;

/** A server's limits, saying how each change went in a toast with Undo. */
export function useServerLimits(burrow: string, thing: string): WatchLimitActions {
  const toast = useToast();
  const { agent } = useTheAgent(burrow);
  return useSetWatchLimit(burrow, thing, {
    assistantName: agent?.name ?? null,
    note: (message, o) => {
      if (!message) return;
      if (o?.undo) toast.show(message, { action: { label: 'Undo', onAction: o.undo } });
      else toast.show(message, o?.failed ? { duration: FAILED_TOAST_MS } : undefined);
    },
  });
}

/** The sheet's state where it is opened from: `openFor(view)` and the sheet to draw once. */
export function useLimitSheet(
  burrow: string,
  thing: string,
): {
  openFor: (view: LimitView) => void;
  sheet: ReactNode;
} {
  const actions = useServerLimits(burrow, thing);
  const [view, setView] = useState<LimitView | null>(null);
  const openFor = useCallback((v: LimitView) => setView(v), []);
  return {
    openFor,
    sheet: view ? (
      <ChangeLimitDialog
        key={`${view.check}|${view.subject?.id ?? ''}`}
        view={view}
        actions={actions}
        onClose={() => setView(null)}
      />
    ) : null,
  };
}

export function ChangeLimitDialog({
  view,
  actions,
  onClose,
}: {
  view: LimitView;
  actions: WatchLimitActions;
  onClose: () => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState(view.value === null ? '' : String(view.value));
  const [problem, setProblem] = useState<string | null>(null);
  const send = async (limit: number | null) => {
    setProblem(null);
    const ok = await actions.set({
      check: view.check,
      subject: view.subject,
      name: view.name,
      unit: view.unit,
      limit,
    });
    if (ok) onClose();
  };
  return (
    <Modal open onOpenChange={(o) => !o && !actions.busy && onClose()}>
      <ModalTitle className={things.dialogTitle}>{LIMIT_WORDS.title}</ModalTitle>
      <p className={things.dialogBody}>{view.about}</p>
      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const value = parseLimit(typed, view);
          if (typeof value !== 'number') setProblem(value.problem);
          else void send(value);
        }}
      >
        <Field
          id={`${id}-limit`}
          label={LIMIT_WORDS.label}
          help={`${view.rangeWords} ${view.defaultWords}`}
          problem={problem ?? undefined}
          after={<span className={styles.unit}>{view.unit}</span>}
        >
          <Input
            id={`${id}-limit`}
            size="md"
            inputMode="decimal"
            autoComplete="off"
            className={styles.limit}
            value={typed}
            placeholder={view.defaultValue !== null ? String(view.defaultValue) : undefined}
            invalid={problem !== null}
            onChange={(e) => {
              setTyped(e.target.value);
              setProblem(null);
            }}
          />
        </Field>
        <div className={things.dialogActions}>
          {view.own ? (
            <Button
              variant="ghost"
              className={things.spacer}
              disabled={actions.busy}
              onClick={() => void send(null)}
              aria-label={
                view.defaultValue !== null
                  ? `${LIMIT_WORDS.useDefault}: ${limitText(view.defaultValue, view.unit)}`
                  : LIMIT_WORDS.useDefault
              }
            >
              {LIMIT_WORDS.useDefault}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={actions.busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={actions.busy}
            aria-busy={actions.busy || undefined}
          >
            {LIMIT_WORDS.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
