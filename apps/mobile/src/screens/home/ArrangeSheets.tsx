/**
 * A gear's sheet on the arranged Overview (docs/decisions/overview-arranged.md; the mock's `.drawer` at
 * phone width, a sheet from the bottom): for a tile its logo and name, the tile as it looks, *What it shows* (its main
 * figures or a panel of its page, each with what it says now), *Time span* where it draws a chart, *Size*, *Place*
 * (Move earlier, Move later: no dragging on a phone) and *Remove from Overview*; for a figure at the top Whombat's own
 * four and every thing's figures grouped by thing, those at the top already greyed; for a pinned chart *Width*, *Place*
 * and *Remove*; and *Add to Overview* with what was removed. Every choice is saved at once; there is no Save.
 */
import {
  ARRANGE_WORDS,
  type ArrangedTile,
  type FigureFace,
  type HomeThingRow,
  type OverviewTile,
} from '@whombat/client';
import { useOverviewFigures } from '@whombat/client/react';
import type { OverviewLayoutTop, OverviewRange, OverviewTileSize, Widget } from '@whombat/core';
import { type ReactNode, useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { type ShowChoice, tileShowChoices, topChoiceGroups } from '../../data/overviewArranged';
import type { PhoneGlyph } from '../../data/thingLook';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { ThingIcon } from '../../ui/assistant';
import { LayoutGrid, Pin, Plus, X } from '../../ui/icons';
import { Button, SectionLabel } from '../../ui/primitives';
import { Segmented } from '../../ui/Segmented';
import { Sheet } from '../../ui/sheet';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';
import { ConnectionTile } from './ServicesCard';

const A = ARRANGE_WORDS;

/** What a gear opened: a tile, one of the four figures, a pinned chart, or *Add to Overview*. */
export type ArrangeTarget =
  | { kind: 'tile'; thing: string }
  | { kind: 'figure'; index: number }
  | { kind: 'pin'; id: string }
  | { kind: 'add' };

/** The changes a sheet makes; each is saved at once. */
export interface ArrangeActions {
  show(thing: string, choice: ShowChoice): void;
  range(thing: string, range: OverviewRange): void;
  size(thing: string, size: OverviewTileSize): void;
  move(thing: string, by: -1 | 1): void;
  remove(thing: string): void;
  add(thing: string): void;
  top(index: number, top: OverviewLayoutTop): void;
  pinSize(id: string, size: 'half' | 'full'): void;
  pinMove(id: string, by: -1 | 1): void;
  canPinMove(id: string, by: -1 | 1): boolean;
  pinRemove(id: string): void;
  pinAdd(id: string): void;
}

export function ArrangeSheet({
  target,
  onClose,
  tiles,
  removed,
  faceOf,
  glyphOf,
  top,
  pins,
  removedPins,
  pinSizes,
  actions,
  failed,
}: {
  target: ArrangeTarget | null;
  onClose: () => void;
  tiles: readonly ArrangedTile<OverviewTile>[];
  removed: readonly ArrangedTile<OverviewTile>[];
  /** What a tile shows now (null until its view arrives). */
  faceOf: (at: ArrangedTile<OverviewTile>) => FigureFace | null;
  glyphOf: (thing: string) => { glyph: PhoneGlyph; mark: HomeThingRow['mark']; name: string } | null;
  top: readonly OverviewLayoutTop[];
  pins: readonly Widget[];
  removedPins: readonly Widget[];
  pinSizes: Readonly<Record<string, 'half' | 'full'>>;
  actions: ArrangeActions;
  /** The last save failed. */
  failed: boolean;
}) {
  const { slug } = useBurrowBase();
  const theme = useTheme();
  // While the sheet slides away it keeps what it showed.
  const last = useRef(target);
  if (target) last.current = target;
  const asked = target;
  target = target ?? last.current;
  const tileAt = target?.kind === 'tile' ? tiles.findIndex((t) => t.tile.thing === target.thing) : -1;
  const tile = tileAt === -1 ? null : (tiles[tileAt] ?? null);
  const pin = target?.kind === 'pin' ? (pins.find((p) => p.id === target.id) ?? null) : null;
  // What a tile can show is read when its gear opens; a figure's choices, every thing's.
  const thingFigures = useOverviewFigures(slug, tile?.tile.thing ?? null, !!tile);
  const allFigures = useOverviewFigures(slug, null, target?.kind === 'figure');
  const label =
    target?.kind === 'tile'
      ? A.changeTile(tile?.item.row.name ?? '')
      : target?.kind === 'figure'
        ? A.figureTitle
        : target?.kind === 'pin'
          ? A.changePin(pin?.title ?? '')
          : A.add;
  const visible = asked !== null && (asked.kind !== 'tile' || !!tile) && (asked.kind !== 'pin' || !!pin);
  return (
    <Sheet visible={visible} onClose={onClose} label={label} maxHeight="88%">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 12 }}
      >
        {target?.kind === 'tile' && tile ? (
          <TileParts
            at={tile}
            first={tileAt === 0}
            last={tileAt === tiles.length - 1}
            face={faceOf(tile)}
            glyph={glyphOf(tile.tile.thing)?.glyph ?? tile.item.row.glyph}
            choices={tileShowChoices(thingFigures.data, tile.tile.thing)}
            reading={thingFigures.isLoading}
            couldntRead={!!thingFigures.error && !thingFigures.data}
            actions={actions}
            onClose={onClose}
          />
        ) : target?.kind === 'figure' ? (
          <FigureParts
            index={target.index}
            groups={topChoiceGroups(allFigures.data, top, target.index)}
            glyphOf={glyphOf}
            reading={allFigures.isLoading}
            couldntRead={!!allFigures.error && !allFigures.data}
            actions={actions}
            onClose={onClose}
          />
        ) : target?.kind === 'pin' && pin ? (
          <PinParts pin={pin} size={pinSizes[pin.id] ?? 'half'} actions={actions} onClose={onClose} />
        ) : target?.kind === 'add' ? (
          <AddParts
            removed={removed}
            pins={removedPins}
            glyphOf={glyphOf}
            actions={actions}
            onClose={onClose}
          />
        ) : null}
        {failed ? (
          <Text size={14} weight={500} lh={1.45} color={theme.colors.bad} accessibilityLiveRegion="polite">
            {A.couldntSave}
          </Text>
        ) : null}
        <Fine>{A.same}</Fine>
      </ScrollView>
    </Sheet>
  );
}

/* A tile ------------------------------------------------------------------------------------------------------- */

function TileParts({
  at,
  first,
  last,
  face,
  glyph,
  choices,
  reading,
  couldntRead,
  actions,
  onClose,
}: {
  at: ArrangedTile<OverviewTile>;
  first: boolean;
  last: boolean;
  face: FigureFace | null;
  glyph: PhoneGlyph;
  choices: ShowChoice[];
  reading: boolean;
  couldntRead: boolean;
  actions: ArrangeActions;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { tile, item } = at;
  const chosen = tile.panel ?? '';
  const chart = !!face?.spark || !!choices.find((c) => c.key === chosen)?.chart;
  return (
    <>
      <Head
        icon={<ThingIcon glyph={glyph} mark={item.row.mark} size={22} color={theme.colors.ink2} />}
        title={item.row.name}
        sub={item.what ?? item.row.subtitle ?? ''}
        onClose={onClose}
      />
      <View style={{ padding: 14, borderRadius: 16, backgroundColor: theme.colors.sel }}>
        <ConnectionTile tile={item} size={tile.size} face={face} glyph={glyph} name={item.row.name} still />
      </View>
      <Part label={A.shows}>
        {reading ? (
          <Fine>{A.reading}</Fine>
        ) : couldntRead ? (
          <Fine>{A.couldntRead}</Fine>
        ) : (
          <View accessibilityRole="radiogroup" accessibilityLabel={A.shows} style={{ gap: 6 }}>
            {choices.map((c) => (
              <Opt
                key={c.key || 'figures'}
                name={c.name}
                line={c.line}
                chosen={c.key === chosen}
                onPress={() => actions.show(tile.thing, c)}
              />
            ))}
          </View>
        )}
      </Part>
      {chart ? (
        <Part label={A.span}>
          <Segmented
            options={(['1h', '24h', '7d'] as const).map((value) => ({ value, label: A.ranges[value] }))}
            value={tile.range ?? '24h'}
            onChange={(range) => actions.range(tile.thing, range)}
            label={A.span}
          />
        </Part>
      ) : null}
      <Part label={A.size}>
        <Shapes
          label={A.size}
          options={(['s', 'w', 'l'] as const).map((value) => ({
            value,
            label: A.sizes[value],
            cells: SHAPES[value],
          }))}
          value={tile.size}
          onChange={(size) => actions.size(tile.thing, size)}
        />
      </Part>
      <Part label={A.place}>
        <Moves
          name={item.row.name}
          earlier={first ? null : () => actions.move(tile.thing, -1)}
          later={last ? null : () => actions.move(tile.thing, 1)}
        />
      </Part>
      <Foot
        remove={() => {
          actions.remove(tile.thing);
          onClose();
        }}
        name={item.row.name}
        onClose={onClose}
      />
    </>
  );
}

/* A figure at the top ------------------------------------------------------------------------------------------ */

function FigureParts({
  index,
  groups,
  glyphOf,
  reading,
  couldntRead,
  actions,
  onClose,
}: {
  index: number;
  groups: ReturnType<typeof topChoiceGroups>;
  glyphOf: (thing: string) => { glyph: PhoneGlyph; mark: HomeThingRow['mark']; name: string } | null;
  reading: boolean;
  couldntRead: boolean;
  actions: ArrangeActions;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <>
      <Head
        icon={<LayoutGrid size={20} color={theme.colors.ink2} strokeWidth={1.75} />}
        title={A.figureSub(index + 1)}
        sub={A.figureTitle}
        onClose={onClose}
      />
      <Part label={A.shows}>
        <View style={{ gap: 6 }}>
          {groups.map((g, gi) => {
            const thing = g.thing ? glyphOf(g.thing) : null;
            return (
              <View
                key={g.key}
                accessibilityRole="radiogroup"
                accessibilityLabel={g.label}
                style={{ gap: 6 }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 7,
                    marginTop: gi ? 6 : 0,
                    minHeight: 22,
                  }}
                >
                  {thing ? (
                    <ThingIcon glyph={thing.glyph} mark={thing.mark} size={14} color={theme.colors.ink2} />
                  ) : null}
                  <Text size={13} weight={600} color={theme.colors.ink2} accessibilityRole="header">
                    {g.label}
                  </Text>
                </View>
                {g.items.map((c) => (
                  <Opt
                    key={c.key}
                    name={c.name}
                    line={c.taken ? A.shownAlready : c.line}
                    chosen={c.chosen}
                    disabled={c.taken}
                    onPress={() => actions.top(index, c.top)}
                  />
                ))}
              </View>
            );
          })}
          {reading ? <Fine>{A.reading}</Fine> : couldntRead ? <Fine>{A.couldntRead}</Fine> : null}
        </View>
      </Part>
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: theme.colors.line,
          paddingTop: 14,
          alignItems: 'flex-end',
        }}
      >
        <Button label={A.done} onPress={onClose} style={{ paddingHorizontal: 18 }} />
      </View>
    </>
  );
}

/* A pinned chart ----------------------------------------------------------------------------------------------- */

function PinParts({
  pin,
  size,
  actions,
  onClose,
}: {
  pin: Widget;
  size: 'half' | 'full';
  actions: ArrangeActions;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <>
      <Head
        icon={<Pin size={20} color={theme.colors.ink2} strokeWidth={1.75} />}
        title={pin.title}
        sub={A.pinSub}
        onClose={onClose}
      />
      <Part label={A.width}>
        <Shapes
          label={A.width}
          options={(['half', 'full'] as const).map((value) => ({
            value,
            label: A.pinSizes[value],
            cells: value === 'half' ? [1, 0, 1, 0] : [1, 1, 1, 1],
          }))}
          value={size}
          onChange={(s) => actions.pinSize(pin.id, s)}
        />
      </Part>
      <Part label={A.place}>
        <Moves
          name={pin.title}
          earlier={actions.canPinMove(pin.id, -1) ? () => actions.pinMove(pin.id, -1) : null}
          later={actions.canPinMove(pin.id, 1) ? () => actions.pinMove(pin.id, 1) : null}
        />
      </Part>
      <Foot
        remove={() => {
          actions.pinRemove(pin.id);
          onClose();
        }}
        name={pin.title}
        onClose={onClose}
      />
    </>
  );
}

/* Add to Overview ---------------------------------------------------------------------------------------------- */

function AddParts({
  removed,
  pins,
  glyphOf,
  actions,
  onClose,
}: {
  removed: readonly ArrangedTile<OverviewTile>[];
  pins: readonly Widget[];
  glyphOf: (thing: string) => { glyph: PhoneGlyph; mark: HomeThingRow['mark']; name: string } | null;
  actions: ArrangeActions;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <>
      <Head
        icon={<Plus size={20} color={theme.colors.ink2} strokeWidth={1.75} />}
        title={A.add}
        sub={A.addLine(removed.length + pins.length)}
        onClose={onClose}
      />
      {removed.length + pins.length === 0 ? (
        <Text size={14.5} lh={1.45} color={theme.colors.ink2} style={{ paddingHorizontal: 2 }}>
          {A.addEmpty}
        </Text>
      ) : null}
      {removed.length ? (
        <Part label={A.addTiles}>
          <View style={{ gap: 6 }}>
            {removed.map((r) => {
              const look = glyphOf(r.tile.thing);
              return (
                <Opt
                  key={r.tile.thing}
                  name={r.item.row.name}
                  line={r.item.what}
                  icon={
                    <ThingIcon
                      glyph={look?.glyph ?? r.item.row.glyph}
                      mark={r.item.row.mark}
                      size={16}
                      color={theme.colors.ink2}
                    />
                  }
                  add
                  onPress={() => actions.add(r.tile.thing)}
                />
              );
            })}
          </View>
        </Part>
      ) : null}
      {pins.length ? (
        <Part label={A.addPins}>
          <View style={{ gap: 6 }}>
            {pins.map((p) => (
              <Opt
                key={p.id}
                name={p.title}
                line={p.subtitle ?? null}
                add
                onPress={() => actions.pinAdd(p.id)}
              />
            ))}
          </View>
        </Part>
      ) : null}
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: theme.colors.line,
          paddingTop: 14,
          alignItems: 'flex-end',
        }}
      >
        <Button label={A.done} onPress={onClose} style={{ paddingHorizontal: 18 }} />
      </View>
    </>
  );
}

/* Parts -------------------------------------------------------------------------------------------------------- */

/** The sheet's head (the mock's `.dr-h`): a 38 logo, the title 17/650 over its line 13 in `mut`, and Close. */
function Head({
  icon,
  title,
  sub,
  onClose,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          backgroundColor: theme.colors.sf2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text size={17} weight={600} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {sub ? (
          <Text size={13} color={theme.colors.mut} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Touchable
        onPress={onClose}
        feedback="wash"
        ringRadius={10}
        accessibilityRole="button"
        accessibilityLabel={A.close}
        hitSlop={hitSlopFor(40)}
        style={{ width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }}
      >
        <X size={18} color={theme.colors.mut} strokeWidth={1.75} />
      </Touchable>
    </View>
  );
}

/** A part of the sheet under its mono label (the mock's `.drawer h4`). */
function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      <SectionLabel>{label.toUpperCase()}</SectionLabel>
      {children}
    </View>
  );
}

function Fine({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text size={12.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 2 }}>
      {children}
    </Text>
  );
}

/**
 * A choice (the mock's `.opt`): 44 and more, padded 9 12, radius 12, a hairline on `sf`; its name 14.5 and what it
 * says now mono 13 in `mut` at the right; the chosen one ringed in `ink`, one greyed when it can't be chosen. A radio
 * for a screen reader; in *Add to Overview* a button with a plus.
 */
function Opt({
  name,
  line,
  chosen = false,
  disabled = false,
  add = false,
  icon,
  onPress,
}: {
  name: string;
  line: string | null;
  chosen?: boolean;
  disabled?: boolean;
  add?: boolean;
  icon?: ReactNode;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled}
      feedback="wash"
      ringRadius={12}
      accessibilityRole={add ? 'button' : 'radio'}
      accessibilityLabel={add ? `${A.add}: ${name}` : line ? `${name}, ${line}` : name}
      accessibilityState={add ? { disabled } : { selected: chosen, disabled }}
      style={{
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: chosen ? 2 : 1,
        borderColor: chosen ? theme.colors.ink : theme.colors.line,
        backgroundColor: theme.colors.sf,
        opacity: disabled ? 0.45 : 1,
        ...(chosen ? { paddingVertical: 8, paddingHorizontal: 11 } : null),
      }}
    >
      {icon ?? null}
      <Text size={14.5} numberOfLines={2} style={{ flex: 1 }}>
        {name}
      </Text>
      {line ? (
        <Text
          size={13}
          weight={500}
          mono
          color={theme.colors.mut}
          numberOfLines={1}
          style={{ flexShrink: 1, maxWidth: '55%' }}
        >
          {line}
        </Text>
      ) : null}
      {add ? <Plus size={18} color={theme.colors.ink2} strokeWidth={1.75} /> : null}
    </Touchable>
  );
}

/** A size's shape: four cells, two by two, lit where the tile covers them. */
const SHAPES: Record<OverviewTileSize, number[]> = { s: [1, 0, 0, 0], w: [1, 1, 0, 0], l: [1, 1, 1, 1] };

/**
 * Size or Width (the mock's `.dseg`): a `line` trough padded 3, radius 12; each choice 44 and more with its shape over
 * its name (13.5/500), the chosen one on `sf`. A radio group for a screen reader.
 */
function Shapes<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; cells: number[] }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        gap: 2,
        padding: 3,
        borderRadius: 12,
        backgroundColor: theme.colors.line,
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Touchable
            key={o.value}
            onPress={() => onChange(o.value)}
            feedback={on ? 'none' : 'wash'}
            ringRadius={9}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: on }}
            style={{
              flex: 1,
              minHeight: 44,
              paddingVertical: 7,
              paddingHorizontal: 6,
              borderRadius: 9,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              backgroundColor: on ? theme.colors.sf : 'transparent',
            }}
          >
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ width: 24, flexDirection: 'row', flexWrap: 'wrap', gap: 2 }}
            >
              {o.cells.map((lit, i) => (
                <View
                  // biome-ignore lint/suspicious/noArrayIndexKey: the shape's cells are fixed places
                  key={i}
                  style={{
                    width: 11,
                    height: 8,
                    borderRadius: 2,
                    backgroundColor: lit ? (on ? theme.colors.ink : theme.colors.mut) : theme.colors.line2,
                  }}
                />
              ))}
            </View>
            <Text size={13.5} weight={500} color={on ? theme.colors.ink : theme.colors.mut}>
              {o.label}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}

/** *Move earlier* and *Move later* side by side (the mock's `.moves`), each off at its end. */
function Moves({
  name,
  earlier,
  later,
}: {
  name: string;
  earlier: (() => void) | null;
  later: (() => void) | null;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Button
        label={A.earlier}
        variant="secondary"
        onPress={() => earlier?.()}
        disabled={!earlier}
        accessibilityLabel={`${A.earlier}: ${name}`}
        style={{ flex: 1 }}
      />
      <Button
        label={A.later}
        variant="secondary"
        onPress={() => later?.()}
        disabled={!later}
        accessibilityLabel={`${A.later}: ${name}`}
        style={{ flex: 1 }}
      />
    </View>
  );
}

/** *Remove from Overview* in `bad` and Done, under a hairline (the mock's `.dr-foot`). */
function Foot({ remove, name, onClose }: { remove: () => void; name: string; onClose: () => void }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 14,
        marginTop: 4,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Touchable
        onPress={remove}
        feedback="fade"
        ringRadius={8}
        accessibilityRole="button"
        accessibilityLabel={`${A.remove}: ${name}`}
        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 }}
      >
        <Text size={14} weight={500} color={theme.colors.bad}>
          {A.remove}
        </Text>
      </Touchable>
      <View style={{ flex: 1 }} />
      <Button label={A.done} onPress={onClose} style={{ paddingHorizontal: 18 }} />
    </View>
  );
}
