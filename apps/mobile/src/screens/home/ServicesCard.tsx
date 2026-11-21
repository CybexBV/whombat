/**
 * Connections on Overview (docs/decisions/overview-one-page.md OVP-09, the phone form of OVP-11; the mock's `.con`
 * under 620 px): every connection and device as a small tile, one under the other, worst first when the list loads or
 * is pulled to refresh and never re-sorted under the finger — its logo, its name, one line (why it isn't fine in its
 * colour, that it is being learned, or what it says now), its mark at the top right and a foot with what it is and
 * when it was used. What it says is the shared `overviewTiles`. A tile opens its page; a person's own mail account,
 * which has none, goes where its `href` says (AP-2814). Add a connection sits in the heading for people who may; with
 * nothing yet it is the section's one row. A long press on a connection Whombat keeps offers Open and Rename (iOS's own
 * menu on iPhone, a sheet elsewhere); Rename turns its name into a box.
 */
import {
  type HomeThingRow,
  type OverviewSectionView,
  type OverviewTile,
  overviewTiles,
  type ThingRenameTarget,
  thingRenameTarget,
} from '@whombat/client';
import type { ThingSummary } from '@whombat/core';
import { type ReactNode, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { CONNECTIONS_COPY, serviceRowOpens } from '../../data/home';
import { parseThingRowPick, RENAME_COPY, thingRowMenu } from '../../data/rename';
import { OVERVIEW_TITLE } from '../../data/shell';
import { useAgentWords } from '../../data/useAgent';
import { useStatusOrder } from '../../data/useStatusOrder';
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
import { OverviewSection, SectionLink } from './Section';

const tileId = (t: OverviewTile) => t.row.id;
const tileLevel = (t: OverviewTile) => t.row.level;

export function ServicesCard({
  view,
  rows,
  things,
  add,
  sortKey = 0,
}: {
  /** The section's heading, count and line (`overviewSections`). */
  view: OverviewSectionView;
  /** The rows the section counts (the shared `homeSections`' things). */
  rows: readonly HomeThingRow[];
  /** The things themselves: when each was used and where one without a page goes. */
  things: readonly ThingSummary[];
  add: boolean;
  /** Changes on a pull to refresh: the tiles sort worst first again (else they keep their order while live). */
  sortKey?: number;
}) {
  const navigation = useAppNavigation();
  const beside = useBeside();
  const theme = useTheme();
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const assistant = useAgentWords();
  const all = useMemo(
    () => overviewTiles(rows, things, now, timeZone, assistant.name),
    [rows, things, now, timeZone, assistant.name],
  );
  const tiles = useStatusOrder(all, tileId, tileLevel, sortKey);
  const opensOf = useMemo(() => new Map(things.map((t) => [t.id, serviceRowOpens(t)])), [things]);
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
  return (
    <OverviewSection
      label={view.label}
      count={tiles.length ? view.count : null}
      summary={view.summary}
      links={
        add && tiles.length ? <SectionLink label={CONNECTIONS_COPY.addConnection} onPress={adding} /> : null
      }
    >
      {tiles.length ? (
        <View style={{ gap: 8 }}>
          {tiles.map((tile) => {
            const name = rename.shown(tile.row.id, tile.row.name);
            // Servers are their own section; here the connections Whombat keeps (`con_…`) have a menu.
            const target = thingRenameTarget({ id: tile.row.id, name });
            return (
              <ConnectionTile
                key={tile.row.id}
                tile={tile}
                name={name}
                selected={isBeside(beside, 'Thing', 'thingId', tile.row.id)}
                onPress={() => open(tile)}
                menu={
                  target
                    ? { onPick: (id) => pick(tile, id), onOpen: () => setMenuFor({ tile, target }) }
                    : null
                }
                renaming={
                  target && rename.editing === tile.row.id ? (
                    <InlineRename
                      value={name}
                      maxLength={target.max}
                      label={RENAME_COPY.label(name)}
                      onSave={(typed) => rename.save(target, typed)}
                      onClose={rename.stop}
                      size={15.5}
                      weight={600}
                    />
                  ) : null
                }
              />
            );
          })}
        </View>
      ) : add ? (
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
 * One connection (the mock's `.con`): `sf`, a hairline, radius 16, padded 14 16 13; the 40dp logo tile, the name
 * (15.5/600) over its line (13.5, `ink2`; why it isn't fine in `warnText` or `bad` at 500, learning and offline in
 * `mut`), the mark at the top right (connected a plain `ok` dot, else the status level's shape), and the foot under a
 * hairline (mono 11.5, `mut`): what it is on the left, when it was used on the right. What isn't fine has a 4dp edge in
 * its colour (the mock's hairline and 3px inset). One button for a screen reader, named by `tile.label`, with Rename
 * among its actions when it has a menu. While it is renamed the tile is no button.
 */
function ConnectionTile({
  tile,
  name,
  selected,
  onPress,
  menu,
  renaming,
}: {
  tile: OverviewTile;
  /** The name it shows (the one just saved while the list catches up). */
  name: string;
  /** With two pages: the page beside the list shows it. */
  selected: boolean;
  onPress: () => void;
  /** Open and Rename on a long press: a pick, and the sheet where iOS's own menu isn't; null without. */
  menu: { onPick: (id: string) => void; onOpen: () => void } | null;
  renaming: ReactNode;
}) {
  const theme = useTheme();
  const { line } = tile;
  const edgeColor = line.tone === 'bad' ? theme.colors.bad : line.tone === 'warn' ? theme.colors.warn : null;
  const lineColor =
    line.tone === 'bad'
      ? theme.colors.bad
      : line.tone === 'warn'
        ? theme.colors.warnText
        : line.tone === 'mut'
          ? theme.colors.mut
          : theme.colors.ink2;
  const edge = edgeColor ? 4 : 1;
  const frame = {
    backgroundColor: theme.colors.sf,
    borderWidth: 1,
    borderLeftWidth: edge,
    borderColor: theme.colors.line,
    borderLeftColor: edgeColor ?? theme.colors.line,
    borderRadius: 16,
    overflow: 'hidden' as const,
  };
  const inner = {
    ...(selected ? { backgroundColor: theme.colors.sel } : null),
    paddingTop: 14,
    paddingBottom: 13,
    paddingRight: 16,
    paddingLeft: 16 - (edge - 1),
  };
  const foot = tile.what || tile.used;
  const content = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            backgroundColor: theme.colors.sf2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ThingIcon glyph={tile.row.glyph} mark={tile.row.mark} size={22} color={theme.colors.ink2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {renaming ?? (
            <Text size={15.5} weight={600} tracking={-0.005} numberOfLines={1}>
              {name}
            </Text>
          )}
          <Text
            size={13.5}
            weight={line.tone === 'bad' || line.tone === 'warn' ? 500 : 400}
            color={lineColor}
            numberOfLines={1}
            style={{ marginTop: 1 }}
          >
            {line.text}
          </Text>
        </View>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ alignSelf: 'flex-start', paddingTop: 4 }}
        >
          {tile.row.level === 'connected' ? (
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.ok }} />
          ) : (
            <StatusMark level={tile.row.level} />
          )}
        </View>
      </View>
      {foot ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            gap: 12,
            marginTop: 11,
            paddingTop: 9,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
            {tile.what ?? ''}
          </Text>
          {tile.used ? (
            <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1}>
              {tile.used}
            </Text>
          ) : null}
        </View>
      ) : null}
    </>
  );
  if (renaming)
    return (
      <View style={frame}>
        <View style={inner}>{content}</View>
      </View>
    );
  // The menu takes the tile's own press (so a hold doesn't open it too): the Touchable is its only child.
  const button = (
    <Touchable
      onPress={onPress}
      {...(menu && !hasNativeMenu ? { onLongPress: menu.onOpen } : null)}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={tile.label}
      ringRadius={16}
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
      style={frame}
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
