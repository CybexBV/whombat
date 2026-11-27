/**
 * A Summary's panels, drawn by kind (contracts 0.88/0.89 `ThingPagePanel`; Whombat dashboards.md DS-05…DS-08,
 * connection-pages.md CP-03, CP-06; dashboards-web.md AP-2050…): figures with a small line of the range or a meter,
 * chart cards, “Worth a look” folding after five, tables whose cells may carry a small bar, a small line or a button,
 * bar lists, lists, facts, a few sentences, what Whombat may do, what it changed and the widgets kept here. The builder
 * (the server for a connection, the client for a server) words every panel; this knows nothing of Home Assistant or
 * Proxmox. A panel with nothing to say is left out (less-is-more.md AP-1752), except “Worth a look”, which says so.
 */

import {
  handleTheseView,
  itemWhen,
  keepHereQuestion,
  LIMIT_WORDS,
  noticeGroups,
  noticeLink,
  OVERVIEW_WORDS,
  quietLineText,
  THING_ACCESS_TIER_WORDS,
  thingItemLink,
} from '@whombat/client';
import { HOST_RANGE_WORDS } from '@whombat/client/hosts';
import {
  type QuietActions,
  type ThingButtons,
  useChanges,
  useTheAgent,
  useWidgets,
} from '@whombat/client/react';
import type {
  HostSeriesRange,
  LookResearch,
  ThingImageShape,
  ThingPageButton,
  ThingPageCell,
  ThingPageColumn,
  ThingPageItem,
  ThingPageKpi,
  ThingPageLink,
  ThingPageNotice,
  ThingPagePanel,
  ThingPanelAsk,
  ThingTone,
} from '@whombat/core';
import { ChevronDown, ChevronRight, ChevronUp, ExternalLink, Info } from 'lucide-react';
import { type CSSProperties, type ReactNode, useId, useState } from 'react';
import type { ContextMenuItem } from '../../../app/shell/ContextMenu';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { DoneList } from '../../home/DoneList';
import { WidgetCard } from '../../home/WidgetCard';
import { AppLink, Card, Dot } from '../parts';
import { NoticeMenu, QuietUndo } from '../quiet/NoticeMenu';
import quietStyles from '../quiet/Quiet.module.css';
import { useThingSearch } from '../search';
import things from '../Things.module.css';
import { NOTICE_ICONS } from '../thingIcons';
import { AskAbout } from './AskAbout';
import { ThingButton, ThingButtonRow } from './Buttons';
import { ChartCard } from './ChartCard';
import { ControlsPanelView } from './Controls';
import { type ChartPanel, seriesColor } from './chartModel';
import styles from './Dashboard.module.css';
import { OpenCharts } from './FigureCharts';
import { splitFigureValue } from './figures';
import { GalleryPanelView, PersonInitial } from './Gallery';
import { NoticeStrip } from './NoticeStrip';
import { Picture } from './Picture';
import service from './Service.module.css';
import { SettingsFoot, SettingsLead, SettingsPanelView } from './Settings';
import slots from './Slots.module.css';
import { Blocks, Meter, Spark } from './Spark';
import { TrendCard } from './TrendCard';

/** What a panel needs beside itself: the thing, the clock, the range, and the page's ways to ask and to change tab. */
export interface DashboardContext {
  burrow: string;
  /** The page's thing: `connection:con_…`, `device:…`, `server:pve-02`. */
  thing: { id: string; name: string; settings: boolean; canManage: boolean };
  timeZone: string;
  now: number;
  /** The range the charts and small lines cover. */
  range: HostSeriesRange;
  /**
   * The ranges the page offers beside the charts a figure opens (AP-2510), and how to pick one; none or one: no picker
   * there.
   */
  ranges?: readonly HostSeriesRange[];
  onRange?: (range: HostSeriesRange) => void;
  /** Opens the Ask pane in a new chat, with this question ready to send (none: an empty box). */
  onAsk: (question?: string) => void;
  onTab: (tab: string) => void;
  /**
   * The page's buttons (contracts 0.121, CT-1001; service-dashboards.md AP-4560): pressing, its question, which run.
   * None (a server's Summary, built here): the page has none.
   */
  buttons?: ThingButtons | null;
  /** When the page was last read (ms; the query's `dataUpdatedAt`): a switch's guess settles on a read after it. */
  readAt?: number;
  /**
   * Ignore, Remind me tomorrow, Stop watching and Undo on its lines (quiet-notices.md AP-4822); none on a Whombat without
   * `things.quiet`: no ⋯ menu, no Undo.
   */
  quiet?: QuietActions | null;
  /** What the assistant is doing about the thing (its research), for Worth a look's one button (handle-it.md). */
  research?: LookResearch | null;
  /**
   * *Ask {assistant} to handle these*: hands everything that needs a look to the assistant (`looks.handle`), with
   * today's question for a Whombat without it. None: the Ask pane opens with the question.
   */
  onHandle?: (question: string) => void;
  /**
   * **Put it back** on a setting's row (service-settings.md SST-03): `changes.undo` of its change, the toast says how it
   * went. None: the row only says who changed it.
   */
  putBack?: (changeId: string) => void;
  /** The change being put back now (its row's link is busy). */
  puttingBack?: string | null;
  /**
   * End now on a line quiet because the thing is kept quiet: `things.endQuiet`. None: the line's
   * Undo ends it.
   */
  endQuiet?: (() => void) | null;
  endingQuiet?: boolean;
  /**
   * A line's “Change the limit” in its ⋯ (a server's check with a limit): the limit now in words and how to open
   * its sheet; null: the line has none.
   */
  limitFor?: ((line: ThingPageNotice) => { now: string; open: () => void } | null) | null;
}

/** A line's own extras in its ⋯ menu: Change the limit with the limit now under it, where its check has one. */
export function lineExtras(n: ThingPageNotice, ctx: DashboardContext): ContextMenuItem[] {
  const limit = ctx.limitFor?.(n);
  return limit ? [{ label: LIMIT_WORDS.menu, description: limit.now, onSelect: limit.open }] : [];
}

type PanelOf<K extends ThingPagePanel['kind']> = Extract<ThingPagePanel, { kind: K }>;

const NO_CHARTS: Readonly<Record<string, ChartPanel[]>> = {};

/** “the last 24 hours”. */
export function rangeWords(range: HostSeriesRange): string {
  return HOST_RANGE_WORDS[range].replace(/^L/, 'the l');
}

export function Panel({
  panel,
  ctx,
  wide = false,
  charts = NO_CHARTS,
  look,
}: {
  panel: ThingPagePanel;
  ctx: DashboardContext;
  wide?: boolean;
  /** The charts each figure opens (`figureCharts`, AP-2510): a figure's key → its charts. */
  charts?: Readonly<Record<string, ChartPanel[]>>;
  /**
   * A service's settings tab (service-settings.md SST-07): its line of words before the cards and its “Something
   * else?” after them are drawn as that tab's.
   */
  look?: 'settings';
}) {
  switch (panel.kind) {
    case 'kpis':
      return <KpisPanel panel={panel} ctx={ctx} charts={charts} />;
    case 'chart':
      // A chart whose points carry their own words (“Thu” … “Today”) is a service's Trend (service-slots.md SLT-06).
      if (panel.labels?.length) return <TrendCard panel={panel} ctx={ctx} />;
      return (
        <ChartCard panel={panel} timeZone={ctx.timeZone} rangeWords={rangeWords(ctx.range)} wide={wide} />
      );
    case 'notices':
      // On top of a service's Summary it is a slim strip (service-slots.md SLT-08).
      return panel.place === 'top' ? (
        <NoticeStrip panel={panel} ctx={ctx} />
      ) : (
        <NoticesPanel panel={panel} ctx={ctx} />
      );
    case 'table':
      return <TablePanel panel={panel} ctx={ctx} />;
    case 'bars':
      return <BarsPanel panel={panel} ctx={ctx} />;
    case 'list':
      return <ListPanel panel={panel} ctx={ctx} />;
    case 'facts':
      return <FactsPanel panel={panel} ctx={ctx} />;
    case 'text':
      if (look === 'settings')
        return panel.title ? (
          <SettingsFoot panel={panel} ctx={ctx} />
        ) : (
          <SettingsLead panel={panel} ctx={ctx} />
        );
      return <TextPanel panel={panel} ctx={ctx} />;
    case 'access':
      return <AccessPanel panel={panel} ctx={ctx} />;
    case 'changes':
      return <ChangesPanel panel={panel} ctx={ctx} />;
    case 'widgets':
      return <WidgetsPanel panel={panel} ctx={ctx} />;
    case 'gallery':
      return <GalleryPanelView panel={panel} ctx={ctx} />;
    case 'controls':
      return <ControlsPanelView panel={panel} ctx={ctx} />;
    case 'settings':
      return <SettingsPanelView panel={panel} ctx={ctx} />;
    default:
      // A kind a newer builder draws: left out.
      return null;
  }
}

/**
 * A panel's head after its title (contracts 0.121 CT-1003; service-dashboards.md AP-4567): its buttons (Pause all,
 * Search for missing, Update lists), its corner link, then its Ask (service-settings.md SST-08).
 */
export function PanelHead({
  panel,
  ctx,
}: {
  panel: {
    title?: string;
    buttons?: readonly ThingPageButton[];
    link?: ThingPageLink;
    ask?: ThingPanelAsk;
  };
  ctx: DashboardContext;
}): ReactNode {
  const link = cornerLink(panel.link, ctx);
  const ask =
    panel.ask?.questions.length && panel.title ? (
      <AskAbout title={panel.title} ask={panel.ask} ctx={ctx} />
    ) : null;
  if (!panel.buttons?.length && !ask) return link ?? null;
  return (
    <div className={service.headTools}>
      <ThingButtonRow items={panel.buttons} buttons={ctx.buttons} />
      {link}
      {ask}
    </div>
  );
}

/* A button or a link the builder worded (“Look into it”, “Show them”, “All guests”, “Open Home Assistant”). */

export function PageLink({
  link,
  ctx,
  className,
  look = 'link',
  name,
}: {
  link: ThingPageLink;
  ctx: Pick<DashboardContext, 'onAsk' | 'onTab'>;
  className?: string;
  /** A text link in a card's corner or a notice, or a small button under a few sentences. */
  look?: 'link' | 'button';
  /** Its name for a screen reader when the label alone is said by several (“Ask Neo about …”). */
  name?: string;
}) {
  if (look === 'button') {
    if (link.kind === 'href')
      return (
        <AppLink href={link.href} className={cx(styles.buttonLink, className)}>
          {link.label}
        </AppLink>
      );
    if (link.kind === 'url')
      return (
        <a href={link.url} target="_blank" rel="noreferrer" className={cx(styles.buttonLink, className)}>
          {link.label}
        </a>
      );
    return (
      <Button
        size="sm"
        className={className}
        onClick={() => (link.kind === 'ask' ? ctx.onAsk(link.question) : ctx.onTab(link.tab))}
      >
        {link.label}
      </Button>
    );
  }
  const cls = cx(styles.link, className);
  switch (link.kind) {
    case 'ask':
      return (
        <button type="button" className={cls} aria-label={name} onClick={() => ctx.onAsk(link.question)}>
          {link.label}
        </button>
      );
    case 'tab':
      return (
        <button type="button" className={cls} onClick={() => ctx.onTab(link.tab)}>
          {link.label}
        </button>
      );
    case 'href':
      return (
        <AppLink href={link.href} className={cls} aria-label={name}>
          {link.label}
        </AppLink>
      );
    case 'url':
      return (
        <a href={link.url} target="_blank" rel="noreferrer" className={cls} aria-label={name}>
          {link.label}
        </a>
      );
  }
}

/** The head of a card with no buttons of its own: only its Ask, when it has one (SST-08). */
function askHead(panel: { title?: string; ask?: ThingPanelAsk }, ctx: DashboardContext): ReactNode {
  return panel.ask ? <PanelHead panel={{ title: panel.title, ask: panel.ask }} ctx={ctx} /> : undefined;
}

/** A card's corner link (“All guests →”). */
function cornerLink(link: ThingPageLink | undefined, ctx: DashboardContext): ReactNode {
  return link ? <PageLink link={link} ctx={ctx} className={things.cardLink} /> : undefined;
}

const TONE_TEXT: Record<ThingTone, string | undefined> = {
  ok: undefined,
  warn: styles.warn,
  bad: styles.bad,
};

/* Figures (DS-07) */

/** A server's four figures, the ones with its Overview card's block bars. */
const SERVER_FIGURES = new Set(['cpu', 'memory', 'storage', 'hottest']);

/** A figure's line colour: a warn or bad tone wins, then its own, then blue. */
function kpiColor(k: ThingPageKpi): string {
  if (k.tone === 'warn') return 'var(--warn)';
  if (k.tone === 'bad') return 'var(--bad)';
  return seriesColor(k.color ?? 'blue');
}

function KpisPanel({
  panel,
  ctx,
  charts,
}: {
  panel: PanelOf<'kpis'>;
  ctx: DashboardContext;
  charts: Readonly<Record<string, ChartPanel[]>>;
}) {
  const over = rangeWords(ctx.range);
  const [search, set] = useThingSearch();
  const uid = useId();
  const regionId = `${uid}-charts`;
  const figureId = (key: string) => `${uid}-fig-${key}`;
  // One figure open at a time, the address keeps which (`?chart=cpu`); a key this card has no charts for opens nothing.
  const openKey =
    search.chart && charts[search.chart] && panel.items.some((k) => k.key === search.chart)
      ? search.chart
      : null;
  const history =
    panel.id === 'figures' && ctx.thing.id.startsWith('server:')
      ? (panel.items.find((k) => charts[k.key]?.length)?.key ?? null)
      : null;
  const close = () => {
    const key = openKey;
    set({ chart: undefined }, { replace: true });
    if (key) document.getElementById(figureId(key))?.focus();
  };
  return (
    <section className={things.card} aria-label="At a glance">
      <div
        className={cx(styles.figs, panel.items.length === 4 && styles.figsFour)}
        style={{ '--figs': panel.items.length } as CSSProperties}
      >
        {panel.items.map((k) => (
          <Figure
            key={k.key}
            k={k}
            id={figureId(k.key)}
            over={over}
            ctx={ctx}
            opens={charts[k.key] ? { open: openKey === k.key, controls: regionId } : null}
            onToggle={() => set({ chart: openKey === k.key ? undefined : k.key }, { replace: true })}
          />
        ))}
      </div>
      {/* A server's figures: their history, the first figure's charts (`?chart=cpu`). */}
      {history && !openKey ? (
        <button
          type="button"
          className={styles.history}
          aria-controls={regionId}
          onClick={() => set({ chart: history }, { replace: true })}
        >
          {OVERVIEW_WORDS.readingHistory}
          <Icon icon={ChevronRight} size={13} />
        </button>
      ) : null}
      <OpenCharts
        id={regionId}
        charts={openKey ? (charts[openKey] ?? null) : null}
        timeZone={ctx.timeZone}
        rangeWords={over}
        range={ctx.range}
        ranges={ctx.ranges ?? []}
        onRange={(r) => ctx.onRange?.(r)}
        onClose={close}
      />
    </section>
  );
}

/**
 * One figure (DS-07; connections-page.md AP-2510, mock `#server-web`): its label with a small chevron, the value in the
 * mono face with its unit small, a line under it, a small line or a meter. A figure with charts is a button that opens
 * them (down, up while open, the open one lifted with its colour under it); a figure with a link leads there (right);
 * any other is words.
 */
function Figure({
  k,
  id,
  over,
  ctx,
  opens,
  onToggle,
}: {
  k: ThingPageKpi;
  id: string;
  over: string;
  ctx: DashboardContext;
  opens: { open: boolean; controls: string } | null;
  onToggle: () => void;
}) {
  const { number, unit } = splitFigureValue(k.value);
  // A server's four figures carry the block bars of its Overview card (overview-server-connection-final.md).
  const blocks = ctx.thing.id.startsWith('server:') && SERVER_FIGURES.has(k.key) && k.meter !== undefined;
  const link = opens ? undefined : k.link;
  const chevron = opens ? (opens.open ? ChevronUp : ChevronDown) : link ? ChevronRight : null;
  const color = kpiColor(k);
  const className = cx(
    styles.fig,
    (opens || link) && styles.figButton,
    opens?.open && styles.figOpen,
    k.tone === 'warn' && styles.figWarn,
    k.tone === 'bad' && styles.figBad,
  );
  // Named by its label and value (“CPU 10 %”), described by the line under it.
  const named = {
    'aria-label': `${k.label} ${k.value}${k.rest ? ` ${k.rest}` : ''}`,
    ...(k.sub ? { 'aria-describedby': `${id}-s` } : {}),
  };
  const body = (
    <>
      <span className={styles.figHead}>
        <span className={things.lbl}>{k.label}</span>
        {chevron ? <Icon icon={chevron} size={13} className={styles.figChevron} /> : null}
      </span>
      <b className={cx(styles.figValue, blocks && styles.figWord)}>
        {number}
        {unit ? <small className={styles.figRest}>{unit}</small> : null}
        {k.rest ? <small className={styles.figRest}> {k.rest}</small> : null}
      </b>
      <span id={`${id}-s`} className={cx(styles.figSub, blocks && styles.figWrap)}>
        {k.sub ?? ' '}
      </span>
      {blocks ? (
        <Blocks share={k.meter as number} warn={k.tone === 'warn' || k.tone === 'bad'} />
      ) : k.spark?.length ? (
        <Spark values={k.spark} color={color} height={26} label={`${k.label} over ${over}`} />
      ) : k.meter !== undefined ? (
        <Meter value={k.meter} color={color} label={k.label} />
      ) : null}
    </>
  );
  const style = { '--fig-color': color } as CSSProperties;
  if (opens)
    return (
      <button
        type="button"
        id={id}
        className={className}
        style={style}
        aria-expanded={opens.open}
        aria-controls={opens.controls}
        onClick={onToggle}
        {...named}
      >
        {body}
      </button>
    );
  if (link?.kind === 'href')
    return (
      <AppLink href={link.href} id={id} className={className} style={style} {...named}>
        {body}
      </AppLink>
    );
  if (link?.kind === 'url')
    return (
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        id={id}
        className={className}
        style={style}
        {...named}
      >
        {body}
      </a>
    );
  if (link)
    return (
      <button
        type="button"
        id={id}
        className={className}
        style={style}
        onClick={() => (link.kind === 'ask' ? ctx.onAsk(link.question) : ctx.onTab(link.tab))}
        {...named}
      >
        {body}
      </button>
    );
  return (
    <div id={id} className={className} style={style}>
      {body}
    </div>
  );
}

/* Worth a look (DS-05): five, the rest folded */

/** How many notices show before “Show N more”. */
export const NOTICES_SHOWN = 5;

const NOTICE_TONES: Record<ThingPageNotice['tone'], { icon: string; words: string }> = {
  bad: { icon: styles.wiBad as string, words: 'Problem: ' },
  warn: { icon: styles.wiWarn as string, words: 'Needs a look: ' },
  info: { icon: styles.wiInfo as string, words: '' },
};

/**
 * Worth a look (DS-05; quiet-notices.md QN-02, QN-10, QN-14; AP-4822…AP-4825, AP-4833): the lines that ask first (the
 * card's count), each with the link its kind keeps (only problems ask), its own button and its ⋯ menu for who may quiet
 * it — at the line's end, or in a card under 420 px on a row of their own under the words, the ⋯ at the right, so the
 * title keeps its width. Two or more such lines get one button that hands them all to the assistant. Heads-ups and quiet
 * lines (greyed, with who quieted them until when and Undo) fold under one row, so routine news doesn't bury what needs
 * the person.
 */
function NoticesPanel({ panel, ctx }: { panel: PanelOf<'notices'>; ctx: DashboardContext }) {
  const [open, setOpen] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const { words } = useTheAgent(ctx.burrow);
  const groups = noticeGroups(panel.items);
  const more = groups.shown.length - NOTICES_SHOWN;
  const shown = open || more <= 0 ? groups.shown : groups.shown.slice(0, NOTICES_SHOWN);
  const all = handleTheseView(groups.asking, ctx.research, ctx.thing.name, words.name);
  const line = (n: ThingPageNotice) => {
    const link = noticeLink(n, words.ask);
    const quiet = quietLineText(n);
    return (
      <div
        key={n.id}
        className={cx(styles.watch, quiet && quietStyles.quietLine)}
        data-notice={n.id}
        data-quiet={quiet ? n.quiet?.state : undefined}
      >
        <span
          className={cx(styles.wi, quiet ? quietStyles.quietIcon : NOTICE_TONES[n.tone].icon)}
          aria-hidden="true"
        >
          <Icon icon={NOTICE_ICONS[n.icon] ?? Info} size={15} />
        </span>
        <div className={styles.watchText}>
          <b>
            {!quiet && NOTICE_TONES[n.tone].words ? (
              <span className={things.srOnly}>{NOTICE_TONES[n.tone].words}</span>
            ) : null}
            {n.title}
          </b>
          {quiet ? <small>{quiet}</small> : n.detail ? <small>{n.detail}</small> : null}
        </div>
        {link || (n.action && !quiet) ? (
          // Its link, button and ⋯ together: at the line's end, or on a row of their own under it in a
          // narrow card (AP-4833).
          <div className={styles.watchActs}>
            {link ? (
              <PageLink
                link={link}
                ctx={ctx}
                {...(link.kind === 'ask' ? { name: `${link.label} about ${n.title}` } : {})}
              />
            ) : null}
            {n.action && !quiet ? <ThingButton button={n.action} buttons={ctx.buttons} /> : null}
            {quiet ? null : (
              <NoticeMenu
                line={n}
                actions={ctx.quiet}
                extra={lineExtras(n, ctx)}
                className={styles.watchEnd}
              />
            )}
          </div>
        ) : quiet ? (
          <QuietUndo line={n} actions={ctx.quiet} onEnd={ctx.endQuiet} ending={ctx.endingQuiet} />
        ) : (
          <NoticeMenu line={n} actions={ctx.quiet} extra={lineExtras(n, ctx)} />
        )}
      </div>
    );
  };
  return (
    <Card
      title={panel.title}
      meta={groups.asking.length ? String(groups.asking.length) : undefined}
      link={askHead(panel, ctx)}
    >
      {!groups.asking.length ? (
        <p className={styles.quiet}>{panel.empty || 'Nothing needs a look.'}</p>
      ) : null}
      {shown.map(line)}
      {more > 0 ? (
        <button type="button" className={styles.more} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show fewer' : `Show ${more} more`}
        </button>
      ) : null}
      {all?.label ? (
        <div className={styles.handleAll}>
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              ctx.onHandle ? ctx.onHandle(all.fallback.question) : ctx.onAsk(all.fallback.question)
            }
          >
            {all.label}
          </Button>
        </div>
      ) : all?.busy ? (
        <p className={cx(styles.handleAll, styles.handleBusy)} role="status">
          <span className={styles.handleSpin} aria-hidden="true" />
          {all.busy}
        </p>
      ) : null}
      {unfolded ? groups.folded.map(line) : null}
      {groups.foldLabel ? (
        <button
          type="button"
          className={styles.more}
          aria-expanded={unfolded}
          onClick={() => setUnfolded((o) => !o)}
        >
          {unfolded ? 'Show fewer' : groups.foldLabel}
        </button>
      ) : null}
    </Card>
  );
}

/* Tables (DS-08): cells with a small bar, a small line or a button */

/**
 * Which columns a narrowing card drops (AP-1754): the first two stay, then a button column, the rest go from the last
 * one back — under 640 px, 520, 420 and 340.
 */
function dropClass(
  index: number,
  columns: readonly ThingPageColumn[],
  buttons: boolean[],
): string | undefined {
  if (index < 2 || buttons[index]) return undefined;
  const rest = columns.map((_, i) => i).filter((i) => i >= 2 && !buttons[i]);
  const fromEnd = rest.length - 1 - rest.indexOf(index);
  return [things.dropM, things.dropS, things.dropXs, things.dropXxs][fromEnd];
}

const CELL_TONES: Record<NonNullable<ThingPageCell['tone']>, string | undefined> = {
  ok: undefined,
  muted: styles.cellMuted,
  warn: styles.warn,
  bad: styles.bad,
};

function Cell({
  cell,
  column,
  ctx,
}: {
  cell: ThingPageCell;
  column: ThingPageColumn;
  ctx: DashboardContext;
}) {
  // A button in the cell (CT-1002): its own label; `text` is the same words for older apps.
  if (cell.action) return <ThingButton button={cell.action} buttons={ctx.buttons} />;
  if (cell.button && cell.href)
    return (
      <AppLink href={cell.href} className={styles.cellButton}>
        {cell.text}
      </AppLink>
    );
  if (cell.spark)
    return (
      <Spark
        values={cell.spark}
        color="var(--chart1)"
        height={24}
        className={styles.cellSpark}
        label={column.label || undefined}
      />
    );
  const words = cell.tag ? <span className={things.gtag}>{cell.text}</span> : cell.text;
  const inner = cell.href ? (
    <AppLink href={cell.href} className={styles.cellLink}>
      {words}
    </AppLink>
  ) : cell.url ? (
    <a href={cell.url} target="_blank" rel="noreferrer" className={styles.cellLink}>
      {words}
    </a>
  ) : (
    words
  );
  const line = cell.dot ? (
    <span className={cx(things.state, cell.mono && styles.cellMono)}>
      <Dot tone={cell.dot === 'off' ? 'mut' : cell.dot} />
      {inner}
    </span>
  ) : (
    inner
  );
  return (
    <>
      {cell.meter !== undefined ? (
        <span className={styles.minibar}>
          <span className={styles.minibarTrack} aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(1, cell.meter)) * 100}%` }} />
          </span>
          {line}
        </span>
      ) : (
        line
      )}
      {cell.note ? <span className={styles.cellNote}>{cell.note}</span> : null}
    </>
  );
}

function TablePanel({ panel, ctx }: { panel: PanelOf<'table'>; ctx: DashboardContext }) {
  if (!panel.rows.length && !panel.empty) return null;
  const buttons = panel.columns.map((c) =>
    panel.rows.some((r) => r.cells[c.key]?.button || r.cells[c.key]?.action),
  );
  const sparks = panel.columns.map((c) => panel.rows.some((r) => r.cells[c.key]?.spark));
  return (
    <Card title={panel.title} meta={panel.meta} link={<PanelHead panel={panel} ctx={ctx} />}>
      {panel.rows.length ? (
        <table className={things.table}>
          <thead>
            <tr>
              {panel.columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cx(dropClass(i, panel.columns, buttons), sparks[i] && styles.sparkCol)}
                >
                  {c.label || <span className={things.srOnly}>{buttons[i] ? 'Open' : c.key}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {panel.rows.map((r) => (
              <tr key={r.id}>
                {panel.columns.map((c, i) => {
                  const cell = r.cells[c.key];
                  return (
                    <td
                      key={c.key}
                      className={cx(
                        dropClass(i, panel.columns, buttons),
                        c.numeric && things.num,
                        cell?.mono && !c.numeric && styles.cellMono,
                        cell?.tone && CELL_TONES[cell.tone],
                        buttons[i] && styles.cellEnd,
                      )}
                      title={i === 0 && cell && !cell.action ? cell.text : undefined}
                    >
                      {cell ? <Cell cell={cell} column={c} ctx={ctx} /> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className={styles.quiet}>{panel.empty}</p>
      )}
    </Card>
  );
}

/* Bar lists (DS-08): storages, disks, pools */

const BAR_TONES: Record<ThingTone, string | undefined> = {
  ok: undefined,
  warn: 'var(--warn)',
  bad: 'var(--bad)',
};

/**
 * A card's meta as its link when the link names it (“thetitan” and “See thetitan”, service-slots.md SLT-07): the
 * meta leads there and the corner link goes, so a narrow card's head stays on one line.
 */
function metaAsLink(
  panel: { meta?: string | undefined; link?: ThingPageLink | undefined },
  ctx: DashboardContext,
): { meta: ReactNode; link: ThingPageLink | undefined } {
  const { meta, link } = panel;
  if (!meta || !link || (link.kind !== 'href' && link.kind !== 'url') || !link.label.includes(meta))
    return { meta, link };
  return {
    meta: <PageLink link={{ ...link, label: meta }} ctx={ctx} className={slots.metaLink} name={link.label} />,
    link: undefined,
  };
}

function BarsPanel({ panel, ctx }: { panel: PanelOf<'bars'>; ctx: DashboardContext }) {
  if (!panel.items.length && !panel.empty) return null;
  const columns = Math.min(panel.columns ?? 1, panel.items.length || 1);
  const head = metaAsLink(panel, ctx);
  // A one-column card in a row of slots (the machine): each line's name over its words, the value and a small meter
  // on the right (service-slots.md SLT-07).
  const compact =
    panel.place === 'chart' && (panel.span ?? 1) === 1 && columns === 1 && !panel.items.some((b) => b.person);
  return (
    <Card
      title={panel.title}
      meta={head.meta}
      link={<PanelHead panel={{ ...panel, link: head.link }} ctx={ctx} />}
    >
      {compact && panel.items.length ? (
        <ul className={slots.mrows}>
          {panel.items.map((b) => (
            <li key={b.id} className={slots.mrow}>
              <div className={slots.mwords}>
                {b.href ? (
                  <AppLink href={b.href} className={styles.barLink}>
                    <b>{b.label}</b>
                  </AppLink>
                ) : (
                  <b>{b.label}</b>
                )}
                {b.note ? <small>{b.note}</small> : null}
                {b.sub ? (
                  <small className={b.subTone ? TONE_TEXT[b.subTone] : undefined}>{b.sub}</small>
                ) : null}
              </div>
              <div className={slots.mstat}>
                {b.value ? <span className={b.tone ? TONE_TEXT[b.tone] : undefined}>{b.value}</span> : null}
                {b.pct != null ? (
                  <Meter
                    value={b.pct}
                    color={(b.tone && BAR_TONES[b.tone]) || 'var(--ok)'}
                    label={b.label}
                    className={slots.mmeter}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : panel.items.length ? (
        <ul
          className={cx(styles.bars, columns > 1 && styles.barsCols)}
          style={columns > 1 ? ({ '--bar-cols': columns } as CSSProperties) : undefined}
        >
          {panel.items.map((b) => {
            const label = <b className={cx(styles.barLabel, b.mono && styles.barLabelMono)}>{b.label}</b>;
            // Who uses it, by name with their initial (service-slots.md SLT-05).
            if (b.person) return <PersonBar key={b.id} bar={b} />;
            return (
              <li key={b.id} className={styles.bar}>
                <div className={styles.barTop}>
                  {b.href ? (
                    <AppLink href={b.href} className={styles.barLink}>
                      {label}
                    </AppLink>
                  ) : (
                    label
                  )}
                  {b.note ? <span className={styles.barNote}>{b.note}</span> : null}
                  {b.value ? <span className={styles.barValue}>{b.value}</span> : null}
                </div>
                {b.pct != null ? (
                  <Meter
                    value={b.pct}
                    color={(b.tone && BAR_TONES[b.tone]) || 'var(--chart1)'}
                    label={b.label}
                    className={styles.barTrack}
                  />
                ) : null}
                {b.sub ? (
                  <p className={cx(styles.barSub, b.subTone && TONE_TEXT[b.subTone])}>{b.sub}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.quiet}>{panel.empty}</p>
      )}
    </Card>
  );
}

/** A person's line of a bar list: their initial, name and note, the value on the right, a thin bar under the words. */
function PersonBar({ bar }: { bar: PanelOf<'bars'>['items'][number] }) {
  return (
    <li className={slots.person}>
      <PersonInitial name={bar.label} size={30} />
      <div className={slots.personWords}>
        {bar.href ? (
          <AppLink href={bar.href} className={styles.barLink}>
            <b>{bar.label}</b>
          </AppLink>
        ) : (
          <b>{bar.label}</b>
        )}
        {bar.note ? <small>{bar.note}</small> : null}
      </div>
      {bar.value ? <span className={slots.personValue}>{bar.value}</span> : <span />}
      {bar.pct != null ? (
        <Meter
          value={bar.pct}
          color={(bar.tone && BAR_TONES[bar.tone]) || 'color-mix(in srgb, var(--chart1) 60%, var(--sf))'}
          label={bar.label}
          className={slots.personBar}
        />
      ) : null}
      {bar.sub ? (
        <p className={cx(slots.personSub, bar.subTone && TONE_TEXT[bar.subTone])}>{bar.sub}</p>
      ) : null}
    </li>
  );
}

/* Lists: a dot of its tone, or its icon */

const ITEM_DOTS: Record<NonNullable<ThingPageItem['tone']>, 'ok' | 'warn' | 'bad' | 'mut'> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  info: 'mut',
};

const ITEM_WORDS: Record<NonNullable<ThingPageItem['tone']>, string> = {
  ok: 'Fine',
  warn: 'Needs a look',
  bad: 'Problem',
  info: 'Note',
};

/** A list line's picture: small, its shape's width. */
const LINE_PICTURES: Record<ThingImageShape, string | undefined> = {
  poster: service.linePicPoster,
  square: service.linePicSquare,
  wide: service.linePicWide,
};

const ITEM_ICON_TONES: Record<NonNullable<ThingPageItem['tone']>, string | undefined> = {
  ok: styles.toneOk,
  warn: styles.warn,
  bad: styles.bad,
  info: styles.cellMuted,
};

function ListPanel({ panel, ctx }: { panel: PanelOf<'list'>; ctx: DashboardContext }) {
  if (!panel.items.length && !panel.empty) return null;
  if (panel.look === 'counts') return <CountsPanel panel={panel} ctx={ctx} />;
  return (
    <Card title={panel.title} meta={panel.meta} link={<PanelHead panel={panel} ctx={ctx} />}>
      {panel.items.length ? (
        <ul className={styles.lines}>
          {panel.items.map((item) => {
            const tone = item.tone ?? 'info';
            const end = item.right ?? (item.at ? itemWhen(item.at, ctx.now, ctx.timeZone) : null);
            // The service's own page for the line (CT-1013): its title opens it in a new tab.
            const link = thingItemLink({ url: item.url });
            return (
              <li
                key={item.id}
                className={cx(
                  styles.line,
                  item.image && service.lineWithPic,
                  !!item.actions?.length && service.lineWithActs,
                )}
              >
                {item.image ? (
                  // A small picture instead of the icon (CT-1002): a poster, a thumbnail.
                  <Picture
                    burrow={ctx.burrow}
                    thing={ctx.thing.id}
                    image={item.image}
                    shape={item.image.shape}
                    title={item.title}
                    className={LINE_PICTURES[item.image.shape]}
                  />
                ) : item.icon ? (
                  <span
                    className={cx(styles.lineIcon, ITEM_ICON_TONES[tone])}
                    role="img"
                    aria-label={ITEM_WORDS[tone]}
                  >
                    <Icon icon={NOTICE_ICONS[item.icon] ?? Info} size={15} />
                  </span>
                ) : (
                  <span className={styles.lineDot}>
                    <Dot tone={ITEM_DOTS[tone]} label={ITEM_WORDS[tone]} />
                  </span>
                )}
                <div className={styles.lineText}>
                  {link?.kind === 'url' ? (
                    <b>
                      <a href={link.url} target="_blank" rel="noreferrer" className={service.lineLink}>
                        {item.title}
                        <Icon icon={ExternalLink} size={12} className={service.lineOut} />
                      </a>
                    </b>
                  ) : (
                    <b>{item.title}</b>
                  )}
                  {item.detail ? <small>{item.detail}</small> : null}
                </div>
                {item.figure?.note &&
                (item.figure.tone === 'warn' || item.figure.tone === 'bad') &&
                !item.at &&
                !item.right ? (
                  // A count that shows a problem has it under it (“44 of 45” over “1 offline”), in its tone, said once
                  // (servers-connections-places.md); other notes repeat the line's words, so they stay out. A line
                  // with a time or its own end keeps it.
                  <span className={cx(styles.lineEnd, styles.lineFigure)}>
                    <span className={FIGURE_TONES[item.figure.tone]}>{item.figure.value}</span>
                    <small className={FIGURE_TONES[item.figure.tone]}>{item.figure.note}</small>
                  </span>
                ) : end ? (
                  item.at && !item.right ? (
                    <time className={styles.lineEnd} dateTime={item.at}>
                      {end}
                    </time>
                  ) : (
                    <span className={styles.lineEnd}>{end}</span>
                  )
                ) : null}
                <ThingButtonRow
                  items={item.actions}
                  buttons={ctx.buttons}
                  className={service.lineActs}
                  label={item.title}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.quiet}>{panel.empty}</p>
      )}
    </Card>
  );
}

/** The colour of what changed under a count (“+9 this week”): its tone's, quiet without one. */
const FIGURE_TONES: Record<ThingTone, string | undefined> = {
  ok: slots.figureOk,
  warn: styles.warn,
  bad: styles.bad,
};

/**
 * A list of counts (service-slots.md SLT-03; mock's Libraries): each line its icon on a tile, its title and detail, its
 * count large on the right with what changed under it, then its button as a glyph (Scan), named by its label.
 */
function CountsPanel({ panel, ctx }: { panel: PanelOf<'list'>; ctx: DashboardContext }) {
  return (
    <Card title={panel.title} meta={panel.meta} link={<PanelHead panel={panel} ctx={ctx} />}>
      {panel.items.length ? (
        <ul className={slots.counts}>
          {panel.items.map((item) => {
            const link = thingItemLink({ url: item.url });
            const figure = item.figure ?? (item.right ? { value: item.right } : null);
            return (
              <li key={item.id} className={slots.count} data-item={item.id}>
                <span className={slots.countTile} aria-hidden="true">
                  <Icon icon={(item.icon && NOTICE_ICONS[item.icon]) || Info} size={18} />
                </span>
                <div className={slots.countWords}>
                  <b>
                    {link?.kind === 'url' ? (
                      <a href={link.url} target="_blank" rel="noreferrer" className={service.lineLink}>
                        {item.title}
                      </a>
                    ) : (
                      item.title
                    )}
                  </b>
                  {item.detail ? (
                    <small
                      className={item.tone ? TONE_TEXT[item.tone === 'info' ? 'ok' : item.tone] : undefined}
                    >
                      {item.detail}
                    </small>
                  ) : null}
                </div>
                {figure ? (
                  <div className={slots.countFigure}>
                    <b>{figure.value}</b>
                    {'note' in figure && figure.note ? (
                      <small className={figure.tone ? FIGURE_TONES[figure.tone] : undefined}>
                        {figure.note}
                      </small>
                    ) : null}
                  </div>
                ) : (
                  <span />
                )}
                <ThingButtonRow
                  items={item.actions}
                  buttons={ctx.buttons}
                  className={slots.countActs}
                  label={item.title}
                  look="icon"
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.quiet}>{panel.empty}</p>
      )}
    </Card>
  );
}

/* Facts and sentences */

function FactsPanel({ panel, ctx }: { panel: PanelOf<'facts'>; ctx: DashboardContext }) {
  if (!panel.items.length) return null;
  return (
    <Card title={panel.title} link={askHead(panel, ctx)}>
      <dl className={styles.facts}>
        {panel.items.map((f) => (
          <div key={f.label}>
            <dt className={things.lbl}>{f.label}</dt>
            <dd className={f.mono ? styles.mono : undefined}>{f.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/**
 * A few sentences: a card with its title, or — without one — a note of one line with its way out on the right
 * (hetzner.png's “Hetzner can’t see memory or disk space … Add as a server”).
 */
function TextPanel({ panel, ctx }: { panel: PanelOf<'text'>; ctx: DashboardContext }) {
  if (!panel.title)
    return (
      <section className={cx(things.card, styles.note)} aria-label={panel.body.split(/[.!?]/)[0]}>
        <span className={styles.noteIcon} aria-hidden="true">
          <Icon icon={Info} size={16} />
        </span>
        <div className={styles.noteText}>
          {panel.body.split(/\n\s*\n/).map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        {panel.link ? <PageLink link={panel.link} ctx={ctx} look="button" /> : null}
      </section>
    );
  return (
    <Card title={panel.title} link={askHead(panel, ctx)}>
      <div className={styles.text}>
        {panel.body.split(/\n\s*\n/).map((p) => (
          <p key={p}>{p}</p>
        ))}
        {panel.link ? (
          <div className={styles.textActs}>
            <PageLink link={panel.link} ctx={ctx} look="button" />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/* What Whombat may do */

function AccessPanel({ panel, ctx }: { panel: PanelOf<'access'>; ctx: DashboardContext }) {
  const { words } = useTheAgent(ctx.burrow);
  if (!panel.items.length && !panel.lookOnly) return null;
  const change = ctx.thing.settings && ctx.thing.canManage;
  return (
    <Card
      title={panel.title}
      link={
        change ? (
          <button type="button" className={things.cardLink} onClick={() => ctx.onTab('settings')}>
            Change in Connection
          </button>
        ) : undefined
      }
    >
      {panel.items.length ? (
        <ul className={styles.tools}>
          {panel.items.map((a) => (
            <li key={a.label} className={styles.tool} title={a.count === 1 ? '1 tool' : `${a.count} tools`}>
              {a.label}
              <span className={styles.tier}>{THING_ACCESS_TIER_WORDS[a.tier]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {panel.lookOnly ? (
        <p className={styles.toolNote}>
          Look only: {words.Name} reads {ctx.thing.name} and changes nothing there.
        </p>
      ) : null}
    </Card>
  );
}

/* What Whombat changed here */

function ChangesPanel({ panel, ctx }: { panel: PanelOf<'changes'>; ctx: DashboardContext }) {
  const { data } = useChanges({
    params: { burrow: ctx.burrow },
    query: { thing: ctx.thing.id, limit: panel.limit },
  });
  // Nothing changed here yet: left out (AP-1752); the Activity tab says so.
  if (!data?.changes.length) return null;
  return (
    <Card
      title={panel.title}
      link={
        <button type="button" className={things.cardLink} onClick={() => ctx.onTab('activity')}>
          Activity
        </button>
      }
    >
      <DoneList
        burrow={ctx.burrow}
        changes={data.changes}
        now={ctx.now}
        timeZone={ctx.timeZone}
        empty="Nothing yet."
        here={`/things/${encodeURIComponent(ctx.thing.id)}`}
      />
    </Card>
  );
}

/* Show more here */

function WidgetsPanel({ panel, ctx }: { panel: PanelOf<'widgets'>; ctx: DashboardContext }) {
  const { words } = useTheAgent(ctx.burrow);
  const { data } = useWidgets({ params: { burrow: ctx.burrow }, query: { thing: ctx.thing.id } });
  const widgets = data?.widgets ?? [];
  if (!widgets.length && !panel.suggestions.length) return null;
  const suggest: ReactNode = (
    <Card title={panel.title}>
      <p className={styles.lead}>
        Ask {words.Name} to keep figures from {ctx.thing.name} on this page. They refresh by themselves,
        without asking the AI each time.
      </p>
      <div className={styles.chips}>
        {panel.suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className={styles.chip}
            onClick={() => ctx.onAsk(keepHereQuestion(s, ctx.thing.name))}
          >
            {s}
          </button>
        ))}
        <button type="button" className={styles.chip} onClick={() => ctx.onAsk()}>
          Something else…
        </button>
      </div>
    </Card>
  );
  if (!widgets.length) return suggest;
  return (
    <div className={styles.widgets}>
      {widgets.map((w, i) => (
        <WidgetCard
          key={w.id}
          burrow={ctx.burrow}
          widget={w}
          index={i}
          count={widgets.length}
          timeZone={ctx.timeZone}
          thing={ctx.thing.id}
        />
      ))}
      {suggest}
    </div>
  );
}
