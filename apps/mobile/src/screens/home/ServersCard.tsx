/**
 * Servers on Overview (docs/decisions/overview-one-page.md, the phone form of OVP-11; the mock's `.srv` under 620 px):
 * one card per server from the shared `overviewServerRows`, worst first when the list loads or is pulled to refresh,
 * never re-sorted under the finger; a server that runs on another follows it, set in with an elbow line. A card: the
 * logo on a 40dp tile, the name with the This Whombat tag and the pill only when it isn't fine, the system line, the
 * small clock line when its reading is old (or when an offline one was last seen); then the figures two by two, each
 * with its small label — Processor · 24 h with its 24 hour line, Memory and Storage with a word, the amount and a block
 * bar, Temperature with its limit and bar — and Running across the full width with its count, word and dots. A server
 * that isn't working has a tinted card with a `bad` edge. The card is one button, named by every figure, that opens the
 * server (where its charts and machines are); a long press offers Open and Rename. A failed refresh keeps the cards
 * under a note; a server waiting to be added is a dashed card after the others, with Review; without the hosts service
 * there is no section; a service that's down says so.
 */
import {
  OVERVIEW_WORDS,
  type OverviewSectionView,
  readState,
  type StatusLevel,
  serverQuietWords,
  thingRenameTarget,
} from '@whombat/client';
import {
  isHostsUnavailable,
  litSegments,
  type OverviewAmountCell,
  type OverviewCpuCell,
  type OverviewRunningCell,
  type OverviewServerRow,
  type OverviewTempCell,
  overviewServerRows,
  sparklinePaths,
  TILE_SEGMENTS,
} from '@whombat/client/hosts';
import { useHostsFleet, useHostsStatus } from '@whombat/client/hosts/react';
import { useHomeOverview } from '@whombat/client/react';
import { thingId } from '@whombat/core';
import { type ReactNode, useMemo, useState } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { HOME_SERVERS_COPY, serverGroups } from '../../data/homeServers';
import { isOwnId, parseThingRowPick, RENAME_COPY, thingRowMenu } from '../../data/rename';
import { OVERVIEW_TITLE } from '../../data/shell';
import { useStatusOrder } from '../../data/useStatusOrder';
import { type ThingRenaming, useThingRename } from '../../data/useThingRename';
import { useAppNavigation } from '../../navigation/hooks';
import { isBeside, useBeside } from '../../navigation/panes';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard, OneRow, ThingIcon } from '../../ui/assistant';
import { tint } from '../../ui/glanceColors';
import { BellOff, Clock, Plus } from '../../ui/icons';
import { InlineRename } from '../../ui/inlineRename';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../../ui/nativeMenu';
import { Button } from '../../ui/primitives';
import { LevelPill } from '../../ui/statusMark';
import { Touchable } from '../../ui/Touchable';
import { CardQuiet } from '../thing/parts';
import { CardSkeletons, ReadNote } from './OverviewParts';
import { OverviewSection, SectionLink } from './Section';

type Group = OverviewServerRow[];
const groupId = (g: Group) => g[0]?.id ?? '';
// The shared rows come worst first already; one level for all keeps that order when the list sorts.
const sameLevel = (): StatusLevel => 'connected';

/** The pill's mark by its tone: red for what isn't working, amber for a look, grey (a hollow ring) offline or waiting. */
const PILL_LEVEL: Record<string, StatusLevel> = { bad: 'notWorking', warn: 'needsLook', mut: 'learning' };

export function ServersCard({
  view,
  sortKey = 0,
}: {
  /** The section's heading, count and line (`overviewSections`). */
  view: OverviewSectionView;
  /** Changes on a pull to refresh: the cards sort worst first again (else they keep their order while live). */
  sortKey?: number;
}) {
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const theme = useTheme();
  const navigation = useAppNavigation();
  const beside = useBeside();
  const status = useHostsStatus({ params: { burrow: slug } }, { retry: false });
  const present = status.data?.present === true;
  // The same read as a server's page (ServerScreen), so opening one reads nothing again.
  const fleet = useHostsFleet(present ? { params: { burrow: slug } } : null, { retry: false });
  const rows = useMemo(
    () => overviewServerRows(fleet.data?.servers ?? [], now.getTime(), timeZone),
    [fleet.data?.servers, now, timeZone],
  );
  // Worst first when the list loads or is pulled to refresh; a live change doesn't move a card under the finger.
  const groups = useStatusOrder(
    useMemo(() => serverGroups(rows), [rows]),
    groupId,
    sameLevel,
    sortKey,
  );
  const rename = useThingRename(slug);
  // A server kept quiet says so on its card: Home's thing has until when.
  const home = useHomeOverview({ params: { burrow: slug } });
  const quietWords = useMemo(
    () => serverQuietWords(home.data?.things, now, timeZone),
    [home.data?.things, now, timeZone],
  );
  // Elsewhere than iPhone a held card's menu is a sheet, for the card it was held on.
  const [menuFor, setMenuFor] = useState<OverviewServerRow | null>(null);
  if (!present && !isHostsUnavailable(status.error)) return null;
  const down =
    isHostsUnavailable(status.error) || isHostsUnavailable(fleet.error) || status.data?.healthy === false;
  // A failed refresh keeps the cards, each with its own reading time.
  const fleetState = readState({ hasData: !!fleet.data, error: fleet.error });
  const add = () => navigation.navigate('AddServer', { back: OVERVIEW_TITLE });
  const thing = (row: OverviewServerRow) => thingId('server', row.id);
  const open = (row: OverviewServerRow) =>
    navigation.navigate('Thing', {
      thingId: thing(row),
      title: rename.shown(thing(row), row.name),
      back: OVERVIEW_TITLE,
    });
  const pick = (row: OverviewServerRow, id: string) => {
    const picked = parseThingRowPick(id);
    if (picked === 'open') open(row);
    else if (picked === 'rename') rename.start(thing(row));
  };
  const pending = fleet.data?.pendingEnrollments ?? 0;
  const any = groups.length > 0;
  return (
    <OverviewSection
      label={view.label}
      count={any ? view.count : null}
      summary={view.summary}
      links={any ? <SectionLink label={OVERVIEW_WORDS.addServer} onPress={add} /> : null}
    >
      {fleetState === 'saved' ? (
        <ReadNote
          title={OVERVIEW_WORDS.couldntRefresh(HOME_SERVERS_COPY.yours)}
          body={OVERVIEW_WORDS.savedEach}
          onRetry={() => void fleet.refetch()}
          error={fleet.error}
        />
      ) : null}
      {any || pending ? (
        <View style={{ gap: 12 }}>
          {groups.flat().map((row) => {
            const name = rename.shown(thing(row), row.name);
            return (
              <ServerCard
                key={row.id}
                row={row}
                name={name}
                selected={isBeside(beside, 'Thing', 'thingId', thing(row))}
                onPress={() => open(row)}
                onPick={(id) => pick(row, id)}
                onMenu={() => setMenuFor(row)}
                renaming={renameBox(row, name, rename)}
                quiet={quietWords.get(thing(row)) || null}
              />
            );
          })}
          {pending ? <WaitingCard pending={pending} onReview={add} /> : null}
        </View>
      ) : down ? (
        <OneCard>
          <CardQuiet text={HOME_SERVERS_COPY.down} first />
        </OneCard>
      ) : !fleet.data ? (
        <CardSkeletons label={HOME_SERVERS_COPY.looking} tiles={4} />
      ) : (
        <OneCard>
          <OneRow
            first
            leading={<Plus size={19} color={theme.colors.brand} strokeWidth={2} />}
            title={HOME_SERVERS_COPY.addServer}
            line={HOME_SERVERS_COPY.addServerLine}
            chevron
            label={HOME_SERVERS_COPY.addServer}
            hint={HOME_SERVERS_COPY.addServerLine}
            onPress={add}
          />
        </OneCard>
      )}
      {hasNativeMenu ? null : (
        <MenuSheet
          spec={menuFor ? thingRowMenu(rename.shown(thing(menuFor), menuFor.name)) : null}
          visible={menuFor !== null}
          label={RENAME_COPY.rowMenu(menuFor ? rename.shown(thing(menuFor), menuFor.name) : '')}
          onClose={() => setMenuFor(null)}
          onPick={(id) => menuFor && pick(menuFor, id)}
        />
      )}
    </OverviewSection>
  );
}

/** The box a card's name turns into while it is renamed, else null. */
function renameBox(row: OverviewServerRow, name: string, rename: ThingRenaming): ReactNode {
  const id = thingId('server', row.id);
  if (rename.editing !== id) return null;
  const target = thingRenameTarget({ id, name });
  if (!target) return null;
  return (
    <InlineRename
      value={name}
      maxLength={target.max}
      label={RENAME_COPY.label(name)}
      hint={RENAME_COPY.serverHint}
      onSave={(typed) => rename.save(target, typed)}
      onClose={rename.stop}
      size={17}
      weight={600}
      mono={isOwnId(name, row.id)}
    />
  );
}

/**
 * One server (the mock's `.srv` card): `sf`, a hairline, radius 16, padded 16, 14 between its rows and 18 between its
 * two columns. Not working: tinted 6 % `bad` with a 4dp `bad` edge (the mock's hairline and 3px inset). A server that
 * runs on another is set in 18 with the elbow line from the card above. One button for a screen reader, named by every
 * figure, with Rename among its actions; the parts inside are decorative. While it is renamed the card is no button.
 */
function ServerCard({
  row,
  name,
  selected,
  onPress,
  onPick,
  onMenu,
  renaming,
  quiet = null,
}: {
  row: OverviewServerRow;
  /** The name it shows (the one just saved while the list catches up). */
  name: string;
  /** With two pages: the page beside the list shows it. */
  selected: boolean;
  onPress: () => void;
  /** A pick from its menu (`thingRowMenu`). */
  onPick: (id: string) => void;
  /** Opens its menu as a sheet (where iOS's own isn't). */
  onMenu: () => void;
  /** The box its name is while it is renamed. */
  renaming: ReactNode;
  /** “Quiet until 23:00” while it is kept quiet. */
  quiet?: string | null;
}) {
  const theme = useTheme();
  // Where the elbow ends: the middle of the name block, measured, as the mock's `bottom: 50%`.
  const [whoMiddle, setWhoMiddle] = useState(37);
  const edge = row.notWorking ? 4 : 1;
  const frame = {
    backgroundColor: theme.colors.sf,
    borderWidth: 1,
    borderLeftWidth: edge,
    borderColor: theme.colors.line,
    borderLeftColor: row.notWorking ? theme.colors.bad : theme.colors.line,
    borderRadius: 16,
    overflow: 'hidden' as const,
  };
  const inner = {
    backgroundColor: selected ? theme.colors.sel : row.notWorking ? tint(theme.colors.bad, 0.06) : undefined,
    padding: 16,
    paddingLeft: 16 - (edge - 1),
    gap: 14,
  };
  const content = (
    <>
      <View
        {...(renaming
          ? null
          : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' })}
        onLayout={(e) => setWhoMiddle(17 + e.nativeEvent.layout.height / 2)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
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
          <ThingIcon glyph="server" mark={row.mark} size={22} color={theme.colors.ink2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* The tag and the pill beside the name, wrapping under it when a long status needs the room. */}
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 }}
          >
            <View style={{ flexShrink: 1, minWidth: 0 }}>
              {renaming ?? (
                <Text size={17} weight={600} tracking={-0.01} mono={isOwnId(name, row.id)} numberOfLines={1}>
                  {name}
                </Text>
              )}
            </View>
            {row.thisWhombat ? <Tag text={OVERVIEW_WORDS.thisWhombat} /> : null}
            {row.pill ? (
              <LevelPill level={PILL_LEVEL[row.pill.tone] ?? row.level} word={row.pill.word} />
            ) : null}
          </View>
          {row.osLine ? (
            <Text size={13} lh={1.4} color={theme.colors.mut} numberOfLines={1} style={{ marginTop: 2 }}>
              {row.osLine}
            </Text>
          ) : null}
          {row.seen || row.stale ? <ClockLine text={row.seen ?? row.stale ?? ''} /> : null}
          {quiet ? <ClockLine text={quiet} icon={BellOff} /> : null}
        </View>
      </View>
      <Figures row={row} />
    </>
  );
  const card = renaming ? (
    <View style={frame}>
      <View style={inner}>{content}</View>
    </View>
  ) : (
    // The menu takes the card's own press (so a hold doesn't open the server too): the Touchable is its only child.
    <NativeMenu spec={thingRowMenu(name)} onPick={onPick}>
      <Touchable
        onPress={onPress}
        {...(hasNativeMenu ? null : { onLongPress: onMenu })}
        feedback="wash"
        accessibilityRole="button"
        accessibilityLabel={quiet ? `${row.label}. ${quiet}` : row.label}
        ringRadius={16}
        accessibilityHint={HOME_SERVERS_COPY.opens}
        accessibilityState={{ selected }}
        // Screen readers can't hold: Rename is the card's own action too.
        accessibilityActions={[{ name: 'rename', label: RENAME_COPY.rename }]}
        onAccessibilityAction={(e) => onPick(e.nativeEvent.actionName)}
        style={frame}
      >
        <View style={inner}>{content}</View>
      </Touchable>
    </NativeMenu>
  );
  if (!row.child) return card;
  // Set in under its parent: the elbow starts in the gap above (from the card over it) and turns into this card at the
  // middle of its name, 10 left of its edge (the mock's `left: -27px; top: -30px; width: 10px`).
  return (
    <View style={{ flexDirection: 'row' }}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 10,
          marginLeft: 8,
          marginTop: -13,
          height: 13 + whoMiddle,
          borderLeftWidth: 1.5,
          borderBottomWidth: 1.5,
          borderColor: theme.colors.line2,
          borderBottomLeftRadius: 7,
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>{card}</View>
    </View>
  );
}

/**
 * A server waiting to be added, after the cards (the narrow page's dashed card, overview-one-page.md): a
 * dashed `line2` frame, the server glyph on its tile, what it is and what to do, and Review, which opens Add a server
 * with its waiting list.
 */
function WaitingCard({ pending, onReview }: { pending: number; onReview: () => void }) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.line2,
        borderRadius: 16,
        padding: 16,
        gap: 14,
      }}
    >
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
          <ThingIcon glyph="server" size={22} color={theme.colors.ink2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text size={17} weight={600} lh={1.35} tracking={-0.01}>
            {HOME_SERVERS_COPY.waiting(pending)}
          </Text>
          <Text size={13} lh={1.4} color={theme.colors.mut} style={{ marginTop: 2 }}>
            {HOME_SERVERS_COPY.waitingLine}
          </Text>
        </View>
      </View>
      <Button
        label={HOME_SERVERS_COPY.review}
        onPress={onReview}
        accessibilityLabel={`${HOME_SERVERS_COPY.review}: ${HOME_SERVERS_COPY.waiting(pending)}`}
        style={{ alignSelf: 'flex-start', paddingHorizontal: 16 }}
      />
    </View>
  );
}

/** “This Whombat” (the mock's `.tag`): mono 10.5/500, capitals, `brand`, a `line2` hairline, radius 5. */
function Tag({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.line2,
        borderRadius: 5,
        paddingHorizontal: 6,
        paddingVertical: 1,
      }}
    >
      <Text size={10.5} weight={500} mono tracking={0.04} uppercase color={theme.colors.brand}>
        {text}
      </Text>
    </View>
  );
}

/** “Read 12 min ago”, “Last seen 2 d ago” (the mock's `.stale`): a 12dp clock and mono 11.5 in `mut`. */
function ClockLine({ text, icon: Icon = Clock }: { text: string; icon?: typeof Clock }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 }}>
      <Icon size={12} color={theme.colors.mut} strokeWidth={1.75} />
      <Text size={11.5} mono color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
        {text}
      </Text>
    </View>
  );
}

/** The figures two by two, Running across both columns; dimmed for a server that is offline or still waiting. */
function Figures({ row }: { row: OverviewServerRow }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ gap: 14, opacity: row.offline ? 0.55 : 1 }}
    >
      <View style={{ flexDirection: 'row', gap: 18 }}>
        <CpuFigure cell={row.cpu} />
        <AmountFigure cell={row.memory} />
      </View>
      <View style={{ flexDirection: 'row', gap: 18 }}>
        <AmountFigure cell={row.storage} />
        <TempFigure cell={row.temp} />
      </View>
      <RunningFigure cell={row.running} />
    </View>
  );
}

/** A figure's frame: its label (mono 10.5/500, .06em, capitals, `mut`), then what it says. */
function Figure({ label, full = false, children }: { label: string; full?: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={full ? null : { flex: 1, minWidth: 0 }}>
      <Text
        size={10.5}
        weight={500}
        mono
        tracking={0.06}
        uppercase
        color={theme.colors.mut}
        numberOfLines={1}
        style={{ marginBottom: 2 }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

/** The figure (17/600, amber when past its limit) and its word beside it (13, `mut`), on one baseline. */
function Value({ value, small, color }: { value: string; small?: string | null; color?: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 7 }}>
      <Text
        size={17}
        weight={600}
        tracking={-0.01}
        color={color ?? theme.colors.ink}
        numberOfLines={1}
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {value}
      </Text>
      {small ? (
        <Text size={13} color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
          {small}
        </Text>
      ) : null}
    </View>
  );
}

/** The line under a figure (“76 of 118 GB”, “limit 85 °C”): 12.5 in `mut`. */
function Sub({ text }: { text: string }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <Text size={12.5} color={theme.colors.mut} numberOfLines={1} style={{ marginTop: 1 }}>
      {text}
    </Text>
  );
}

function CpuFigure({ cell }: { cell: OverviewCpuCell }) {
  const theme = useTheme();
  const small = [cell.word, cell.avg].filter(Boolean).join(' · ');
  return (
    <Figure label={cell.label}>
      <Value
        value={cell.value}
        small={small}
        color={cell.tone === 'warn' ? theme.colors.warnText : undefined}
      />
      <Sparkline points={cell.points} />
    </Figure>
  );
}

function AmountFigure({ cell }: { cell: OverviewAmountCell }) {
  const theme = useTheme();
  const warn = cell.tone === 'warn';
  return (
    <Figure label={cell.label}>
      <Value value={cell.value} small={cell.word} color={warn ? theme.colors.warnText : undefined} />
      <Sub text={cell.sub} />
      <BlockBar share={cell.share} warn={warn} />
    </Figure>
  );
}

function TempFigure({ cell }: { cell: OverviewTempCell }) {
  const theme = useTheme();
  const warn = cell.tone === 'warn';
  return (
    <Figure label={cell.label}>
      <Value
        value={cell.value}
        color={cell.noSensor ? theme.colors.mut : warn ? theme.colors.warnText : undefined}
      />
      <Sub text={cell.sub} />
      {cell.noSensor ? null : <BlockBar share={cell.share} warn={warn} />}
    </Figure>
  );
}

/** Running: the count and its word, and a dot for each machine or app — unwell amber, running filled, stopped hollow. */
function RunningFigure({ cell }: { cell: OverviewRunningCell }) {
  const theme = useTheme();
  const { unwell, running, stopped, more } = cell.dots;
  const dot = { width: 7, height: 7, borderRadius: 3.5 };
  return (
    <Figure label={cell.label} full>
      {cell.nothing ? (
        <Text size={13} color={theme.colors.mut}>
          {cell.word}
        </Text>
      ) : (
        <>
          <Value value={cell.count} small={cell.word} />
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 3, marginTop: 8 }}
          >
            {Array.from({ length: unwell }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: dots are counts, not things
              <View key={`u${i}`} style={{ ...dot, backgroundColor: theme.colors.warn }} />
            ))}
            {Array.from({ length: running }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: dots are counts, not things
              <View key={`r${i}`} style={{ ...dot, backgroundColor: theme.colors.ink2, opacity: 0.62 }} />
            ))}
            {Array.from({ length: stopped }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: dots are counts, not things
              <View key={`s${i}`} style={{ ...dot, borderWidth: 1.5, borderColor: theme.colors.line2 }} />
            ))}
            {more > 0 ? (
              <Text size={11.5} mono color={theme.colors.mut} style={{ marginLeft: 3 }}>
                +{more}
              </Text>
            ) : null}
          </View>
        </>
      )}
    </Figure>
  );
}

/**
 * The block bar (the mock's `.meter`): 20 blocks 2 apart, 7 tall, radius 1, lit in `chart1` (amber past its limit),
 * unlit `line2`. Decorative: the figure says it.
 */
function BlockBar({ share, warn }: { share: number | null; warn: boolean }) {
  const theme = useTheme();
  const lit = litSegments(share, TILE_SEGMENTS);
  const on = warn ? theme.colors.warn : theme.chart.chart1;
  return (
    <View style={{ flexDirection: 'row', gap: 2, height: 7, marginTop: 7 }}>
      {Array.from({ length: TILE_SEGMENTS }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are fixed positions
          key={i}
          style={{ flex: 1, borderRadius: 1, backgroundColor: i < lit ? on : theme.colors.line2 }}
        />
      ))}
    </View>
  );
}

/**
 * The processor's last 24 hours (the mock's `.spark`): 31 tall across the figure, the wash under the line in `chart1`
 * at the charts' wash, the line 1.5 on top. Nothing with fewer than two readings; decorative, “avg” says it.
 */
function Sparkline({ points }: { points: readonly number[] }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const paths = width > 0 ? sparklinePaths(points, width, SPARK_HEIGHT) : null;
  if (points.length < 2) return null;
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height: SPARK_HEIGHT, marginTop: 2 }}
    >
      {paths ? (
        <Svg width={width} height={SPARK_HEIGHT}>
          <Path d={paths.area} fill={theme.chart.chart1} fillOpacity={Number(theme.chart.chartWash)} />
          <Path
            d={paths.line}
            fill="none"
            stroke={theme.chart.chart1}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </Svg>
      ) : null}
    </View>
  );
}

const SPARK_HEIGHT = 31;
