/**
 * Settings → This Whombat → Overview → NETWORK (Whombat hardware-support.md HD-05, HD-06, HD-10, HD-11;
 * hardware-support-web.md AP-3223…AP-3227): where the Whombat offers `host.network`, after SCREEN —
 *
 * - the connection rows: each cable (“Cable · Connected” and its address), the Wi-Fi (“Wi-Fi · Home · Strong signal”
 *   with its bars and **Join a Wi-Fi network**), or why there is none (“No Wi-Fi card”; “This Wi-Fi card has no driver
 *   yet.” with **See hardware**), and “Can’t reach Whombat right now” first when the box couldn't;
 * - a change while it runs (“Joining Home…”, “Checking that … reaches the internet there…”), and how it ended;
 * - the saved networks, the one in use first, each with **Forget** (asked once);
 * - **Use Wi-Fi only** on the Wi-Fi while a cable carries the box, and on Wi-Fi only “Cable · Switched off” with **Use the
 *   cable again** (each asked once), the cable change while it runs and how it ended, the servers following the box's
 *   new address (with **Point them here** for those that don't) and how to keep the old address (Whombat
 *   network-move.md; app network-move-app.md).
 *
 * Every word is the client's `NETWORK_TEXT`; `networkSectionView` decides the rows.
 */
import {
  type CableChange,
  type CableUse,
  type HostNetwork,
  NETWORK_TEXT,
  type NetworkApi,
  type NetworkChange,
  type NetworkChangeView,
  type NetworkPoller,
  type NetworkRowView,
  networkErrorText,
  networkSectionView,
  type SavedNetworkView,
  type ServerMoveView,
  type WifiSignal,
  wifiOnlyDialogView,
} from '@whombat/client';
import { Lock } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button, ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import m from './Machine.module.css';
import { useMachineHere, useNetwork } from './useMachine';
import { WifiDialog } from './WifiDialog';

const T = NETWORK_TEXT;

/** Point them here (the dialog on Connections). */
const REPOINT_HREF = '/things/servers?repoint=1';

/** NETWORK, on a Whombat with a manager; nothing elsewhere. `onHardware` opens About → HARDWARE. */
export function NetworkSection({ burrow, onHardware }: { burrow: string; onHardware?: () => void }) {
  const here = useMachineHere(burrow);
  const { state, poller } = useNetwork(here.network);
  if (!here.network || !poller || state.reason === 'not_managed') return null;
  if (!state.network && state.reason !== 'unavailable') return null;
  return (
    <Network api={here.network} poller={poller} name={here.name} state={state} onHardware={onHardware} />
  );
}

function Network({
  api,
  poller,
  name,
  state,
  onHardware,
}: {
  api: NetworkApi;
  poller: NetworkPoller;
  name: string;
  state: ReturnType<NetworkPoller['getState']>;
  onHardware: (() => void) | undefined;
}) {
  const id = useId();
  const [joining, setJoining] = useState(false);
  const [forgetting, setForgetting] = useState<SavedNetworkView | null>(null);
  const [switching, setSwitching] = useState<CableUse | null>(null);
  const network = state.network;
  const v = network
    ? networkSectionView(network, {
        name,
        seenRunning: state.seenRunning,
        cableSeenRunning: state.cableSeenRunning,
        move: state.move,
      })
    : null;
  return (
    <section className={styles.section} aria-labelledby={id} data-network="">
      <SectionLabel as="h2" id={id}>
        {T.section}
      </SectionLabel>
      <div className={styles.card}>
        {!v ? (
          <div className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>{T.unavailable}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => poller.refresh()}>
              {T.tryAgain}
            </Button>
          </div>
        ) : (
          <>
            {v.rows.map((row) => (
              <ConnectionRow
                key={row.key}
                row={row}
                canJoin={v.canJoin}
                connected={network?.wifi?.state === 'connected'}
                onJoin={() => setJoining(true)}
                onSwitch={setSwitching}
                onHardware={onHardware}
              />
            ))}
            {v.change ? <ChangeRow change={v.change} kind="network-change" /> : null}
            {v.cableChange ? <ChangeRow change={v.cableChange} kind="network-cable-change" /> : null}
            {v.move ? <MoveRow move={v.move} /> : null}
            {v.tip ? (
              <div className={styles.row} data-row="network-tip">
                <span className={styles.rowMain}>
                  <span className={styles.rowMeta}>{v.tip}</span>
                </span>
              </div>
            ) : null}
            {v.saved.map((s) => (
              <div key={s.ssid} className={styles.row} data-row="network-saved">
                <span className={m.lock} aria-hidden="true">
                  {s.security === 'open' ? null : <Icon icon={Lock} size={13} />}
                </span>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{s.ssid}</span>
                  <span className={styles.rowMeta}>{s.meta}</span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={v.busy}
                  aria-label={`${T.forget} ${s.ssid}`}
                  onClick={() => setForgetting(s)}
                >
                  {T.forget}
                </Button>
              </div>
            ))}
          </>
        )}
      </div>
      <WifiDialog
        open={joining}
        onClose={() => setJoining(false)}
        api={api}
        name={name}
        change={network?.change ?? null}
        onStarted={(change) => poller.started(change)}
      />
      <ForgetDialog
        saved={forgetting}
        onClose={() => setForgetting(null)}
        api={api}
        name={name}
        onStarted={(change) => poller.started(change)}
      />
      {network ? (
        <CableDialog
          use={switching}
          network={network}
          onClose={() => setSwitching(null)}
          api={api}
          name={name}
          onStarted={(change) => poller.cableStarted(change)}
        />
      ) : null}
    </section>
  );
}

/** A change as one line, read out as it moves: the running dot while it runs, then how it ended. */
function ChangeRow({ change, kind }: { change: NetworkChangeView; kind: string }) {
  return (
    <div className={styles.row} data-row={kind} role="status">
      <StatusDot tone={change.dot} size={8} label={null} className={change.running ? m.running : undefined} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{change.title}</span>
        {change.meta ? <span className={styles.rowMeta}>{change.meta}</span> : null}
      </span>
    </div>
  );
}

/** The servers following the box's new address, and Point them here for those that haven't after 5 minutes. */
function MoveRow({ move }: { move: ServerMoveView }) {
  const navigateHref = useNavigateHref();
  return (
    <div className={styles.row} data-row="network-move" role="status">
      <StatusDot tone={move.dot} size={8} label={null} className={move.running ? m.running : undefined} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{move.title}</span>
        {move.missing ? <span className={styles.rowMeta}>{move.missing}</span> : null}
      </span>
      {move.repoint ? (
        <ButtonLink
          variant="secondary"
          size="sm"
          href={REPOINT_HREF}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            navigateHref(REPOINT_HREF);
          }}
        >
          {T.move.pointHere}
        </ButtonLink>
      ) : null}
    </div>
  );
}

/** Four rising bars, `signal` of them lit; the words say it for screen readers. */
export function SignalBars({ signal }: { signal: WifiSignal }) {
  return (
    <span className={m.bars} aria-hidden="true" data-signal={signal}>
      {[1, 2, 3, 4].map((n) => (
        <span key={n} className={cx(m.bar, n <= signal && m.lit)} />
      ))}
    </span>
  );
}

function ConnectionRow({
  row,
  canJoin,
  connected,
  onJoin,
  onSwitch,
  onHardware,
}: {
  row: NetworkRowView;
  canJoin: boolean;
  connected: boolean;
  onJoin: () => void;
  onSwitch: (use: CableUse) => void;
  onHardware: (() => void) | undefined;
}) {
  return (
    <div className={styles.row} data-row={`network-${row.kind}`}>
      <StatusDot tone={row.dot} size={8} label={null} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{row.title}</span>
        {row.meta ? <span className={styles.rowMeta}>{row.meta}</span> : null}
      </span>
      {row.signal !== null ? <SignalBars signal={row.signal} /> : null}
      {row.action === 'wifiOnly' ? (
        <Button variant="secondary" size="sm" onClick={() => onSwitch('wifi')}>
          {T.useWifiOnly}
        </Button>
      ) : null}
      {row.action === 'cable' ? (
        <Button variant="secondary" size="sm" onClick={() => onSwitch('cable')}>
          {T.useCableAgain}
        </Button>
      ) : null}
      {row.kind === 'wifi' ? (
        <Button variant={connected ? 'secondary' : 'primary'} size="sm" disabled={!canJoin} onClick={onJoin}>
          {T.join}
        </Button>
      ) : null}
      {row.hardware && onHardware ? (
        <Button variant="secondary" size="sm" onClick={onHardware}>
          {T.seeHardware}
        </Button>
      ) : null}
    </div>
  );
}

/** Forget (asked once): a saved network the box won't join again by itself. */
function ForgetDialog({
  saved,
  onClose,
  api,
  name,
  onStarted,
}: {
  saved: SavedNetworkView | null;
  onClose: () => void;
  api: NetworkApi;
  name: string;
  onStarted: (change: NetworkChange) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The last network asked about stays in the dialog while it closes.
  const [shown, setShown] = useState(saved);
  useEffect(() => {
    if (saved) setShown(saved);
    else setNote(null);
  }, [saved]);
  const forget = async () => {
    if (!saved) return;
    setBusy(true);
    try {
      onStarted(await api.forget(saved.ssid));
      onClose();
    } catch (error) {
      setNote(networkErrorText(error, name));
    } finally {
      setBusy(false);
    }
  };
  const F = T.forgetDialog;
  return (
    <Modal open={saved !== null} onOpenChange={(next) => (next ? null : onClose())} width="md">
      <div className={tw.dialog}>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{shown ? F.title(shown.ssid) : ''}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>
            {shown ? F.lead(name, shown.security !== 'open') : ''}
          </ModalDescription>
        </div>
        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {T.dialog.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void forget()}>
            {busy ? F.busy : F.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Use Wi-Fi only, or Use the cable again (asked once): what happens, the guard, and when the Wi-Fi is another
 * network than the cable that the servers can't follow by themselves. A refusal stays in the dialog.
 */
function CableDialog({
  use,
  network,
  onClose,
  api,
  name,
  onStarted,
}: {
  use: CableUse | null;
  network: HostNetwork;
  onClose: () => void;
  api: NetworkApi;
  name: string;
  onStarted: (change: CableChange) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What was asked stays in the dialog while it closes.
  const [shown, setShown] = useState(use);
  useEffect(() => {
    if (use) setShown(use);
    else setNote(null);
  }, [use]);
  const submit = async () => {
    if (!use) return;
    setBusy(true);
    try {
      onStarted(await api.setCable(use));
      onClose();
    } catch (error) {
      setNote(networkErrorText(error, name));
    } finally {
      setBusy(false);
    }
  };
  const wifi = shown !== 'cable';
  const d = wifiOnlyDialogView(network, name);
  const C = T.cableDialog;
  return (
    <Modal open={use !== null} onOpenChange={(next) => (next ? null : onClose())} width="md">
      <div className={tw.dialog} data-dialog={wifi ? 'wifi-only' : 'cable-again'}>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{wifi ? d.title : C.title}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{wifi ? d.lead : C.lead(name)}</ModalDescription>
        </div>
        {wifi ? <p className={m.hint}>{d.guard}</p> : null}
        {wifi && d.otherNetwork ? <p className={m.hint}>{d.otherNetwork}</p> : null}
        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {T.dialog.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void submit()}>
            {busy ? T.wifiOnlyDialog.busy : wifi ? T.wifiOnlyDialog.submit : C.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
