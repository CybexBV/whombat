/**
 * A chosen widget's sheet on the phone (Whombat desk-display.md DK-140, DK-143…DK-145, DK-159, DK-164, DK-165, DK-167;
 * desk-display-android.md AP-6015, AP-6016, AP-6018…AP-6020, AP-6123, AP-9980…): what it is and where (an account's
 * widget names its account, “Google · anna@example.com”); *Move* — four arrows, one cell each (an arrow at the grid's
 * edge is off; onto one other widget the two change places, any other taken spot says so); *Size* — its shapes as the
 * Overview's gear draws them, then − and + for wide and high, within its smallest and largest; its own settings
 * (*What’s going on*'s choices and *Servers*' order; a server's server; *What it shows* — every view of its connection,
 * server or account as the Overview's options; a server's chart's range; *On a locked screen*); what touching it on the
 * screen does; *Remove from this page* and *Done*. Every button 44dp and named for TalkBack with the widget's name.
 * Changes go into the draft.
 */
import {
  DESK_SCREENS_TEXT,
  DESK_WIDGET_LOCK,
  DESK_WIDGET_RANGES,
  type DeskCatalogItem,
  type DeskShow,
  type DeskShowOption,
  type DeskShowPatch,
  type DeskWidget,
  fillDeskWords,
  gridText,
  sameWidget,
  sizePresets,
  type ViewOf,
  widgetSize,
} from '@whombat/client/desk';
import { type Grid, SERVER_SHOW_VIEWS, serverShow } from '@whombat/screen';
import { type ReactNode, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  type LucideIcon,
  Minus,
  Plus,
} from '../../ui/icons';
import { Button, SectionLabel } from '../../ui/primitives';
import { Segmented } from '../../ui/Segmented';
import { Sheet } from '../../ui/sheet';
import { Touchable } from '../../ui/Touchable';
import { DeskMiddleCard, DeskServersCard } from '../DeskShowsPart';
import { PHONE_SCREENS_TEXT, sizesLine, type TileLabel, tileWhere } from './tiles';
import { WidgetLogo } from './WidgetLogo';

const E = DESK_SCREENS_TEXT.editor;
const M = PHONE_SCREENS_TEXT;

export interface WidgetSheetActions {
  nudge(dx: number, dy: number): void;
  grow(dim: 'w' | 'h', by: number): void;
  canNudge(dx: number, dy: number): boolean;
  /** One of *Size*'s shapes: `w` × `h` at once. */
  resize(w: number, h: number): void;
  setOpts(opts: Record<string, string>): void;
  setRef(ref: string): void;
  /** *What it shows*: another view of its connection, server or account. */
  choose(item: DeskCatalogItem): void;
  setShow(patch: DeskShowPatch): void;
  remove(): void;
}

export function WidgetSheet({
  visible,
  onClose,
  widget,
  label,
  grid,
  viewOf,
  actions,
  options,
  show,
  servers,
  choices = [],
  reading = false,
  pairFirst = false,
  lockable = false,
  note,
  noteTone = 'bad',
}: {
  visible: boolean;
  onClose: () => void;
  widget: DeskWidget | null;
  label: TileLabel | null;
  /** The page's grid: the shapes it has room for. */
  grid: Pick<Grid, 'cols' | 'rows'>;
  viewOf: ViewOf;
  actions: WidgetSheetActions;
  /**
   * What *What’s going on* and *Servers* can choose from (the box's lists); none on a runtime without them, or where
   * the choices can't be kept now (the box's own screen before it's paired: `pairFirst`).
   */
  options: readonly DeskShowOption[] | undefined;
  pairFirst?: boolean;
  /** It shows what a locked screen leaves out (`widgetPrivate`): *On a locked screen* is offered. */
  lockable?: boolean;
  /** The screen's choices as the draft has them. */
  show: DeskShow;
  /** The servers a server widget can show, once each. */
  servers: readonly DeskCatalogItem[];
  /** Every view of its connection, server or account (`catalogGroupOf`'s items), for *What it shows*. */
  choices?: readonly DeskCatalogItem[];
  /** The rest of its views are being read (a connection listed only partly). */
  reading?: boolean;
  /** What a button here did or couldn't do, said under Move and Size (the toasts are behind the sheet). */
  note: string | null;
  /** `bad` for what couldn't be done, `ok` for what was (two widgets swapped). */
  noteTone?: 'bad' | 'ok';
}) {
  const theme = useTheme();
  const [dragging, setDragging] = useState(false);
  const name = label?.name ?? '';
  const sheetLabel = name || E.addWidget;
  return (
    <Sheet visible={visible && widget !== null} onClose={onClose} label={sheetLabel} maxHeight="88%">
      {widget && label ? (
        <ScrollView
          scrollEnabled={!dragging}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8, gap: 18 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <WidgetLogo type={widget.type} mark={label.mark} name={label.of ?? label.name} size={40} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
                {label.name}
              </Text>
              <Text size={13} lh={1.4} color={theme.colors.mut}>
                {[label.of, tileWhere(widget)].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </View>
          <MovePart name={name} actions={actions} />
          <SizePart widget={widget} name={name} grid={grid} viewOf={viewOf} actions={actions} />
          {note ? (
            <Text
              size={14}
              lh={1.45}
              color={noteTone === 'ok' ? theme.colors.ink2 : theme.colors.bad}
              accessibilityLiveRegion="polite"
              style={{ paddingHorizontal: 6, marginTop: -6 }}
            >
              {note}
            </Text>
          ) : null}
          <OwnSettings
            widget={widget}
            actions={actions}
            options={options}
            show={show}
            servers={servers}
            choices={choices}
            reading={reading}
            pairFirst={pairFirst}
            lockable={lockable}
            onDragging={setDragging}
          />
          <TouchLine widget={widget} label={label} server={servers.find((s) => s.ref === widget.ref)?.name} />
          <View style={{ gap: 6 }}>
            <RemoveButton name={name} onPress={actions.remove} />
            <Button label={M.done} onPress={onClose} />
          </View>
        </ScrollView>
      ) : null}
    </Sheet>
  );
}

/* Move and Size ---------------------------------------------------------------------------------------------------- */

const ARROWS: readonly { key: keyof typeof M.moveTo; dx: number; dy: number; icon: LucideIcon }[] = [
  { key: 'left', dx: -1, dy: 0, icon: ArrowLeft },
  { key: 'up', dx: 0, dy: -1, icon: ArrowUp },
  { key: 'down', dx: 0, dy: 1, icon: ArrowDown },
  { key: 'right', dx: 1, dy: 0, icon: ArrowRight },
];

function MovePart({ name, actions }: { name: string; actions: WidgetSheetActions }) {
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>{M.move.toUpperCase()}</SectionLabel>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {ARROWS.map((a) => (
          <SquareButton
            key={a.key}
            icon={a.icon}
            label={fillDeskWords(M.moveTo[a.key], { name })}
            disabled={!actions.canNudge(a.dx, a.dy)}
            onPress={() => actions.nudge(a.dx, a.dy)}
            wide
          />
        ))}
      </View>
    </View>
  );
}

function SizePart({
  widget,
  name,
  grid,
  viewOf,
  actions,
}: {
  widget: DeskWidget;
  name: string;
  grid: Pick<Grid, 'cols' | 'rows'>;
  viewOf: ViewOf;
  actions: WidgetSheetActions;
}) {
  const theme = useTheme();
  const size = widgetSize(widget, viewOf);
  const presets = sizePresets(size, grid);
  const stepper = (dim: 'w' | 'h') => {
    const value = widget[dim];
    const i = dim === 'w' ? 0 : 1;
    const less = dim === 'w' ? E.narrower : E.lower;
    const more = dim === 'w' ? E.wider : E.higher;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text size={14} color={theme.colors.mut} style={{ width: 40 }}>
          {dim === 'w' ? E.wide : E.high}
        </Text>
        <SquareButton
          icon={Minus}
          label={`${less}, ${name}`}
          disabled={value <= (size.min[i] ?? 1)}
          onPress={() => actions.grow(dim, -1)}
        />
        <Text
          size={16}
          weight={600}
          mono
          style={{ minWidth: 22, textAlign: 'center' }}
          accessibilityLabel={`${dim === 'w' ? E.wide : E.high} ${value}`}
        >
          {String(value)}
        </Text>
        <SquareButton
          icon={Plus}
          label={`${more}, ${name}`}
          disabled={value >= (size.max[i] ?? value)}
          onPress={() => actions.grow(dim, 1)}
        />
      </View>
    );
  };
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>{E.sizeLabel.toUpperCase()}</SectionLabel>
      {presets.length > 1 ? (
        <Shapes
          name={name}
          presets={presets}
          value={{ w: widget.w, h: widget.h }}
          onPick={(p) => actions.resize(p.w, p.h)}
        />
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 8 }}>
        {stepper('w')}
        {stepper('h')}
      </View>
      <Text size={13} lh={1.4} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
        {`${gridText(widget.w, widget.h)} · ${sizesLine(size)}`}
      </Text>
    </View>
  );
}

/**
 * *Size*'s shapes (DK-165), the Overview gear's way (its `Shapes`): a `line` trough padded 3, each shape 44dp and more
 * with its cells drawn small over its name and size, the one it is on `sf`. Radios for TalkBack, named with the widget.
 */
function Shapes({
  name,
  presets,
  value,
  onPick,
}: {
  name: string;
  presets: readonly { key: keyof typeof E.shapes; w: number; h: number }[];
  value: { w: number; h: number };
  onPick: (p: { w: number; h: number }) => void;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={`${E.sizeLabel}, ${name}`}
      style={{
        flexDirection: 'row',
        gap: 2,
        padding: 3,
        borderRadius: 12,
        backgroundColor: theme.colors.line,
      }}
    >
      {presets.map((p) => {
        const on = p.w === value.w && p.h === value.h;
        const cell = Math.max(3, Math.min(6, Math.floor(40 / p.w), Math.floor(24 / p.h)));
        return (
          <Touchable
            key={p.key}
            onPress={() => onPick(p)}
            feedback={on ? 'none' : 'wash'}
            ringRadius={9}
            accessibilityRole="radio"
            accessibilityLabel={fillDeskWords(E.shape, { name: E.shapes[p.key], size: gridText(p.w, p.h) })}
            accessibilityState={{ selected: on }}
            style={{
              flex: 1,
              minHeight: 44,
              paddingTop: 8,
              paddingBottom: 6,
              paddingHorizontal: 2,
              borderRadius: 9,
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 4,
              backgroundColor: on ? theme.colors.sf : 'transparent',
            }}
          >
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ width: p.w * cell + (p.w - 1), flexDirection: 'row', flexWrap: 'wrap', gap: 1 }}
            >
              {Array.from({ length: p.w * p.h }, (_, i) => (
                <View
                  // biome-ignore lint/suspicious/noArrayIndexKey: a shape's cells are fixed places
                  key={i}
                  style={{
                    width: cell,
                    height: cell,
                    borderRadius: 1,
                    backgroundColor: on ? theme.colors.ink : theme.colors.mut,
                    opacity: on ? 1 : 0.55,
                  }}
                />
              ))}
            </View>
            <Text size={12.5} weight={500} color={on ? theme.colors.ink : theme.colors.mut} numberOfLines={1}>
              {E.shapes[p.key]}
            </Text>
            <Text size={11} mono color={on ? theme.colors.ink2 : theme.colors.mut}>
              {`${p.w}×${p.h}`}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}

/** A 44dp square button with an icon: the arrows (`wide`: sharing the row) and the size steppers. */
function SquareButton({
  icon: Icon,
  label,
  disabled,
  onPress,
  wide = false,
}: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  onPress: () => void;
  wide?: boolean;
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
      ringRadius={12}
      style={{
        ...(wide ? { flex: 1 } : { width: 44 }),
        height: 44,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon size={20} color={disabled ? theme.colors.line2 : theme.colors.ink} />
    </Touchable>
  );
}

/* Its own settings (DK-144) ---------------------------------------------------------------------------------------- */

function OwnSettings({
  widget,
  actions,
  options,
  show,
  servers,
  choices,
  reading,
  pairFirst,
  lockable,
  onDragging,
}: {
  widget: DeskWidget;
  actions: WidgetSheetActions;
  options: readonly DeskShowOption[] | undefined;
  show: DeskShow;
  servers: readonly DeskCatalogItem[];
  choices: readonly DeskCatalogItem[];
  reading: boolean;
  pairFirst: boolean;
  /** It shows something private: *On a locked screen* is offered. */
  lockable: boolean;
  onDragging: (dragging: boolean) => void;
}) {
  const theme = useTheme();
  const opt = (key: string, value: string) => actions.setOpts({ ...widget.opts, [key]: value });
  if ((widget.type === 'now' || widget.type === 'strip') && pairFirst)
    return (
      <Text size={14} lh={1.45} color={theme.colors.ink2} style={{ paddingHorizontal: 6 }}>
        {M.pairFirst}
      </Text>
    );
  switch (widget.type) {
    case 'now':
      return options ? (
        <DeskMiddleCard
          options={options}
          show={show}
          onPatch={actions.setShow}
          label={E.nowChoices}
          hint={E.nowHint}
        />
      ) : null;
    case 'strip':
      return options ? (
        <DeskServersCard
          options={options}
          show={show}
          onPatch={actions.setShow}
          onDragging={onDragging}
          label={E.stripOrder}
          hint={E.stripHint}
        />
      ) : null;
    case 'server': {
      const part = serverShow(widget.opts);
      // The overview draws its processor over the range when it's high enough; the charted parts always do.
      const ranged = part === 'overview' || SERVER_SHOW_VIEWS[part] === 'chart';
      return (
        <>
          {servers.length > 0 ? (
            <View style={{ gap: 6 }}>
              <SectionLabel>{E.server.toUpperCase()}</SectionLabel>
              <ChoiceCard label={E.server}>
                {servers.map((s, i) => (
                  <ChoiceRow
                    key={s.ref ?? s.name}
                    name={s.name}
                    line={s.line}
                    logo={<WidgetLogo type="server" mark={s.mark} name={s.name} />}
                    first={i === 0}
                    chosen={s.ref === widget.ref}
                    onPress={() => s.ref && actions.setRef(s.ref)}
                  />
                ))}
              </ChoiceCard>
            </View>
          ) : null}
          <ShowsPart widget={widget} choices={choices} reading={reading} onChoose={actions.choose} />
          {ranged ? (
            <View style={{ gap: 8 }}>
              <SectionLabel>{E.chart.toUpperCase()}</SectionLabel>
              <Segmented
                options={DESK_WIDGET_RANGES.map((value) => ({ value, label: E.ranges[value] }))}
                value={
                  (DESK_WIDGET_RANGES as readonly string[]).includes(widget.opts.range ?? '')
                    ? (widget.opts.range as (typeof DESK_WIDGET_RANGES)[number])
                    : '24h'
                }
                onChange={(range) => opt('range', range)}
                label={E.chart}
              />
            </View>
          ) : null}
          {lockable ? <LockPart widget={widget} onLock={(lock) => opt('lock', lock)} /> : null}
        </>
      );
    }
    case 'panel':
    case 'figures':
    case 'widget':
      return (
        <>
          <ShowsPart widget={widget} choices={choices} reading={reading} onChoose={actions.choose} />
          {lockable ? <LockPart widget={widget} onLock={(lock) => opt('lock', lock)} /> : null}
        </>
      );
    default:
      return null;
  }
}

/**
 * *What it shows* (DK-164): every view of its connection, server or account as the Overview gear's options — 44dp and
 * more, a hairline on `sf`, its name over its line, the one it shows ringed in `ink` — radios for TalkBack. Choosing one
 * changes the widget in its place, fitted to the new view.
 */
function ShowsPart({
  widget,
  choices,
  reading,
  onChoose,
}: {
  widget: DeskWidget;
  choices: readonly DeskCatalogItem[];
  reading: boolean;
  onChoose: (item: DeskCatalogItem) => void;
}) {
  const theme = useTheme();
  if (choices.length < 2 && !reading) return null;
  return (
    <View style={{ gap: 6 }}>
      <SectionLabel>{E.shows.toUpperCase()}</SectionLabel>
      <View accessibilityRole="radiogroup" accessibilityLabel={E.shows} style={{ gap: 6 }}>
        {choices.map((item) => {
          const on = sameWidget(widget, item);
          return (
            <Touchable
              key={`${item.type}|${item.opts.panel ?? ''}|${item.opts.show ?? ''}`}
              onPress={() => {
                if (!on) onChoose(item);
              }}
              feedback="wash"
              ringRadius={12}
              accessibilityRole="radio"
              accessibilityLabel={item.line ? `${item.name}, ${item.line}` : item.name}
              accessibilityState={{ selected: on }}
              style={{
                minHeight: 44,
                justifyContent: 'center',
                gap: 2,
                paddingVertical: on ? 8 : 9,
                paddingHorizontal: on ? 11 : 12,
                borderRadius: 12,
                borderWidth: on ? 2 : 1,
                borderColor: on ? theme.colors.ink : theme.colors.line,
                backgroundColor: theme.colors.sf,
              }}
            >
              <Text size={14.5} weight={500} lh={1.35}>
                {item.name}
              </Text>
              {item.line ? (
                <Text size={12.5} lh={1.4} color={theme.colors.mut} numberOfLines={2}>
                  {item.line}
                </Text>
              ) : null}
            </Touchable>
          );
        })}
      </View>
      {reading ? (
        <Text size={12.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
          {E.reading}
        </Text>
      ) : null}
    </View>
  );
}

/** *On a locked screen*: *Show it* · *Hide it*, hidden unless chosen, for a widget that shows something private. */
function LockPart({ widget, onLock }: { widget: DeskWidget; onLock: (lock: string) => void }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>{E.lock.toUpperCase()}</SectionLabel>
      <Segmented
        options={DESK_WIDGET_LOCK.map((value) => ({ value, label: E.locks[value] }))}
        value={widget.opts.lock === 'show' ? 'show' : 'hide'}
        onChange={onLock}
        label={E.lock}
      />
      <Text size={13} lh={1.4} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
        {E.lockHint}
      </Text>
    </View>
  );
}

/** A card of radio rows: *Server*'s servers. */
function ChoiceCard({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        borderRadius: 20,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

/** A choice: a server with its mark, name and line; the chosen one checked (a radio for TalkBack). */
function ChoiceRow({
  name,
  line,
  logo,
  first,
  chosen,
  onPress,
}: {
  name: string;
  line?: string;
  logo?: ReactNode;
  first: boolean;
  chosen: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="radio"
      accessibilityState={{ selected: chosen }}
      accessibilityLabel={line ? `${name}, ${line}` : name}
      onPress={onPress}
      feedback="wash"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {logo ?? null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text size={15} weight={500} lh={1.35}>
          {name}
        </Text>
        {line ? (
          <Text size={13} lh={1.4} color={theme.colors.mut} numberOfLines={1}>
            {line}
          </Text>
        ) : null}
      </View>
      {chosen ? <Check size={20} color={theme.colors.ink} /> : null}
    </Touchable>
  );
}

/**
 * What touching it on the screen does (DK-140): a server, any part of it, opens the server's page; the rest open big;
 * Whombat's own as before.
 */
function TouchLine({
  widget,
  label,
  server,
}: {
  widget: DeskWidget;
  label: TileLabel;
  server?: string | undefined;
}) {
  const theme = useTheme();
  const text =
    widget.type === 'server'
      ? fillDeskWords(E.touchServer, { name: server ?? label.name })
      : ['panel', 'figures', 'widget'].includes(widget.type)
        ? E.touchBig
        : widget.type === 'done' || widget.type === 'work'
          ? E.touchOwn
          : null;
  if (!text) return null;
  return (
    <View style={{ gap: 4 }}>
      <SectionLabel>{E.touch.toUpperCase()}</SectionLabel>
      <Text size={14} lh={1.45} color={theme.colors.ink2} style={{ paddingHorizontal: 6 }}>
        {text}
      </Text>
    </View>
  );
}

/** *Remove from this page*, in red; Undo brings it back. */
function RemoveButton({ name, onPress }: { name: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={fillDeskWords(E.removeOne, { name })}
      onPress={onPress}
      feedback="wash"
      ringRadius={12}
      style={{
        minHeight: 44,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 12,
      }}
    >
      <Text size={15} weight={500} color={theme.colors.bad}>
        {E.remove}
      </Text>
    </Touchable>
  );
}
