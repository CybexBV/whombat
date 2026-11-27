/**
 * The Bluetooth sheet on the box's screen (BT-02…BT-07, BT-11; CG-204…CG-209): the paired devices with Connect or
 * Disconnect and Remove, and Add a device: the hint, the devices found nearby, then the pairing Whombat runs, followed
 * until it ends (the code in very large digits, or the Yes/No question). Whombat decides whether the screen may change
 * Bluetooth now (`mayChange`); when it may not, the sheet shows the paired devices read-only and says how to change
 * them. The console server's `/api/bluetooth…` ask the runtime (§2.4).
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import deskStyles from '../desk/desk.module.css';
import { useT } from '../i18n/react';
import {
  type BluetoothAnswer,
  type BluetoothDevice,
  type BluetoothPairing,
  missingOf,
  pairingRunning,
  parseBluetoothAnswer,
  parseDevice,
  parsePairing,
  parseScan,
  pollMs,
  SHEET_IDLE_MS,
  sortDevices,
} from '../lib/bluetooth';
import { btCopy, pairingView, refusalText } from '../lib/bluetoothCopy';
import type { Client } from '../lib/client';
import { deskErrorCode } from '../lib/desk';
import { useHoldFocus, useLastInput, useNow } from '../ui/hooks';
import { Icon as WifiIcon } from '../wifi/icons';
import { Outcome } from '../wifi/parts';
import wifiStyles from '../wifi/wifi.module.css';
import { CodeDigits, FoundList, PairedList } from './parts';

export type BluetoothStep =
  | { kind: 'list' }
  | { kind: 'remove'; device: BluetoothDevice }
  | { kind: 'add' }
  /** A pairing Whombat runs, followed by its id. */
  | { kind: 'pairing'; id: string };

/** Fixtures only: where the sheet starts. */
export interface BluetoothSheetInitial {
  step?: BluetoothStep;
  error?: string;
}

export function BluetoothSheet({
  client,
  onClose,
  initial,
}: {
  client: Client;
  onClose: () => void;
  initial?: BluetoothSheetInitial;
}) {
  const t = useT();
  const BT = btCopy(t);

  const [answer, setAnswer] = useState<BluetoothAnswer | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [step, setStep] = useState<BluetoothStep>(initial?.step ?? { kind: 'list' });
  const [found, setFound] = useState<BluetoothDevice[]>([]);
  const [error, setError] = useState<string | null>(initial?.error ?? null);
  /** What runs now: a device's connect or disconnect (its address), a scan, a pairing starting, an answer, a removal. */
  const [busy, setBusy] = useState<string | null>(null);
  const [followed, setFollowed] = useState<BluetoothPairing | null>(null);
  /** The pairings this sheet started: closing it stops only those. */
  const started = useRef(new Set<string>());
  const card = useRef<HTMLElement>(null);
  useHoldFocus(card);

  const load = useCallback(async () => {
    const res = await client.get('/api/bluetooth').catch(() => null);
    const a = res?.status === 200 ? parseBluetoothAnswer(res.body) : null;
    setUnreadable(!a);
    if (a) setAnswer(a);
    return a;
  }, [client]);

  // Every second while the box looks or pairs, else every 2 s (CG-205); the poll's pace follows the last answer.
  const pace = pollMs(answer?.bluetooth);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), pace);
    return () => clearInterval(t);
  }, [load, pace]);

  const bt = answer?.bluetooth ?? null;
  const may = answer?.mayChange ?? false;
  const scanning = bt?.scan != null;
  // What the box found, kept when the minute is over (still choosable: a device gone answers `not_found`).
  useEffect(() => {
    if (bt?.scan) setFound(bt.scan.devices);
  }, [bt?.scan]);

  const look = useCallback(async () => {
    setBusy('scan');
    setError(null);
    const res = await client.post('/api/bluetooth/scan', {}).catch(() => null);
    setBusy(null);
    const s = res?.status === 200 ? parseScan((res.body as { scan?: unknown } | null)?.scan) : null;
    if (s) setFound(s.devices);
    else setError(refusalText(res ? deskErrorCode(res.body) : null, t));
    void load();
  }, [client, load, t]);

  // The pairing this sheet follows, as Whombat reports it; while the screen may change Bluetooth, a pairing that runs
  // while the list shows (one started in the app, or before the page reloaded) is followed too (CG-207).
  const pairingId = step.kind === 'pairing' ? step.id : null;
  useEffect(() => {
    const p = bt?.pairing;
    if (!p) return;
    if (pairingId && p.id === pairingId) setFollowed(p);
    else if (step.kind === 'list' && may && pairingRunning(p)) {
      setFollowed(p);
      setStep({ kind: 'pairing', id: p.id });
    }
  }, [bt?.pairing, pairingId, step.kind, may]);

  // Whombat said the screen may not change Bluetooth (or locked it meanwhile): back to the list, read-only. A pairing
  // already running is still shown to its end.
  useEffect(() => {
    if (answer && !answer.mayChange && (step.kind === 'add' || step.kind === 'remove')) {
      setStep({ kind: 'list' });
      setError(null);
    }
  }, [answer, step.kind]);

  // Opening Add a device starts looking.
  const lookedFor = useRef(false);
  useEffect(() => {
    if (step.kind !== 'add') {
      lookedFor.current = false;
      return;
    }
    if (lookedFor.current || !may) return;
    lookedFor.current = true;
    void look();
  }, [step.kind, may, look]);

  const running = step.kind === 'pairing' && pairingRunning(followed);
  const closeSheet = useCallback(() => {
    // Closing the sheet stops a pairing it started (the app's dialog does the same).
    if (running && followed && started.current.has(followed.id))
      void client.post('/api/bluetooth/cancel', { pairingId: followed.id }).catch(() => null);
    onClose();
  }, [running, followed, client, onClose]);

  // Untouched for 2 minutes the sheet closes, unless a pairing runs (CG-108's rule).
  const now = useNow(1000);
  const lastInput = useLastInput();
  useEffect(() => {
    if (!running && now - lastInput >= SHEET_IDLE_MS) onClose();
  }, [now, lastInput, running, onClose]);

  /** A refusal in words; `fallback` for one the words don't name (no answer, `unavailable`, a broken answer). */
  const refused = (res: { status: number; body: unknown } | null, fallback?: string) => {
    const code = res ? deskErrorCode(res.body) : null;
    if (code === 'locked') {
      void load();
      if (step.kind === 'add' || step.kind === 'remove') setStep({ kind: 'list' });
    }
    const named =
      code === 'locked' || (code !== null && code !== 'unavailable' && BT.errors[code] !== undefined);
    setError(named || !fallback ? refusalText(code, t) : fallback);
  };

  const pick = async (d: BluetoothDevice) => {
    setBusy('pair');
    setError(null);
    const res = await client.post('/api/bluetooth/pair', { address: d.address }).catch(() => null);
    setBusy(null);
    const p = res?.status === 200 ? parsePairing((res.body as { pairing?: unknown } | null)?.pairing) : null;
    if (p) {
      started.current.add(p.id);
      setFollowed(p);
      setStep({ kind: 'pairing', id: p.id });
      void load();
      return;
    }
    refused(res);
  };

  const toggle = async (d: BluetoothDevice) => {
    setBusy(d.address);
    setError(null);
    const path = d.connected ? '/api/bluetooth/disconnect' : '/api/bluetooth/connect';
    const res = await client.post(path, { address: d.address }).catch(() => null);
    setBusy(null);
    const after = res?.status === 200 ? parseDevice((res.body as { device?: unknown } | null)?.device) : null;
    if (!after) refused(res, d.connected ? undefined : BT.connectFailed(d.name));
    // The service waited for the device and it didn't come (switched off, out of reach).
    else if (!d.connected && !after.connected) setError(BT.connectFailed(d.name));
    void load();
  };

  const remove = async (d: BluetoothDevice) => {
    setBusy('remove');
    setError(null);
    const res = await client.post('/api/bluetooth/forget', { address: d.address }).catch(() => null);
    setBusy(null);
    if (res?.status === 200) setStep({ kind: 'list' });
    else refused(res);
    void load();
  };

  /** Stop the pairing (Cancel, or No to the question) and choose again. */
  const answerPairing = async (p: BluetoothPairing, accept: boolean | null) => {
    setBusy('answer');
    setError(null);
    const res = await client
      .post(
        accept === null ? '/api/bluetooth/cancel' : '/api/bluetooth/confirm',
        accept === null ? { pairingId: p.id } : { pairingId: p.id, accept },
      )
      .catch(() => null);
    setBusy(null);
    const next =
      res?.status === 200 ? parsePairing((res.body as { pairing?: unknown } | null)?.pairing) : null;
    if (!next) {
      refused(res);
      return;
    }
    if (accept) setFollowed(next);
    else {
      setFollowed(null);
      setStep({ kind: 'add' });
    }
    void load();
  };

  const missing = bt ? missingOf(bt) : null;
  const close = (
    <button type="button" className={deskStyles.btn} onClick={closeSheet}>
      {BT.close}
    </button>
  );
  const primary = `${deskStyles.btn} ${deskStyles.btnPrimary}`;
  let body: ReactNode;
  let buttons: ReactNode;

  if (step.kind === 'pairing') {
    const p = followed;
    const v = p ? pairingView(p, t) : null;
    if (p && (p.phase === 'code' || p.phase === 'confirm') && p.code) {
      body = (
        <>
          <Head title={v?.title ?? ''} />
          {/* The typed digits only when the keyboard says how many (BT-04). */}
          <CodeDigits code={p.code} typed={p.phase === 'code' ? p.typed : undefined} />
          {error && <p className={wifiStyles.error}>{error}</p>}
        </>
      );
      buttons =
        p.phase === 'confirm' ? (
          <>
            <button
              type="button"
              className={primary}
              autoFocus
              aria-disabled={busy !== null}
              data-busy={busy !== null || undefined}
              onClick={() => busy === null && void answerPairing(p, true)}
            >
              {BT.yes}
            </button>
            <button
              type="button"
              className={deskStyles.btn}
              aria-disabled={busy !== null}
              onClick={() => busy === null && void answerPairing(p, false)}
            >
              {BT.no}
            </button>
          </>
        ) : (
          <CancelButton busy={busy !== null} onCancel={() => void answerPairing(p, null)} />
        );
    } else {
      body = (
        <>
          <Outcome
            title={v?.title ?? BT.title}
            line={v?.line ?? null}
            tone={v?.tone ?? 'mut'}
            running={v?.running ?? true}
          />
          {error && <p className={wifiStyles.error}>{error}</p>}
        </>
      );
      if (!p || v?.running)
        buttons = p ? (
          <CancelButton busy={busy !== null} onCancel={() => void answerPairing(p, null)} />
        ) : (
          close
        );
      else if (p.phase === 'done')
        buttons = (
          <button
            type="button"
            className={primary}
            autoFocus
            onClick={() => {
              setStep({ kind: 'list' });
              void load();
            }}
          >
            {BT.done}
          </button>
        );
      else
        buttons = (
          <>
            {may && (
              <button type="button" className={primary} autoFocus onClick={() => setStep({ kind: 'add' })}>
                {BT.tryAgain}
              </button>
            )}
            {close}
          </>
        );
    }
  } else if (step.kind === 'remove') {
    const d = step.device;
    body = (
      <>
        <Head title={BT.removeTitle(d.name)} line={BT.removeLead} />
        {error && <p className={wifiStyles.error}>{error}</p>}
      </>
    );
    buttons = (
      <>
        <button
          type="button"
          className={primary}
          autoFocus
          aria-disabled={busy !== null}
          data-busy={busy !== null || undefined}
          onClick={() => busy === null && void remove(d)}
        >
          {busy === 'remove' ? BT.removing : BT.remove}
        </button>
        <button
          type="button"
          className={deskStyles.btn}
          onClick={() => {
            setError(null);
            setStep({ kind: 'list' });
          }}
        >
          {BT.cancel}
        </button>
      </>
    );
  } else if (step.kind === 'add') {
    const looking = scanning || busy === 'scan';
    body = (
      <>
        <Head title={BT.add} line={BT.hint} />
        <FoundList devices={found} looking={looking} onPick={busy === null ? (d) => void pick(d) : null} />
        {error && <p className={wifiStyles.error}>{error}</p>}
      </>
    );
    buttons = (
      <>
        <button
          type="button"
          className={deskStyles.btn}
          aria-disabled={looking}
          data-busy={looking || undefined}
          onClick={() => !looking && void look()}
        >
          <WifiIcon name="again" />
          &nbsp;{BT.again}
        </button>
        <span className={wifiStyles.grow} />
        <button
          type="button"
          className={deskStyles.btn}
          onClick={() => {
            setError(null);
            setStep({ kind: 'list' });
          }}
        >
          {BT.back}
        </button>
      </>
    );
  } else {
    // The paired devices: changeable, read-only (BT-02), or Bluetooth that can't be used.
    const readOnly = answer !== null && !may;
    const actions = may && !missing;
    body = (
      <>
        <Head title={BT.yourDevices} line={missing ? BT.missing[missing] : null} />
        {unreadable && !bt ? (
          <p className={wifiStyles.error}>{BT.unreadable}</p>
        ) : (
          (!missing || (bt?.devices.length ?? 0) > 0) && (
            <PairedList
              devices={sortDevices(bt?.devices ?? [])}
              loading={!bt}
              busy={busy}
              onToggle={actions ? (d) => void toggle(d) : null}
              onRemove={
                actions
                  ? (d) => {
                      setError(null);
                      setStep({ kind: 'remove', device: d });
                    }
                  : null
              }
            />
          )
        )}
        {error && <p className={wifiStyles.error}>{error}</p>}
        {readOnly && !missing && <p className={wifiStyles.note}>{BT.readOnly}</p>}
      </>
    );
    buttons = actions ? (
      <>
        <button
          type="button"
          className={primary}
          aria-disabled={busy !== null}
          onClick={() => {
            if (busy !== null) return;
            setError(null);
            setStep({ kind: 'add' });
          }}
        >
          <WifiIcon name="plus" />
          &nbsp;{BT.add}
        </button>
        {close}
      </>
    ) : (
      <>
        <span className={wifiStyles.grow} />
        {close}
      </>
    );
  }

  return (
    // The sheet's own keys stay here: the desk's (Talk, the PIN pad) don't see them (CG-109).
    // biome-ignore lint/a11y/noStaticElementInteractions: catches bubbling keys and clicks, nothing of its own
    <div
      className={wifiStyles.layer}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') closeSheet();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={wifiStyles.scrim}
        aria-label={BT.close}
        tabIndex={-1}
        onClick={closeSheet}
      />
      <div className={wifiStyles.sheet}>
        <section
          ref={card}
          className={wifiStyles.card}
          role="dialog"
          aria-modal="true"
          aria-label={BT.title}
          tabIndex={-1}
        >
          {body}
          <div className={wifiStyles.buttons}>{buttons}</div>
        </section>
      </div>
    </div>
  );
}

function CancelButton({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  const t = useT();
  const BT = btCopy(t);

  return (
    <>
      <span className={wifiStyles.grow} />
      <button
        type="button"
        className={deskStyles.btn}
        aria-disabled={busy}
        data-busy={busy || undefined}
        onClick={() => !busy && onCancel()}
      >
        {BT.cancel}
      </button>
    </>
  );
}

/** The sheet's head: the kicker, the title, a line under it. */
function Head({ title, line }: { title: string; line?: string | null }) {
  const t = useT();
  const BT = btCopy(t);

  return (
    <div className={wifiStyles.head}>
      <span className={wifiStyles.kicker}>{BT.kicker}</span>
      <h2 className={wifiStyles.title}>{title}</h2>
      {line && <p className={wifiStyles.line}>{line}</p>}
    </div>
  );
}
