/**
 * The editor's side panel (the mockups' `editor.html`): *Add a widget* — search, *Didn’t fit*, the sections that fold
 * (DK-155: Whombat's own and *Servers* folded at first, each server inside it, each connection or device, *Your
 * accounts* with each account open inside it, the assistant's Home widgets), a thing's whole list read when asked, a widget's live preview after half a second on it
 * (DK-156), drag one in or *+* — or, with a widget chosen, its settings (DK-144): a preview at its size, what it shows
 * (a server, which part of it and its chart's range, a connection and its panel), *On a locked screen* where it shows
 * something private,
 * *What’s going on*'s choices and *Servers*' order (the screen's own, saved as they're chosen), its size, what touching
 * it does, and *Remove from this page*.
 */
import { isBrandMark } from '@whombat/brand';
import { BrandMark } from '@whombat/brand/react';
import {
  CATALOG_FOLDED_AT_FIRST,
  catalogFind,
  catalogItemKey,
  catalogName,
  catalogSections,
  catalogServers,
  DESK_SCREENS_TEXT,
  DESK_WIDGET_RANGES,
  DESK_WORDS,
  type DeskApi,
  type DeskCalm,
  type DeskCatalog,
  type DeskCatalogGroup,
  type DeskCatalogItem,
  type DeskImage,
  type DeskScreen,
  type DeskScreenDetail,
  type DeskShowLevel,
  type DeskShowPatch,
  type DeskWidget,
  type DeskWidgetView,
  deskShowLevel,
  fillDeskWords,
  gridText,
  isAccountGroup,
  type NewWidget,
  ownWidgetName,
  sameWidget,
  screensErrorText,
  sectionCount,
  serverParts,
  type ViewOf,
  widgetSize,
} from '@whombat/client/desk';
import {
  useDeskScreen,
  useDeskScreenActions,
  useDeskScreenViews,
  useDeskWidgets,
} from '@whombat/client/desk/react';
import { cellRect, type Grid, screenGrid, serverShow, sizeOf, type WidgetSize } from '@whombat/screen';
import { WidgetPreview } from '@whombat/screen/react';
import {
  Activity,
  Boxes,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Columns2,
  Cpu,
  GitPullRequest,
  GripVertical,
  HardDrive,
  LayoutGrid,
  type LucideIcon,
  Mail,
  MemoryStick,
  Network,
  Plug,
  Plus,
  Rows3,
  Server,
  Sparkles,
  Thermometer,
  TriangleAlert,
} from 'lucide-react';
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { useToast } from '../../../components/Toast';
import { GroupLabel, LevelRow, OptionMark, ServerRows } from '../../desk/ShowsPart';
import e from './Editor.module.css';
import type { ScreenEditor } from './useScreenEditor';

const E = DESK_SCREENS_TEXT.editor;
const W = DESK_WORDS.settings;

/** Something to put on the page: the widget, its name for the words, its view kind and sizes, the size it had. */
export interface CatalogPick {
  widget: NewWidget;
  name: string;
  view?: string;
  size: WidgetSize;
  want?: { w: number; h: number };
}

const OWN_ICONS: Record<string, LucideIcon> = {
  clock: Clock,
  status: Activity,
  now: Columns2,
  strip: Rows3,
  work: Sparkles,
  coming: CalendarClock,
  done: CalendarCheck,
};

/** A widget's name in the editor: Whombat's own by the contract's words, the rest by the catalogue or its view. */
export function widgetName(
  w: Pick<DeskWidget, 'type' | 'ref' | 'opts'>,
  view: DeskWidgetView | undefined,
  catalog: DeskCatalog | undefined,
  assistant: string,
): string {
  const own = ownWidgetName(w.type, assistant);
  if (own) return own;
  const found = catalogFind(catalog, w);
  if (found) return catalogName(found.group, found.item);
  if (view?.name && view.name !== view.title) return `${view.name} · ${view.title}`;
  return view?.title ?? w.ref?.slice(w.ref.indexOf(':') + 1) ?? 'Widget';
}

/** A server's parts by a line icon of their own: under the server's name its mark would only repeat. */
const PART_ICONS: Record<string, LucideIcon> = {
  cpu: Cpu,
  memory: MemoryStick,
  network: Network,
  storage: HardDrive,
  guests: Boxes,
  temp: Thermometer,
  alerts: TriangleAlert,
};

/**
 * What an account's widget shows, by its panel's id and name: its calendar, its mail, its pull requests. Under the
 * account's own heading its mark would only repeat, as a server's does.
 */
export function accountIcon(item: Pick<DeskCatalogItem, 'name' | 'opts'>): LucideIcon | undefined {
  const words = `${item.opts.panel ?? ''} ${item.name}`.toLowerCase();
  if (/pull|review/.test(words)) return GitPullRequest;
  if (/mail|inbox|unread/.test(words)) return Mail;
  if (/calendar|today|meeting|agenda|event/.test(words)) return CalendarDays;
  return undefined;
}

/** A widget's mark: a server part's or an account widget's icon, the brand's where there is one, else a line icon. */
function WidgetMark({
  mark,
  type,
  part,
  icon: own,
}: {
  mark?: string | undefined;
  type: string;
  part?: string | undefined;
  icon?: LucideIcon | undefined;
}) {
  const partIcon = own ?? (part ? PART_ICONS[part] : undefined);
  if (partIcon) return <Icon icon={partIcon} size={16} />;
  if (mark && isBrandMark(mark)) return <BrandMark mark={mark} size={18} />;
  const icon = OWN_ICONS[type] ?? (type === 'server' ? Server : type === 'widget' ? LayoutGrid : Plug);
  return <Icon icon={icon} size={16} />;
}

const pickOf = (group: DeskCatalogGroup, item: DeskCatalogItem): CatalogPick => ({
  widget: {
    type: item.type,
    ...(item.ref ? { ref: item.ref } : {}),
    opts: item.opts,
    ...(item.view ? { view: item.view } : {}),
  },
  name: catalogName(group, item),
  ...(item.view ? { view: item.view } : {}),
  size: sizeOf(item, item.view),
});

export interface WidgetPanelProps {
  api: DeskApi;
  screen: DeskScreenDetail;
  desk: DeskScreen | undefined;
  catalog: DeskCatalog | undefined;
  ed: ScreenEditor;
  views: ReadonlyMap<string, DeskWidgetView>;
  calm: DeskCalm | null;
  assistant: string;
  timeZone: string;
  now: number;
  loadImage: ((image: DeskImage) => Promise<string>) | undefined;
  /** The screen's size: the preview draws the widget on its grid. */
  shape: { width: number; height: number };
  viewOf: ViewOf;
  onPickDown: (event: ReactPointerEvent, pick: CatalogPick) => void;
  onAdd: (pick: CatalogPick) => void;
  say: (text: string | null) => void;
  nameOf: (w: Pick<DeskWidget, 'id' | 'type' | 'ref' | 'opts'>) => string;
}

export function WidgetPanel(props: WidgetPanelProps) {
  const chosen = props.ed.widgets.find((w) => w.id === props.ed.state.selected);
  return (
    <aside className={e.panel} aria-label={chosen ? props.nameOf(chosen) : E.addWidget}>
      {chosen ? <ChosenPanel {...props} widget={chosen} /> : <AddPanel {...props} />}
    </aside>
  );
}

/* Add a widget ----------------------------------------------------------------------------------------------------- */

/** How long the pointer (or the keyboard) rests on a widget before its preview shows (DK-156). */
const PEEK_MS = 500;

/** A widget whose preview shows, the row it shows beside and the page it stays on. */
interface Peek {
  pick: CatalogPick;
  row: DOMRect;
  area: PeekArea;
}

/** A rectangle on the window: a row, the page's room. */
export interface PeekArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const matchesQuery = (query: string, ...words: (string | undefined)[]) =>
  !query || words.join(' ').toLowerCase().includes(query);

function AddPanel(props: WidgetPanelProps) {
  const { api, screen, catalog, ed, assistant, onPickDown, onAdd, views } = props;
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  // What the person folded or opened; the rest as it starts (DK-155). A search shows everything that matches.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const isOpen = (key: string, atFirst: boolean) => query !== '' || (folds[key] ?? atFirst);
  const toggle = (key: string, atFirst: boolean) => setFolds((f) => ({ ...f, [key]: !(f[key] ?? atFirst) }));
  const [peek, setPeek] = useState<Peek | null>(null);
  const onPage = (item: DeskCatalogItem) => ed.widgets.some((w) => sameWidget(w, item));
  const tray = ed.tray.map((w) => {
    const found = catalogFind(catalog, w);
    const view = views.get(w.id)?.kind ?? found?.item.view;
    const pick: CatalogPick = {
      widget: { id: w.id, type: w.type, ...(w.ref ? { ref: w.ref } : {}), opts: w.opts },
      name: widgetName(w, views.get(w.id), catalog, assistant),
      ...(view ? { view } : {}),
      size: sizeOf(w, view),
      want: { w: w.w, h: w.h },
    };
    return { key: w.id, pick, mark: found?.item.mark ?? views.get(w.id)?.mark, line: found?.item.line ?? '' };
  });
  // Each section with the items the search leaves; a thing listed partly keeps its row to read the rest.
  const sections = catalogSections(catalog)
    .map((section) => {
      const groups = section.groups
        .map((g) => ({
          group: g,
          items: g.items.filter((i) => matchesQuery(query, i.name, i.line, g.label, section.label)),
        }))
        .filter((g) => g.items.length > 0 || (g.group.partial && !query));
      return { section, groups };
    })
    .filter((x) => x.groups.length > 0);
  const row = (group: DeskCatalogGroup, item: DeskCatalogItem) => (
    <CatalogRow
      key={catalogItemKey(item)}
      pick={pickOf(group, item)}
      label={item.name}
      mark={item.mark}
      icon={isAccountGroup(group) ? accountIcon(item) : undefined}
      line={item.line}
      here={onPage(item)}
      onPickDown={onPickDown}
      onAdd={onAdd}
      onPeek={setPeek}
    />
  );
  return (
    <>
      <h2 className={e.panelTitle}>{E.addWidget}</h2>
      <input
        className={e.search}
        type="search"
        placeholder={E.search}
        aria-label={E.search}
        value={q}
        onChange={(ev) => setQ(ev.target.value)}
      />
      {tray.length > 0 ? (
        <section className={cx(e.group, e.tray)} aria-label={E.didntFit}>
          <h3 className={e.groupLabel}>{E.didntFit}</h3>
          {tray.map((t) => (
            <CatalogRow
              key={t.key}
              pick={t.pick}
              mark={t.mark}
              line={t.line}
              here={false}
              onPickDown={onPickDown}
              onAdd={onAdd}
              onPeek={setPeek}
            />
          ))}
        </section>
      ) : null}
      {sections.map(({ section, groups }) => {
        const atFirst = !CATALOG_FOLDED_AT_FIRST.has(section.kind);
        const open = isOpen(section.key, atFirst);
        return (
          <section key={section.key} className={e.section} aria-label={section.label}>
            <Fold
              label={section.label}
              count={query ? groups.reduce((n, g) => n + g.items.length, 0) : sectionCount(section)}
              open={open}
              onToggle={() => toggle(section.key, atFirst)}
              controls={`fold-${section.key}`}
            />
            {open ? (
              <div id={`fold-${section.key}`}>
                {section.kind === 'servers' || section.kind === 'accounts'
                  ? groups.map(({ group, items }) => {
                      // A fleet's servers start folded; a person's few accounts open (AP-6110).
                      const groupAtFirst = section.kind === 'accounts';
                      const serverOpen = isOpen(group.key, groupAtFirst);
                      return (
                        <div key={group.key} className={e.server}>
                          <GroupFold
                            group={group}
                            type={section.kind === 'servers' ? 'server' : 'panel'}
                            count={items.length}
                            open={serverOpen}
                            onToggle={() => toggle(group.key, groupAtFirst)}
                            controls={`fold-${group.key}`}
                          />
                          {serverOpen ? (
                            <div id={`fold-${group.key}`} className={e.serverItems}>
                              {items.map((item) => row(group, item))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  : groups.map(({ group, items }) =>
                      group.partial ? (
                        <ThingRows
                          key={group.key}
                          api={api}
                          screen={screen.id}
                          group={group}
                          items={items}
                          query={query}
                          row={row}
                        />
                      ) : (
                        items.map((item) => row(group, item))
                      ),
                    )}
              </div>
            ) : null}
          </section>
        );
      })}
      {query && sections.length === 0 && tray.length === 0 ? (
        <p className={e.noMatch}>{fillDeskWords(E.noMatch, { q })}</p>
      ) : null}
      <p className={e.ask}>{fillDeskWords(E.ask, { assistant: assistant })}</p>
      {peek ? <PeekPreview {...props} peek={peek} onClose={() => setPeek(null)} /> : null}
    </>
  );
}

/** A section's heading: a button that folds it (DK-155), with how many widgets it has. */
function Fold({
  label,
  count,
  open,
  onToggle,
  controls,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  return (
    <h3 className={e.foldHead}>
      <button
        type="button"
        className={e.fold}
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        <span className={e.foldChevron} aria-hidden="true">
          <Icon icon={ChevronRight} size={13} />
        </span>
        <span className={e.foldLabel}>{label}</span>
        <span className={e.foldCount}>{count}</span>
      </button>
    </h3>
  );
}

/** A server under *Servers*, or an account under *Your accounts*: its mark and name, folding its widgets. */
function GroupFold({
  group,
  type,
  count,
  open,
  onToggle,
  controls,
}: {
  group: DeskCatalogGroup;
  type: 'server' | 'panel';
  count: number;
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  return (
    <button
      type="button"
      className={e.serverFold}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <span className={e.foldChevron} aria-hidden="true">
        <Icon icon={ChevronRight} size={13} />
      </span>
      <span className={e.tile}>
        <WidgetMark mark={group.mark} type={type} />
      </span>
      <span className={e.serverName}>{group.label}</span>
      <span className={e.foldCount}>{count}</span>
    </button>
  );
}

/** A thing whose page wasn't read in time: its figures, and its widgets once asked for (`desk.widgets {thing}`). */
function ThingRows({
  api,
  screen,
  group,
  items,
  query,
  row,
}: {
  api: DeskApi;
  screen: string;
  group: DeskCatalogGroup;
  items: DeskCatalogItem[];
  query: string;
  row: (group: DeskCatalogGroup, item: DeskCatalogItem) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const whole = useDeskWidgets(api, open && group.thing ? { screen, thing: group.thing } : null);
  const full = whole.data?.groups[0];
  const shown = (full?.items ?? items).filter((i) => matchesQuery(query, i.name, i.line, group.label));
  return (
    <>
      {shown.map((item) => row(full ?? group, item))}
      {!full ? (
        <button type="button" className={e.more} onClick={() => setOpen(true)} disabled={open}>
          {open ? E.loadingMore : E.more}
        </button>
      ) : null}
    </>
  );
}

function CatalogRow({
  pick,
  label,
  mark,
  icon,
  line,
  here,
  onPickDown,
  onAdd,
  onPeek,
}: {
  pick: CatalogPick;
  /** Its name under its heading (“Storage” under pve-01); `pick.name` says what it belongs to too. */
  label?: string;
  mark: string | undefined;
  /** A line icon of its own (an account's calendar, mail, pull requests). */
  icon?: LucideIcon | undefined;
  line: string;
  here: boolean;
  onPickDown: WidgetPanelProps['onPickDown'];
  onAdd: WidgetPanelProps['onAdd'];
  onPeek: (peek: Peek | null) => void;
}) {
  const def = pick.want ?? { w: pick.size.def[0], h: pick.size.def[1] };
  const ref = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Resting on it for half a second shows its preview (DK-156); leaving, pressing or dragging takes it away.
  const rest = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = ref.current;
      if (el) onPeek({ pick, row: el.getBoundingClientRect(), area: pageArea(el) });
    }, PEEK_MS);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    onPeek(null);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    // Dragging is the pointer's way in; + is everyone's (the keyboard's too).
    <div
      ref={ref}
      className={e.item}
      onPointerEnter={(ev) => {
        if (ev.pointerType === 'mouse') rest();
      }}
      onPointerLeave={leave}
      onPointerDown={(ev) => {
        leave();
        if ((ev.target as HTMLElement).closest('button')) return;
        onPickDown(ev, pick);
      }}
    >
      <span className={e.grip} aria-hidden="true">
        <Icon icon={GripVertical} size={14} />
      </span>
      <span className={e.tile}>
        <WidgetMark
          mark={mark}
          type={pick.widget.type}
          part={pick.widget.type === 'server' ? pick.widget.opts?.show : undefined}
          icon={icon}
        />
      </span>
      <span className={e.itemText}>
        <span className={e.itemName}>
          <span className={e.itemNameText}>{label ?? pick.name}</span>
          {here ? <span className={e.tag}>{E.onThisPage}</span> : null}
        </span>
        {line ? <span className={e.itemLine}>{line}</span> : null}
      </span>
      <span className={e.size}>{`${def.w}×${def.h}`}</span>
      <button
        type="button"
        className={e.add}
        aria-label={fillDeskWords(E.addOne, { name: pick.name })}
        onClick={() => {
          leave();
          onAdd(pick);
        }}
        onFocus={(ev) => {
          if (focusVisible(ev.target)) rest();
        }}
        onBlur={leave}
        onKeyDown={(ev) => {
          if (ev.key === 'Escape') leave();
        }}
      >
        <Icon icon={Plus} size={16} />
      </button>
    </div>
  );
}

/** Whether the keyboard brought focus here (a click's focus shows no preview); a browser that can't tell: yes. */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** The preview's room: at most this wide and high, this far from the row and from the page's edges. */
const PEEK_MAX = { width: 380, height: 250 };
const PEEK_GAP = 14;
const PEEK_EDGE = 8;

/** The page's room on the window: the app's content beside the sidebar, else the window. */
function pageArea(el: Element): PeekArea {
  const win = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const page = el.closest('main')?.getBoundingClientRect();
  if (!page || page.width <= 0) return win;
  return {
    left: Math.max(win.left, page.left),
    top: Math.max(win.top, page.top),
    right: Math.min(win.right, page.right),
    bottom: Math.min(win.bottom, page.bottom),
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Where a preview of `box`'s size goes for `row`, always on the page (`area`): to the row's left where it fits (the
 * panel beside the screen), else its right, else under the row or over it (the panel under the screen on a narrow
 * window), lined up with the row and kept inside the page.
 */
export function peekPlace(
  row: PeekArea,
  box: { width: number; height: number },
  area: PeekArea,
): { left: number; top: number } {
  const lo = { x: area.left + PEEK_EDGE, y: area.top + PEEK_EDGE };
  const hi = { x: area.right - PEEK_EDGE - box.width, y: area.bottom - PEEK_EDGE - box.height };
  const beside = (left: number) => ({
    left,
    top: clamp((row.top + row.bottom) / 2 - box.height / 2, lo.y, Math.max(lo.y, hi.y)),
  });
  if (row.left - PEEK_GAP - box.width >= lo.x) return beside(row.left - PEEK_GAP - box.width);
  if (row.right + PEEK_GAP <= hi.x) return beside(row.right + PEEK_GAP);
  const left = clamp(row.right - box.width, lo.x, Math.max(lo.x, hi.x));
  const below = row.bottom + PEEK_GAP;
  const above = row.top - PEEK_GAP - box.height;
  if (below <= hi.y) return { left, top: below };
  if (above >= lo.y) return { left, top: above };
  // Neither fits whole: the side with more room, kept on the page.
  const top = area.bottom - row.bottom >= row.top - area.top ? below : above;
  return { left, top: clamp(top, lo.y, Math.max(lo.y, hi.y)) };
}

/**
 * A widget's preview beside its row (DK-156): drawn live at the size it starts at, with what it shows now
 * (`desk.screen.views` for it alone), always on the page (`peekPlace`). Escape closes it.
 */
function PeekPreview({
  api,
  screen,
  calm,
  assistant,
  timeZone,
  now,
  loadImage,
  shape,
  peek,
  onClose,
}: WidgetPanelProps & { peek: Peek; onClose: () => void }) {
  const { pick, row, area } = peek;
  const spec = useMemo(
    () => ({
      id: 'w_peek',
      type: pick.widget.type,
      ...(pick.widget.ref ? { ref: pick.widget.ref } : {}),
      opts: pick.widget.opts ?? {},
    }),
    [pick],
  );
  const live = useDeskScreenViews(api, { screen: screen.id, widgets: [spec] });
  const view = live.data?.views.find((v) => v.id === spec.id);
  const size = pick.want ?? { w: pick.size.def[0], h: pick.size.def[1] };
  const g = screenGrid(shape.width, shape.height);
  const r = cellRect(g, { x: 0, y: 0, ...size });
  const k = Math.min(PEEK_MAX.width / r.width, PEEK_MAX.height / r.height, 0.7);
  const width = Math.round(r.width * k);
  const height = Math.round(r.height * k);
  // The card's paddings and border around the drawing, and its name over it.
  const boxW = width + 50;
  const boxH = height + 24 + 22 + 26 + 2;
  const { left, top } = peekPlace(row, { width: boxW, height: boxH }, area);
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
  return createPortal(
    <div className={e.peek} role="tooltip" style={{ left, top, width: boxW }} data-peek>
      <div className={e.peekHead}>
        <span className={e.peekName}>{pick.name}</span>
        <span className={e.size}>{`${size.w}×${size.h}`}</span>
      </div>
      <div className={e.peekBox} style={{ height: height + 24 }}>
        {live.data || ownWidgetName(pick.widget.type, assistant) ? (
          <WidgetPreview
            widget={spec}
            view={view}
            calm={live.data?.calm ?? calm}
            w={size.w}
            h={size.h}
            width={width}
            screen={{ width: shape.width, height: shape.height }}
            assistant={assistant}
            timeZone={timeZone}
            now={now}
            loadImage={loadImage}
          />
        ) : (
          <span className={e.peekWait}>{E.peekReading}</span>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* A chosen widget -------------------------------------------------------------------------------------------------- */

/**
 * View kinds that show what people do or see, for a runtime whose *Add a widget* doesn't say what's private: a locked
 * screen hides them unless the person says otherwise.
 */
const PRIVATE_VIEWS = new Set(['posters', 'camera']);

function ChosenPanel({
  api,
  screen,
  desk,
  catalog,
  ed,
  views,
  calm,
  assistant,
  timeZone,
  now,
  loadImage,
  shape,
  viewOf,
  say,
  nameOf,
  widget,
}: WidgetPanelProps & { widget: DeskWidget }) {
  const view = views.get(widget.id);
  const found = catalogFind(catalog, widget);
  const name = nameOf(widget);
  const limits = widgetSize(widget, viewOf);
  const kind = viewOf(widget) ?? view?.kind;
  const ownType = ownWidgetName(widget.type, assistant) !== null;
  // A server's part says what it is; its overview, that it's a server.
  const sub =
    widget.type === 'server'
      ? serverShow(widget.opts) === 'overview'
        ? E.server_
        : (found?.item.line ?? E.server_)
      : found
        ? [found.group.label, found.item.line].filter(Boolean).join(' · ')
        : (view?.name ?? '');
  const serverName =
    widget.type === 'server'
      ? (catalogServers(catalog).find((x) => x.ref === widget.ref)?.name ?? view?.name ?? view?.title ?? name)
      : name;
  const mark = found?.item.mark ?? view?.mark;
  const setOpt = (key: string, value: string | null) => {
    const opts = { ...widget.opts };
    if (value === null) delete opts[key];
    else opts[key] = value;
    ed.setSpec(widget.id, { opts });
  };
  return (
    <>
      <button type="button" className={e.backLink} onClick={() => ed.select(null)}>
        <Icon icon={ChevronLeft} size={14} />
        {E.backToAdd}
      </button>
      <div className={e.chosenHead}>
        <span className={cx(e.tile, e.tileBig)}>
          <WidgetMark mark={mark} type={widget.type} />
        </span>
        <div className={e.chosenText}>
          <span className={e.chosenName}>{name}</span>
          {sub ? <span className={e.chosenSub}>{sub}</span> : null}
        </div>
      </div>
      <div className={e.preview} role="img" aria-label={fillDeskWords(E.preview, { name })}>
        <WidgetPreview
          widget={widget}
          view={view}
          calm={calm}
          w={widget.w}
          h={widget.h}
          width={previewWidth(ed.grid, widget)}
          screen={{ width: shape.width, height: shape.height }}
          assistant={assistant}
          timeZone={timeZone}
          now={now}
          loadImage={loadImage}
        />
      </div>

      {widget.type === 'server' ? (
        <ServerFields catalog={catalog} widget={widget} ed={ed} setOpt={setOpt} />
      ) : null}
      {widget.type === 'panel' || widget.type === 'figures' ? (
        <ThingFields api={api} screen={screen.id} catalog={catalog} widget={widget} ed={ed} />
      ) : null}
      {(widget.type === 'panel' || widget.type === 'server') &&
      (found?.item.private ?? (widget.type === 'panel' && kind !== undefined && PRIVATE_VIEWS.has(kind))) ? (
        <LockField
          value={widget.opts.lock === 'show' ? 'show' : 'hide'}
          onChange={(v) => setOpt('lock', v)}
        />
      ) : null}
      {widget.type === 'now' || widget.type === 'strip' ? (
        <ShowFields api={api} screen={screen} desk={desk} type={widget.type} assistant={assistant} />
      ) : null}

      <div className={e.field}>
        <span className={e.fieldLabel}>{E.sizeLabel}</span>
        <div className={e.steppers}>
          <span className={e.stepLabel}>{E.wide}</span>
          <Stepper
            value={widget.w}
            less={E.narrower}
            more={E.wider}
            onLess={() => say(ed.grow(widget.id, 'w', -1))}
            onMore={() => say(ed.grow(widget.id, 'w', 1))}
          />
          <span className={cx(e.stepLabel, e.stepLabelGap)}>{E.high}</span>
          <Stepper
            value={widget.h}
            less={E.lower}
            more={E.higher}
            onLess={() => say(ed.grow(widget.id, 'h', -1))}
            onMore={() => say(ed.grow(widget.id, 'h', 1))}
          />
        </div>
        <span className={e.fieldHint}>
          {fillDeskWords(E.sizes, {
            min: gridText(limits.min[0], limits.min[1]),
            max: gridText(limits.max[0], limits.max[1]),
          })}
        </span>
      </div>

      {ownType ? null : (
        <div className={e.field}>
          <span className={e.fieldLabel}>{E.touch}</span>
          <span className={e.fieldHint}>
            {widget.type === 'server' ? fillDeskWords(E.touchServer, { name: serverName }) : E.touchBig}
          </span>
        </div>
      )}
      <button type="button" className={e.removeLink} onClick={() => say(ed.remove(widget.id, name))}>
        {E.remove}
      </button>
    </>
  );
}

/**
 * The preview's width: the widget at its size, within 290 × 200 (what the panel's preview has inside it at its
 * narrowest) and at most 0.62 of the screen's pixels.
 */
function previewWidth(grid: Grid, widget: DeskWidget): number {
  const r = cellRect(grid, widget);
  return Math.round(r.width * Math.min(290 / r.width, 200 / r.height, 0.62));
}

function Stepper({
  value,
  less,
  more,
  onLess,
  onMore,
}: {
  value: number;
  less: string;
  more: string;
  onLess: () => void;
  onMore: () => void;
}) {
  return (
    <span className={e.stepper}>
      <button type="button" aria-label={less} onClick={onLess}>
        −
      </button>
      <b aria-live="polite">{value}</b>
      <button type="button" aria-label={more} onClick={onMore}>
        +
      </button>
    </span>
  );
}

/** The parts drawn over a range, whose chart's range can be chosen. */
const RANGED = new Set(['overview', 'cpu', 'memory', 'network']);

/** A server widget: which server, which part of it (DK-153), and its chart's range. */
function ServerFields({
  catalog,
  widget,
  ed,
  setOpt,
}: {
  catalog: DeskCatalog | undefined;
  widget: DeskWidget;
  ed: ScreenEditor;
  setOpt: (key: string, value: string | null) => void;
}) {
  const id = useId();
  const servers = catalogServers(catalog);
  const show = serverShow(widget.opts);
  const parts = serverParts(catalog, widget.ref);
  /** The widget's options with `show` set to `next` (the overview's is none). */
  const withShow = (opts: Record<string, string>, next: string) => {
    const out = { ...opts };
    if (next && next !== 'overview') out.show = next;
    else delete out.show;
    return out;
  };
  return (
    <>
      <div className={e.field}>
        <label className={e.fieldLabel} htmlFor={`${id}-server`}>
          {E.server}
        </label>
        <select
          id={`${id}-server`}
          className={e.select}
          value={widget.ref ?? ''}
          onChange={(ev) => {
            // Another server keeps the part when it has it, else shows its overview.
            const offers = serverParts(catalog, ev.target.value).some((p) => (p.show || 'overview') === show);
            ed.setSpec(widget.id, { ref: ev.target.value, opts: withShow(widget.opts, offers ? show : '') });
          }}
        >
          {servers.some((x) => x.ref === widget.ref) ? null : (
            <option value={widget.ref ?? ''}>{widget.ref}</option>
          )}
          {servers.map((x) => (
            <option key={x.ref} value={x.ref}>
              {x.name}
            </option>
          ))}
        </select>
      </div>
      {parts.length > 1 ? (
        <div className={e.field}>
          <label className={e.fieldLabel} htmlFor={`${id}-shows`}>
            {E.panel}
          </label>
          <select
            id={`${id}-shows`}
            className={e.select}
            value={show}
            onChange={(ev) => ed.setSpec(widget.id, { opts: withShow(widget.opts, ev.target.value) })}
          >
            {parts.some((p) => (p.show || 'overview') === show) ? null : <option value={show}>{show}</option>}
            {parts.map((p) => (
              <option key={p.show || 'overview'} value={p.show || 'overview'}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {RANGED.has(show) ? (
        <div className={e.field}>
          <span className={e.fieldLabel}>{E.chart}</span>
          <SegmentedControl
            variant="soft"
            size="sm"
            role="radiogroup"
            label={E.chart}
            value={(widget.opts.range as (typeof DESK_WIDGET_RANGES)[number] | undefined) ?? '24h'}
            onChange={(range) => setOpt('range', range === '24h' ? null : range)}
            options={DESK_WIDGET_RANGES.map((r) => ({ value: r, label: E.ranges[r] }))}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * A connection's widget: which connection, and for a panel which of its page's panels. An account's widget lists the
 * person's accounts instead (AP-6111): another account keeps the panel when it has one by that id.
 */
function ThingFields({
  api,
  screen,
  catalog,
  widget,
  ed,
}: {
  api: DeskApi;
  screen: string;
  catalog: DeskCatalog | undefined;
  widget: DeskWidget;
  ed: ScreenEditor;
}) {
  const id = useId();
  const account = !!widget.ref && isAccountGroup({ key: widget.ref });
  const things = (catalog?.groups ?? []).filter((g) => g.thing && isAccountGroup(g) === account);
  const group = things.find((g) => g.thing === widget.ref);
  // A thing listed partly: its whole list, read for the panel's choices.
  const whole = useDeskWidgets(api, group?.partial && group.thing ? { screen, thing: group.thing } : null);
  const panels = (whole.data?.groups[0] ?? group)?.items.filter((i) => i.type === 'panel') ?? [];
  return (
    <>
      <div className={e.field}>
        <label className={e.fieldLabel} htmlFor={`${id}-thing`}>
          {account ? E.account : E.thing}
        </label>
        <select
          id={`${id}-thing`}
          className={e.select}
          value={widget.ref ?? ''}
          onChange={(ev) => {
            const next = things.find((g) => g.thing === ev.target.value);
            const same = next?.items.find(
              (i) => i.type === widget.type && i.opts.panel === widget.opts.panel,
            );
            const first = same ?? next?.items.find((i) => i.type === widget.type);
            if (!next) return;
            ed.setSpec(widget.id, {
              ref: ev.target.value,
              opts:
                widget.type === 'panel' ? { ...widget.opts, panel: first?.opts.panel ?? '' } : widget.opts,
            });
          }}
        >
          {group ? null : <option value={widget.ref ?? ''}>{widget.ref}</option>}
          {things.map((g) => (
            <option key={g.key} value={g.thing}>
              {g.label}
            </option>
          ))}
        </select>
      </div>
      {widget.type === 'panel' && panels.length > 0 ? (
        <div className={e.field}>
          <label className={e.fieldLabel} htmlFor={`${id}-panel`}>
            {E.panel}
          </label>
          <select
            id={`${id}-panel`}
            className={e.select}
            value={widget.opts.panel ?? ''}
            onChange={(ev) => ed.setSpec(widget.id, { opts: { ...widget.opts, panel: ev.target.value } })}
          >
            {panels.map((p) => (
              <option key={p.opts.panel} value={p.opts.panel}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </>
  );
}

function LockField({ value, onChange }: { value: 'show' | 'hide'; onChange: (v: 'show' | 'hide') => void }) {
  const id = useId();
  return (
    <div className={e.field}>
      <span className={e.fieldLabel}>{E.lock}</span>
      <SegmentedControl
        variant="soft"
        size="sm"
        role="radiogroup"
        label={E.lock}
        describedBy={`${id}-hint`}
        value={value}
        onChange={onChange}
        options={[
          { value: 'show', label: E.locks.show },
          { value: 'hide', label: E.locks.hide },
        ]}
      />
      <span className={e.fieldHint} id={`${id}-hint`}>
        {E.lockHint}
      </span>
    </div>
  );
}

/**
 * *What’s going on*'s choices (which things may show: *Always · When it matters · Off*) and *Servers*' order and
 * choices, the screen's own (`show`), saved as they're chosen like every choice in Settings: they aren't the layout's.
 */
function ShowFields({
  api,
  screen,
  desk,
  type,
  assistant,
}: {
  api: DeskApi;
  screen: DeskScreenDetail;
  desk: DeskScreen | undefined;
  type: 'now' | 'strip';
  assistant: string;
}) {
  const latest = useDeskScreen(api, screen.id).data ?? screen;
  const actions = useDeskScreenActions(api);
  const toast = useToast();
  const options = desk?.showOptions ?? [];
  const show = latest.show;
  const save = (patch: DeskShowPatch) =>
    void actions
      .update({ screen: screen.id, show: patch })
      .catch((error) => toast.show(screensErrorText(error)));
  const level = (key: string): DeskShowLevel => deskShowLevel(show, key);
  const fill = (text: string) => fillDeskWords(text, { assistant });
  const groups = useMemo(
    () => ({
      assistant: options.filter((o) => o.group === 'assistant'),
      connection: options.filter((o) => o.group === 'connection'),
      widget: options.filter((o) => o.group === 'widget'),
      server: options.filter((o) => o.group === 'server'),
    }),
    [options],
  );
  if (options.length === 0) return null;
  if (type === 'strip')
    return (
      <div className={cx(e.field, e.showField)}>
        <span className={e.fieldLabel}>{E.stripOrder}</span>
        <span className={e.fieldHint}>{E.stripHint}</span>
        <div className={e.showRows}>
          <ServerRows
            servers={groups.server}
            order={show.order}
            level={level}
            onLevel={(key, l) => save({ items: { [key]: l } })}
            onOrder={(order) => save({ order })}
          />
        </div>
      </div>
    );
  const row = (o: (typeof options)[number]) => (
    <LevelRow
      key={o.key}
      row={o.key}
      mark={<OptionMark option={o} />}
      name={o.key === 'work' ? fill(W.work.name) : o.key === 'coming' ? W.coming.name : o.name}
      line={o.key === 'work' ? fill(W.work.line) : o.key === 'coming' ? W.coming.line : o.line}
      value={level(o.key)}
      onChange={(l) => save({ items: { [o.key]: l } })}
    />
  );
  return (
    <div className={cx(e.field, e.showField)}>
      <span className={e.fieldLabel}>{E.nowChoices}</span>
      <span className={e.fieldHint}>{E.nowHint}</span>
      <div className={e.showRows}>
        {groups.assistant.map(row)}
        {groups.connection.length > 0 ? <GroupLabel>{W.groups.connection}</GroupLabel> : null}
        {groups.connection.map(row)}
        {groups.widget.length > 0 ? <GroupLabel>{W.groups.widget}</GroupLabel> : null}
        {groups.widget.map(row)}
      </div>
    </div>
  );
}
