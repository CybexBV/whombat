/**
 * A chosen widget's sheet on the phone (Whombat desk-display.md DK-140, DK-143…DK-145, DK-159; desk-display-android.md
 * AP-6015, AP-6016, AP-6018…AP-6020, AP-6123): what it is and where (an account's widget names its account, “Google ·
 * anna@example.com”); *Move* — four arrows, one cell each (an arrow at the grid's edge is off, a taken spot says so);
 * *Size* — − and + for wide and high, within its smallest and largest; its own settings (*What’s going on*'s choices and
 * *Servers*' order, moved here from the older *Screen* page; a server's server, the part of it it shows and its chart's
 * range; what a connection's widget shows; which of its account's widgets an account's shows; *On a locked screen*); what
 * touching it on the screen does; *Remove from this page* and *Done*. Every button 44dp and named for TalkBack with the widget's name. Changes go into the draft.
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
  type ViewOf,
  widgetSize,
} from '@whombat/client/desk';
import { SERVER_SHOW_VIEWS, serverShow } from '@whombat/screen';
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
import { accountShows } from './catalog';
import { PHONE_SCREENS_TEXT, sizesLine, type TileLabel, tileWhere } from './tiles';
import { ACCOUNT_ICONS, WidgetLogo } from './WidgetLogo';

const E = DESK_SCREENS_TEXT.editor;
const M = PHONE_SCREENS_TEXT;

/** A part of a server *Shows* offers: its `opts.show` (the overview's empty) and name. */
export interface ServerPart {
  show: string;
  name: string;
}

export interface WidgetSheetActions {
  nudge(dx: number, dy: number): void;
  grow(dim: 'w' | 'h', by: number): void;
  canNudge(dx: number, dy: number): boolean;
  setOpts(opts: Record<string, string>): void;
  setRef(ref: string): void;
  /** A server widget's part (`opts.show`; the overview's is empty), its other choices kept. */
  setPart(show: string): void;
  /** An account widget switched to another of its account's widgets. */
  setItem(item: DeskCatalogItem): void;
  setShow(patch: DeskShowPatch): void;
  remove(): void;
}

export function WidgetSheet({
  visible,
  onClose,
  widget,
  label,
  viewOf,
  actions,
  options,
  show,
  servers,
  parts,
  choices = [],
  pairFirst = false,
  lockable = false,
  note,
}: {
  visible: boolean;
  onClose: () => void;
  widget: DeskWidget | null;
  label: TileLabel | null;
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
  /** The parts the chosen server widget's server offers (`serverParts`), for *Shows*. */
  parts: readonly ServerPart[];
  /** The widgets of an account widget's account it can switch to (`accountChoices`), for *Shows*. */
  choices?: readonly DeskCatalogItem[];
  /** What a button here couldn't do, said under Move and Size (the toasts are behind the sheet). */
  note: string | null;
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
          <SizePart widget={widget} name={name} viewOf={viewOf} actions={actions} />
          {note ? (
            <Text
              size={14}
              lh={1.45}
              color={theme.colors.bad}
              accessibilityLiveRegion="polite"
              style={{ paddingHorizontal: 6, marginTop: -6 }}
            >
              {note}
            </Text>
          ) : null}
          <OwnSettings
            widget={widget}
            label={label}
            actions={actions}
            options={options}
            show={show}
            servers={servers}
            parts={parts}
            choices={choices}
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
  viewOf,
  actions,
}: {
  widget: DeskWidget;
  name: string;
  viewOf: ViewOf;
  actions: WidgetSheetActions;
}) {
  const theme = useTheme();
  const size = widgetSize(widget, viewOf);
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
  label,
  actions,
  options,
  show,
  servers,
  parts,
  choices,
  pairFirst,
  lockable,
  onDragging,
}: {
  widget: DeskWidget;
  label: TileLabel;
  actions: WidgetSheetActions;
  options: readonly DeskShowOption[] | undefined;
  show: DeskShow;
  servers: readonly DeskCatalogItem[];
  parts: readonly ServerPart[];
  choices: readonly DeskCatalogItem[];
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
      const chosenPart = part === 'overview' ? '' : part;
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
          {parts.length > 1 ? (
            <View style={{ gap: 6 }}>
              <SectionLabel>{E.panel.toUpperCase()}</SectionLabel>
              <ChoiceCard label={E.panel}>
                {parts.map((p, i) => (
                  <ChoiceRow
                    key={p.show || 'overview'}
                    name={p.name}
                    first={i === 0}
                    chosen={p.show === chosenPart}
                    onPress={() => actions.setPart(p.show)}
                  />
                ))}
              </ChoiceCard>
            </View>
          ) : null}
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
          {choices.length > 1 ? (
            // An account's widget: another of its account's, as a server's parts.
            <View style={{ gap: 6 }}>
              <SectionLabel>{E.panel.toUpperCase()}</SectionLabel>
              <ChoiceCard label={E.panel}>
                {choices.map((item, i) => {
                  const shows = accountShows(item);
                  return (
                    <ChoiceRow
                      key={item.opts.panel ?? item.name}
                      name={item.name}
                      line={item.line}
                      logo={
                        <WidgetLogo
                          type={item.type}
                          mark={item.mark}
                          name={item.name}
                          icon={shows ? ACCOUNT_ICONS[shows] : undefined}
                        />
                      }
                      first={i === 0}
                      chosen={(item.opts.panel ?? '') === (widget.opts.panel ?? '')}
                      onPress={() => actions.setItem(item)}
                    />
                  );
                })}
              </ChoiceCard>
            </View>
          ) : widget.type !== 'widget' && label.of ? (
            <View style={{ gap: 4 }}>
              <SectionLabel>{E.panel.toUpperCase()}</SectionLabel>
              <Text size={15} lh={1.4} style={{ paddingHorizontal: 6 }}>
                {fillDeskWords(M.shows, { panel: label.name, thing: label.of })}
              </Text>
            </View>
          ) : null}
          {lockable ? <LockPart widget={widget} onLock={(lock) => opt('lock', lock)} /> : null}
        </>
      );
    default:
      return null;
  }
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

/** A card of radio rows: *Server*'s servers, *Shows*' parts or an account's widgets. */
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

/**
 * A choice: a server or an account's widget with its mark, name and line, or a part by its name; the chosen one
 * checked (a radio for TalkBack).
 */
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
