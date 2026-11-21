/**
 * HARDWARE in This Whombat → About (Whombat hardware-support.md HD-01, HD-03, HD-11; hardware-support-android.md
 * AP-3259, AP-3260), the web's section (hardware-support-web.md AP-3228…AP-3230) on a phone: where the
 * Whombat offers `host.hardware`, before DIAGNOSTICS — the machine (its name over CPU, memory and kernel) with **Share
 * report**, the parts that don't work in one line each (“This Wi-Fi card has no driver yet.”) or that every part has a
 * driver, then every part by group (Network · Sound · Graphics & screens · Storage · Power · Other) in compact rows, its
 * vendor, what it does and its driver on the line under its name (“No driver” in red). Read once when About opens.
 *
 * Share report writes the shared `hardwareReportText` to `whombat-hardware-YYYY-MM-DD.txt` in the app's cache and
 * hands it to Android's share sheet (the copy goes afterwards), as DIAGNOSTICS shares its files.
 */
import {
  HARDWARE_TEXT,
  type HardwareLoader,
  type HardwareRowView,
  type HostHardware,
  hardwareReportFileName,
  hardwareReportText,
  hardwareSectionView,
} from '@whombat/client';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useState } from 'react';
import { type LayoutChangeEvent, Platform, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button, SkeletonRows } from '../ui/primitives';
import { hardwareReportAbout, MACHINE_TEXT } from './machine';
import { Card, ErrorLine, Row } from './ui';
import type { MachineHere } from './useMachine';

const T = HARDWARE_TEXT;

type Read = { hardware: HostHardware } | { failed: true } | null;

/**
 * HARDWARE, or nothing (no manager here). `runtime`: the Whombat's version for the
 * report's header; `onLayout` lets About scroll to it (NETWORK's See hardware).
 */
export function HardwareSection({
  machine,
  runtime,
  onLayout,
}: {
  machine: MachineHere;
  runtime?: string | null;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  if (!machine.hardware) return null;
  return (
    <Hardware
      load={machine.hardware}
      name={machine.name}
      runtime={runtime ?? null}
      onReset={machine.onReset}
      onLayout={onLayout}
    />
  );
}

function Hardware({
  load,
  name,
  runtime,
  onReset,
  onLayout,
}: {
  load: HardwareLoader;
  name: string;
  runtime: string | null;
  onReset: MachineHere['onReset'];
  onLayout: ((e: LayoutChangeEvent) => void) | undefined;
}) {
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const [read, setRead] = useState<Read>(null);
  const [gone, setGone] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ask = useCallback(() => {
    let live = true;
    setRead(null);
    load().then(
      (r) => {
        if (!live) return;
        if (r.hardware) setRead({ hardware: r.hardware });
        else if (r.reason === 'not_managed') setGone(true);
        else setRead({ failed: true });
      },
      () => live && setRead({ failed: true }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  useEffect(ask, [ask]);
  // The demo machine starting over as another one.
  useEffect(() => onReset?.(() => void ask()), [onReset, ask]);
  if (gone) return null;
  const hardware = read && 'hardware' in read ? read.hardware : null;
  const v = hardware ? hardwareSectionView(hardware) : null;

  const share = async () => {
    if (!hardware) return;
    setSharing(true);
    setNote(null);
    const config = Constants.expoConfig;
    const about = hardwareReportAbout({
      burrow: name,
      app: config?.version,
      build: Platform.OS === 'ios' ? config?.ios?.buildNumber : config?.android?.versionCode,
      runtime,
      platform: Platform.OS,
    });
    const file = new File(Paths.cache, hardwareReportFileName(hardware, timeZone));
    try {
      if (file.exists) file.delete();
      file.create();
      file.write(hardwareReportText(hardware, about));
      await Sharing.shareAsync(file.uri, {
        mimeType: 'text/plain',
        UTI: 'public.plain-text',
        dialogTitle: T.share,
      });
    } catch {
      setNote(MACHINE_TEXT.shareFailed);
    } finally {
      setSharing(false);
      try {
        file.delete();
      } catch {
        // already gone
      }
    }
  };

  return (
    <View onLayout={onLayout}>
      <Card label={T.section}>
        {read === null ? <SkeletonRows count={3} lines={2} /> : null}
        {read && !v ? (
          <Row
            first
            dot="mut"
            title={T.unavailable}
            action={
              <Button
                label={T.tryAgain}
                variant="secondary"
                onPress={() => void ask()}
                style={{ paddingHorizontal: 14 }}
              />
            }
          />
        ) : null}
        {v ? (
          <>
            <View style={{ paddingVertical: 14, paddingHorizontal: 16, gap: 10 }}>
              <View style={{ gap: 3 }}>
                <Text size={15} weight={500} lh={1.35}>
                  {v.machine}
                </Text>
                <Text size={12} mono lh={1.45} color={theme.colors.mut}>
                  {v.machineMeta}
                </Text>
              </View>
              <Button
                label={T.share}
                variant="secondary"
                // Not `busy`: a spinner for the label would narrow the button (as VERSION's Check, AP-2972).
                disabled={sharing}
                onPress={() => void share()}
                style={{ alignSelf: 'flex-start', paddingHorizontal: 16 }}
              />
              <ErrorLine text={note} />
            </View>
            {v.problems.length > 0 ? (
              v.problems.map((p) => <Row key={p.key} dot={p.dot} title={p.title} meta={p.meta} />)
            ) : (
              <Row dot="ok" title={T.allWork} />
            )}
            {v.groups.map((g) => (
              <View key={g.group} style={{ borderTopWidth: 1, borderTopColor: theme.colors.line }}>
                <Text
                  size={11}
                  weight={500}
                  mono
                  tracking={0.05}
                  color={theme.colors.mut}
                  accessibilityRole="header"
                  style={{ paddingTop: 12, paddingBottom: 2, paddingHorizontal: 16 }}
                >
                  {g.label.toUpperCase()}
                </Text>
                {g.rows.map((row) => (
                  <DeviceRow key={row.key} row={row} />
                ))}
                <View style={{ height: 8 }} />
              </View>
            ))}
          </>
        ) : null}
      </Card>
    </View>
  );
}

/**
 * One part, compact (not a control): a dot only when it doesn't work, its name (14/500) over its vendor, what it does
 * and its driver (mono 11.5 `mut`; “No driver” in `bad`). Read as one line.
 */
function DeviceRow({ row }: { row: HardwareRowView }) {
  const theme = useTheme();
  const line = [row.meta, row.driver].filter(Boolean).join(' · ');
  return (
    <View
      accessible
      accessibilityLabel={[row.title, line].filter(Boolean).join(', ')}
      style={{ flexDirection: 'row', gap: 10, paddingVertical: 6, paddingHorizontal: 16 }}
    >
      <View style={{ width: 7, paddingTop: 6 }}>
        {row.dot ? (
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 3.5,
              backgroundColor: row.dot === 'bad' ? theme.colors.bad : theme.colors.warn,
            }}
          />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text size={14} weight={500} lh={1.35}>
          {row.title}
        </Text>
        {line ? (
          <Text size={11.5} mono lh={1.45} color={theme.colors.mut}>
            {row.meta ?? ''}
            {row.meta && row.driver ? ' · ' : ''}
            {row.driver ? (
              <Text size={11.5} mono color={row.noDriver ? theme.colors.bad : theme.colors.mut}>
                {row.driver}
              </Text>
            ) : null}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
