/**
 * Settings → Screen → What it shows on the phone (Whombat desk-display.md DK-102…DK-111, DK-123, DK-124;
 * desk-display-android.md AP-5863…AP-5868; mockup `desk-calm-glance/settings.html`): the preview on top — Now ·
 * Something’s wrong · {assistant} at work, the box's own calm glance for the choices on the page, drawn in the desk's
 * dark look, and *Try “…” on the screen* — then TOP BAR, THE MIDDLE, SERVERS and AROUND IT. Each thing has one control,
 * Always · When it matters · Off, under its name (a row is too narrow for both); remote help and the camera always show
 * while on, so theirs is a fixed *Always* with a lock. Servers keep the strip's order: Move up and Move down on each
 * (44dp, named for TalkBack), and a drag by the grip. A choice saves at once, shown before the answer and put back when
 * refused.
 */

import { isBrandMark } from '@whombat/brand';
import { agentFaceOf } from '@whombat/client';
import {
  DESK_BAR_ITEMS,
  DESK_TRY_S,
  type DeskApi,
  type DeskBarItem,
  type DeskClock,
  type DeskPreviewScenario,
  type DeskScreen,
  type DeskShow,
  type DeskShowLevel,
  type DeskShowOption,
  type DeskShowPatch,
  fillDeskWords,
} from '@whombat/client/desk';
import { type DeskActions, useDeskPreview } from '@whombat/client/desk/react';
import { deskWords } from '@whombat/core/domain';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Switch, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { useAgentWords, useTheAgentHere } from '../data/useAgent';
import { useI18n } from '../i18n';
import { useDeskFailure } from '../managed/DeskSection';
import { Card } from '../managed/ui';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ConnectionLogo } from '../ui/ConnectionLogo';
import {
  BatteryMedium,
  ChevronDown,
  ChevronUp,
  Globe,
  GripVertical,
  Headphones,
  Lock,
  type LucideIcon,
  RefreshCw,
  Wifi,
} from '../ui/icons';
import { Button } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';
import { DeskPreviewScreen } from './DeskPreviewScreen';
import {
  type DeskChoiceRow,
  deskDragPlaces,
  deskLevelOptions,
  deskMoveServer,
  deskScenarioOptions,
  deskShowsView,
  deskTryLabel,
} from './deskScreen';

const BAR_ICONS: Record<DeskBarItem, LucideIcon> = {
  network: Wifi,
  internet: Globe,
  battery: BatteryMedium,
  updates: RefreshCw,
};

export function DeskShowsPart({
  api,
  screen,
  options,
  actions,
  onDragging,
}: {
  api: DeskApi;
  screen: DeskScreen;
  options: readonly DeskShowOption[];
  actions: DeskActions;
  /** A server is being dragged: the page holds its scrolling still meanwhile. */
  onDragging: (dragging: boolean) => void;
}) {
  const failed = useDeskFailure();
  const assistant = useAgentWords().name;
  const show = screen.settings.show;
  const save = (patch: DeskShowPatch) => void actions.update({ show: patch }).catch(failed);
  return (
    <View style={{ gap: 18 }}>
      <PreviewCard api={api} screen={screen} assistant={assistant} />
      <DeskBarCard show={show} onPatch={save} />
      <DeskMiddleCard options={options} show={show} onPatch={save} />
      <DeskServersCard options={options} show={show} onPatch={save} onDragging={onDragging} />
      <DeskAroundCard show={show} onPatch={save} clock />
    </View>
  );
}

/** A hint under a card's label, the assistant's name filled in. */
function Hint({ text }: { text: string }) {
  const theme = useTheme();
  const assistant = useAgentWords().name;
  return (
    <Text size={13} lh={1.4} color={theme.colors.mut}>
      {fillDeskWords(text, { assistant })}
    </Text>
  );
}

/**
 * TOP BAR (DK-110): each item's Always · When it matters · Off, then remote help and the camera's fixed *Always*. On a
 * screen of widgets it is the box's own screen's (the top bar isn't part of the layout, DK-134).
 */
export function DeskBarCard({ show, onPatch }: { show: DeskShow; onPatch: (patch: DeskShowPatch) => void }) {
  const { rawLocale } = useI18n();
  const S = deskWords(rawLocale).settings;
  const theme = useTheme();
  const rows = DESK_BAR_ITEMS.map((item) => ({ item, ...S.barItems[item], level: show.bar[item] }));
  return (
    <Card label={S.bar.toUpperCase()}>
      <Part first>
        <Hint text={S.barHint} />
      </Part>
      {rows.map((r) => (
        <ChoiceRow
          key={r.item}
          icon={BAR_ICONS[r.item]}
          name={r.name}
          line={r.line}
          level={r.level}
          onLevel={(l) => onPatch({ bar: { [r.item]: l } })}
        />
      ))}
      <Part>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Headphones size={20} color={theme.colors.ink2} />
          <Names name={S.alwaysShown} line={S.alwaysShownHint} />
          <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
            accessibilityLabel={S.levels.always}
          >
            <Lock size={13} color={theme.colors.mut} />
            <Text size={13.5} color={theme.colors.mut}>
              {S.levels.always}
            </Text>
          </View>
        </View>
      </Part>
    </Card>
  );
}

/**
 * THE MIDDLE (DK-102…DK-106) by group: what may show among the things going on. On a screen of widgets these are
 * *What’s going on*'s own choices (DK-144), shown in its sheet with `label` its heading.
 */
export function DeskMiddleCard({
  options,
  show,
  onPatch,
  label,
  hint,
}: {
  options: readonly DeskShowOption[];
  show: DeskShow;
  onPatch: (patch: DeskShowPatch) => void;
  label?: string;
  hint?: string;
}) {
  const { rawLocale } = useI18n();
  const S = deskWords(rawLocale).settings;
  const assistant = useAgentWords().name;
  const view = useMemo(
    () => deskShowsView(options, show, assistant, rawLocale),
    [options, show, assistant, rawLocale],
  );
  return (
    <Card label={(label ?? S.middle).toUpperCase()}>
      <Part first>
        <Hint text={hint ?? S.middleHint} />
      </Part>
      {view.middle.map((g) => (
        <View key={g.group}>
          <GroupLabel title={g.title} />
          {g.rows.map((r) => (
            <ChoiceRow
              key={r.key}
              logo={r}
              name={r.name}
              line={r.line}
              level={r.level}
              onLevel={(l) => onPatch({ items: { [r.key]: l } })}
            />
          ))}
        </View>
      ))}
    </Card>
  );
}

/**
 * SERVERS (DK-108): the strip's order with Move up, Move down and a drag, each server's choice, and This Whombat's. On
 * a screen of widgets these are the *Servers* widget's own (DK-144), shown in its sheet with `label` its heading.
 */
export function DeskServersCard({
  options,
  show,
  onPatch,
  onDragging,
  label,
  hint,
}: {
  options: readonly DeskShowOption[];
  show: DeskShow;
  onPatch: (patch: DeskShowPatch) => void;
  /** A server is being dragged: the page holds its scrolling still meanwhile. */
  onDragging: (dragging: boolean) => void;
  label?: string;
  hint?: string;
}) {
  const { rawLocale } = useI18n();
  const S = deskWords(rawLocale).settings;
  const assistant = useAgentWords().name;
  const view = useMemo(
    () => deskShowsView(options, show, assistant, rawLocale),
    [options, show, assistant, rawLocale],
  );
  if (view.servers.length === 0 && !view.box) return null;
  const ids = view.servers.map((s) => s.id);
  const move = (id: string, by: number) => {
    const order = deskMoveServer(ids, id, by);
    if (order) onPatch({ order });
  };
  const level = (key: string) => (l: DeskShowLevel) => onPatch({ items: { [key]: l } });
  return (
    <Card label={(label ?? S.servers).toUpperCase()}>
      <Part first>
        <Hint text={hint ?? S.serversHint} />
      </Part>
      <ServerList
        servers={view.servers}
        onMove={move}
        onLevel={(key, l) => level(key)(l)}
        onDragging={onDragging}
      />
      {view.box ? (
        <ChoiceRow
          logo={view.box}
          name={view.box.name}
          line={view.box.line}
          level={view.box.level}
          onLevel={level(view.box.key)}
        />
      ) : null}
    </Card>
  );
}

/**
 * AROUND IT: the clock big or small (`clock`; a screen of widgets sizes its clock itself), *Welcome back* and *Done
 * today*.
 */
export function DeskAroundCard({
  show,
  onPatch,
  clock = false,
}: {
  show: DeskShow;
  onPatch: (patch: DeskShowPatch) => void;
  clock?: boolean;
}) {
  const { rawLocale } = useI18n();
  const S = deskWords(rawLocale).settings;
  const assistant = useAgentWords().name;
  return (
    <Card label={S.around.toUpperCase()}>
      {clock ? (
        <Part first>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Names name={S.clock.name} line={S.clock.line} />
            <View style={{ width: 128 }}>
              <Segmented<DeskClock>
                options={[
                  { value: 'big', label: S.clocks.big },
                  { value: 'small', label: S.clocks.small },
                ]}
                value={show.clock}
                onChange={(c) => onPatch({ clock: c })}
                label={S.clock.name}
              />
            </View>
          </View>
        </Part>
      ) : null}
      <SwitchRow
        first={!clock}
        name={S.welcomeBack.name}
        line={S.welcomeBack.line}
        on={show.welcomeBack}
        onChange={(welcomeBack) => onPatch({ welcomeBack })}
      />
      <SwitchRow
        name={S.doneToday.name}
        line={fillDeskWords(S.doneToday.line, { assistant })}
        on={show.doneToday}
        onChange={(doneToday) => onPatch({ doneToday })}
      />
    </Card>
  );
}

/* The preview ------------------------------------------------------------------------------------------------------ */

/**
 * The preview (DK-123, DK-124): the scenario chips, the box's calm glance for the page's choices (kept while the next
 * one loads), the note, and *Try “…” on the screen*, which says “On the screen for a minute.” until the screen goes
 * back.
 */
function PreviewCard({ api, screen, assistant }: { api: DeskApi; screen: DeskScreen; assistant: string }) {
  const { rawLocale } = useI18n();
  const S = deskWords(rawLocale).settings;
  const failed = useDeskFailure();
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const face = agentFaceOf(useTheAgentHere());
  const [scenario, setScenario] = useState<DeskPreviewScenario>('now');
  const show = screen.settings.show;
  const input = useMemo(() => ({ scenario, show }), [scenario, show]);
  const preview = useDeskPreview(api, input);
  const [trying, setTrying] = useState<number | null>(null);
  useEffect(() => {
    if (trying === null) return;
    const t = setTimeout(() => setTrying(null), Math.max(0, trying - Date.now()));
    return () => clearTimeout(t);
  }, [trying]);
  const tryIt = () =>
    api.tryOnScreen(input).then((r) => {
      const until = Date.parse(r.until);
      setTrying(Number.isFinite(until) ? until : Date.now() + DESK_TRY_S * 1000);
    }, failed);
  return (
    <Card>
      <Part first>
        <Text size={11} weight={600} mono tracking={0.1} color={theme.colors.mut} accessibilityRole="header">
          {S.preview.toUpperCase()}
        </Text>
        <Segmented
          options={deskScenarioOptions(assistant, rawLocale)}
          value={scenario}
          onChange={setScenario}
          label={S.preview}
          fit
        />
        {preview.data ? (
          <DeskPreviewScreen
            preview={preview.data}
            assistant={assistant}
            face={face}
            timeZone={timeZone}
            now={Date.now()}
          />
        ) : (
          <View
            style={{
              width: '100%',
              aspectRatio: 1280 / 800,
              borderRadius: 10,
              backgroundColor: theme.colors.sf2,
            }}
          />
        )}
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {S.previewNote}
        </Text>
        {trying !== null ? (
          <Text
            size={14}
            weight={500}
            lh={1.4}
            accessibilityLiveRegion="polite"
            style={{ minHeight: 44, paddingTop: 12 }}
          >
            {S.trying}
          </Text>
        ) : (
          <Button
            label={deskTryLabel(scenario, assistant, rawLocale)}
            variant="secondary"
            onPress={() => void tryIt()}
          />
        )}
      </Part>
    </Card>
  );
}

/* Rows ------------------------------------------------------------------------------------------------------------- */

function Part({ first = false, children }: { first?: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: 10,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {children}
    </View>
  );
}

function Names({ name, line }: { name: string; line?: string }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text size={15} weight={500} lh={1.35}>
        {name}
      </Text>
      {line ? (
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {line}
        </Text>
      ) : null}
    </View>
  );
}

function GroupLabel({ title }: { title: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 2,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Text size={11} weight={600} mono tracking={0.1} color={theme.colors.mut} accessibilityRole="header">
        {title.toUpperCase()}
      </Text>
    </View>
  );
}

/** A thing's mark: its brand's where `@whombat/brand` has one, else its first letter. */
function Logo({ row }: { row: Pick<DeskChoiceRow, 'mark' | 'name'> }) {
  const logo =
    row.mark && isBrandMark(row.mark)
      ? ({ kind: 'mark', mark: row.mark } as const)
      : ({ kind: 'monogram', letter: row.name.slice(0, 1).toUpperCase() } as const);
  return <ConnectionLogo logo={logo} size={32} />;
}

/** A thing to choose for: its icon or mark, name and line, then Always · When it matters · Off under them. */
function ChoiceRow({
  icon: Icon,
  logo,
  name,
  line,
  level,
  onLevel,
  lead,
  end,
}: {
  icon?: LucideIcon;
  logo?: Pick<DeskChoiceRow, 'mark' | 'name'>;
  name: string;
  line: string;
  level: DeskShowLevel;
  onLevel: (level: DeskShowLevel) => void;
  lead?: ReactNode;
  end?: ReactNode;
}) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  return (
    <Part>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {lead}
        {Icon ? <Icon size={20} color={theme.colors.ink2} /> : logo ? <Logo row={logo} /> : null}
        <Names name={name} line={line} />
        {end}
      </View>
      <Segmented options={deskLevelOptions(rawLocale)} value={level} onChange={onLevel} label={name} fit />
    </Part>
  );
}

function SwitchRow({
  name,
  line,
  on,
  onChange,
  first = false,
}: {
  name: string;
  line: string;
  on: boolean;
  onChange: (on: boolean) => void;
  first?: boolean;
}) {
  const theme = useTheme();
  return (
    <Part first={first}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Names name={name} line={line} />
        <Switch
          value={on}
          onValueChange={onChange}
          accessibilityLabel={name}
          accessibilityHint={line}
          accessibilityRole="switch"
          {...switchColors(theme, on)}
          style={{ minHeight: 44 }}
        />
      </View>
    </Part>
  );
}

/* Servers ---------------------------------------------------------------------------------------------------------- */

type ServerRow = DeskChoiceRow & { id: string };

/**
 * The servers in the strip's order (DK-108): each with its grip, Move up and Move down. A drag by the grip marks where
 * the server will land with a line and moves it there on release; half a row is enough to change places.
 */
function ServerList({
  servers,
  onMove,
  onLevel,
  onDragging,
}: {
  servers: readonly ServerRow[];
  onMove: (id: string, by: number) => void;
  onLevel: (key: string, level: DeskShowLevel) => void;
  onDragging: (dragging: boolean) => void;
}) {
  const { rawLocale } = useI18n();
  const S = deskWords(rawLocale).settings;
  const theme = useTheme();
  const [drag, setDrag] = useState<{ id: string; dy: number } | null>(null);
  const heights = useRef(new Map<string, number>());
  const rowHeight = () => {
    const all = [...heights.current.values()];
    return all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
  };
  const from = drag ? servers.findIndex((s) => s.id === drag.id) : -1;
  const to =
    drag && from >= 0
      ? Math.min(servers.length - 1, Math.max(0, from + deskDragPlaces(drag.dy, rowHeight())))
      : -1;
  const latest = useRef({ onMove, onDragging, rowHeight });
  latest.current = { onMove, onDragging, rowHeight };
  const dragTo = useMemo(
    () => ({
      start(id: string) {
        latest.current.onDragging(true);
        setDrag({ id, dy: 0 });
      },
      move(id: string, dy: number) {
        setDrag({ id, dy });
      },
      end(id: string, dy: number) {
        latest.current.onDragging(false);
        setDrag(null);
        const by = deskDragPlaces(dy, latest.current.rowHeight());
        if (by !== 0) latest.current.onMove(id, by);
      },
    }),
    [],
  );
  const mark = <View style={{ height: 2, marginHorizontal: 16, backgroundColor: theme.colors.brand }} />;
  return (
    <View>
      {servers.map((s, i) => (
        <View
          key={s.id}
          onLayout={(e) => heights.current.set(s.id, e.nativeEvent.layout.height)}
          style={{ backgroundColor: drag?.id === s.id ? theme.colors.sel : 'transparent' }}
        >
          {to === i && to < from ? mark : null}
          <ChoiceRow
            logo={s}
            name={s.name}
            line={s.line}
            level={s.level}
            onLevel={(l) => onLevel(s.key, l)}
            lead={<Grip id={s.id} drag={dragTo} />}
            end={
              <>
                <MoveButton
                  label={fillDeskWords(S.moveUp, { name: s.name })}
                  icon={ChevronUp}
                  disabled={i === 0}
                  onPress={() => onMove(s.id, -1)}
                />
                <MoveButton
                  label={fillDeskWords(S.moveDown, { name: s.name })}
                  icon={ChevronDown}
                  disabled={i === servers.length - 1}
                  onPress={() => onMove(s.id, 1)}
                />
              </>
            }
          />
          {to === i && to > from ? mark : null}
        </View>
      ))}
    </View>
  );
}

/** The grip: a drag handle for the finger only (Move up and Move down are the buttons TalkBack reads). */
function Grip({
  id,
  drag,
}: {
  id: string;
  drag: { start(id: string): void; move(id: string, dy: number): void; end(id: string, dy: number): void };
}) {
  const theme = useTheme();
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => drag.start(id),
        onPanResponderMove: (_, g) => drag.move(id, g.dy),
        onPanResponderRelease: (_, g) => drag.end(id, g.dy),
        onPanResponderTerminate: () => drag.end(id, 0),
      }),
    [id, drag],
  );
  return (
    <View
      {...responder.panHandlers}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 24, height: 44, marginLeft: -6, alignItems: 'center', justifyContent: 'center' }}
    >
      <GripVertical size={18} color={theme.colors.mut} />
    </View>
  );
}

function MoveButton({
  label,
  icon: Icon,
  disabled,
  onPress,
}: {
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      feedback="wash"
      ringRadius={22}
      style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon size={20} color={disabled ? theme.colors.line2 : theme.colors.ink2} />
    </Touchable>
  );
}
