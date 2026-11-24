/**
 * Connections on the arranged Overview (docs/decisions/overview-arranged.md; the mock's
 * `.bento` at phone width): every connection, device and account as a tile in the person's order — small ones two
 * across, wide and large the full width. A tile: its logo, name and mark, then the figure it shows large with its unit
 * and what it is, one line (why it isn't fine in its colour), a small chart where its view has points, and a foot with
 * what it is (and when it was used, where there is room). Until its view arrives, or on an older Whombat, it says its
 * line from Home (`overviewTiles`). A tile opens its page; a person's own mail account, which has none, goes where its
 * `href` says. Add a connection sits in the heading for people who may; with nothing yet it is the section's
 * one row. A long press on a connection Whombat keeps offers Open and Rename. While the page is arranged a tile is no
 * link: its gear opens its sheet, and *Add to Overview* closes the list.
 */
import {
  ARRANGE_WORDS,
  type ArrangedTile,
  type FigureFace,
  type OverviewSectionView,
  type OverviewTile,
  showId,
  type ThingRenameTarget,
  thingRenameTarget,
  viewFace,
} from '@whombat/client';
import type { DeskWidgetView, OverviewTileSize, ThingSummary } from '@whombat/core';
import { type ReactNode, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { CONNECTIONS_COPY, serviceRowOpens } from '../../data/home';
import { figureWhat, tileRows } from '../../data/overviewArranged';
import { parseThingRowPick, RENAME_COPY, thingRowMenu } from '../../data/rename';
import { OVERVIEW_TITLE } from '../../data/shell';
import { type PhoneGlyph, phoneThingGlyph } from '../../data/thingLook';
import { useThingRename } from '../../data/useThingRename';
import { openHref, useAppNavigation } from '../../navigation/hooks';
import { isBeside, useBeside } from '../../navigation/panes';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard, OneRow, ThingIcon } from '../../ui/assistant';
import { Plus } from '../../ui/icons';
import { InlineRename } from '../../ui/inlineRename';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../../ui/nativeMenu';
import { StatusMark } from '../../ui/statusMark';
import { Touchable } from '../../ui/Touchable';
import { GearButton, Spark, useToneColor } from './ArrangedParts';
import { OverviewSection, SectionLink } from './Section';

/** A place in the list: a tile, or *Add to Overview* at its end while arranging. */
type Cell = { kind: 'tile'; at: ArrangedTile<OverviewTile> } | { kind: 'add' };

export function ServicesCard({
  view,
  tiles,
  removed,
  views,
  things,
  add,
  arranging = false,
  onGear,
  onAdd,
}: {
  /** The section's heading, count and line (`overviewSections`). */
  view: OverviewSectionView;
  /** The tiles shown, in the person's order (`arrangeTiles`). */
  tiles: readonly ArrangedTile<OverviewTile>[];
  /** How many tiles and pins wait under *Add to Overview*. */
  removed: number;
  /** What each tile shows now, by widget id (`useOverviewViews`); none on an older Whombat or before it arrives. */
  views: ReadonlyMap<string, DeskWidgetView> | undefined;
  /** The things themselves: where one without a page goes, and its logo. */
  things: readonly ThingSummary[];
  add: boolean;
  arranging?: boolean;
  onGear?: (thing: string) => void;
  onAdd?: () => void;
}) {
  const navigation = useAppNavigation();
  const beside = useBeside();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const opensOf = useMemo(() => new Map(things.map((t) => [t.id, serviceRowOpens(t)])), [things]);
  // Website feedback's bubble rather than the generic plug (it has no brand mark).
  const glyphOf = useMemo(() => new Map(things.map((t) => [t.id, phoneThingGlyph(t)])), [things]);
  const adding = () => navigation.navigate('AddConnection');
  const rename = useThingRename(slug);
  // Elsewhere than iPhone a held tile's menu is a sheet, for the tile it was held on.
  const [menuFor, setMenuFor] = useState<{ tile: OverviewTile; target: ThingRenameTarget } | null>(null);
  const open = (tile: OverviewTile) => {
    const opens = opensOf.get(tile.row.id);
    if (opens) openHref(opens);
    else
      navigation.navigate('Thing', {
        thingId: tile.row.id,
        title: rename.shown(tile.row.id, tile.row.name),
        back: OVERVIEW_TITLE,
      });
  };
  const pick = (tile: OverviewTile, id: string) => {
    const picked = parseThingRowPick(id);
    if (picked === 'open') open(tile);
    else if (picked === 'rename') rename.start(tile.row.id);
  };
  const cells: Cell[] = [
    ...tiles.map((at) => ({ kind: 'tile' as const, at })),
    ...(arranging ? [{ kind: 'add' as const }] : []),
  ];
  const rows = tileRows(cells, (c) => (c.kind === 'tile' ? c.at.tile.size : 's'));
  const cell = (c: Cell) => {
    if (c.kind === 'add') return <AddTile key="add" removed={removed} onPress={() => onAdd?.()} />;
    const { tile, item } = c.at;
    const name = rename.shown(item.row.id, item.row.name);
    // Servers are their own section; here the connections Whombat keeps (`con_…`) have a menu.
    const target = arranging ? null : thingRenameTarget({ id: item.row.id, name });
    const v = views?.get(showId(tile));
    return (
      <ConnectionTile
        key={item.row.id}
        tile={item}
        size={tile.size}
        face={v ? viewFace(v) : null}
        glyph={glyphOf.get(item.row.id) ?? item.row.glyph}
        name={name}
        selected={isBeside(beside, 'Thing', 'thingId', item.row.id)}
        onPress={() => open(item)}
        arranging={arranging}
        onGear={() => onGear?.(tile.thing)}
        menu={
          target ? { onPick: (id) => pick(item, id), onOpen: () => setMenuFor({ tile: item, target }) } : null
        }
        renaming={
          target && rename.editing === item.row.id ? (
            <InlineRename
              value={name}
              maxLength={target.max}
              label={RENAME_COPY.label(name)}
              onSave={(typed) => rename.save(target, typed)}
              onClose={rename.stop}
              size={15}
              weight={600}
            />
          ) : null
        }
      />
    );
  };
  return (
    <OverviewSection
      label={view.label}
      count={tiles.length ? view.count : null}
      summary={view.summary}
      links={
        add && tiles.length ? <SectionLink label={CONNECTIONS_COPY.addConnection} onPress={adding} /> : null
      }
    >
      {cells.length ? (
        <View style={{ gap: 10 }}>
          {rows.map((row) =>
            row.kind === 'full' ? (
              cell(row.item)
            ) : (
              <View
                key={row.items.map((c) => (c.kind === 'tile' ? c.at.tile.thing : 'add')).join('+')}
                style={{ flexDirection: 'row', gap: 10, alignItems: 'stretch' }}
              >
                {row.items.map((c) => (
                  <View key={c.kind === 'tile' ? c.at.tile.thing : 'add'} style={{ flex: 1, minWidth: 0 }}>
                    {cell(c)}
                  </View>
                ))}
                {row.items.length === 1 ? <View style={{ flex: 1 }} /> : null}
              </View>
            ),
          )}
        </View>
      ) : add && !removed ? (
        <OneCard>
          <OneRow
            first
            leading={<Plus size={19} color={theme.colors.brand} strokeWidth={2} />}
            title={CONNECTIONS_COPY.addConnection}
            line={CONNECTIONS_COPY.addConnectionLine}
            chevron
            label={CONNECTIONS_COPY.addConnection}
            hint={CONNECTIONS_COPY.addConnectionLine}
            onPress={adding}
          />
        </OneCard>
      ) : null}
      {hasNativeMenu ? null : (
        <MenuSheet
          spec={menuFor ? thingRowMenu(menuFor.target.name) : null}
          visible={menuFor !== null}
          label={RENAME_COPY.rowMenu(menuFor?.target.name ?? '')}
          onClose={() => setMenuFor(null)}
          onPick={(id) => menuFor && pick(menuFor.tile, id)}
        />
      )}
    </OverviewSection>
  );
}

/**
 * One tile (the mock's `.tile` at phone width): `sf`, a hairline, radius 18, padded 14 13 12. Its head: the 32dp logo
 * (radius 9), the name 15/600 and the mark (connected a plain `ok` dot, else the status level's shape), and its gear
 * while arranging. Then the figure 23/700 (40 on a large tile) with its unit 15/500 and what it is 14 in `mut`; one
 * line 13.5 (why it isn't fine in `warnText` or `bad`); a small chart (40 tall, 54 wide, 150 large); the foot under a
 * hairline (mono 11.5 in `mut`). What isn't fine keeps a 4dp edge in its colour wherever it sits. One button for a
 * screen reader, named by `tile.label` and what it shows; while arranging, words and its gear.
 */
export function ConnectionTile({
  tile,
  size,
  face,
  glyph,
  name,
  selected = false,
  onPress,
  arranging = false,
  onGear,
  menu = null,
  renaming = null,
  still = false,
}: {
  tile: OverviewTile;
  size: OverviewTileSize;
  /** What its view leads with; null until the view arrives (its line from Home instead). */
  face: FigureFace | null;
  glyph: PhoneGlyph;
  name: string;
  selected?: boolean;
  onPress?: () => void;
  arranging?: boolean;
  onGear?: () => void;
  menu?: { onPick: (id: string) => void; onOpen: () => void } | null;
  renaming?: ReactNode;
  /** A preview (in a gear's sheet): no button, no gear. */
  still?: boolean;
}) {
  const theme = useTheme();
  const toneColor = useToneColor();
  const { line } = tile;
  const edgeColor = line.tone === 'bad' ? theme.colors.bad : line.tone === 'warn' ? theme.colors.warn : null;
  // What isn't fine says so on its line, and so does a thing kept quiet or down because of something else; otherwise
  // the line of what it shows, else Home's.
  const notFine = line.tone === 'bad' || line.tone === 'warn';
  const shownLine =
    notFine || tile.held || !face
      ? { text: line.text, tone: line.tone }
      : { text: face.line ?? line.text, tone: face.tone === 'ok' ? null : face.tone };
  const large = size === 'l';
  const edge = edgeColor ? 4 : 1;
  const frame = {
    backgroundColor: theme.colors.sf,
    borderWidth: 1,
    borderLeftWidth: edge,
    borderColor: theme.colors.line,
    borderLeftColor: edgeColor ?? theme.colors.line,
    borderRadius: 18,
    overflow: 'hidden' as const,
    ...(arranging
      ? { borderColor: theme.colors.line2, borderLeftColor: edgeColor ?? theme.colors.line2 }
      : null),
  };
  const inner = {
    ...(selected ? { backgroundColor: theme.colors.sel } : null),
    flexGrow: 1,
    gap: 10,
    paddingTop: 14,
    paddingBottom: 12,
    paddingRight: 13,
    paddingLeft: 13 - (edge - 1),
  };
  const hasValue = !!face?.value;
  const spoken =
    face && hasValue
      ? `${tile.label}. ${face.value}${face.unit ? ` ${face.unit}` : ''} ${face.label}`
      : tile.label;
  const content = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 }}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            backgroundColor: theme.colors.sf2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ThingIcon glyph={glyph} mark={tile.row.mark} size={19} color={theme.colors.ink2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {renaming ?? (
            <Text size={15} weight={600} numberOfLines={1}>
              {name}
            </Text>
          )}
        </View>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {tile.row.level === 'connected' ? (
            // Down because of something else is grey, not fine (monitoring.md MON-07).
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: tile.held === 'cause' ? theme.colors.mut : theme.colors.ok,
              }}
            />
          ) : (
            <StatusMark level={tile.row.level} />
          )}
        </View>
        {arranging && !still ? (
          <GearButton label={ARRANGE_WORDS.changeTile(name)} onPress={() => onGear?.()} />
        ) : null}
      </View>
      {face && hasValue ? (
        <Text size={large ? 40 : 23} weight={700} tracking={-0.02} lh={1.15} numberOfLines={1}>
          {face.value}
          {face.unit ? (
            <Text size={15} weight={500} color={theme.colors.mut}>
              {` ${face.unit}`}
            </Text>
          ) : null}
          <Text size={14} weight={400} color={theme.colors.mut}>
            {`  ${figureWhat(face.label)}`}
          </Text>
        </Text>
      ) : null}
      {shownLine.text ? (
        <Text
          size={13.5}
          lh={1.45}
          weight={shownLine.tone === 'bad' || shownLine.tone === 'warn' ? 500 : 400}
          color={toneColor(
            shownLine.tone === 'mut'
              ? 'mut'
              : shownLine.tone === 'bad' || shownLine.tone === 'warn'
                ? shownLine.tone
                : null,
            theme.colors.ink2,
          )}
          numberOfLines={2}
        >
          {shownLine.text}
        </Text>
      ) : null}
      {face?.spark ? <Spark points={face.spark} height={large ? 150 : size === 'w' ? 54 : 40} /> : null}
      {tile.what || tile.used ? (
        <View
          style={{
            marginTop: 'auto',
            flexDirection: 'row',
            justifyContent: 'space-between',
            gap: 10,
            paddingTop: 9,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
            {tile.what ?? tile.used ?? ''}
          </Text>
          {/* A small tile has room for one: what it is, else when it was used. */}
          {tile.used && tile.what && size !== 's' ? (
            <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1}>
              {tile.used}
            </Text>
          ) : null}
        </View>
      ) : null}
    </>
  );
  if (renaming || arranging || still || !onPress)
    return (
      <View style={[frame, { flexGrow: 1 }]}>
        <View accessible={!arranging} accessibilityLabel={arranging ? undefined : spoken} style={inner}>
          {content}
        </View>
      </View>
    );
  // The menu takes the tile's own press (so a hold doesn't open it too): the Touchable is its only child.
  const button = (
    <Touchable
      onPress={onPress}
      {...(menu && !hasNativeMenu ? { onLongPress: menu.onOpen } : null)}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={spoken}
      ringRadius={18}
      accessibilityHint={CONNECTIONS_COPY.opens}
      accessibilityState={{ selected }}
      // Screen readers can't hold: Rename is the tile's own action too.
      {...(menu
        ? {
            accessibilityActions: [{ name: 'rename', label: RENAME_COPY.rename }],
            onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) =>
              menu.onPick(e.nativeEvent.actionName),
          }
        : null)}
      style={[frame, { flexGrow: 1 }]}
    >
      <View style={inner}>{content}</View>
    </Touchable>
  );
  return menu ? (
    <NativeMenu spec={thingRowMenu(name)} onPick={menu.onPick}>
      {button}
    </NativeMenu>
  ) : (
    button
  );
}

/**
 * *Add to Overview* (the mock's `.tile.add`): a dashed tile at the end of the list while arranging, “Add to Overview”
 * over how many wait there.
 */
function AddTile({ removed, onPress }: { removed: number; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={18}
      accessibilityRole="button"
      accessibilityLabel={`${ARRANGE_WORDS.add}, ${ARRANGE_WORDS.addLine(removed)}`}
      style={{
        flexGrow: 1,
        minHeight: 150,
        borderRadius: 18,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: theme.colors.line2,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        padding: 14,
      }}
    >
      <Plus size={20} color={theme.colors.ink2} strokeWidth={1.75} />
      <Text size={14.5} weight={500} color={theme.colors.ink2} style={{ textAlign: 'center' }}>
        {ARRANGE_WORDS.add}
      </Text>
      <Text size={12.5} color={theme.colors.mut} style={{ textAlign: 'center' }}>
        {ARRANGE_WORDS.addLine(removed)}
      </Text>
    </Touchable>
  );
}
