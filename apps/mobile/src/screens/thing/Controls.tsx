/**
 * Controls on the phone (contracts 0.121, CT-1005; Whombat service-dashboards.md SD-30; service-dashboards.md
 * AP-4640…AP-4643): Home Assistant's favourites grouped by room or kind, each group a section (its title in the label
 * face) with its tiles two by two. A tile: its icon on a small square, label and state words (warn or bad in their
 * colour), then a switch at its top right — the whole tile is the switch, 44dp and more —, a −/+ stepper, buttons, or a
 * picture on top (a camera). A tile that is on is lit in the second chart colour: its icon and a faint wash, never the
 * status colours. A switch or stepper shows what the person set at once and keeps it until the page is read again after
 * the answer (`useControlGuesses`); a stepper sends its figure once the presses stop (`useStepperDraft`). A control the
 * viewer may not change stays drawn, greyed, and says why when pressed.
 */
import {
  type ControlGuesses,
  guessedOn,
  guessedStep,
  stepperCan,
  stepperWords,
  switchValue,
  type ThingControlsPanel,
} from '@whombat/client';
import { type ThingButtons, useStepperDraft } from '@whombat/client/react';
import type { ThingControl, ThingControlIcon, ThingControlStepper, ThingPageButton } from '@whombat/core';
import { type ReactNode, useMemo } from 'react';
import { Switch, View } from 'react-native';
import { type ControlTileView, controlTile, rowsOf, SERVICE_COPY } from '../../data/servicePanels';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { MonoLabel, OneCard, toneOf } from '../../ui/assistant';
import { tint } from '../../ui/glanceColors';
import {
  Blinds,
  Camera,
  Cctv,
  CircleDot,
  DoorOpen,
  Fan,
  Gauge,
  Lightbulb,
  Lock,
  type LucideIcon,
  Minus,
  Plug,
  Plus,
  Power,
  ScrollText,
  Siren,
  Sparkles,
  Thermometer,
  ToggleRight,
  Tv,
} from '../../ui/icons';
import { switchColors } from '../../ui/switchColors';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';
import { showNotice } from '../feedback';
import type { PanelContext } from './Panels';
import { ThingPicture } from './Picture';
import { CardQuiet } from './parts';
import { ItemButtons, PanelButtons } from './ThingButton';

/** What a page's controls need besides its buttons' runner: what the person set while it settles. */
export interface ControlActions {
  buttons: ThingButtons;
  guesses: ControlGuesses;
  guess: (id: string, value: boolean | number) => void;
  done: (id: string, result: { ok: boolean; at: number }) => void;
}

/** Each control icon in Lucide, as on the web (AP-4566); a name this app doesn't know draws a dot. */
const CONTROL_ICONS: Record<ThingControlIcon, LucideIcon> = {
  light: Lightbulb,
  switch: ToggleRight,
  fan: Fan,
  scene: Sparkles,
  script: ScrollText,
  button: CircleDot,
  thermostat: Thermometer,
  blind: Blinds,
  lock: Lock,
  alarm: Siren,
  sensor: Gauge,
  camera: Cctv,
  plug: Plug,
  door: DoorOpen,
  media: Tv,
  power: Power,
};

export function ControlsCard({ panel, ctx }: { panel: ThingControlsPanel; ctx: PanelContext }) {
  const theme = useTheme();
  const groups = panel.groups.filter((g) => g.items.length > 0);
  return (
    <OneCard meta={panel.meta} label={panel.title}>
      {panel.hint?.trim() ? (
        <Text
          size={13}
          lh={1.45}
          color={theme.colors.mut}
          style={{ paddingHorizontal: 14, paddingBottom: 10, marginTop: panel.meta?.trim() ? -4 : -2 }}
        >
          {panel.hint}
        </Text>
      ) : null}
      <PanelButtons buttons={panel.buttons} act={ctx.act?.buttons} />
      {groups.length === 0 ? <CardQuiet text={panel.empty ?? ''} first /> : null}
      {groups.map((g) => (
        <View key={g.id} style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 8 }}>
          {groups.length > 1 || g.title !== panel.title ? <MonoLabel>{g.title}</MonoLabel> : null}
          {rowsOf(g.items, 2).map((row) => (
            <View key={row.map((c) => c.id).join('|')} style={{ flexDirection: 'row', gap: 10 }}>
              {row.map((c) => (
                <View key={c.id} style={{ flex: 1, minWidth: 0 }}>
                  <ControlTile control={c} ctx={ctx} />
                </View>
              ))}
              {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
            </View>
          ))}
        </View>
      ))}
    </OneCard>
  );
}

function ControlTile({ control, ctx }: { control: ThingControl; ctx: PanelContext }) {
  const act = ctx.act ?? null;
  const on = act ? guessedOn(control, act.guesses) : !!control.on;
  const tile = useMemo(() => controlTile(control, on), [control, on]);
  if (tile.look === 'switch' && control.toggle && act)
    return <SwitchTile control={control} toggle={control.toggle} tile={tile} on={on} act={act} />;
  if (tile.look === 'stepper' && control.stepper && act)
    return <StepperTile control={control} stepper={control.stepper} tile={tile} act={act} />;
  return (
    <TileFrame tile={tile} accessible={tile.look !== 'buttons'}>
      {tile.look === 'image' && control.image ? (
        <ThingPicture
          thing={ctx.thing.id}
          image={control.image}
          shape={control.image.shape}
          initial=""
          radius={8}
        />
      ) : null}
      <TileTop tile={tile} />
      <TileWords tile={tile} />
      {tile.look === 'buttons' && control.buttons ? (
        <ItemButtons buttons={control.buttons} act={act?.buttons} about={control.label} />
      ) : null}
    </TileFrame>
  );
}

/** A tile's box: a hairline, 12dp corners, lit with a faint wash of the second chart colour when it is on. */
function useTileStyle(lit: boolean) {
  const theme = useTheme();
  return {
    borderWidth: 1,
    borderColor: theme.colors.line,
    borderRadius: 12,
    padding: 12,
    gap: 8,
    backgroundColor: lit ? tint(theme.chart.chart2, Number(theme.chart.chartWash)) : theme.colors.sf,
  };
}

function TileFrame({
  tile,
  accessible,
  children,
}: {
  tile: ControlTileView;
  /** Read as one (a sensor's value, a camera); a tile with buttons lets TalkBack reach them. */
  accessible: boolean;
  children: ReactNode;
}) {
  const style = useTileStyle(tile.lit);
  return (
    <View
      style={[style, { flexGrow: 1 }]}
      {...(accessible ? { accessible, accessibilityLabel: tile.spoken } : {})}
    >
      {children}
    </View>
  );
}

/** The tile's icon on a small square (lit: in the second chart colour). */
function TileIcon({ tile }: { tile: ControlTileView }) {
  const theme = useTheme();
  const Icon = tile.icon ? (CONTROL_ICONS[tile.icon] ?? Camera) : CircleDot;
  const color = tile.lit ? theme.chart.chart2 : theme.colors.mut;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tile.lit ? tint(theme.chart.chart2, 0.16) : theme.colors.sf2,
      }}
    >
      <Icon size={17} color={color} strokeWidth={1.8} />
    </View>
  );
}

function TileTop({ tile, right }: { tile: ControlTileView; right?: ReactNode }) {
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 30 }}
    >
      <TileIcon tile={tile} />
      {right}
    </View>
  );
}

function TileWords({ tile }: { tile: ControlTileView }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <Text size={14} weight={600} lh={1.3} numberOfLines={2}>
        {tile.label}
      </Text>
      {tile.state ? (
        <Text
          size={12.5}
          lh={1.35}
          color={tile.stateTone ? toneOf(theme, tile.stateTone) : theme.colors.mut}
          numberOfLines={2}
        >
          {tile.state}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A light, a switch, a fan, a helper: the whole tile toggles (a switch for TalkBack, checked or not), the switch at its
 * top right shows the state; it sends the state it isn't in (`switchValue`), asked first when its button has a question.
 */
function SwitchTile({
  control,
  toggle: button,
  tile,
  on,
  act,
}: {
  control: ThingControl;
  toggle: ThingPageButton;
  tile: ControlTileView;
  on: boolean;
  act: ControlActions;
}) {
  const theme = useTheme();
  const style = useTileStyle(tile.lit);
  const allowed = button.allowed;
  const reason = allowed ? undefined : button.reason?.trim() || undefined;
  const toggle = () => {
    if (!allowed) {
      if (reason) showNotice(reason);
      return;
    }
    const next = switchValue(on);
    act.buttons.press(button, {
      value: next,
      onSend: () => act.guess(control.id, next),
      onDone: (r) => act.done(control.id, r),
    });
  };
  return (
    <Touchable
      onPress={toggle}
      feedback="wash"
      ringRadius={12}
      accessibilityRole="switch"
      accessibilityLabel={control.label}
      accessibilityHint={reason ?? tile.state ?? undefined}
      accessibilityState={{ checked: on, disabled: !allowed }}
      style={{ ...style, flexGrow: 1, minHeight: 44 }}
    >
      <TileTop
        tile={tile}
        right={
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ marginVertical: -7, marginRight: -4 }}
          >
            <Switch
              value={on}
              disabled={!allowed}
              {...switchColors(theme, on)}
              style={{ minHeight: 44, opacity: allowed ? 1 : 0.45 }}
            />
          </View>
        }
      />
      <TileWords tile={tile} />
    </Touchable>
  );
}

/**
 * A thermostat: the figure it is set to (as many decimals as its step) on its own line, − and + under it sharing the
 * tile's width (36dp tall, padded to 44); each press moves it a step and the last one is sent once the presses stop.
 * TalkBack can also swipe the figure up and down. Half a row is too narrow for “− 21.5 °C +” in one line.
 */
function StepperTile({
  control,
  stepper,
  tile,
  act,
}: {
  control: ThingControl;
  stepper: ThingControlStepper;
  tile: ControlTileView;
  act: ControlActions;
}) {
  const theme = useTheme();
  const style = useTileStyle(tile.lit);
  const allowed = stepper.button.allowed;
  const reason = allowed ? undefined : stepper.button.reason?.trim() || undefined;
  const value = guessedStep({ id: control.id, stepper }, act.guesses);
  const draft = useStepperDraft(value, stepper, (v) =>
    act.buttons.press(stepper.button, {
      value: v,
      onSend: () => act.guess(control.id, v),
      onDone: (r) => act.done(control.id, r),
    }),
  );
  const words = stepperWords(stepper, draft.shown);
  const step = (dir: 1 | -1) => {
    if (!allowed) {
      if (reason) showNotice(reason);
      return;
    }
    if (stepperCan(stepper, draft.shown, dir)) draft.step(dir);
  };
  return (
    <View style={[style, { flexGrow: 1 }]}>
      <TileTop tile={tile} />
      <TileWords tile={tile} />
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`${control.label}, ${words}`}
        {...(reason ? { accessibilityHint: reason } : {})}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        accessibilityLiveRegion="polite"
      >
        <Text
          size={20}
          weight={600}
          mono
          tracking={-0.01}
          color={draft.waiting ? theme.colors.ink2 : theme.colors.ink}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {words}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StepButton
          dir={-1}
          label={SERVICE_COPY.lower(control.label)}
          hint={reason ?? words}
          enabled={allowed && stepperCan(stepper, draft.shown, -1)}
          onPress={() => step(-1)}
        />
        <StepButton
          dir={1}
          label={SERVICE_COPY.raise(control.label)}
          hint={reason ?? words}
          enabled={allowed && stepperCan(stepper, draft.shown, 1)}
          onPress={() => step(1)}
        />
      </View>
    </View>
  );
}

function StepButton({
  dir,
  label,
  hint,
  enabled,
  onPress,
}: {
  dir: 1 | -1;
  label: string;
  hint: string;
  enabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const Icon = dir > 0 ? Plus : Minus;
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={18}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !enabled }}
      hitSlop={hitSlopFor(36)}
      style={{
        flex: 1,
        height: 36,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: enabled ? 1 : 0.45,
      }}
    >
      <Icon size={16} color={theme.colors.ink} strokeWidth={2} />
    </Touchable>
  );
}
