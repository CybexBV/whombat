/**
 * BLUETOOTH on This Whombat's Overview (Whombat bluetooth.md BT-02, BT-05, BT-07, BT-11; bluetooth-android.md
 * AP-3751…AP-3753), the web's section (bluetooth-web.md AP-3702…AP-3705) on a phone: where the Whombat offers
 * `host.bluetooth` and has an adapter, after NETWORK — one card of rows:
 *
 * - why there is no Bluetooth (“This Bluetooth adapter has no driver yet.”, “Bluetooth is switched off.”) with **See
 *   hardware**;
 * - each paired device: its kind's icon, its name over “Connected · Battery 80 %” or “Not connected”, and ⋯, which opens
 *   its actions — Connect or Disconnect, and Remove (asked first); a refusal in red under it; “No devices yet” when there
 *   are none;
 * - a pairing that runs (started here or at the box's screen), read out as it moves;
 * - **Add a device** across the bottom, which opens the Add a device sheet (`BluetoothSheet`).
 *
 * The rows and every word are the shared `bluetoothSectionView` and `BLUETOOTH_TEXT`; the poller follows the box every
 * second while it looks or pairs (`useBluetooth`). Every target 44dp.
 */
import {
  BLUETOOTH_TEXT,
  type BluetoothApi,
  type BluetoothDeviceRow,
  type BluetoothPairingView,
  type BluetoothPoller,
  type BluetoothState,
  bluetoothErrorText,
  bluetoothSectionView,
} from '@whombat/client';
import { type ReactNode, useState } from 'react';
import { Alert, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BluetoothConnected, BluetoothOff, EllipsisVertical, Trash } from '../ui/icons';
import { Button, SkeletonRows, StatusDot } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';
import { BluetoothSheet } from './BluetoothSheet';
import { BLUETOOTH_MOBILE_TEXT, bluetoothCardKind } from './bluetooth';
import { ChangeMark, KindIcon } from './MachineParts';
import { Card, type Dot, dotColor, Row } from './ui';
import { type MachineHere, useBluetooth } from './useMachine';

const T = BLUETOOTH_TEXT;

/** BLUETOOTH, or nothing (no Bluetooth service, or no adapter). */
export function BluetoothSection({ machine, onHardware }: { machine: MachineHere; onHardware?: () => void }) {
  const { state, poller } = useBluetooth(machine.bluetooth, machine.onReset);
  const kind = bluetoothCardKind(machine.bluetooth, state);
  if (kind === 'none' || !machine.bluetooth) return null;
  return (
    <Card label={T.section}>
      {kind === 'loading' ? <SkeletonRows count={2} lines={2} /> : null}
      {kind === 'unavailable' ? (
        <Row
          first
          dot="mut"
          title={T.unavailable}
          action={
            <Button
              label={T.tryAgain}
              variant="secondary"
              onPress={() => poller.refresh()}
              style={{ paddingHorizontal: 14 }}
            />
          }
        />
      ) : null}
      {kind === 'rows' && state.bluetooth ? (
        <BluetoothRows
          api={machine.bluetooth}
          poller={poller}
          bluetooth={state.bluetooth}
          onHardware={onHardware}
        />
      ) : null}
    </Card>
  );
}

/** What a device's row says instead of its state: what the phone asked it, or why that didn't work. */
type RowNote = { address: string; text: string; bad: boolean };

function BluetoothRows({
  api,
  poller,
  bluetooth,
  onHardware,
}: {
  api: BluetoothApi;
  poller: BluetoothPoller;
  bluetooth: BluetoothState;
  onHardware: (() => void) | undefined;
}) {
  const theme = useTheme();
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<BluetoothDeviceRow | null>(null);
  const [note, setNote] = useState<RowNote | null>(null);
  const v = bluetoothSectionView(bluetooth);
  const busy = note !== null && !note.bad;

  const toggle = async (row: BluetoothDeviceRow) => {
    const connect = row.toggle === 'connect';
    setNote({ address: row.address, text: connect ? T.connecting : T.disconnecting, bad: false });
    try {
      const device = connect ? await api.connect(row.address) : await api.disconnect(row.address);
      poller.device(device);
      setNote(
        connect && !device.connected
          ? { address: row.address, text: T.didNotConnect(row.name), bad: true }
          : null,
      );
    } catch (error) {
      setNote({
        address: row.address,
        text: bluetoothErrorText(error, row.name, { paired: true }),
        bad: true,
      });
      poller.refresh();
    }
  };

  const forget = async (row: BluetoothDeviceRow) => {
    setNote({ address: row.address, text: T.removeDialog.busy, bad: false });
    try {
      await api.forget(row.address);
      poller.removed(row.address);
      setNote(null);
    } catch (error) {
      setNote({
        address: row.address,
        text: bluetoothErrorText(error, row.name, { paired: true }),
        bad: true,
      });
      poller.refresh();
    }
  };

  const act = (what: 'toggle' | 'remove') => {
    const row = acting;
    setActing(null);
    if (!row) return;
    if (what === 'toggle') {
      void toggle(row);
      return;
    }
    const R = T.removeDialog;
    Alert.alert(R.title(row.name), R.lead, [
      { text: R.cancel, style: 'cancel' },
      { text: R.submit, style: 'destructive', onPress: () => void forget(row) },
    ]);
  };

  return (
    <>
      {v.missing ? (
        <MissingRow
          text={v.missing.text}
          dot={v.missing.dot}
          action={
            onHardware ? (
              <Button
                label={T.seeHardware}
                variant="secondary"
                onPress={onHardware}
                style={{ paddingHorizontal: 14 }}
              />
            ) : null
          }
        />
      ) : null}
      {v.devices.map((row, i) => (
        <DeviceRow
          key={row.address}
          row={row}
          first={i === 0 && !v.missing}
          note={note?.address === row.address ? note : null}
          canChange={v.canChange}
          busy={busy}
          onMore={() => {
            setNote(null);
            setActing(row);
          }}
        />
      ))}
      {v.devices.length === 0 && !v.missing ? <Row first title={T.none} meta={T.noneMeta} /> : null}
      {v.pairing ? <PairingRow pairing={v.pairing} /> : null}
      {v.missing ? null : (
        <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
          <Button
            label={T.add}
            variant={v.devices.length === 0 ? 'primary' : 'secondary'}
            disabled={!v.canAdd}
            onPress={() => setAdding(true)}
          />
        </View>
      )}
      <DeviceActionSheet row={acting} onClose={() => setActing(null)} onAct={act} />
      <BluetoothSheet
        visible={adding}
        onClose={() => setAdding(false)}
        api={api}
        poller={poller}
        bluetooth={bluetooth}
      />
    </>
  );
}

/**
 * A paired device: its kind's icon (`ink2` while connected, `mut` while not), its name over its state — or what the phone
 * asked it — and under that, in red, why it didn't work; ⋯.
 */
function DeviceRow({
  row,
  first,
  note,
  canChange,
  busy,
  onMore,
}: {
  row: BluetoothDeviceRow;
  first: boolean;
  note: RowNote | null;
  /** The adapter works: ⋯ is there. */
  canChange: boolean;
  /** Something the phone asked a device runs: every ⋯ waits. */
  busy: boolean;
  onMore: () => void;
}) {
  const theme = useTheme();
  const asking = note && !note.bad ? note.text : null;
  const problem = note?.bad ? note.text : null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 6,
        paddingLeft: 16,
        paddingRight: 6,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <KindIcon icon={row.icon} color={row.connected ? theme.colors.ink2 : theme.colors.mut} />
      <View
        style={{ flex: 1, gap: 3, paddingVertical: 6 }}
        accessible
        accessibilityLabel={[asking ? `${row.name}, ${asking}` : row.label, problem]
          .filter(Boolean)
          .join('. ')}
        accessibilityLiveRegion={problem ? 'assertive' : asking ? 'polite' : 'none'}
      >
        <Text size={15} weight={500} lh={1.35} numberOfLines={1}>
          {row.name}
        </Text>
        <Text size={12} mono lh={1.45} color={theme.colors.mut}>
          {asking ?? row.meta}
        </Text>
        {problem ? (
          <Text size={13} lh={1.4} color={theme.colors.bad}>
            {problem}
          </Text>
        ) : null}
      </View>
      {canChange ? <MoreButton name={row.name} disabled={busy} onPress={onMore} /> : null}
    </View>
  );
}

/** Why there is no Bluetooth: its dot in the icons' slot, so the words line up with the names under it. */
function MissingRow({ text, dot, action }: { text: string; dot: Dot; action: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
      }}
    >
      <View style={{ width: 20, alignItems: 'center' }}>
        <StatusDot color={dotColor(theme, dot)} label={text} />
      </View>
      <Text size={15} weight={500} lh={1.35} style={{ flex: 1 }}>
        {text}
      </Text>
      {action}
    </View>
  );
}

/** A row's ⋯: 44dp, the vertical ellipsis in `ink2`, as on an automation and a file in Files. */
function MoreButton({ name, disabled, onPress }: { name: string; disabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled}
      feedback="wash"
      ringRadius={22}
      accessibilityLabel={T.actions(name)}
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <EllipsisVertical size={19} color={theme.colors.ink2} strokeWidth={1.75} />
    </Touchable>
  );
}

/** A pairing that runs: a spinner in the dot's place and its line, read out as it moves. */
function PairingRow({ pairing }: { pairing: BluetoothPairingView }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={pairing.text}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ width: 20, alignItems: 'center' }}>
        <ChangeMark dot={pairing.dot} running={pairing.running} />
      </View>
      <Text size={15} weight={500} lh={1.35} style={{ flex: 1 }}>
        {pairing.text}
      </Text>
    </View>
  );
}

/** A device's actions, as an automation's: its name on top, then 52dp rows — Connect or Disconnect, Remove in red. */
function DeviceActionSheet({
  row,
  onClose,
  onAct,
}: {
  /** The device the sheet is for; null when it is closed. */
  row: BluetoothDeviceRow | null;
  onClose: () => void;
  onAct: (what: 'toggle' | 'remove') => void;
}) {
  const theme = useTheme();
  const connect = row?.toggle !== 'disconnect';
  return (
    <Sheet visible={row !== null} onClose={onClose} label={BLUETOOTH_MOBILE_TEXT.deviceActions}>
      <Text
        size={13.5}
        lh={1.4}
        color={theme.colors.mut}
        numberOfLines={2}
        style={{ paddingHorizontal: 22, paddingBottom: 12 }}
      >
        {row?.name ?? ''}
      </Text>
      {[
        {
          key: 'toggle' as const,
          label: connect ? T.connect : T.disconnect,
          Icon: connect ? BluetoothConnected : BluetoothOff,
          color: theme.colors.ink,
        },
        { key: 'remove' as const, label: T.remove, Icon: Trash, color: theme.colors.bad },
      ].map(({ key, label, Icon, color }) => (
        <Touchable
          key={key}
          onPress={() => onAct(key)}
          feedback="wash"
          accessibilityLabel={label}
          style={{
            minHeight: 52,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            paddingHorizontal: 22,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Icon size={19} color={key === 'remove' ? color : theme.colors.ink2} strokeWidth={1.75} />
          <Text size={16} weight={500} color={color}>
            {label}
          </Text>
        </Touchable>
      ))}
    </Sheet>
  );
}
