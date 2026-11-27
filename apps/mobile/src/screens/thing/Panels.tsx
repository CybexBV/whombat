/**
 * The one stacked renderer of a Summary's and a thing page's panels on the phone (Whombat connection-pages.md CP-03,
 * CP-06, CP-19, dashboards.md DS-01…DS-08; connection-pages-mobile.md AP-1953…AP-1959, dashboards-mobile.md
 * AP-2120…AP-2135), for a connection's or device's page (`things.page`) and a server's Summary (`serverDashboard`) alike:
 * panels stacked in the order given, drawn by kind in the server page's language (`OneCard`, mono labels, 52dp rows) —
 * figures in one card two by two with their small line or meter (a figure that names charts opens them inside that card,
 * Whombat connections-page.md CN-05, connections-page.md AP-2558…), chart cards the whole width (`ChartCard`; on a
 * Summary only those no figure names, `SummaryPanels`), Worth a look
 * with each notice's way out on the right (five, then “Show N more”) — its ⋯ menu beside it and quiet lines greyed at
 * the bottom with Undo (quiet-notices-mobile.md AP-4861, AP-4862) —, bar lists, a table's first column as the title
 * with its figures (and a small bar) on the right, its small line under it and a button, lists with their time or size,
 * facts, a few sentences, what Whombat may do (“Change” opens Settings), what it did here (Undo) and the widgets kept
 * here with chips asking for more. Contracts 0.121's service pages (service-dashboards.md AP-4630…): galleries
 * (`Gallery.tsx`) and controls (`Controls.tsx`), buttons on a panel's head, a notice, a table row and a list line
 * (`ThingButton.tsx`), a list line's small picture and a row's or line's outside page. A service's settings
 * (`Settings.tsx`; service-settings.md SST-01…SST-09) and any card's Ask in its head (SST-08). Colours only from the theme.
 */

import {
  handleTheseView,
  keepHereQuestion,
  type LimitView,
  limitNow,
  limitWords,
  noticeGroups,
  overviewWords,
  thingImageInitial,
  widgetChart,
} from '@whombat/client';
import { litSegments, TILE_SEGMENTS_PHONE } from '@whombat/client/hosts';
import { type QuietActions, type QuietTarget, useWidgets } from '@whombat/client/react';
import type { HostSeriesRange, LookResearch, ThingNoticeIcon, ThingPagePanel, Widget } from '@whombat/core';
import { Fragment, type ReactNode, useContext, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { HumanAvatar } from '../../avatars/Avatars';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import {
  type BarRowView,
  barRows,
  type CellPart,
  dashboardCopy,
  type FigureTile,
  figurePress,
  figureTiles,
  foldNotices,
  type RangeOption,
  rangePlace,
  summaryLayout,
  type TableRowView,
  tableRows,
  toggleFigure,
  wideLayout,
} from '../../data/dashboard';
import type { ChartSwatch, HostReadout } from '../../data/hostStatus';
import { monitoringCopy } from '../../data/monitoring';
import { parseQuietPick, quietLineMenu } from '../../data/nativeMenu';
import { LINE_PICTURE_WIDTH, serviceCopy } from '../../data/servicePanels';
import { panelAsk } from '../../data/serviceSettings';
import { HINGE_GAP, halfWidths, isSlotPage, isStrip, slotColumns } from '../../data/serviceSlots';
import {
  accessRows,
  foldHeadsUps,
  type LinkRun,
  type ListRowView,
  linkRun,
  listRows,
  type NoticeRowView,
  noticeRows,
  noticesBadge,
  PANEL_ROWS_FIRST,
  type PhoneThingTab,
  quietLineCopy,
  thingPageCopy,
} from '../../data/thingPage';
import { useAgentWords } from '../../data/useAgent';
import { mobileTranslator, useI18n, useMobileT } from '../../i18n';
import { LineChart, Meter, Readout, SmallLine, swatchColor } from '../../managed/HostCharts';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import {
  Dot,
  MonoLabel,
  OneCard,
  OneCardAside,
  OneCardLookContext,
  OneRow,
  ToneBadge,
  toneOf,
} from '../../ui/assistant';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, Ellipsis, X } from '../../ui/icons';
import { hasNativeMenu, NativeMenu } from '../../ui/nativeMenu';
import { Button } from '../../ui/primitives';
import { StatusPill } from '../../ui/StatusPill';
import { useScreenShape } from '../../ui/screenShape';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';
import { ChangesCard } from './Changes';
import { ChartCard } from './ChartCard';
import { type ControlActions, ControlsCard } from './Controls';
import { GalleryCard } from './Gallery';
import { NOTICE_ICONS } from './noticeIcons';
import { ThingPicture } from './Picture';
import { CardQuiet, HeaderLink } from './parts';
import { QuietMenuSheet, type QuietMenuTarget } from './QuietMenu';
import { LiveLine, RangeControl } from './RangeControl';
import { AskLink, SettingsCard } from './Settings';
import { CountsCard, LiveCard, ShelfCard, SlotHalfContext, StripCard } from './Slots';
import { ItemButtons, PanelButtons, ThingButton } from './ThingButton';

/** The thing the panels are about: its thingId (`connection:con_ha`, `server:pve-02`) and its name. */
export interface PanelThing {
  id: string;
  name: string;
}

/** What a panel needs from its page and screen. */
export interface PanelContext {
  thing: PanelThing;
  tabs: readonly PhoneThingTab[];
  /** The range the charts and small lines cover (DS-03). */
  range: HostSeriesRange;
  /** Run a button's way out (a question, a tab, Settings, a page, the browser). */
  run: (run: LinkRun) => void;
  /** Settings (the Connection screen), when the page has one and the viewer may change it. */
  openSettings: (() => void) | null;
  /**
   * The page's buttons and what its switches and steppers show while they settle (contracts 0.121; AP-4630…): a
   * connection's page has them, a server's Summary (built on the phone) none, and draws no buttons.
   */
  act?: ControlActions | null;
  /**
   * Ignore, Remind me tomorrow, Stop watching and Undo on Worth a look's lines (quiet-notices-mobile.md AP-4861): on a
   * Whombat with `things.quiet`; null or absent on an older one, whose lines get no ⋯ menu.
   */
  quiet?: QuietActions | null;
  /** What the assistant is doing about the thing (its research), for Worth a look's one button (handle-it.md). */
  research?: LookResearch | null;
  /**
   * *Ask {assistant} to handle these*: hands everything that needs a look to the assistant (`looks.handle`), with
   * today's question for a Whombat without it. None: the question opens in a new chat, as before.
   */
  onHandle?: ((question: string) => void) | null;
  /**
   * Put it back (Whombat service-settings.md SST-03): undoes a setting's last change (`changes.undo`), from its Change
   * sheet. None: no Put it back there.
   */
  putBack?: ((changeId: string) => void) | null;
  /**
   * End now on a line held because the thing is kept quiet: ends the whole window. None
   * on a Whombat without it, or for who may not end it.
   */
  endQuiet?: { run: () => void; busy: boolean } | null;
  /**
   * Change the limit in a line's ⋯: the limit of a server's check the line comes from, for its
   * item, and what opens its sheet. None where nothing has a limit.
   */
  limits?: { of: (line: QuietTarget) => LimitView | null; open: (view: LimitView) => void } | null;
}

type ChartPanel = Extract<ThingPagePanel, { kind: 'chart' }>;

/** The range control a Summary offers (DS-03): its ranges, the one shown, a server's “Live · every 10 s”. */
export interface SummaryRange {
  options: readonly RangeOption[];
  value: HostSeriesRange;
  onChange: (range: HostSeriesRange) => void;
  live?: string | null;
}

/** A Summary's figures that open their charts (CN-05): each figure's charts, the one open, and the range control. */
interface FigureOpening {
  charts: Readonly<Record<string, ChartPanel[]>>;
  opened: string | null;
  setOpened: (key: string | null) => void;
  range: SummaryRange | null;
}

/**
 * A Summary's panels on the phone (CN-05, AP-2510; connections-page.md AP-2558…AP-2561): the charts a figure names
 * (the shared `figureCharts`) aren't cards of their own — the figure opens them inside the figures' card, one at a
 * time — and the rest stack as before. While a chart card is still there (or no figure opens anything) the range control
 * stands right above the first chart it controls, else above the figures (`rangePlace`); when every chart sits behind a
 * figure it moves into the opened figure and the top keeps only a server's “Live · every 10 s”. On a wide page they sit in columns (`WidePanels`).
 */
export function SummaryPanels({
  panels,
  ctx,
  range,
  extra,
  wide = false,
}: {
  panels: readonly ThingPagePanel[];
  ctx: PanelContext;
  range: SummaryRange | null;
  /** A card of the screen's own after Worth a look (else after the figures): a server's Updates (AP-2881). */
  extra?: ReactNode;
  /** The page is wide (the list hidden on an open phone): columns, as on the web. */
  wide?: boolean;
}) {
  const { open, panels: rest, rangeOnTop } = useMemo(() => summaryLayout(panels), [panels]);
  const after = extra
    ? (rest.find((p) => p.kind === 'notices' && p.id === 'look') ?? rest.find((p) => p.kind === 'kpis'))?.id
    : undefined;
  const [opened, setOpened] = useState<string | null>(null);
  const shown = opened && open[opened] ? opened : null;
  // A page in slots (service-slots.md SLT-01) heads its cards with their names, as one page.
  const slots = useMemo(() => isSlotPage(rest), [rest]);
  // The range stands by what it controls (the first chart, else the figures), not above everything else.
  const rangeAt = rangeOnTop && !wide ? rangePlace(rest) : null;
  const rangeControl = range ? (
    <RangeControl options={range.options} value={range.value} onChange={range.onChange} live={range.live} />
  ) : null;
  const draw = (p: ThingPagePanel) => (
    <Fragment key={p.id}>
      {p.id === rangeAt ? rangeControl : null}
      <Panel
        panel={p}
        ctx={ctx}
        {...(p.kind === 'kpis' ? { figures: { charts: open, opened: shown, setOpened, range } } : {})}
      />
      {p.id === after ? extra : null}
    </Fragment>
  );
  return (
    <OneCardLookContext.Provider value={slots ? 'heading' : 'label'}>
      {range && rangeOnTop ? (
        rangeAt === null ? (
          rangeControl
        ) : null
      ) : range?.live ? (
        <LiveLine text={range.live} />
      ) : null}
      {wide ? <WidePanels panels={rest} draw={draw} /> : rest.map(draw)}
      {extra && after === undefined ? extra : null}
    </OneCardLookContext.Provider>
  );
}

/**
 * A tab's panels other than the Summary's (a service's settings, its other tabs): stacked, or in columns on a wide page.
 */
export function TabPanels({
  panels,
  ctx,
  wide,
}: {
  panels: readonly ThingPagePanel[];
  ctx: PanelContext;
  wide: boolean;
}) {
  const draw = (p: ThingPagePanel) => <Panel key={p.id} panel={p} ctx={ctx} />;
  return wide ? <WidePanels panels={panels} draw={draw} /> : panels.map(draw);
}

/** The gap between a page's cards, as the screens stack them. */
const CARD_GAP = 14;

/**
 * Panels on a wide page (iphone-duo.md AP-6741; `wideLayout`): the top across the width, chart cards two to a line, the
 * main and side columns side by side (each stacking its own, so nothing stretches beside a long list), the bottom.
 */
function WidePanels({
  panels,
  draw,
}: {
  panels: readonly ThingPagePanel[];
  draw: (panel: ThingPagePanel) => ReactNode;
}) {
  const laid = useMemo(() => wideLayout(panels), [panels]);
  if (isSlotPage(panels)) return <SlotHalves panels={panels} draw={draw} />;
  const column = (list: readonly ThingPagePanel[], flex: number) => (
    <View style={{ flex, minWidth: 0, gap: CARD_GAP }}>{list.map(draw)}</View>
  );
  return (
    <>
      {laid.top.map(draw)}
      {laid.chartLines.map((line) => (
        <View
          key={line.map((p) => p.id).join(' ')}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: CARD_GAP }}
        >
          {line.map((p) => (
            <View key={p.id} style={{ flex: 1, minWidth: 0 }}>
              {draw(p)}
            </View>
          ))}
        </View>
      ))}
      {laid.main.length && laid.side.length ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: CARD_GAP }}>
          {column(laid.main, laid.mainFlex)}
          {column(laid.side, 1)}
        </View>
      ) : (
        [...laid.main, ...laid.side].map(draw)
      )}
      {laid.bottom.map(draw)}
    </>
  );
}

/**
 * A page in slots when wide (service-slots.md SLT-09; `slotColumns`): what is on top across the width, then two
 * columns — Live and the Shelf on the left, Worth a look's strip and the one-column cards on the right —, each in its
 * own half of an open foldable with the fold in the room between them (or sharing the width on a tablet), then the
 * bottom across. The cards inside know they sit in a half (rows instead of swiping and tiles).
 */
function SlotHalves({
  panels,
  draw,
}: {
  panels: readonly ThingPagePanel[];
  draw: (panel: ThingPagePanel) => ReactNode;
}) {
  const laid = useMemo(() => slotColumns(panels), [panels]);
  const shape = useScreenShape();
  const hinge = shape.pages === 2 && shape.fold !== null ? shape.content.left + shape.fold : null;
  const box = useRef<View>(null);
  const [frame, setFrame] = useState<{ x: number; width: number } | null>(null);
  const halves = frame ? halfWidths({ x: frame.x, width: frame.width, hinge }) : null;
  const column = (list: readonly ThingPagePanel[], width: number | undefined) => (
    <View style={{ ...(width === undefined ? { flex: 1 } : { width }), minWidth: 0, gap: CARD_GAP }}>
      {list.map(draw)}
    </View>
  );
  return (
    <>
      {laid.across.map(draw)}
      {laid.left.length || laid.right.length ? (
        <View
          ref={box}
          onLayout={() => box.current?.measureInWindow((x, _y, width) => setFrame({ x, width }))}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: halves ? HINGE_GAP : CARD_GAP }}
        >
          <SlotHalfContext.Provider value>
            {column(laid.left, halves?.left)}
            {column(laid.right, halves?.right)}
          </SlotHalfContext.Provider>
        </View>
      ) : null}
      {laid.bottom.map(draw)}
    </>
  );
}

export function Panel({
  panel,
  ctx,
  figures,
}: {
  panel: ThingPagePanel;
  ctx: PanelContext;
  /** On a Summary: the charts its figures open (`SummaryPanels`). */
  figures?: FigureOpening;
}) {
  // A card's Ask (service-settings.md SST-08) in its head, whatever its kind; a settings group draws its own.
  const assistant = useAgentWords().name;
  const { rawLocale } = useI18n();
  const ask = panel.ask && panel.kind !== 'settings' ? panelAsk(panel, assistant, rawLocale) : null;
  const card = <PanelCard panel={panel} ctx={ctx} figures={figures} />;
  if (!ask || !('title' in panel) || !panel.title) return card;
  return (
    <OneCardAside.Provider value={<AskLink ask={ask} about={panel.title} ctx={ctx} />}>
      {card}
    </OneCardAside.Provider>
  );
}

function PanelCard({
  panel,
  ctx,
  figures,
}: {
  panel: ThingPagePanel;
  ctx: PanelContext;
  figures: FigureOpening | undefined;
}) {
  switch (panel.kind) {
    case 'kpis':
      return <FigureCard panel={panel} ctx={ctx} figures={figures ?? null} />;
    case 'chart':
      return <ChartCard panel={panel} range={ctx.range} />;
    case 'notices':
      return isStrip(panel) ? <StripCard panel={panel} ctx={ctx} /> : <NoticesCard panel={panel} ctx={ctx} />;
    case 'table':
      return <TableCard panel={panel} ctx={ctx} />;
    case 'list':
      return panel.look === 'counts' ? (
        <CountsCard panel={panel} ctx={ctx} />
      ) : (
        <ListCard panel={panel} ctx={ctx} />
      );
    case 'bars':
      return <BarsCard panel={panel} ctx={ctx} />;
    case 'facts':
      return <FactsCard panel={panel} />;
    case 'text':
      return <TextCard panel={panel} ctx={ctx} />;
    case 'access':
      return <AccessCard panel={panel} ctx={ctx} />;
    case 'changes':
      return <ChangesCard title={panel.title} limit={panel.limit} ctx={ctx} />;
    case 'widgets':
      return <WidgetsCard panel={panel} ctx={ctx} />;
    case 'gallery':
      return panel.look === 'rows' ? (
        <LiveCard panel={panel} ctx={ctx} />
      ) : panel.look === 'shelf' ? (
        <ShelfCard panel={panel} ctx={ctx} />
      ) : (
        <GalleryCard panel={panel} ctx={ctx} />
      );
    case 'controls':
      return <ControlsCard panel={panel} ctx={ctx} />;
    case 'settings':
      return <SettingsCard panel={panel} ctx={ctx} />;
  }
}

/* Parts ----------------------------------------------------------------------------------------------------------- */

/** A notice's or a line's icon in its tone (decorative: the row's label says it). */
function ToneIcon({ icon, tone }: { icon: ThingNoticeIcon; tone: string | null }) {
  const theme = useTheme();
  const Icon = NOTICE_ICONS[icon];
  const color = tone === 'bad' || tone === 'warn' || tone === 'ok' ? toneOf(theme, tone) : theme.colors.mut;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Icon size={18} color={color} strokeWidth={1.8} />
    </View>
  );
}

/** Words in parts, some mono, some in a tone (a table row's line). */
function Parts({ parts, size = 13 }: { parts: readonly CellPart[]; size?: number }) {
  const theme = useTheme();
  const color = (tone: CellPart['tone']) =>
    tone === 'bad' || tone === 'warn' || tone === 'ok' ? toneOf(theme, tone) : theme.colors.mut;
  return (
    <Text size={size} color={theme.colors.mut} numberOfLines={2}>
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells in their columns' order
        <Fragment key={i}>
          {i ? ' · ' : null}
          <Text size={p.mono ? size - 0.5 : size} mono={p.mono} color={color(p.tone)}>
            {p.text}
          </Text>
        </Fragment>
      ))}
    </Text>
  );
}

/** “Show all 171” under a long table or list. */
function useFirstRows<T>(rows: readonly T[]): { shown: readonly T[]; more: ReactNode } {
  const { rawLocale } = useI18n();
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const [all, setAll] = useState(false);
  if (all || rows.length <= PANEL_ROWS_FIRST) return { shown: rows, more: null };
  return {
    shown: rows.slice(0, PANEL_ROWS_FIRST),
    more: (
      <View style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
        <Button label={thingPageCopyHere.showAll(rows.length)} variant="quiet" onPress={() => setAll(true)} />
      </View>
    ),
  };
}

/* Figures (kpis) -------------------------------------------------------------------------------------------------- */

/**
 * The figures in one card, two by two between hairlines (a last odd one takes the row): a mono label, the value (in
 * its tone), the rest, the line under it, then its small line over the range or its meter. A figure that names charts
 * is a button (expanded or not, a chevron by its label): it opens them right under its row, inside the card, with the
 * range control and a close button (mock `#server-open`, stacked); one at a time. A figure that leads to a tab (Guests,
 * Array) is a button that switches to it (a `›` by its label).
 */
function FigureCard({
  panel,
  ctx,
  figures,
}: {
  panel: Extract<ThingPagePanel, { kind: 'kpis' }>;
  ctx: PanelContext;
  figures: FigureOpening | null;
}) {
  const { rawLocale } = useI18n();
  const overviewWordsHere = overviewWords(rawLocale);

  const theme = useTheme();
  const tiles = useMemo(
    () => figureTiles(panel.items, ctx.range, rawLocale),
    [panel.items, ctx.range, rawLocale],
  );
  const presses = useMemo(
    () =>
      Object.fromEntries(panel.items.map((k) => [k.key, figurePress(k, figures?.charts ?? null, ctx.tabs)])),
    [panel.items, figures?.charts, ctx.tabs],
  );
  const openKey = figures?.opened && tiles.some((t) => t.key === figures.opened) ? figures.opened : null;
  // A server's figures keep today's segmented block bars, and say where their history is (16-final/server).
  const server = ctx.thing.id.startsWith('server:');
  const historyKey = server ? (tiles.find((t) => figures?.charts[t.key]?.length)?.key ?? null) : null;
  const openTile = openKey ? tiles.find((t) => t.key === openKey) : undefined;
  const openCharts = openKey ? (figures?.charts[openKey] ?? []) : [];
  // Two by two; the opened figure's charts come right under its row, so they open where the finger is.
  const rows = useMemo(() => {
    const out: FigureTile[][] = [];
    for (let i = 0; i < tiles.length; i += 2) out.push(tiles.slice(i, i + 2));
    return out;
  }, [tiles]);
  return (
    <View
      style={{
        backgroundColor: theme.colors.sf,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: 16,
        overflow: 'hidden',
      }}
    >
      {rows.map((row, r) => (
        <Fragment key={row.map((t) => t.key).join(':')}>
          <View style={{ flexDirection: 'row' }}>
            {row.map((t, c) => {
              const press = presses[t.key] ?? null;
              const link = press?.kind === 'link' ? press : null;
              return (
                <FigureCell
                  key={t.key}
                  tile={t}
                  right={c === 1}
                  below={r > 0}
                  opens={press?.kind === 'charts'}
                  open={t.key === openKey}
                  link={link?.label ?? null}
                  blocks={server}
                  onPress={
                    press?.kind === 'charts' && figures
                      ? () => figures.setOpened(toggleFigure(openKey, t.key))
                      : link
                        ? () => ctx.run(link.run)
                        : null
                  }
                />
              );
            })}
          </View>
          {openTile && openCharts.length && figures && row.includes(openTile) ? (
            <OpenFigure
              tile={openTile}
              charts={openCharts}
              range={figures.range}
              shown={ctx.range}
              onClose={() => figures.setOpened(null)}
            />
          ) : null}
        </Fragment>
      ))}
      {historyKey && figures && !openKey ? (
        <Touchable
          onPress={() => figures.setOpened(historyKey)}
          feedback="fade"
          ringRadius={8}
          accessibilityRole="button"
          accessibilityLabel={overviewWordsHere.readingHistory}
          style={{
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 14,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Text size={13.5} weight={600} color={theme.colors.brand}>
            {overviewWordsHere.readingHistory}
          </Text>
          <ChevronRight size={14} color={theme.colors.brand} strokeWidth={1.8} />
        </Touchable>
      ) : null}
    </View>
  );
}

/** What TalkBack adds to a figure that opens its charts, and the close button's words. */
function figureWords(locale?: string | null) {
  const tr = mobileTranslator(locale);
  return {
    opens: tr.t('screens2.panels.opens'),
    closes: tr.t('screens2.panels.closes'),
    close: (label: string) => tr.t('screens2.panels.close', { label }),
  };
}

function FigureCell({
  tile: t,
  right,
  below,
  opens,
  open,
  link,
  blocks = false,
  onPress,
}: {
  tile: FigureTile;
  right: boolean;
  below: boolean;
  opens: boolean;
  open: boolean;
  /** The tab it leads to, as its link says (“Open Guests”). */
  link: string | null;
  /** A server's figure: its meter as today's ten neutral segments, its history behind See reading history. */
  blocks?: boolean;
  onPress: (() => void) | null;
}) {
  const { rawLocale } = useI18n();
  const figureWordsHere = figureWords(rawLocale);
  const theme = useTheme();
  const color = swatchColor(theme, t.swatch);
  const Chevron = opens ? (open ? ChevronUp : ChevronDown) : ChevronRight;
  const content = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <MonoLabel>{t.label}</MonoLabel>
        {opens || link ? (
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Chevron size={14} color={open ? theme.colors.ink2 : theme.colors.mut} strokeWidth={1.8} />
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1}>
        <Text
          size={22}
          weight={700}
          tracking={-0.01}
          color={t.tone && t.tone !== 'ok' ? toneOf(theme, t.tone) : theme.colors.ink}
        >
          {t.value}
        </Text>
        {t.rest ? (
          <Text size={13} color={theme.colors.mut}>
            {` ${t.rest}`}
          </Text>
        ) : null}
      </Text>
      {t.sub ? (
        <Text size={12.5} color={theme.colors.mut} numberOfLines={2}>
          {t.sub}
        </Text>
      ) : null}
      {t.spark || t.meter !== null ? <View style={{ flexGrow: 1 }} /> : null}
      {blocks && t.meter !== null ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: 'row', gap: 1.5, height: 5, marginTop: 8 }}
        >
          {Array.from({ length: TILE_SEGMENTS_PHONE }, (_, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: the segments are fixed positions
              key={i}
              style={{
                flex: 1,
                borderRadius: 1,
                backgroundColor:
                  i < litSegments(t.meter, TILE_SEGMENTS_PHONE) ? theme.colors.ink2 : theme.colors.line2,
              }}
            />
          ))}
        </View>
      ) : t.spark ? (
        <View style={{ marginTop: 4 }}>
          <SmallLine values={t.spark} color={color} height={30} />
        </View>
      ) : t.meter !== null ? (
        <View style={{ marginTop: 8 }}>
          <Meter pct={t.meter * 100} color={color} height={5} flush />
        </View>
      ) : null}
    </>
  );
  const style = {
    flex: 1,
    gap: 4,
    paddingTop: 12,
    paddingHorizontal: 14,
    paddingBottom: open ? 10 : 12,
    borderLeftWidth: right ? 1 : 0,
    borderTopWidth: below ? 1 : 0,
    borderColor: theme.colors.line,
    borderBottomWidth: open ? 2 : 0,
    borderBottomColor: color,
    backgroundColor: open ? theme.colors.sf2 : 'transparent',
  };
  if (!onPress)
    return (
      <View accessible accessibilityLabel={t.spoken} style={style}>
        {content}
      </View>
    );
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={t.spoken}
      accessibilityHint={
        opens ? (open ? figureWordsHere.closes : figureWordsHere.opens) : (link ?? undefined)
      }
      {...(opens ? { accessibilityState: { expanded: open } } : {})}
      style={{ ...style, minHeight: 44 }}
    >
      {content}
    </Touchable>
  );
}

/**
 * An opened figure's charts (CN-05; mock `#server-open` at phone width): a hairline under the figures, the chart's title
 * (17/700; the figure's when it opens more than one) with a close button, the range control, then each chart without
 * its card — its average and peak, the legend, the lines, its small facts; a second chart says its own title (where it
 * isn't the heading's) and figure.
 */
function OpenFigure({
  tile,
  charts,
  range,
  shown,
  onClose,
}: {
  tile: FigureTile;
  charts: readonly ChartPanel[];
  range: SummaryRange | null;
  /** The range the charts cover now (the previous one while a new one loads). */
  shown: HostSeriesRange;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();
  const figureWordsHere = figureWords(rawLocale);
  const theme = useTheme();
  const title = charts.length === 1 ? (charts[0]?.title ?? tile.label) : tile.label;
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
        paddingTop: 12,
        paddingHorizontal: 14,
        paddingBottom: 4,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text size={17} weight={700} numberOfLines={1} style={{ flex: 1 }} accessibilityRole="header">
          {title}
        </Text>
        <Touchable
          onPress={onClose}
          feedback="fade"
          ringRadius={9}
          accessibilityRole="button"
          accessibilityLabel={figureWordsHere.close(title)}
          hitSlop={hitSlopFor(30)}
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            borderWidth: 1,
            borderColor: theme.colors.line2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={16} color={theme.colors.mut} strokeWidth={1.8} />
        </Touchable>
      </View>
      {range ? <RangeControl options={range.options} value={range.value} onChange={range.onChange} /> : null}
      {charts.map((c, i) => (
        <ChartCard
          key={c.id}
          panel={c}
          range={shown}
          inline={{ title: charts.length > 1 && c.title !== title, figure: i > 0 }}
        />
      ))}
    </View>
  );
}

/* Worth a look ---------------------------------------------------------------------------------------------------- */

function NoticesCard({
  panel,
  ctx,
}: {
  panel: Extract<ThingPagePanel, { kind: 'notices' }>;
  ctx: PanelContext;
}) {
  const { rawLocale } = useI18n();
  const dashboardCopyHere = dashboardCopy(rawLocale);

  const theme = useTheme();
  const quiet = ctx.quiet ?? null;
  const agent = useAgentWords();
  const rows = useMemo(
    () => noticeRows(panel, ctx.tabs, { quiet: !!quiet, askLabel: agent.ask, locale: rawLocale }),
    [panel, ctx.tabs, quiet, agent.ask, rawLocale],
  );
  const [open, setOpen] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const [menuFor, setMenuFor] = useState<QuietMenuTarget | null>(null);
  // What asks first, every heads-up and the quiet lines folded under one row, uncounted (the web's Worth a look too).
  const groups = useMemo(() => foldHeadsUps(panel.items, rawLocale), [panel.items, rawLocale]);
  const asking = useMemo(() => noticeGroups(panel.items, rawLocale).asking, [panel.items, rawLocale]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const pick = (items: readonly { id: string }[]) =>
    items.map((n) => byId.get(n.id)).filter((r): r is NoticeRowView => !!r);
  const { shown, more } = foldNotices(pick(groups.shown), open);
  const all = handleTheseView(asking, ctx.research, ctx.thing.name, agent.name, rawLocale);
  const handOver = () => {
    if (!all) return;
    if (ctx.onHandle) return ctx.onHandle(all.fallback.question);
    const asked = linkRun(all.fallback, ctx.tabs);
    if (asked) ctx.run(asked.run);
  };
  const badge = noticesBadge(panel);
  const openMenu = quiet
    ? (r: NoticeRowView) =>
        r.menu ? setMenuFor({ menu: r.menu, line: r.line, limit: ctx.limits?.of(r.line) ?? null }) : undefined
    : null;
  const line = (r: NoticeRowView) =>
    r.button || r.menu || r.quiet ? (
      <NoticeLine key={r.id} row={r} ctx={ctx} onMenu={openMenu} />
    ) : (
      <OneRow
        key={r.id}
        leading={<ToneIcon icon={r.icon} tone={r.tone} />}
        title={r.title}
        line={r.detail}
        trailing={
          r.action ? (
            <Text size={13} weight={600} color={theme.colors.brand} numberOfLines={1}>
              {r.action.label}
            </Text>
          ) : undefined
        }
        label={r.spoken}
        {...(r.action
          ? {
              hint: r.action.label,
              onPress: () => {
                if (r.action) ctx.run(r.action.run);
              },
            }
          : {})}
      />
    );
  return (
    <OneCard
      label={panel.title}
      right={badge ? <ToneBadge text={badge.text} tone={badge.tone} /> : undefined}
    >
      {!badge ? (
        // Nothing asks: its words, above the folded heads-ups and quiet lines (QN-14; AP-4862).
        <CardQuiet text={panel.empty?.trim() || dashboardCopyHere.nothing} first />
      ) : null}
      {shown.map(line)}
      {more || open ? (
        <FoldRow
          label={open ? dashboardCopyHere.showFewer : dashboardCopyHere.showMore(more)}
          onPress={() => setOpen(!open)}
        />
      ) : null}
      {all?.label || all?.busy ? (
        <View
          style={{
            paddingHorizontal: 14,
            paddingVertical: 12,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          {all.label ? (
            <Button label={all.label} variant="primary" onPress={handOver} />
          ) : (
            // While the assistant is on what the person handed it: its line where the button was.
            <View accessibilityRole="text" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator size="small" color={theme.colors.brand} />
              <Text size={13.5} color={theme.colors.ink2} style={{ flex: 1 }}>
                {all.busy}
              </Text>
            </View>
          )}
        </View>
      ) : null}
      {unfolded ? pick(groups.folded).map(line) : null}
      {groups.foldLabel ? (
        <FoldRow
          label={unfolded ? dashboardCopyHere.showFewer : groups.foldLabel}
          onPress={() => setUnfolded(!unfolded)}
        />
      ) : null}
      {quiet ? (
        <QuietMenuSheet
          target={menuFor}
          actions={quiet}
          onLimit={ctx.limits?.open ?? null}
          onClose={() => setMenuFor(null)}
        />
      ) : null}
    </OneCard>
  );
}

/** The room a line's mark takes before its words (20dp and the 12dp gap): buttons under the words line up with them. */
const MARK_ROOM = 32;

/**
 * A notice with more than its way out: a button (0.121, CT-1012: Retry, Clear, Dismiss) under its words, outside the
 * line so TalkBack reaches both; its ⋯ menu (QN-10; quiet-notices-mobile.md AP-4861), a 44dp button on the right that a
 * long press on the line opens too (on iPhone iOS's own menu, ios-native.md); or quiet (QN-14, AP-4862): greyed, its quiet words under the title (“Ignored by John
 * until it’s back online”) and, for who may quiet it, a 44dp Undo on the right. The line's link's words on the right
 * open it, as on every notice.
 */
function NoticeLine({
  row,
  ctx,
  onMenu,
}: {
  row: NoticeRowView;
  ctx: PanelContext;
  onMenu: ((row: NoticeRowView) => void) | null;
}) {
  const { rawLocale } = useI18n();
  const limitWordsHere = limitWords(rawLocale);
  const monitoringCopyHere = monitoringCopy(rawLocale);
  const quietLineCopyHere = quietLineCopy(rawLocale);
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const theme = useTheme();
  const action = row.action;
  const quiet = ctx.quiet ?? null;
  const menu = row.menu && onMenu ? () => onMenu(row) : null;
  // On iPhone the menu is iOS's own, from the line held or its ⋯ tapped.
  // A server's line whose check has a limit offers Change the limit in its ⋯ too.
  const limit = menu && ctx.limits ? ctx.limits.of(row.line) : null;
  const native =
    menu && row.menu && quiet && hasNativeMenu
      ? quietLineMenu(
          row.menu,
          row.line.title,
          limit ? { label: limitWordsHere.menu, words: limitNow(limit, rawLocale) } : null,
        )
      : null;
  const pick = (id: string) => {
    if (id === 'limit' && limit) return ctx.limits?.open(limit);
    const p = parseQuietPick(id);
    if (p && quiet) quiet[p](row.line);
  };
  const undo = row.undo && quiet ? row.undo : null;
  // A line held because the whole thing is kept quiet ends with it: End now, not Undo.
  const endQuiet = row.endNow ? (ctx.endQuiet ?? null) : null;
  const inner = (
    <>
      <View style={{ width: 20, alignItems: 'center' }}>
        <ToneIcon icon={row.icon} tone={row.tone} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={15} weight={600} numberOfLines={2} color={row.quiet ? theme.colors.mut : undefined}>
          {row.title}
        </Text>
        {row.quiet || row.detail ? (
          <Text size={13} color={theme.colors.mut} numberOfLines={2}>
            {row.quiet ?? row.detail}
          </Text>
        ) : null}
      </View>
      {action ? (
        <Text size={13} weight={600} color={theme.colors.brand} numberOfLines={1}>
          {action.label}
        </Text>
      ) : null}
    </>
  );
  const line = {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    paddingVertical: 11,
    minHeight: 52,
  };
  return (
    <View style={{ paddingLeft: 14, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingRight: menu || undo || endQuiet ? 4 : 14,
          gap: 4,
        }}
      >
        {native ? (
          <NativeMenu spec={native} onPick={pick} style={GROWS}>
            <Touchable
              {...(action ? { onPress: () => ctx.run(action.run) } : {})}
              feedback="wash"
              accessibilityRole={action ? 'button' : 'text'}
              accessibilityLabel={row.spoken}
              accessibilityHint={action?.label}
              style={line}
            >
              {inner}
            </Touchable>
          </NativeMenu>
        ) : action || menu ? (
          <Touchable
            {...(action ? { onPress: () => ctx.run(action.run) } : {})}
            {...(menu ? { onLongPress: menu } : {})}
            feedback="wash"
            accessibilityRole={action ? 'button' : 'text'}
            accessibilityLabel={row.spoken}
            accessibilityHint={action?.label}
            style={line}
          >
            {inner}
          </Touchable>
        ) : (
          <View accessible accessibilityLabel={row.spoken} style={line}>
            {inner}
          </View>
        )}
        {native && row.menu ? (
          <NativeMenu spec={native} onPick={pick} trigger="tap" label={row.menu.label} style={MENU_DOT}>
            <View style={MENU_DOT}>
              <Ellipsis size={18} color={theme.colors.mut} strokeWidth={1.8} />
            </View>
          </NativeMenu>
        ) : menu && row.menu ? (
          <Touchable
            onPress={menu}
            feedback="wash"
            ringRadius={22}
            accessibilityLabel={row.menu.label}
            accessibilityHint={quietLineCopyHere.menuHint}
            style={MENU_DOT}
          >
            <Ellipsis size={18} color={theme.colors.mut} strokeWidth={1.8} />
          </Touchable>
        ) : null}
        {undo && quiet ? (
          <Touchable
            onPress={() => quiet.undo(undo)}
            disabled={quiet.busy(undo)}
            feedback="fade"
            ringRadius={10}
            accessibilityLabel={quietLineCopyHere.undoLabel(row.title)}
            accessibilityHint={quietLineCopyHere.undoHint}
            style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 10, justifyContent: 'center' }}
          >
            <Text size={13} weight={600} color={theme.colors.brand}>
              {thingPageCopyHere.undo}
            </Text>
          </Touchable>
        ) : null}
        {endQuiet ? (
          <Touchable
            onPress={endQuiet.run}
            disabled={endQuiet.busy}
            feedback="fade"
            ringRadius={10}
            accessibilityLabel={`${monitoringCopyHere.endNow}: ${row.title}`}
            accessibilityHint={monitoringCopyHere.endNowHint}
            style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 10, justifyContent: 'center' }}
          >
            <Text size={13} weight={600} color={theme.colors.brand}>
              {monitoringCopyHere.endNow}
            </Text>
          </Touchable>
        ) : null}
      </View>
      {row.button && ctx.act ? (
        <View style={{ paddingLeft: MARK_ROOM, paddingRight: 14, paddingBottom: 12, marginTop: -3 }}>
          <ItemButtons buttons={[row.button]} act={ctx.act.buttons} about={row.title} />
        </View>
      ) : null}
    </View>
  );
}

/** A line's part that a tap opens: the room its buttons leave (sized by its content, so it holds the same in a menu). */
const GROWS = { flexGrow: 1, flexShrink: 1, minWidth: 0 } as const;
/** A line's ⋯: 44dp. */
const MENU_DOT = {
  width: 44,
  height: 44,
  borderRadius: 22,
  alignItems: 'center',
  justifyContent: 'center',
} as const;

/** “Show 4 more” at a card's foot: `brand` words on a 44dp row that opens (or closes) the rest in place. */
export function FoldRow({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 14,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Text size={13.5} weight={600} color={theme.colors.brand}>
        {label}
      </Text>
    </Touchable>
  );
}

/* Table ----------------------------------------------------------------------------------------------------------- */

/** A figure on a row's right; a CPU's small bar (32 × 4) before it. */
function RightPart({ part: p, first }: { part: CellPart; first: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {p.meter !== null ? (
        <View style={{ width: 32 }}>
          <Meter
            pct={p.meter * 100}
            color={swatchColor(theme, p.tone === 'bad' || p.tone === 'warn' ? p.tone : 'chart1')}
            height={4}
            flush
          />
        </View>
      ) : null}
      <Text
        size={first ? 13 : 12}
        mono={p.mono}
        color={
          p.tone === 'bad' || p.tone === 'warn'
            ? toneOf(theme, p.tone)
            : first
              ? theme.colors.ink2
              : theme.colors.mut
        }
        numberOfLines={1}
      >
        {p.text}
      </Text>
    </View>
  );
}

/**
 * One table row: its state dot, the first column as the title (its note after it), the rest under it, its small line
 * under that, figures right (a small bar before a CPU's), then its button (“Open”) beside the row, not inside it, so
 * TalkBack reaches both.
 */
function TableRow({
  row,
  onPress,
  onButton,
  act,
}: {
  row: TableRowView;
  onPress: (() => void) | null;
  onButton: (() => void) | null;
  act: ControlActions | null;
}) {
  const { rawLocale } = useI18n();
  const SERVICE_COPY = serviceCopy(rawLocale);
  const theme = useTheme();
  const dotTone = row.dot === 'off' ? null : row.dot;
  const content = (
    <>
      {row.dot ? (
        <View style={{ width: 12, alignItems: 'center' }}>
          <Dot tone={dotTone} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <Text
            size={row.titleMono ? 14.5 : 15}
            weight={row.titleMono ? 500 : 600}
            mono={row.titleMono}
            numberOfLines={1}
            style={{ flexShrink: 0, maxWidth: '100%' }}
          >
            {row.title}
          </Text>
          {row.note ? (
            <Text size={12.5} mono color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
              {row.note}
            </Text>
          ) : null}
        </View>
        {row.line.length ? <Parts parts={row.line} /> : null}
        {row.spark ? (
          <View style={{ width: '70%', maxWidth: 180, marginTop: 4 }}>
            <SmallLine values={row.spark} color={theme.chart.chart1} height={22} />
          </View>
        ) : null}
      </View>
      {row.right.length ? (
        <View style={{ alignItems: 'flex-end', gap: 3 }}>
          {row.right.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the row's figures in their columns' order
            <RightPart key={i} part={p} first={i === 0} />
          ))}
        </View>
      ) : null}
      {onPress && !row.href && row.url ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <ArrowUpRight size={16} color={theme.colors.mut} strokeWidth={1.8} />
        </View>
      ) : onPress ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <ChevronRight size={18} color={theme.colors.mut} strokeWidth={1.7} />
        </View>
      ) : null}
    </>
  );
  // A cell's button (0.121, CT-1002) beside the row when it is the row's only one, else under its words.
  const actions = act ? row.actions : [];
  const beside = actions.length === 1 && !(row.button && onButton) ? actions[0] : undefined;
  const main = {
    flex: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    paddingVertical: 11,
    minHeight: 52,
  };
  return (
    <View style={{ paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {onPress ? (
          <Touchable
            onPress={onPress}
            feedback="fade"
            accessibilityLabel={row.spoken}
            {...(!row.href && row.url
              ? { accessibilityRole: 'link' as const, accessibilityHint: SERVICE_COPY.opensBrowser }
              : {})}
            style={main}
          >
            {content}
          </Touchable>
        ) : (
          <View style={main} accessible accessibilityLabel={row.spoken}>
            {content}
          </View>
        )}
        {row.button && onButton ? (
          <Touchable
            onPress={onButton}
            feedback="wash"
            ringRadius={8}
            accessibilityRole="button"
            accessibilityLabel={`${row.button.label} ${row.title}`}
            hitSlop={hitSlopFor(32)}
            style={{
              minHeight: 32,
              justifyContent: 'center',
              paddingHorizontal: 11,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.line2,
            }}
          >
            <Text size={13} weight={500} numberOfLines={1}>
              {row.button.label}
            </Text>
          </Touchable>
        ) : null}
        {beside && act ? (
          <ThingButton button={beside} act={act.buttons} spoken={`${beside.label} ${row.title}`} />
        ) : null}
      </View>
      {actions.length && !beside && act ? (
        <View style={{ paddingLeft: row.dot ? 22 : 0, paddingBottom: 12, marginTop: -3 }}>
          <ItemButtons buttons={actions} act={act.buttons} about={row.title} />
        </View>
      ) : null}
    </View>
  );
}

function TableCard({ panel, ctx }: { panel: Extract<ThingPagePanel, { kind: 'table' }>; ctx: PanelContext }) {
  const { rawLocale } = useI18n();
  const rows = useMemo(() => tableRows(panel, rawLocale), [panel, rawLocale]);
  const { shown, more } = useFirstRows(rows);
  const link = panelLink(panel.link, ctx);
  return (
    <OneCard meta={panel.meta} label={panel.title} right={link}>
      <PanelButtons buttons={panel.buttons} act={ctx.act?.buttons} />
      {rows.length === 0 && panel.empty ? <CardQuiet text={panel.empty} /> : null}
      {shown.map((r) => (
        <TableRow
          key={r.id}
          row={r}
          onPress={
            r.href
              ? () => ctx.run({ kind: 'href', href: r.href as string })
              : r.url
                ? () => ctx.run({ kind: 'url', url: r.url as string })
                : null
          }
          onButton={
            r.button ? () => ctx.run({ kind: 'href', href: (r.button as { href: string }).href }) : null
          }
          act={ctx.act ?? null}
        />
      ))}
      {more}
    </OneCard>
  );
}

/** A card's header link from the builder's (`table`, `list`, `bars`), when the phone has a way out for it. */
function panelLink(link: Extract<ThingPagePanel, { kind: 'table' }>['link'], ctx: PanelContext): ReactNode {
  const out = linkRun(link, ctx.tabs);
  if (!out) return undefined;
  return <HeaderLink label={out.label} onPress={() => ctx.run(out.run)} />;
}

/* Bars ------------------------------------------------------------------------------------------------------------ */

/**
 * A bar list (storages, disks, pools; CT-396): each line's name (mono when asked) with grey words after it and its
 * figure on the right, a 6dp bar in its tone, and the line under it (“Full in about 5 months”) in its own tone. Side by
 * side on a wide screen, stacked here. A line with a page opens it.
 */
function BarsCard({ panel, ctx }: { panel: Extract<ThingPagePanel, { kind: 'bars' }>; ctx: PanelContext }) {
  const rows = useMemo(() => barRows(panel), [panel]);
  const { shown, more } = useFirstRows(rows);
  // With a heading the meta stands beside the title, so the first line needs no line over it.
  const heading = useContext(OneCardLookContext) === 'heading';
  return (
    <OneCard meta={panel.meta} label={panel.title} right={panelLink(panel.link, ctx)}>
      <PanelButtons buttons={panel.buttons} act={ctx.act?.buttons} />
      {rows.length === 0 && panel.empty ? <CardQuiet text={panel.empty} /> : null}
      {shown.map((r, i) => (
        <BarRow
          key={r.id}
          row={r}
          first={i === 0 && (heading || !panel.meta?.trim())}
          onPress={r.href ? () => ctx.run({ kind: 'href', href: r.href as string }) : null}
        />
      ))}
      {more}
    </OneCard>
  );
}

function BarRow({ row, first, onPress }: { row: BarRowView; first: boolean; onPress: (() => void) | null }) {
  const theme = useTheme();
  const subColor =
    row.subTone === 'bad' || row.subTone === 'warn' ? toneOf(theme, row.subTone) : theme.colors.mut;
  const content = row.initial ? (
    <PersonBar row={row} initial={row.initial} />
  ) : (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <Text
            size={row.mono ? 14.5 : 15}
            weight={row.mono ? 500 : 600}
            mono={row.mono}
            numberOfLines={1}
            style={{ flexShrink: 0, maxWidth: '75%' }}
          >
            {row.label}
          </Text>
          {row.note ? (
            <Text size={12.5} color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
              {row.note}
            </Text>
          ) : null}
        </View>
        {row.value ? (
          <Text
            size={12.5}
            mono
            color={row.tone === 'bad' || row.tone === 'warn' ? toneOf(theme, row.tone) : theme.colors.ink2}
            numberOfLines={1}
          >
            {row.value}
          </Text>
        ) : null}
        {onPress ? (
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <ChevronRight size={16} color={theme.colors.mut} strokeWidth={1.7} />
          </View>
        ) : null}
      </View>
      {row.pct !== null ? (
        <View style={{ marginTop: 7 }}>
          <Meter pct={row.pct * 100} color={swatchColor(theme, row.swatch)} flush />
        </View>
      ) : null}
      {row.sub ? (
        <Text size={12.5} color={subColor} numberOfLines={2} style={{ marginTop: 5 }}>
          {row.sub}
        </Text>
      ) : null}
    </>
  );
  // People read as one list: no lines between them (service-slots-mobile.md AP-7141).
  const style = {
    paddingHorizontal: 14,
    paddingVertical: row.initial ? 7 : 11,
    minHeight: row.initial ? 44 : 52,
    justifyContent: 'center' as const,
    borderTopWidth: first || row.initial ? 0 : 1,
    borderTopColor: theme.colors.line,
  };
  if (!onPress)
    return (
      <View style={style} accessible accessibilityLabel={row.spoken}>
        {content}
      </View>
    );
  return (
    <Touchable onPress={onPress} feedback="wash" accessibilityLabel={row.spoken} style={style}>
      {content}
    </Touchable>
  );
}

/**
 * A person's line (who watches, who asks; service-slots.md SLT-05): their initial in a round mark, their name over its
 * grey words, the figure on the right, and a thin bar under the words in a light chart colour.
 */
function PersonBar({ row, initial }: { row: BarRowView; initial: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <HumanAvatar initials={initial} size={30} label={row.label} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text size={14} weight={600} numberOfLines={1}>
              {row.label}
            </Text>
            {row.note ? (
              <Text size={12} color={theme.colors.mut} numberOfLines={1}>
                {row.note}
              </Text>
            ) : null}
          </View>
          {row.value ? (
            <Text size={13} weight={500} mono color={theme.colors.ink} numberOfLines={1}>
              {row.value}
            </Text>
          ) : null}
        </View>
        {row.pct !== null ? (
          <View style={{ opacity: 0.6 }}>
            <Meter pct={row.pct * 100} color={swatchColor(theme, row.swatch)} height={4} flush />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/* List ------------------------------------------------------------------------------------------------------------ */

function ListCard({ panel, ctx }: { panel: Extract<ThingPagePanel, { kind: 'list' }>; ctx: PanelContext }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const rows = useMemo(() => listRows(panel, now, timeZone, rawLocale), [panel, now, timeZone, rawLocale]);
  const { shown, more } = useFirstRows(rows);
  // When any line has a mark, the others keep its room, so the titles line up (a stopped VM beside a running one).
  const marked = rows.some((r) => r.icon || (r.tone && r.tone !== 'info'));
  return (
    <OneCard meta={panel.meta} label={panel.title} right={panelLink(panel.link, ctx)}>
      <PanelButtons buttons={panel.buttons} act={ctx.act?.buttons} />
      {rows.length === 0 && panel.empty ? <CardQuiet text={panel.empty} /> : null}
      {shown.map((r) =>
        r.image || r.url || (r.actions.length && ctx.act) ? (
          <ListLine key={r.id} row={r} ctx={ctx} marked={marked} />
        ) : (
          <OneRow
            key={r.id}
            leading={
              r.icon ? (
                <ToneIcon icon={r.icon} tone={r.tone} />
              ) : r.tone === 'ok' ? (
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <Check size={17} color={theme.colors.ok} strokeWidth={2} />
                </View>
              ) : r.tone === 'warn' || r.tone === 'bad' ? (
                <Dot tone={r.tone} />
              ) : marked ? (
                <View />
              ) : undefined
            }
            title={r.title}
            line={r.detail}
            trailing={
              r.right ? (
                <Text size={12} mono color={theme.colors.mut} numberOfLines={1}>
                  {r.right}
                </Text>
              ) : undefined
            }
            label={r.spoken}
          />
        ),
      )}
      {more}
    </OneCard>
  );
}

/** A list line's mark before its words: a check when fine, a dot in its tone, its icon; an empty room when others have one. */
function LineMark({ row, marked }: { row: ListRowView; marked: boolean }) {
  const theme = useTheme();
  if (row.icon) return <ToneIcon icon={row.icon} tone={row.tone} />;
  if (row.tone === 'ok')
    return (
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Check size={17} color={theme.colors.ok} strokeWidth={2} />
      </View>
    );
  if (row.tone === 'warn' || row.tone === 'bad') return <Dot tone={row.tone} />;
  return marked ? <View /> : null;
}

/**
 * A list line from a service (0.121, CT-1002, CT-1013): its small picture instead of the mark (a poster 30dp wide, a
 * thumbnail 38, a snapshot 64), the line opening the service's own page in the browser (a small outside mark), and its
 * buttons under its words (a line's title is long; beside it a button left it two words), outside the line, so TalkBack
 * reaches each.
 */
function ListLine({ row, ctx, marked }: { row: ListRowView; ctx: PanelContext; marked: boolean }) {
  const { rawLocale } = useI18n();
  const SERVICE_COPY = serviceCopy(rawLocale);
  const theme = useTheme();
  // A mark (or its empty room when other lines have one); a picture takes its place.
  const hasMark =
    !row.image && (!!row.icon || row.tone === 'ok' || row.tone === 'warn' || row.tone === 'bad' || marked);
  const mark = hasMark ? <LineMark row={row} marked={marked} /> : null;
  const url = row.url;
  const actions = ctx.act ? row.actions : [];
  const inner = (
    <>
      {row.image ? (
        <ThingPicture
          thing={ctx.thing.id}
          image={row.image}
          shape={row.image.shape}
          initial={thingImageInitial(row.title)}
          width={LINE_PICTURE_WIDTH[row.image.shape]}
          radius={5}
          letterSize={13}
        />
      ) : mark ? (
        <View style={{ width: 20, alignItems: 'center' }}>{mark}</View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}>
          <Text size={15} weight={600} numberOfLines={2} style={{ flexShrink: 1 }}>
            {row.title}
          </Text>
          {url ? (
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ marginTop: 3 }}
            >
              <ArrowUpRight size={14} color={theme.colors.mut} strokeWidth={2} />
            </View>
          ) : null}
        </View>
        {row.detail ? (
          <Text size={13} color={theme.colors.mut} numberOfLines={2}>
            {row.detail}
          </Text>
        ) : null}
      </View>
      {row.right ? (
        <Text size={12} mono color={theme.colors.mut} numberOfLines={1}>
          {row.right}
        </Text>
      ) : null}
    </>
  );
  const line = {
    flex: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    paddingVertical: 11,
    minHeight: 52,
  };
  const room = row.image ? LINE_PICTURE_WIDTH[row.image.shape] + 12 : mark ? MARK_ROOM : 0;
  return (
    <View style={{ paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {url ? (
          <Touchable
            onPress={() => ctx.run({ kind: 'url', url })}
            feedback="fade"
            accessibilityRole="link"
            accessibilityLabel={row.spoken}
            accessibilityHint={SERVICE_COPY.opensBrowser}
            style={line}
          >
            {inner}
          </Touchable>
        ) : (
          <View accessible accessibilityLabel={row.spoken} style={line}>
            {inner}
          </View>
        )}
      </View>
      {actions.length && ctx.act ? (
        <View style={{ paddingLeft: room, paddingBottom: 12, marginTop: -3 }}>
          <ItemButtons buttons={actions} act={ctx.act.buttons} about={row.title} />
        </View>
      ) : null}
    </View>
  );
}

/* Facts and text -------------------------------------------------------------------------------------------------- */

function FactsCard({ panel }: { panel: Extract<ThingPagePanel, { kind: 'facts' }> }) {
  const theme = useTheme();
  return (
    <OneCard label={panel.title}>
      <View style={{ paddingHorizontal: 14, paddingBottom: 14, paddingTop: 2, gap: 6 }}>
        {panel.items.map((f) => (
          <View
            key={f.label}
            accessible
            accessibilityLabel={`${f.label}: ${f.value}`}
            style={{ flexDirection: 'row', gap: 10, alignItems: 'baseline' }}
          >
            <Text
              size={11}
              weight={500}
              mono
              tracking={0.05}
              color={theme.colors.mut}
              style={{ minWidth: 88 }}
            >
              {f.label.toUpperCase()}
            </Text>
            <Text
              size={f.mono ? 13 : 13.5}
              lh={1.4}
              mono={!!f.mono}
              color={theme.colors.ink2}
              style={{ flex: 1 }}
            >
              {f.value}
            </Text>
          </View>
        ))}
      </View>
    </OneCard>
  );
}

function TextCard({ panel, ctx }: { panel: Extract<ThingPagePanel, { kind: 'text' }>; ctx: PanelContext }) {
  const theme = useTheme();
  const out = linkRun(panel.link, ctx.tabs);
  return (
    <OneCard {...(panel.title ? { label: panel.title } : {})}>
      <View style={{ paddingHorizontal: 14, paddingTop: panel.title ? 0 : 14, paddingBottom: 14, gap: 12 }}>
        <Text size={14.5} lh={1.5} color={theme.colors.ink2}>
          {panel.body}
        </Text>
        {out ? <Button label={out.label} variant="secondary" onPress={() => ctx.run(out.run)} /> : null}
      </View>
    </OneCard>
  );
}

/* What Whombat may do --------------------------------------------------------------------------------------------- */

function AccessCard({
  panel,
  ctx,
}: {
  panel: Extract<ThingPagePanel, { kind: 'access' }>;
  ctx: PanelContext;
}) {
  const { rawLocale } = useI18n();
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const theme = useTheme();
  const rows = useMemo(() => accessRows(panel, rawLocale), [panel, rawLocale]);
  return (
    <OneCard
      label={panel.title}
      right={
        ctx.openSettings ? (
          <HeaderLink
            label={thingPageCopyHere.change}
            hint={thingPageCopyHere.changeHint}
            onPress={ctx.openSettings}
          />
        ) : undefined
      }
    >
      {panel.lookOnly ? <CardQuiet text={thingPageCopyHere.lookOnly} first /> : null}
      {rows.map((r) => (
        <OneRow
          key={r.label}
          title={r.label}
          trailing={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <StatusPill text={r.tier} tone={r.tone} />
              <Text size={12.5} mono color={theme.colors.mut}>
                {String(r.count)}
              </Text>
            </View>
          }
          label={r.spoken}
        />
      ))}
    </OneCard>
  );
}

/* Show more here -------------------------------------------------------------------------------------------------- */

/** The viewer's widgets kept on this page, then chips that ask Whombat for one (CP-14). */
function WidgetsCard({
  panel,
  ctx,
}: {
  panel: Extract<ThingPagePanel, { kind: 'widgets' }>;
  ctx: PanelContext;
}) {
  const { rawLocale } = useI18n();

  const { slug } = useBurrowBase();
  const list = useWidgets({ params: { burrow: slug }, query: { thing: ctx.thing.id } }, { retry: false });
  const widgets = list.data?.widgets ?? [];
  if (!widgets.length && !panel.suggestions.length) return null;
  return (
    <OneCard label={panel.title}>
      {widgets.map((w, i) => (
        <WidgetBlock key={w.id} widget={w} first={i === 0} />
      ))}
      {panel.suggestions.length ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            paddingHorizontal: 14,
            paddingTop: widgets.length ? 12 : 2,
            paddingBottom: 14,
          }}
        >
          {panel.suggestions.map((s) => (
            <SuggestionChip
              key={s}
              label={s}
              onPress={() =>
                ctx.run({ kind: 'ask', question: keepHereQuestion(s, ctx.thing.name, rawLocale) })
              }
            />
          ))}
        </View>
      ) : null}
    </OneCard>
  );
}

/** A suggestion: a 36dp outlined pill (padded to 44dp) with a plus, that opens the ask sheet. */
function SuggestionChip({ label, onPress }: { label: string; onPress: () => void }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={18}
      accessibilityLabel={label}
      accessibilityHint={tMobile('screens2.panels.keepHint', { what: label.toLowerCase() })}
      hitSlop={hitSlopFor(36)}
      style={{
        minHeight: 36,
        paddingVertical: 6,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 13,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.line2,
      }}
    >
      <Text size={13.5} weight={500} color={theme.colors.ink}>
        {`+ ${label}`}
      </Text>
    </Touchable>
  );
}

/** A widget's value at a moment: whole, or with one decimal. */
const plainNumber = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/**
 * A widget kept here, or pinned on Overview (home-redesign-mobile.md AP-2263): its title, the latest values (a finger
 * picks a moment), its lines with the last point's own time under it (“5 min ago · 14:00”, never “Now”), where it came
 * from.
 */
export function WidgetBlock({ widget, first }: { widget: Widget; first: boolean }) {
  const { rawLocale } = useI18n();

  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  // The last point's age moves on by the minute, not at every tick of the shared clock.
  const minute = Math.floor(useNow().getTime() / 60_000) * 60_000;
  const model = useMemo(
    () => widgetChart(widget, timeZone, minute, rawLocale),
    [widget, timeZone, minute, rawLocale],
  );
  const [selected, setSelected] = useState<number | null>(null);
  const swatch = (color: 1 | 2 | 3): ChartSwatch =>
    color === 1 ? 'chart1' : color === 2 ? 'chart2' : 'chart3';
  const latest: HostReadout = {
    title: widget.subtitle ?? '',
    lines: model.lines.map((l) => ({
      swatch: swatch(l.color),
      value: l.latest === null ? '—' : `${l.latest}${l.unit ? ` ${l.unit}` : ''}`,
      rest: l.label,
    })),
  };
  const readout: HostReadout =
    selected === null
      ? latest
      : {
          title: model.pointLabel(selected),
          lines: model.lines.map((l) => {
            const v = l.values[selected];
            return {
              swatch: swatch(l.color),
              value: v === null || v === undefined ? '—' : `${plainNumber(v)}${l.unit ? ` ${l.unit}` : ''}`,
              rest: l.label,
            };
          }),
        };
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 6,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Text size={15} weight={600}>
        {widget.title}
      </Text>
      <Readout readout={readout} />
      {model.empty ? null : (
        <LineChart
          series={model.lines.map((l) => ({
            key: l.key,
            values: l.values,
            swatch: swatch(l.color),
            area: true,
          }))}
          max={model.max}
          ticks={model.ticks}
          tickLabel={model.tickLabel}
          timeTicks={model.timeTicks}
          height={120}
          label={`${widget.title}, ${latest.lines.map((l) => `${l.rest} ${l.value}`).join(', ')}`}
          readout={readout}
          selected={selected}
          onPick={setSelected}
          onStep={(d) =>
            setSelected((s) =>
              Math.max(0, Math.min(model.times.length - 1, (s ?? model.times.length - 1) + d * 4)),
            )
          }
        />
      )}
      {widget.problem ? (
        <Text size={12.5} lh={1.4} color={theme.colors.warn}>
          {widget.problem}
        </Text>
      ) : null}
      <Text size={12} lh={1.4} color={theme.colors.mut}>
        {model.footer}
      </Text>
    </View>
  );
}
