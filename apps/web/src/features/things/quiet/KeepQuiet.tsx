/**
 * Keep quiet for a while (Whombat; session minor 9): the sheet a
 * page's ⋯ “Keep quiet…” opens — For an hour, Until tonight, Until tomorrow morning or a time picked, each with when it
 * ends, and an optional note — and the line under a page's head while it holds: “Quiet until 23:00 · Moving the NAS”
 * with End now for who may end it, or “Not answering while pve-02 is down” with a link to its cause. The toast says
 * until when with Undo (which ends it). Built from the app's dialog, radio cards, fields and strip rows.
 */
import {
  type HoldView,
  KEEP_QUIET_WORDS,
  type KeepQuietChoice,
  keepQuietBody,
  keepQuietOptions,
  keepQuietTitle,
  pickerValue,
} from '@whombat/client';
import { type KeepQuietActions, useKeepQuiet, useSessionProtocol } from '@whombat/client/react';
import { thingId } from '@whombat/core';
import { KEEP_QUIET_MINOR, protocolAtLeast } from '@whombat/protocol/session';
import { BellOff, Power } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Input } from '../../../components/Input';
import { Modal, ModalTitle } from '../../../components/Modal';
import { useToast } from '../../../components/Toast';
import { Field, OptionCards } from '../../connectors/CatalogParts';
import { useBurrowContext, useNow } from '../../messaging/useRoom';
import { AppLink } from '../parts';
import things from '../Things.module.css';
import styles from './Hold.module.css';

/** A refusal's words stay up long enough to read. */
const FAILED_TOAST_MS = 6000;

/** Whether this Whombat keeps things quiet for a while (session minor 9). */
export function useKeepsQuiet(): boolean {
  return protocolAtLeast(useSessionProtocol(), KEEP_QUIET_MINOR);
}

/** Keep quiet and End now for one thing, each saying how it went in a toast (Undo on Keep quiet ends it). */
export function useThingKeepQuiet(burrow: string, thing: string, name: string): KeepQuietActions {
  const { timeZone } = useBurrowContext(burrow);
  const toast = useToast();
  return useKeepQuiet(burrow, thing, {
    name,
    timeZone,
    note: (message, o) => {
      if (!message) return;
      if (o?.undo) toast.show(message, { action: { label: 'Undo', onAction: o.undo } });
      else toast.show(message, o?.failed ? { duration: FAILED_TOAST_MS } : undefined);
    },
  });
}

/**
 * End now for a server's lines held by its window, where a tab draws them away from the page's head; null on a Whombat
 * that doesn't keep things quiet. The toast says so, as the head's End now does.
 */
export function useServerEndQuiet(
  burrow: string,
  serverId: string,
  name: string,
): { onEnd: (() => void) | null; ending: boolean } {
  const keeps = useKeepsQuiet();
  const actions = useThingKeepQuiet(burrow, thingId('server', serverId), name);
  return { onEnd: keeps ? () => void actions.end() : null, ending: actions.busy };
}

/** Two hours from now, on the hour: where Pick a time starts. */
function firstPick(now: number, timeZone: string): string {
  return `${pickerValue(now + 2 * 60 * 60_000, timeZone).slice(0, 14)}00`;
}

/**
 * The sheet: how long (radio cards with when each ends), the time when picking one, the note, then Cancel and Keep
 * quiet. A refusal stays in the sheet; it closes once the thing is kept quiet.
 */
export function KeepQuietDialog({
  open,
  burrow,
  name,
  actions,
  onClose,
}: {
  open: boolean;
  burrow: string;
  name: string;
  actions: KeepQuietActions;
  onClose: () => void;
}) {
  const ids = useId();
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(30_000);
  const options = keepQuietOptions(now, timeZone);
  const [choice, setChoice] = useState<KeepQuietChoice>('hour');
  const [picked, setPicked] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // A choice that stopped being offered while the sheet was open (Until tonight at 22:30) falls back to an hour.
  const chosen = options.some((o) => o.choice === choice) ? choice : 'hour';
  const close = () => {
    setChoice('hour');
    setPicked('');
    setNote('');
    setProblem(null);
    onClose();
  };
  const submit = async () => {
    const built = keepQuietBody(chosen, { now: Date.now(), timeZone, picked, note });
    if ('problem' in built) {
      setProblem(built.problem);
      return;
    }
    setProblem(null);
    const done = await actions.keep(built.body);
    if (done === true) close();
    else setProblem(done.problem);
  };
  return (
    <Modal open={open} onOpenChange={(o) => !o && !actions.busy && close()}>
      <ModalTitle className={things.dialogTitle}>{keepQuietTitle(name)}</ModalTitle>
      <p className={things.dialogBody}>{KEEP_QUIET_WORDS.body}</p>
      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <OptionCards
          name={`${ids}-until`}
          label="How long"
          options={options.map((o) => ({
            value: o.choice,
            label: o.label,
            line: o.ends ? `Until ${o.ends}` : null,
          }))}
          value={chosen}
          disabled={actions.busy}
          onChange={(v) => {
            const next = v as KeepQuietChoice;
            setChoice(next);
            setProblem(null);
            if (next === 'pick' && !picked) setPicked(firstPick(Date.now(), timeZone));
          }}
        />
        {chosen === 'pick' ? (
          <Field
            id={`${ids}-time`}
            label={KEEP_QUIET_WORDS.pickLabel}
            help={`In your Whombat’s time zone, ${timeZone}.`}
            problem={problem ?? undefined}
          >
            <Input
              id={`${ids}-time`}
              size="md"
              type="datetime-local"
              className={styles.time}
              value={picked}
              min={pickerValue(now, timeZone)}
              invalid={problem !== null}
              onChange={(e) => {
                setPicked(e.target.value);
                setProblem(null);
              }}
            />
          </Field>
        ) : null}
        <Field id={`${ids}-note`} label={KEEP_QUIET_WORDS.note}>
          <Input
            id={`${ids}-note`}
            size="md"
            maxLength={120}
            autoComplete="off"
            placeholder={KEEP_QUIET_WORDS.notePlaceholder}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {problem && chosen !== 'pick' ? (
          <p className={things.error} role="alert">
            {problem}
          </p>
        ) : null}
        <div className={things.dialogActions}>
          <Button variant="secondary" onClick={close} disabled={actions.busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={actions.busy}
            aria-busy={actions.busy || undefined}
          >
            {KEEP_QUIET_WORDS.button}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The line under a page's head while it is held: kept quiet, with who kept it so in its tooltip and End
 * now; or down or quiet because of something else, with a link to the cause's page.
 */
export function HoldLine({
  view,
  onEnd,
  busy = false,
  className,
}: {
  view: HoldView;
  onEnd?: (() => void) | null;
  busy?: boolean;
  className?: string;
}) {
  return (
    <section
      className={cx(styles.hold, className)}
      aria-label={view.kind === 'window' ? 'Kept quiet' : 'Why it isn’t answering'}
      data-hold={view.kind}
    >
      <span className={styles.tile} aria-hidden="true">
        <Icon icon={view.kind === 'window' ? BellOff : Power} size={18} />
      </span>
      <p className={styles.text} title={view.who ?? undefined}>
        <b>{view.words}</b>
        {view.who ? <span className={styles.who}>{view.who}</span> : null}
      </p>
      {view.endNow && onEnd ? (
        <Button size="sm" variant="secondary" className={styles.act} disabled={busy} onClick={onEnd}>
          {KEEP_QUIET_WORDS.endNow}
        </Button>
      ) : view.link ? (
        <AppLink href={view.link.href} className={styles.link}>
          {view.link.label}
        </AppLink>
      ) : null}
    </section>
  );
}
