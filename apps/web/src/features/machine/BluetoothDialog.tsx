/**
 * Add a device (Whombat bluetooth.md BT-03, BT-04, BT-07, BT-11; bluetooth-web.md AP-3713…AP-3715): the hint to put the
 * device in pairing mode, then what the box finds while it looks (“Looking for devices…”: each device's icon, name and
 * bars, strongest first; **Look again** once the minute is over). Choosing one pairs it (`host.bluetooth.pair`) and the
 * dialog follows the pairing BLUETOOTH's poller reads: “Pairing with {name}…”, the code to type with the digits typed so
 * far, or “Does {name} show {code}?” with **No** and **Yes**, then “{name} is ready.” (Done) or why it didn't work
 * (**Try again** looks again). Closing the dialog while a pairing runs cancels it; **No** goes back to the list.
 */
import {
  BLUETOOTH_TEXT,
  type BluetoothApi,
  type BluetoothFoundRow,
  type BluetoothPairing,
  type BluetoothPoller,
  type BluetoothPollState,
  bluetoothErrorCode,
  bluetoothErrorText,
  bluetoothFoundRows,
  bluetoothKindText,
  bluetoothPairingRunning,
  bluetoothPairingView,
} from '@whombat/client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { StatusDot } from '../../components/StatusDot';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import { BLUETOOTH_ICONS } from './BluetoothSection';
import m from './Machine.module.css';
import { SignalBars } from './NetworkSection';

const T = BLUETOOTH_TEXT;
const D = T.dialog;

/** The list, or the pairing chosen from it (`declined`: the person answered No, so it goes back to the list). */
type Step = { at: 'list' } | { at: 'pairing'; pairing: BluetoothPairing; declined: boolean };

export function BluetoothDialog({
  open,
  onClose,
  api,
  poller,
  state,
}: {
  open: boolean;
  onClose: () => void;
  api: BluetoothApi;
  poller: BluetoothPoller;
  /** BLUETOOTH's state (the poller's): the scan and the pairing as the box tells them. */
  state: BluetoothPollState;
}) {
  const [step, setStep] = useState<Step>({ at: 'list' });
  /** The last list the box gave: it stays once the looking is over. */
  const [found, setFound] = useState<BluetoothFoundRow[]>([]);
  /** Asked to look, no answer yet. */
  const [starting, setStarting] = useState(false);
  const [lookNote, setLookNote] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const looking = useRef(0);
  const bluetooth = state.bluetooth;
  const scan = bluetooth?.scan ?? null;
  const paired = bluetooth?.devices;

  const look = async () => {
    const mine = ++looking.current;
    setStarting(true);
    setLookNote(null);
    setNote(null);
    try {
      const r = await api.scan();
      if (mine !== looking.current) return;
      if (r.scan) poller.scanned(r.scan);
      else setLookNote(r.reason === 'no_bluetooth' ? T.errors.no_bluetooth('') : D.couldNotLook);
    } catch {
      if (mine === looking.current) setLookNote(D.couldNotLook);
    } finally {
      if (mine === looking.current) setStarting(false);
    }
  };

  // Opening looks for devices; closing forgets the list and cancels a pairing that still runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening
  useEffect(() => {
    if (open) {
      void look();
      return;
    }
    looking.current += 1;
    setStep({ at: 'list' });
    setFound([]);
    setStarting(false);
    setLookNote(null);
    setNote(null);
    setBusy(false);
  }, [open]);

  // What the box finds, kept once it stops looking.
  useEffect(() => {
    if (scan) setFound(bluetoothFoundRows(scan, paired ?? []));
  }, [scan, paired]);

  // The pairing as the box tells it; one the person declined goes back to the list.
  const told = bluetooth?.pairing ?? null;
  useEffect(() => {
    if (!told) return;
    setStep((s) =>
      s.at === 'pairing' && s.pairing.id === told.id && s.pairing !== told ? { ...s, pairing: told } : s,
    );
  }, [told]);
  const declinedEnded = step.at === 'pairing' && step.declined && !bluetoothPairingRunning(step.pairing);
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the declined pairing ended
  useEffect(() => {
    if (!declinedEnded) return;
    setStep({ at: 'list' });
    void look();
  }, [declinedEnded]);

  const choose = async (row: BluetoothFoundRow) => {
    setBusy(true);
    setNote(null);
    try {
      const pairing = await api.pair(row.address);
      poller.pairing(pairing);
      setStep({ at: 'pairing', pairing, declined: false });
    } catch (error) {
      setNote(bluetoothErrorText(error, row.name));
      if (bluetoothErrorCode(error) === 'not_found')
        setFound((f) => f.filter((r) => r.address !== row.address));
    } finally {
      setBusy(false);
    }
  };

  const answer = async (accept: boolean) => {
    if (step.at !== 'pairing') return;
    setBusy(true);
    setNote(null);
    try {
      const pairing = await api.confirm(step.pairing.id, accept);
      poller.pairing(pairing);
      setStep({ at: 'pairing', pairing, declined: !accept });
    } catch (error) {
      setNote(bluetoothErrorText(error, step.pairing.name));
      poller.refresh();
    } finally {
      setBusy(false);
    }
  };

  /** Esc, the close button, Cancel and Done: a pairing that still runs is cancelled on the way out. */
  const close = () => {
    if (step.at === 'pairing' && bluetoothPairingRunning(step.pairing))
      api.cancel(step.pairing.id).then(
        (pairing) => poller.pairing(pairing),
        () => poller.refresh(),
      );
    onClose();
  };

  const again = () => {
    setStep({ at: 'list' });
    void look();
  };

  const pairing = step.at === 'pairing' ? step.pairing : null;
  const view = pairing ? bluetoothPairingView(pairing) : null;
  const lookingNow = starting || scan !== null;

  return (
    <Modal open={open} onOpenChange={(next) => (next ? null : close())} width="md">
      <div className={tw.dialog} data-bluetooth-dialog={view?.phase ?? 'list'}>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{pairing ? pairing.name : D.title}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>
            {pairing ? bluetoothKindText(pairing.kind) : D.hint}
          </ModalDescription>
        </div>

        {step.at === 'list' ? (
          <>
            {found.length > 0 ? (
              <ul className={m.list} aria-label={D.nearby}>
                {found.map((row) => (
                  <li key={row.address}>
                    <button
                      type="button"
                      className={m.network}
                      disabled={busy}
                      aria-label={row.label}
                      data-address={row.address}
                      onClick={() => void choose(row)}
                    >
                      <span className={m.slot} aria-hidden="true">
                        <Icon icon={BLUETOOTH_ICONS[row.icon]} size={18} />
                      </span>
                      <span className={m.networkText}>
                        <span className={m.networkName}>{row.name}</span>
                        <span className={m.networkMeta}>{row.kindText}</span>
                      </span>
                      {row.signal !== null ? <SignalBars signal={row.signal} /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={m.listNote} role="status">
                {lookingNow ? D.looking : (lookNote ?? D.none)}
              </p>
            )}
            <div className={m.listFoot}>
              {lookingNow && found.length > 0 ? (
                <span className={m.looking} role="status">
                  <StatusDot tone="mut" size={8} label={null} className={m.running} />
                  {D.looking}
                </span>
              ) : !lookingNow ? (
                <Button variant="link" onClick={() => void look()}>
                  {D.again}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}

        {view ? (
          <>
            <div className={m.outcome} role="status" data-outcome={view.phase}>
              <StatusDot
                tone={view.dot}
                size={8}
                label={null}
                className={view.running && !view.digits ? m.running : undefined}
              />
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{view.text}</span>
              </span>
            </div>
            {view.digits ? (
              <div className={m.code} aria-hidden="true" data-code="">
                {view.digits.map((d, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: a digit's place is its identity
                    key={i}
                    className={cx(
                      m.digit,
                      d.typed && m.typed,
                      view.phase === 'code' && !d.typed && view.digits?.[i - 1]?.typed !== false && m.next,
                    )}
                  >
                    {d.digit}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}

        <div className={tw.dialogActions}>
          {!view ? (
            <ModalClose asChild>
              <Button variant="secondary" size="lg">
                {D.cancel}
              </Button>
            </ModalClose>
          ) : view.asks ? (
            <>
              <Button variant="secondary" size="lg" disabled={busy} onClick={() => void answer(false)}>
                {D.no}
              </Button>
              <Button variant="primary" size="lg" disabled={busy} onClick={() => void answer(true)}>
                {D.yes}
              </Button>
            </>
          ) : view.phase === 'done' ? (
            <ModalClose asChild>
              <Button variant="primary" size="lg">
                {D.done}
              </Button>
            </ModalClose>
          ) : view.phase === 'failed' ? (
            <>
              <ModalClose asChild>
                <Button variant="secondary" size="lg">
                  {D.close}
                </Button>
              </ModalClose>
              <Button variant="primary" size="lg" onClick={again}>
                {D.tryAgain}
              </Button>
            </>
          ) : (
            <ModalClose asChild>
              <Button variant="secondary" size="lg">
                {D.cancel}
              </Button>
            </ModalClose>
          )}
        </div>
      </div>
    </Modal>
  );
}
