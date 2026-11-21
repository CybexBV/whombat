/**
 * Settings → This Whombat → Overview → BLUETOOTH (Whombat bluetooth.md BT-02, BT-05, BT-11; bluetooth-web.md
 * AP-3711…AP-3716): where the Whombat offers `host.bluetooth` and the machine has an adapter, after NETWORK —
 *
 * - why the box can't use Bluetooth (“This Bluetooth adapter has no driver yet.”, “Bluetooth is switched off.”) with
 *   **See hardware**;
 * - a pairing that runs, from here or the box's screen (“Pairing with Magic Keyboard…”);
 * - the paired devices, connected first: the kind's icon, the name, “Connected · Battery 80 %” or “Not connected”, and a
 *   ⋯ menu with Connect or Disconnect and Remove (asked once);
 * - **Add a device**, which opens the dialog that looks for devices and pairs one.
 *
 * Every word is the client's `BLUETOOTH_TEXT`; `bluetoothSectionView` decides the rows.
 */
import {
  BLUETOOTH_TEXT,
  type BluetoothApi,
  type BluetoothDeviceRow,
  type BluetoothIcon,
  type BluetoothPoller,
  type BluetoothPollState,
  bluetoothErrorText,
  bluetoothSectionView,
  bluetoothShown,
} from '@whombat/client';
import {
  Bluetooth as BluetoothMark,
  Ellipsis,
  Gamepad2,
  Headphones,
  Headset,
  Keyboard,
  type LucideIcon,
  Mouse,
  Speaker,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { ContextMenuItem } from '../../app/shell/ContextMenu';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import { MenuButton } from '../things/manage/MenuButton';
import { BluetoothDialog } from './BluetoothDialog';
import m from './Machine.module.css';
import { useBluetooth, useMachineHere } from './useMachine';

const T = BLUETOOTH_TEXT;

/** Each kind's icon (the client names them in Lucide's words, so the phone draws the same ones). */
export const BLUETOOTH_ICONS: Record<BluetoothIcon, LucideIcon> = {
  keyboard: Keyboard,
  mouse: Mouse,
  headphones: Headphones,
  headset: Headset,
  speaker: Speaker,
  'gamepad-2': Gamepad2,
  bluetooth: BluetoothMark,
};

/** BLUETOOTH, on a Whombat whose machine has an adapter; nothing elsewhere. `onHardware` opens HARDWARE. */
export function BluetoothSection({ burrow, onHardware }: { burrow: string; onHardware?: () => void }) {
  const here = useMachineHere(burrow);
  const { state, poller } = useBluetooth(here.bluetooth);
  if (!here.bluetooth || !poller || state.reason === 'not_managed') return null;
  if (!state.bluetooth && state.reason !== 'unavailable') return null;
  if (state.bluetooth && !bluetoothShown(state.bluetooth)) return null;
  return <Bluetooth api={here.bluetooth} poller={poller} state={state} onHardware={onHardware} />;
}

function Bluetooth({
  api,
  poller,
  state,
  onHardware,
}: {
  api: BluetoothApi;
  poller: BluetoothPoller;
  state: BluetoothPollState;
  onHardware: (() => void) | undefined;
}) {
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<BluetoothDeviceRow | null>(null);
  /** Devices being connected or disconnected, and what went wrong with one. */
  const [toggling, setToggling] = useState<Record<string, 'connect' | 'disconnect'>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const v = state.bluetooth ? bluetoothSectionView(state.bluetooth) : null;

  const toggle = async (row: BluetoothDeviceRow) => {
    const what = row.toggle;
    setToggling((t) => ({ ...t, [row.address]: what }));
    setProblems(({ [row.address]: _, ...rest }) => rest);
    try {
      const device = what === 'connect' ? await api.connect(row.address) : await api.disconnect(row.address);
      poller.device(device);
      if (what === 'connect' && !device.connected)
        setProblems((p) => ({ ...p, [row.address]: T.didNotConnect(row.name) }));
    } catch (error) {
      setProblems((p) => ({ ...p, [row.address]: bluetoothErrorText(error, row.name, { paired: true }) }));
      poller.refresh();
    } finally {
      setToggling(({ [row.address]: _, ...rest }) => rest);
    }
  };

  const add = (primary: boolean) => (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      size="sm"
      disabled={!v?.canAdd}
      onClick={() => setAdding(true)}
    >
      {T.add}
    </Button>
  );

  return (
    <section className={styles.section} aria-labelledby={id} data-bluetooth="">
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
            {v.missing ? (
              <div className={styles.row} data-row="bluetooth-missing">
                <span className={m.slot}>
                  <StatusDot tone={v.missing.dot} size={8} label={null} />
                </span>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{v.missing.text}</span>
                </span>
                {onHardware ? (
                  <Button variant="secondary" size="sm" onClick={onHardware}>
                    {T.seeHardware}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {v.pairing ? (
              <div className={styles.row} data-row="bluetooth-pairing" role="status">
                <span className={m.slot}>
                  <StatusDot tone={v.pairing.dot} size={8} label={null} className={m.running} />
                </span>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{v.pairing.text}</span>
                </span>
              </div>
            ) : null}
            {v.devices.map((row) => (
              <DeviceRow
                key={row.address}
                row={row}
                canChange={v.canChange}
                toggling={toggling[row.address] ?? null}
                problem={problems[row.address] ?? null}
                onToggle={() => void toggle(row)}
                onRemove={() => setRemoving(row)}
              />
            ))}
            {v.canChange && v.devices.length === 0 ? (
              <div className={styles.row} data-row="bluetooth-none">
                <span className={m.slot} aria-hidden="true">
                  <Icon icon={BluetoothMark} size={18} />
                </span>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{T.none}</span>
                  <span className={styles.rowMeta}>{T.noneMeta}</span>
                </span>
                {add(true)}
              </div>
            ) : v.canChange ? (
              <div className={styles.moreRow} data-row="bluetooth-add">
                {add(false)}
              </div>
            ) : null}
          </>
        )}
      </div>
      <BluetoothDialog
        open={adding}
        onClose={() => setAdding(false)}
        api={api}
        poller={poller}
        state={state}
      />
      <RemoveDialog
        device={removing}
        onClose={() => setRemoving(null)}
        api={api}
        onRemoved={(address) => poller.removed(address)}
      />
    </section>
  );
}

function DeviceRow({
  row,
  canChange,
  toggling,
  problem,
  onToggle,
  onRemove,
}: {
  row: BluetoothDeviceRow;
  canChange: boolean;
  toggling: 'connect' | 'disconnect' | null;
  problem: string | null;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const items: ContextMenuItem[] = [
    { label: row.toggle === 'connect' ? T.connect : T.disconnect, onSelect: onToggle },
    { label: `${T.remove}…`, danger: true, separated: true, onSelect: onRemove },
  ];
  return (
    <div
      className={styles.row}
      data-row="bluetooth-device"
      data-address={row.address}
      data-connected={row.connected}
    >
      <span className={m.slot} data-connected={row.connected} aria-hidden="true">
        <Icon icon={BLUETOOTH_ICONS[row.icon]} size={18} />
      </span>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{row.name}</span>
        <span className={styles.rowMeta}>
          {toggling === 'connect' ? T.connecting : toggling === 'disconnect' ? T.disconnecting : row.meta}
        </span>
        {problem ? (
          <span className={m.problem} role="alert">
            {problem}
          </span>
        ) : null}
      </span>
      {canChange ? (
        <MenuButton
          label={T.actions(row.name)}
          className={m.menuButton}
          disabled={toggling !== null}
          items={items}
        >
          <Icon icon={Ellipsis} size={15} />
        </MenuButton>
      ) : null}
    </div>
  );
}

/** Remove (asked once): the device has to be paired again to be used (BT-05). */
function RemoveDialog({
  device,
  onClose,
  api,
  onRemoved,
}: {
  device: BluetoothDeviceRow | null;
  onClose: () => void;
  api: BluetoothApi;
  onRemoved: (address: string) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The last device asked about stays in the dialog while it closes.
  const [shown, setShown] = useState(device);
  useEffect(() => {
    if (device) setShown(device);
    else setNote(null);
  }, [device]);
  const remove = async () => {
    if (!device) return;
    setBusy(true);
    try {
      await api.forget(device.address);
      onRemoved(device.address);
      onClose();
    } catch (error) {
      setNote(bluetoothErrorText(error, device.name, { paired: true }));
    } finally {
      setBusy(false);
    }
  };
  const R = T.removeDialog;
  return (
    <Modal open={device !== null} onOpenChange={(next) => (next ? null : onClose())} width="md">
      <div className={tw.dialog}>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{shown ? R.title(shown.name) : ''}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{R.lead}</ModalDescription>
        </div>
        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {R.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void remove()}>
            {busy ? R.busy : R.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
