/**
 * NETWORK on This Whombat's Overview (Whombat hardware-support.md HD-05, HD-06, HD-10, HD-11; hardware-support-android.md
 * AP-3251…AP-3255), the web's section (hardware-support-web.md AP-3223…AP-3227) on a phone: where the Whombat offers
 * `host.network`, after SCREEN — one card of rows:
 *
 * - “Can’t reach Whombat right now” first when the box couldn't; each cable (“Cable · Connected” and its address); the
 *   Wi-Fi (“Wi-Fi · Home · Strong signal” with its bars) or why there is none (“No Wi-Fi card”; “This Wi-Fi card has no
 *   driver yet.” with **See hardware**, which opens the Hardware screen);
 * - a change while it runs (“Joining Home…”, “Checking that … reaches the internet there…”), and how it ended;
 * - the saved networks, the one in use first, each with **Forget** (asked first);
 * - **Join a Wi-Fi network** across the bottom, which opens the Wi-Fi sheet (`WifiSheet`);
 * - Wi-Fi only (Whombat network-move.md; network-move-app.md): **Use Wi-Fi only** or **Use the cable
 *   again** across the bottom above Join, asked in an alert; the cable change's line, the servers finding the box's new
 *   address with **Point them here** (`onRepoint`) for those that don't, and how to keep the old address.
 *
 * The rows and every word are the shared `networkSectionView` and `NETWORK_TEXT`; the poller follows a change every 2 s
 * while it runs (`useNetwork`). Every target 44dp.
 */
import {
  type CableUse,
  type HostNetwork,
  NETWORK_TEXT,
  type NetworkApi,
  type NetworkChangeView,
  type NetworkPoller,
  type NetworkRowView,
  networkErrorText,
  networkSectionView,
  type SavedNetworkView,
  type ServerMove,
  type ServerMoveView,
} from '@whombat/client';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Lock } from '../ui/icons';
import { Button, SkeletonRows } from '../ui/primitives';
import { ChangeMark, SignalBars } from './MachineParts';
import { cableConfirm, MACHINE_TEXT, networkCardKind } from './machine';
import { Card, Row } from './ui';
import { type MachineHere, useNetwork } from './useMachine';
import { WifiSheet } from './WifiSheet';

const T = NETWORK_TEXT;

/** NETWORK, or nothing (no manager here). `onHardware` opens the Hardware screen, `onRepoint` Point them here. */
export function NetworkSection({
  machine,
  onHardware,
  onRepoint,
}: {
  machine: MachineHere;
  onHardware?: () => void;
  onRepoint?: () => void;
}) {
  const { state, poller } = useNetwork(machine.network, machine.onReset);
  const kind = networkCardKind(machine.network, state);
  if (kind === 'none' || !machine.network) return null;
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
      {kind === 'rows' && state.network ? (
        <NetworkRows
          api={machine.network}
          poller={poller}
          network={state.network}
          seenRunning={state.seenRunning}
          cableSeenRunning={state.cableSeenRunning}
          move={state.move}
          name={machine.name}
          onHardware={onHardware}
          onRepoint={onRepoint}
        />
      ) : null}
    </Card>
  );
}

function NetworkRows({
  api,
  poller,
  network,
  seenRunning,
  cableSeenRunning,
  move,
  name,
  onHardware,
  onRepoint,
}: {
  api: NetworkApi;
  poller: NetworkPoller;
  network: HostNetwork;
  seenRunning: boolean;
  cableSeenRunning: boolean;
  move: ServerMove | null;
  name: string;
  onHardware: (() => void) | undefined;
  onRepoint: (() => void) | undefined;
}) {
  const theme = useTheme();
  const [joining, setJoining] = useState(false);
  const v = networkSectionView(network, { name, seenRunning, cableSeenRunning, move });
  const switchTo = (use: CableUse) => {
    const c = cableConfirm(network, use, name);
    Alert.alert(c.title, c.message, [
      { text: T.dialog.cancel, style: 'cancel' },
      {
        text: c.submit,
        onPress: () =>
          api.setCable(use).then(
            (change) => poller.cableStarted(change),
            (error) => {
              Alert.alert(MACHINE_TEXT.switchFailed(use), networkErrorText(error, name));
              poller.refresh();
            },
          ),
      },
    ]);
  };
  const offer = v.rows.find((r) => r.action !== null)?.action ?? null;
  const F = T.forgetDialog;
  const forget = (saved: SavedNetworkView) =>
    Alert.alert(F.title(saved.ssid), F.lead(name, saved.security !== 'open'), [
      { text: T.dialog.cancel, style: 'cancel' },
      {
        text: F.submit,
        style: 'destructive',
        onPress: () =>
          api.forget(saved.ssid).then(
            (change) => poller.started(change),
            (error) => {
              Alert.alert(MACHINE_TEXT.forgetFailed(saved.ssid), networkErrorText(error, name));
              poller.refresh();
            },
          ),
      },
    ]);
  const wifi = network.wifi;
  return (
    <>
      {v.rows.map((row, i) => (
        <ConnectionRow key={row.key} row={row} first={i === 0} onHardware={onHardware} />
      ))}
      {v.change ? <ChangeRow change={v.change} first={v.rows.length === 0} /> : null}
      {v.cableChange ? <ChangeRow change={v.cableChange} first={false} /> : null}
      {v.move ? <MoveRow move={v.move} onRepoint={onRepoint} /> : null}
      {v.tip ? (
        <View
          style={{
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Text size={13} lh={1.45} color={theme.colors.mut}>
            {v.tip}
          </Text>
        </View>
      ) : null}
      {v.saved.map((s) => (
        <SavedRow key={s.ssid} saved={s} busy={v.busy} onForget={() => forget(s)} />
      ))}
      {wifi ? (
        <View style={{ padding: 16, gap: 10, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
          {offer ? (
            <Button
              label={offer === 'wifiOnly' ? T.useWifiOnly : T.useCableAgain}
              variant="secondary"
              onPress={() => switchTo(offer === 'wifiOnly' ? 'wifi' : 'cable')}
            />
          ) : null}
          <Button
            label={T.join}
            variant={wifi.state === 'connected' ? 'secondary' : 'primary'}
            disabled={!v.canJoin}
            onPress={() => setJoining(true)}
          />
        </View>
      ) : null}
      <WifiSheet
        visible={joining}
        onClose={() => setJoining(false)}
        api={api}
        name={name}
        change={network.change}
        onStarted={(change) => poller.started(change)}
      />
    </>
  );
}

/** A cable, the Wi-Fi with its bars, or why there is no Wi-Fi (with See hardware where the card is the reason). */
function ConnectionRow({
  row,
  first,
  onHardware,
}: {
  row: NetworkRowView;
  first: boolean;
  onHardware: (() => void) | undefined;
}) {
  return (
    <Row
      first={first}
      dot={row.dot}
      title={row.title}
      meta={row.meta}
      action={
        row.signal !== null ? (
          <SignalBars signal={row.signal} />
        ) : row.hardware && onHardware ? (
          <Button
            label={T.seeHardware}
            variant="secondary"
            onPress={onHardware}
            style={{ paddingHorizontal: 14 }}
          />
        ) : null
      }
    />
  );
}

/** A change as one line: a spinner while it runs, then its dot; read out as it moves. */
function ChangeRow({ change, first }: { change: NetworkChangeView; first: boolean }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={[change.title, change.meta].filter(Boolean).join('. ')}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <ChangeMark dot={change.dot} running={change.running} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text size={15} weight={500} lh={1.35}>
          {change.title}
        </Text>
        {change.meta ? (
          <Text size={12} mono lh={1.45} color={theme.colors.mut}>
            {change.meta}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** The servers finding the box's new address: a spinner while they come, Point them here for those that don't. */
function MoveRow({ move, onRepoint }: { move: ServerMoveView; onRepoint: (() => void) | undefined }) {
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
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={[move.title, move.missing].filter(Boolean).join(' ')}
      >
        <ChangeMark dot={move.dot} running={move.running} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text size={15} weight={500} lh={1.35}>
            {move.title}
          </Text>
          {move.missing ? (
            <Text size={12} mono lh={1.45} color={theme.colors.mut}>
              {move.missing}
            </Text>
          ) : null}
        </View>
      </View>
      {move.repoint && onRepoint ? (
        <Button
          label={T.move.pointHere}
          variant="secondary"
          onPress={onRepoint}
          style={{ paddingHorizontal: 14 }}
        />
      ) : null}
    </View>
  );
}

/** A saved network: a lock in the dot's place when secured, its name and state, Forget. */
function SavedRow({
  saved,
  busy,
  onForget,
}: {
  saved: SavedNetworkView;
  busy: boolean;
  onForget: () => void;
}) {
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
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{ width: 8, alignItems: 'center', overflow: 'visible' }}
      >
        {saved.security === 'open' ? null : <Lock size={13} color={theme.colors.mut} strokeWidth={2} />}
      </View>
      <View style={{ flex: 1, gap: 3 }} accessible accessibilityLabel={`${saved.ssid}, ${saved.meta}`}>
        <Text size={15} weight={500} lh={1.35}>
          {saved.ssid}
        </Text>
        <Text size={12} mono lh={1.45} color={theme.colors.mut}>
          {saved.meta}
        </Text>
      </View>
      <Button
        label={T.forget}
        accessibilityLabel={`${T.forget} ${saved.ssid}`}
        variant="secondary"
        disabled={busy}
        onPress={onForget}
        style={{ paddingHorizontal: 14 }}
      />
    </View>
  );
}
