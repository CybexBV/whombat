/**
 * Add a device, in a sheet (Whombat bluetooth.md BT-01, BT-03, BT-04, BT-07, BT-11; bluetooth-android.md AP-3754…AP-3757),
 * the web's dialog (bluetooth-web.md AP-3707, AP-3708) on a phone. Two steps:
 *
 * - **the list**: the hint, then the devices the box finds as 52dp rows — its kind's icon, its name over its kind, the
 *   bars — with “Looking for devices…” at the end while it looks (a minute), “No devices nearby.” when it found none;
 *   Look again · Cancel. Choosing one pairs it;
 * - **the pairing** the box runs, followed every second by BLUETOOTH's poller: “Pairing with {name}…”, the code to type
 *   in large digits (the typed ones dimmed, the next one ringed), “Does {name} show {code}?” with No · Yes (No goes back
 *   to the list and looks again), “{name} is ready.” with Done, or why it didn't work with Close · Try again (which looks
 *   again: the device has to be in pairing mode). The device's name is the sheet's title meanwhile, over its kind.
 *
 * Closing the sheet — Cancel, the backdrop, Back — cancels a pairing it started that still runs. The steps' logic is
 * `bluetooth.ts` (tested); the rows, the pairing in words and every word are the shared model's.
 */
import {
  BLUETOOTH_TEXT,
  type BluetoothApi,
  type BluetoothFoundRow,
  type BluetoothPairingView,
  type BluetoothPoller,
  type BluetoothScan,
  type BluetoothState,
  bluetoothErrorCode,
  bluetoothErrorText,
  bluetoothKindText,
  bluetoothPairingView,
} from '@whombat/client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';
import {
  type BluetoothLook,
  type BluetoothStep,
  bluetoothBackToList,
  bluetoothCancelOnClose,
  bluetoothDigitsLabel,
  bluetoothFollowed,
  bluetoothListView,
} from './bluetooth';
import { ChangeMark, KindIcon, SignalBars } from './MachineParts';
import { ErrorLine } from './ui';

const T = BLUETOOTH_TEXT;
const D = T.dialog;

export function BluetoothSheet({
  visible,
  onClose,
  api,
  poller,
  bluetooth,
}: {
  visible: boolean;
  onClose: () => void;
  api: BluetoothApi;
  /** BLUETOOTH's poller: it follows the looking and the pairing, and takes what the sheet started. */
  poller: BluetoothPoller;
  /** The box's Bluetooth as BLUETOOTH shows it (the poller's). */
  bluetooth: BluetoothState;
}) {
  const theme = useTheme();
  const [step, setStep] = useState<BluetoothStep>({ at: 'list' });
  const [look, setLook] = useState<BluetoothLook>({ at: 'asking' });
  const [seen, setSeen] = useState<BluetoothScan | null>(null);
  const [gone, setGone] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  /** A device being asked to pair (its address), or the answer to the question. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Bumped on every opening and closing: an answer for an earlier one is dropped. */
  const opening = useRef(0);

  const lookAgain = async () => {
    const mine = opening.current;
    setLook({ at: 'asking' });
    setProblem(null);
    setGone([]);
    try {
      const r = await api.scan();
      if (mine !== opening.current) return;
      if (r.scan) {
        poller.scanned(r.scan);
        setSeen(r.scan);
        setLook({ at: 'asked' });
      } else
        setLook({
          at: 'failed',
          note: r.reason === 'no_bluetooth' ? T.errors.no_bluetooth('') : D.couldNotLook,
        });
    } catch (error) {
      if (mine !== opening.current) return;
      setLook({
        at: 'failed',
        note: bluetoothErrorCode(error) === 'no_bluetooth' ? T.errors.no_bluetooth('') : D.couldNotLook,
      });
    }
  };

  // Opening looks for devices; closing forgets the steps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening
  useEffect(() => {
    opening.current += 1;
    setStep({ at: 'list' });
    setSeen(null);
    setProblem(null);
    setBusy(null);
    if (visible) void lookAgain();
  }, [visible]);

  // What the box found while it looks; after that the list keeps what it found last.
  const scan = bluetooth.scan;
  useEffect(() => {
    if (visible && scan) setSeen(scan);
  }, [visible, scan]);

  // The pairing this sheet started, as the box tells it.
  const current = bluetooth.pairing;
  useEffect(() => {
    if (step.at === 'pairing' && current && current.id === step.pairing.id && current !== step.pairing)
      setStep({ ...step, pairing: current });
  }, [step, current]);

  // One the person answered No to goes back to the list once it ended, looking again.
  const back = bluetoothBackToList(step, current);
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the declined pairing ended
  useEffect(() => {
    if (!back) return;
    setStep({ at: 'list' });
    setSeen(null);
    void lookAgain();
  }, [back]);

  const close = () => {
    const id = bluetoothCancelOnClose(step, current);
    if (id)
      api.cancel(id).then(
        (p) => poller.pairing(p),
        () => poller.refresh(),
      );
    onClose();
  };

  const pair = async (row: BluetoothFoundRow) => {
    const mine = opening.current;
    setBusy(row.address);
    setProblem(null);
    try {
      const p = await api.pair(row.address);
      poller.pairing(p);
      // Closed while it was asked: the pairing nobody watches stops.
      if (mine !== opening.current)
        api.cancel(p.id).then(
          (c) => poller.pairing(c),
          () => poller.refresh(),
        );
      else setStep({ at: 'pairing', pairing: p });
    } catch (error) {
      if (mine === opening.current) {
        setProblem(bluetoothErrorText(error, row.name));
        // A device no longer nearby leaves the list.
        if (bluetoothErrorCode(error) === 'not_found') setGone((g) => [...g, row.address]);
      }
      poller.refresh();
    } finally {
      if (mine === opening.current) setBusy(null);
    }
  };

  const answer = async (accept: boolean) => {
    if (step.at !== 'pairing') return;
    const mine = opening.current;
    const { id, name } = step.pairing;
    setBusy(accept ? 'yes' : 'no');
    setProblem(null);
    try {
      const p = await api.confirm(id, accept);
      poller.pairing(p);
      if (mine === opening.current) setStep({ at: 'pairing', pairing: p, declined: !accept });
    } catch (error) {
      if (mine === opening.current) setProblem(bluetoothErrorText(error, name));
      poller.refresh();
    } finally {
      if (mine === opening.current) setBusy(null);
    }
  };

  const tryAgain = () => {
    setStep({ at: 'list' });
    setSeen(null);
    void lookAgain();
  };

  const list = step.at === 'list' ? bluetoothListView(look, bluetooth, seen, Date.now(), gone) : null;
  const pairing =
    step.at === 'pairing' ? bluetoothPairingView(bluetoothFollowed(step.pairing, current)) : null;

  return (
    <Sheet visible={visible} onClose={close} label={D.title} closeLabel={D.cancel}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}>
        <View style={{ gap: 4 }}>
          <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
            {pairing ? pairing.name : D.title}
          </Text>
          <Text size={13.5} lh={1.45} color={theme.colors.mut}>
            {pairing ? bluetoothKindText(pairing.kind) : D.hint}
          </Text>
        </View>

        {list ? (
          <>
            <View
              accessibilityLabel={D.nearby}
              style={{ borderTopWidth: 1, borderTopColor: theme.colors.line }}
            >
              {list.rows.map((row) => (
                <FoundRow
                  key={row.address}
                  row={row}
                  asking={busy === row.address}
                  disabled={busy !== null}
                  onPress={() => void pair(row)}
                />
              ))}
              {list.looking ? (
                <ListNote text={D.looking} busy />
              ) : list.note ? (
                <ListNote text={list.note} />
              ) : null}
            </View>
            <ErrorLine text={problem} />
            <Buttons>
              <Button
                label={D.again}
                variant="secondary"
                disabled={!list.canLookAgain || busy !== null}
                onPress={() => void lookAgain()}
                style={{ flex: 1 }}
              />
              <Button label={D.cancel} variant="secondary" onPress={close} style={{ flex: 1 }} />
            </Buttons>
          </>
        ) : null}

        {pairing ? (
          <>
            <PairingPanel pairing={pairing} />
            {pairing.digits ? <Digits pairing={pairing} /> : null}
            <ErrorLine text={problem} />
            {pairing.asks ? (
              <Buttons>
                <Button
                  label={D.no}
                  variant="secondary"
                  busy={busy === 'no'}
                  disabled={busy !== null}
                  onPress={() => void answer(false)}
                  style={{ flex: 1 }}
                />
                <Button
                  label={D.yes}
                  busy={busy === 'yes'}
                  disabled={busy !== null}
                  onPress={() => void answer(true)}
                  style={{ flex: 1 }}
                />
              </Buttons>
            ) : pairing.running ? (
              <Button label={D.cancel} variant="secondary" onPress={close} />
            ) : pairing.phase === 'done' ? (
              <Button label={D.done} onPress={onClose} />
            ) : (
              <Buttons>
                <Button label={D.close} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
                <Button label={D.tryAgain} onPress={tryAgain} style={{ flex: 1 }} />
              </Buttons>
            )}
          </>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function Buttons({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: 8 }}>{children}</View>;
}

/** A device the box found: 52dp, its kind's icon, its name over its kind, the bars (a spinner while it is asked). */
function FoundRow({
  row,
  asking,
  disabled,
  onPress,
}: {
  row: BluetoothFoundRow;
  asking: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={row.label}
      feedback="wash"
      disabled={disabled}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingVertical: 10,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <KindIcon icon={row.icon} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15} weight={500} numberOfLines={1}>
          {row.name}
        </Text>
        <Text size={12.5} lh={1.4} color={theme.colors.mut}>
          {row.kindText}
        </Text>
      </View>
      {asking ? (
        <ActivityIndicator size={16} color={theme.colors.mut} />
      ) : row.signal !== null ? (
        <SignalBars signal={row.signal} />
      ) : null}
    </Touchable>
  );
}

/** “Looking for devices…” (with a spinner), “No devices nearby.” or why it couldn't look. */
function ListNote({ text, busy = false }: { text: string; busy?: boolean }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 52,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      {busy ? <ActivityIndicator size={16} color={theme.colors.mut} /> : null}
      <Text size={14} lh={1.45} color={theme.colors.mut} style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

/** The pairing in one line: a spinner while the box works, else its dot; read out as it moves. */
function PairingPanel({ pairing }: { pairing: BluetoothPairingView }) {
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
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      {/* The question waits for the person, not the box: its dot, no spinner. */}
      <ChangeMark dot={pairing.dot} running={pairing.running && !pairing.asks} />
      <Text size={15} weight={500} lh={1.35} style={{ flex: 1 }}>
        {pairing.text}
      </Text>
    </View>
  );
}

/**
 * The code in large digits (BT-04, AP-3756), one 44 × 56 cell each as the web's: the ones typed so far dimmed, the next
 * one ringed in `brand`, the rest in `ink`. Read as the digits and how many are typed.
 */
function Digits({ pairing }: { pairing: BluetoothPairingView }) {
  const theme = useTheme();
  const digits = pairing.digits ?? [];
  const next = pairing.phase === 'code' ? digits.findIndex((d) => !d.typed) : -1;
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={bluetoothDigitsLabel(pairing) ?? undefined}
      style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 4 }}
    >
      {digits.map((d, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: a code's digits are its places
          key={i}
          style={{
            width: 44,
            height: 56,
            borderRadius: 14,
            borderWidth: i === next ? 2 : 1,
            borderColor: i === next ? theme.colors.brand : d.typed ? theme.colors.line : theme.colors.line2,
            backgroundColor: d.typed ? theme.colors.sf2 : theme.colors.bg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text size={30} weight={600} mono color={d.typed ? theme.colors.mut : theme.colors.ink}>
            {d.digit}
          </Text>
        </View>
      ))}
    </View>
  );
}
