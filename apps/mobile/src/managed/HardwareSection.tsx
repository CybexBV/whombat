/**
 * HARDWARE (Whombat hardware-support.md HD-01, HD-03, HD-11; hardware-support-android.md AP-3259, AP-3260), where the
 * Whombat offers `host.hardware`, in two sizes. On This Whombat → About, `HardwareSummary`: one row with the machine's
 * icon and name and “Every part has a driver.”, or the parts that don't work in one row each, opening the Hardware
 * screen. On that screen, `HardwareSection` (docs/app/decisions/about-page.md): the machine — its icon (a laptop where
 * it has a battery, a box for a virtual machine), its name, a badge that says whether every part works — over its facts
 * as tiles (processor, memory, storage, system) and **Share report**; the parts that don't work under NEEDS ATTENTION;
 * then each group (Network · Sound · Graphics & screens · Storage · Power · Other) as a card of its own, every part with
 * the icon of its kind, its vendor and what it does, and its driver in a chip (“No driver” in red). Each reads once when
 * it shows.
 *
 * Share report writes the shared `hardwareReportText` to `whombat-hardware-YYYY-MM-DD.txt` in the app's cache and
 * hands it to the system's share sheet (the copy goes afterwards), as DIAGNOSTICS shares its files.
 */
import {
  type HardwareKind,
  type HardwareLoader,
  type HardwareProblemView,
  type HardwareRowView,
  type HardwareSpec,
  type HostHardware,
  hardwareReportFileName,
  hardwareReportText,
  hardwareSectionView,
  hardwareSpecs,
  hardwareText,
} from '@whombat/client';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type LayoutChangeEvent, Platform, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { tint } from '../ui/glanceColors';
import {
  BatteryFull,
  Bluetooth,
  Box,
  Camera,
  CircleAlert,
  CircleCheck,
  CircuitBoard,
  Cpu,
  EthernetPort,
  Gpu,
  HardDrive,
  Keyboard,
  Laptop,
  type LucideIcon,
  MemoryStick,
  Monitor,
  Server,
  Share2,
  SquareTerminal,
  Usb,
  Volume2,
  Wifi,
} from '../ui/icons';
import { Button, SkeletonRows } from '../ui/primitives';
import { hardwareReportAbout, machineText } from './machine';
import { Card, type Dot, dotColor, ErrorLine, IconTile, LinkRow, Row } from './ui';
import type { MachineHere } from './useMachine';

type Read = { hardware: HostHardware } | { failed: true } | null;

/** The icon of each kind of part. */
const KIND_ICONS: Record<HardwareKind, LucideIcon> = {
  wired: EthernetPort,
  wifi: Wifi,
  bluetooth: Bluetooth,
  sound: Volume2,
  graphics: Gpu,
  display: Monitor,
  storage: HardDrive,
  battery: BatteryFull,
  camera: Camera,
  input: Keyboard,
  usb: Usb,
  other: CircuitBoard,
};

const SPEC_ICONS: Record<HardwareSpec['key'], LucideIcon> = {
  cpu: Cpu,
  memory: MemoryStick,
  storage: HardDrive,
  system: SquareTerminal,
};

/** The machine's icon: a box for a virtual machine, a laptop where it has a battery, else a server. */
function machineIcon(h: HostHardware): LucideIcon {
  if (h.machine.virtual) return Box;
  return h.devices.some((d) => d.kind === 'battery') ? Laptop : Server;
}

/** The worst of the parts that don't work, or ok. */
function worstOf(problems: readonly HardwareProblemView[]): Dot {
  return problems.some((p) => p.dot === 'bad') ? 'bad' : problems.length > 0 ? 'warn' : 'ok';
}

/** HARDWARE in full (the Hardware screen), or nothing (no manager here). `runtime`: the Whombat's version for the report's header. */
export function HardwareSection({ machine, runtime }: { machine: MachineHere; runtime?: string | null }) {
  if (!machine.hardware) return null;
  return (
    <Hardware
      load={machine.hardware}
      name={machine.name}
      runtime={runtime ?? null}
      onReset={machine.onReset}
    />
  );
}

/**
 * HARDWARE on About, or nothing (no manager here): one row that opens the Hardware screen, so the list of parts doesn't
 * fill About. The parts that don't work stay in sight under it. `onLayout` lets About scroll to it.
 */
export function HardwareSummary({
  machine,
  onOpen,
  onLayout,
}: {
  machine: MachineHere;
  onOpen: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  if (!machine.hardware) return null;
  return <Summary load={machine.hardware} onReset={machine.onReset} onOpen={onOpen} onLayout={onLayout} />;
}

/** The hardware read once as it shows, again on Try again and when the demo machine starts over; `gone`: no manager. */
function useHardwareRead(load: HardwareLoader, onReset: MachineHere['onReset']) {
  const { rawLocale } = useI18n();
  const [read, setRead] = useState<Read>(null);
  const [gone, setGone] = useState(false);
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
  const hardware = read && 'hardware' in read ? read.hardware : null;
  return { read, gone, ask, hardware, view: hardware ? hardwareSectionView(hardware, rawLocale) : null };
}

/** “The hardware couldn’t be read right now.” with Try again. */
function Unavailable({ onRetry }: { onRetry: () => void }) {
  const { rawLocale } = useI18n();
  const T = hardwareText(rawLocale);
  return (
    <Row
      first
      dot="mut"
      title={T.unavailable}
      action={
        <Button label={T.tryAgain} variant="secondary" onPress={onRetry} style={{ paddingHorizontal: 14 }} />
      }
    />
  );
}

function Summary({
  load,
  onReset,
  onOpen,
  onLayout,
}: {
  load: HardwareLoader;
  onReset: MachineHere['onReset'];
  onOpen: () => void;
  onLayout: ((e: LayoutChangeEvent) => void) | undefined;
}) {
  const { rawLocale } = useI18n();
  const T = hardwareText(rawLocale);
  const { read, gone, ask, hardware, view: v } = useHardwareRead(load, onReset);
  if (gone) return null;
  return (
    <View onLayout={onLayout}>
      <Card label={T.section}>
        {read === null ? <SkeletonRows count={1} lines={2} /> : null}
        {read && !v ? <Unavailable onRetry={() => void ask()} /> : null}
        {v && hardware ? (
          <>
            <LinkRow
              first
              icon={machineIcon(hardware)}
              dot={worstOf(v.problems)}
              title={v.machine}
              body={v.problems.length > 0 ? null : T.allWork}
              label={v.problems.length > 0 ? v.machine : `${v.machine}, ${T.allWork}`}
              onPress={onOpen}
            />
            {v.problems.map((p) => (
              <ProblemRow key={p.key} problem={p} />
            ))}
          </>
        ) : null}
      </Card>
    </View>
  );
}

function Hardware({
  load,
  name,
  runtime,
  onReset,
}: {
  load: HardwareLoader;
  name: string;
  runtime: string | null;
  onReset: MachineHere['onReset'];
}) {
  const { rawLocale } = useI18n();
  const T = hardwareText(rawLocale);
  const { timeZone } = useBurrowBase();
  const { read, gone, ask, hardware, view: v } = useHardwareRead(load, onReset);
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (gone) return null;

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
      setNote(machineText(rawLocale).shareFailed);
    } finally {
      setSharing(false);
      try {
        file.delete();
      } catch {
        // already gone
      }
    }
  };

  if (read === null)
    return (
      <Card>
        <SkeletonRows count={3} lines={2} />
      </Card>
    );
  if (!v || !hardware)
    return (
      <Card>
        <Unavailable onRetry={() => void ask()} />
      </Card>
    );
  return (
    <View style={{ gap: 14 }}>
      <MachineCard
        hardware={hardware}
        machine={v.machine}
        problems={v.problems.length}
        worst={worstOf(v.problems)}
      >
        <Button
          label={T.share}
          variant="secondary"
          // Not `busy`: a spinner for the label would narrow the button (as VERSION's Check, AP-2972).
          disabled={sharing}
          onPress={() => void share()}
          icon={Share2}
        />
        <ErrorLine text={note} />
      </MachineCard>
      {v.problems.length > 0 ? (
        <Card label={T.problemsLabel.toUpperCase()}>
          {v.problems.map((p, i) => (
            <ProblemRow key={p.key} problem={p} first={i === 0} />
          ))}
        </Card>
      ) : null}
      {v.groups.map((g) => (
        <Card key={g.group} label={`${g.label.toUpperCase()} · ${g.rows.length}`}>
          {g.rows.map((row, i) => (
            <PartRow key={row.key} row={row} first={i === 0} />
          ))}
        </Card>
      ))}
    </View>
  );
}

/**
 * The machine at the top: its icon on a brand wash, its name, whether every part works (a green badge) or how many
 * need attention (in the worst one's colour), then its facts as tiles and what goes under them (Share report).
 */
function MachineCard({
  hardware,
  machine,
  problems,
  worst,
  children,
}: {
  hardware: HostHardware;
  machine: string;
  problems: number;
  worst: Dot;
  children: ReactNode;
}) {
  const { rawLocale } = useI18n();
  const T = hardwareText(rawLocale);
  const theme = useTheme();
  const Icon = machineIcon(hardware);
  const specs = hardwareSpecs(hardware, rawLocale);
  // The processor's name is long, so it has the whole width; the others go two by two, and one left alone is wide too.
  const halves = specs.filter((sp) => sp.key !== 'cpu');
  const lone = halves.length % 2 === 1 ? halves[halves.length - 1]?.key : undefined;
  const wide = new Set<HardwareSpec['key']>(lone ? ['cpu', lone] : ['cpu']);
  const color = dotColor(theme, worst);
  const BadgeIcon = worst === 'ok' ? CircleCheck : CircleAlert;
  const badge = worst === 'ok' ? T.everyPartWorks : T.needAttention(problems);
  return (
    <View
      style={{
        borderRadius: 20,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        padding: 16,
        gap: 16,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          style={{
            width: 56,
            height: 56,
            borderRadius: 17,
            alignItems: 'center',
            justifyContent: 'center',
            // A stronger wash than the tiles' so it reads as the brand's colour in the light theme too.
            backgroundColor: tint(theme.colors.brand, 0.24),
          }}
        >
          <Icon size={28} color={theme.colors.brand} strokeWidth={1.7} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 7 }}>
          <Text size={18} weight={600} lh={1.3} accessibilityRole="header">
            {machine}
          </Text>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              alignSelf: 'flex-start',
              gap: 5,
              paddingVertical: 4,
              paddingLeft: 7,
              paddingRight: 10,
              borderRadius: 999,
              backgroundColor: tint(color, 0.14),
            }}
          >
            <BadgeIcon size={14} color={color} strokeWidth={2} />
            <Text size={12.5} weight={500} color={color}>
              {badge}
            </Text>
          </View>
        </View>
      </View>
      {specs.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {specs.map((spec) => (
            <SpecTile key={spec.key} spec={spec} wide={wide.has(spec.key)} />
          ))}
        </View>
      ) : null}
      <View style={{ gap: 8, alignItems: 'flex-start' }}>{children}</View>
    </View>
  );
}

/** One of the machine's facts: its icon and name small, its value, a line under it. Read as one. */
function SpecTile({ spec, wide }: { spec: HardwareSpec; wide: boolean }) {
  const theme = useTheme();
  const Icon = SPEC_ICONS[spec.key];
  return (
    <View
      accessible
      accessibilityLabel={[spec.label, spec.value, spec.line].filter(Boolean).join(', ')}
      style={{
        flexGrow: 1,
        flexBasis: wide ? '100%' : '40%',
        gap: 5,
        paddingVertical: 11,
        paddingHorizontal: 12,
        borderRadius: 14,
        backgroundColor: theme.colors.sf2,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon size={14} color={theme.colors.mut} strokeWidth={1.9} />
        <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
          {spec.label.toUpperCase()}
        </Text>
      </View>
      <Text size={15} weight={600} lh={1.3}>
        {spec.value}
      </Text>
      {spec.line ? (
        <Text size={12.5} lh={1.35} color={theme.colors.mut}>
          {spec.line}
        </Text>
      ) : null}
    </View>
  );
}

/** A part that doesn't work: the icon of its kind in its colour, its name, what is wrong in words. */
function ProblemRow({ problem, first = false }: { problem: HardwareProblemView; first?: boolean }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${problem.title}, ${problem.meta}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 11,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <IconTile icon={KIND_ICONS[problem.kind]} tone={problem.dot} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={14.5} weight={500} lh={1.35}>
          {problem.title}
        </Text>
        <Text size={13} lh={1.4} color={theme.colors.ink2}>
          {problem.meta}
        </Text>
      </View>
    </View>
  );
}

/**
 * One part (not a control): the icon of its kind (in red or amber when it doesn't work), its name, its vendor and what
 * it does, and its driver in a chip (“No driver” in red). Read as one line.
 */
function PartRow({ row, first }: { row: HardwareRowView; first: boolean }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={[row.title, row.meta, row.driver].filter(Boolean).join(', ')}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <IconTile icon={KIND_ICONS[row.kind]} tone={row.dot} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text size={14.5} weight={500} lh={1.35}>
          {row.title}
        </Text>
        {row.meta || row.driver ? (
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 }}
          >
            {row.meta ? (
              <Text size={12.5} lh={1.4} color={theme.colors.mut} style={{ flexShrink: 1 }}>
                {row.meta}
              </Text>
            ) : null}
            {row.driver ? <DriverChip text={row.driver} missing={row.noDriver} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A part's driver in mono on the chips' surface; “No driver” on red's wash. */
function DriverChip({ text, missing }: { text: string; missing: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingVertical: 2,
        paddingHorizontal: 7,
        borderRadius: 6,
        backgroundColor: missing ? tint(theme.colors.bad, 0.14) : theme.colors.sf2,
      }}
    >
      <Text size={11.5} mono lh={1.4} color={missing ? theme.colors.bad : theme.colors.ink2}>
        {text}
      </Text>
    </View>
  );
}
