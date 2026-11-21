/**
 * `<Screen>` (DK-126…DK-141): the whole screen at its logical size, scaled to the box it's given — the fixed top bar
 * (the Whombat's name, the pill, the pages, the host's chips), the current page's widgets on the screen's grid, the thin
 * edge and the modal for outages and questions, a widget opened big, and *Try on the screen*'s banner. Pages turn by a
 * swipe or a touched name, by themselves when the layout says so, and go back to the first after a while untouched.
 * In `editing` it draws the cells and nothing reacts to touch; the editor draws its selection over it (`overlay`).
 */
import {
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type AttentionActions, AttentionModal, LockIcon } from './AttentionModal';
import { edgeTone, MODAL_CLOSED, type ModalState, modalView, pill } from './attention';
import { bigSize, PAGE_NAMES_MIN, type PagesAt, pagesAt } from './forms';
import { BAR, cellRect, GAP, type Grid, PAD, type Placed, pageOn, screenGrid } from './grid';
import { type Pager, pagerGo, pagerProgress, pagerStart, pagerTick, pagerTouch } from './pager';
import { cx, EnvProvider, type ScreenEnv } from './parts';
import st from './screen.module.css';
import { sizeOf } from './specs';
import type { DeskGrid, DeskImage, DeskWidget, DeskWidgetView, ScreenCalm } from './types';
import { WidgetView } from './WidgetView';
import ws from './widgets.module.css';
import { clockText, dateText, fillWords, SCREEN_WORDS } from './words';

export interface ScreenProps extends AttentionActions {
  /** The screen's size in logical pixels: it decides the grid (with the layout's Size). */
  width: number;
  height: number;
  /** Drawn at this share of that size (a thumbnail, the editor); 1 by default. */
  scale?: number | undefined;
  /** What the screen draws: its layout, the views, what needs the person, its pop-ups, a draft being tried. */
  grid: DeskGrid;
  /** The calm glance, for Whombat's own widgets. */
  calm?: ScreenCalm | null | undefined;
  /** The Whombat's name, on the left of the top bar. */
  name: string;
  /** The assistant's name (“Dusty”). */
  assistant: string;
  timeZone?: string | undefined;
  /** The time (ms): the clock, the turning, “since 14:30 · 4 min”. The host ticks it (every second or so). */
  now: number;
  /** The chips on the right of the top bar (`<ScreenChip>`): the box's network, battery and lock, or *Online*. */
  chips?: ReactNode;
  /** The lock shows *Only the time* (DK-138): the clock alone. */
  onlyTime?: boolean | undefined;
  loadImage?: ((image: DeskImage) => Promise<string>) | undefined;
  renderFace?: ((size: number) => ReactNode) | undefined;
  /** The page shown, when the host decides it (the editor); else the screen turns its own pages. */
  page?: number | undefined;
  onPage?: ((page: number) => void) | undefined;
  /** Keys put away with *Not now*, when the host keeps them; else the screen keeps them while it's drawn. */
  away?: readonly string[] | undefined;
  onAway?: ((keys: string[]) => void) | undefined;
  onServer?: ((id: string) => void) | undefined;
  onServers?: (() => void) | undefined;
  onDoneToday?: (() => void) | undefined;
  /** A widget that hides its words while locked was touched. */
  onUnlock?: (() => void) | undefined;
  /** Someone touched the screen (a screen elsewhere asks for its state sooner). */
  onTouch?: (() => void) | undefined;
  /** The editor: cells drawn, nothing reacts to touch, no modal, no turning. */
  editing?: boolean | undefined;
  /** The current page's widgets as the editor has them (a draft, mid-drag); else the page's own on this grid. */
  widgets?: readonly DeskWidget[] | undefined;
  /** A widget left out of the drawing (the editor draws it where it's being dragged). */
  hidden?: string | undefined;
  /** Drawn over the widgets in the screen's own pixels (the editor's selection, handles and ghost). */
  overlay?: ReactNode;
  className?: string | undefined;
}

/** Before the top bar is measured: below this width the pages follow the name (narrower still, dots). */
const PAGES_CENTRED_MIN = 1100;
/** A page's dot, with its touch area. */
const DOT_W = 17;
const SWIPE_PX = 60;

/** A chip in the top bar: a sign and a few words. */
export function ScreenChip({
  icon,
  children,
  tone,
}: {
  icon?: ReactNode;
  children?: ReactNode;
  tone?: 'warn' | 'bad' | undefined;
}) {
  return (
    <span className={st.chip} data-tone={tone}>
      {icon}
      {children}
    </span>
  );
}

/** The top bar's signs, for hosts that have no own: Wi-Fi, a battery at `percent`, the lock, a green dot. */
export function ChipIcon({
  name,
  percent,
}: {
  name: 'wifi' | 'battery' | 'lock' | 'online';
  percent?: number;
}) {
  if (name === 'online') return <span className={st.chipDot} aria-hidden="true" />;
  if (name === 'lock') return <LockIcon />;
  if (name === 'battery')
    return (
      <svg
        width="24"
        height="16"
        viewBox="0 0 26 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <rect x="1" y="2" width="21" height="12" rx="3" />
        <rect
          x="3.5"
          y="4.5"
          width={(16 * Math.max(6, percent ?? 100)) / 100}
          height="7"
          rx="1.5"
          fill="currentColor"
          stroke="none"
        />
        <path d="M24.5 6v4" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" />
      <circle cx="12" cy="19.5" r="1" fill="currentColor" />
    </svg>
  );
}

/** The grid's cells, dashed (the editor). */
export function Cells({ g }: { g: Grid }) {
  const out: ReactNode[] = [];
  for (let y = 0; y < g.rows; y++)
    for (let x = 0; x < g.cols; x++) {
      const r = cellRect(g, { x, y, w: 1, h: 1 });
      out.push(<div key={`${x}-${y}`} className={st.cell} style={r} />);
    }
  return <>{out}</>;
}

/** A widget placed on the grid by its cells (the screen's pixels). */
export function WidgetBox({
  g,
  widget,
  view,
  calm,
  now,
  className,
}: {
  g: Grid;
  widget: Placed;
  view?: DeskWidgetView | undefined;
  calm?: ScreenCalm | null | undefined;
  now?: number | undefined;
  className?: string | undefined;
}) {
  const r = cellRect(g, widget);
  const style = useMemo<CSSProperties>(
    () => ({ left: r.left, top: r.top, width: r.width, height: r.height }),
    [r.left, r.top, r.width, r.height],
  );
  return (
    <WidgetView
      widget={widget}
      view={view}
      calm={calm}
      w={widget.w}
      h={widget.h}
      pw={r.width}
      ph={r.height}
      now={widget.type === 'clock' ? now : undefined}
      style={style}
      className={className}
    />
  );
}

/** The latest of the host's props, for callbacks that stay the same across draws. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function Screen(props: ScreenProps) {
  const { grid: state, now, editing = false } = props;
  const layout = state.layout;
  const g = useMemo(
    () => screenGrid(props.width, props.height, layout.size),
    [props.width, props.height, layout.size],
  );
  const scale = props.scale ?? 1;
  const pages = layout.pages;
  const latest = useLatest(props);

  /* Pages (DK-133) */
  const [pager, setPager] = useState<Pager>(() => pagerStart(now));
  const controlled = props.page !== undefined;
  const page = Math.min(controlled ? (props.page ?? 0) : pager.page, pages.length - 1);
  useEffect(() => {
    if (controlled || editing) return;
    setPager((p) => pagerTick(p, now, pages.length, layout.turn));
  }, [now, controlled, editing, pages.length, layout.turn]);
  const go = useCallback(
    (to: number) => {
      const p = latest.current;
      const n = p.grid.layout.pages.length;
      const next = ((to % n) + n) % n;
      if (p.page !== undefined) p.onPage?.(next);
      else setPager(pagerGo(next, n, p.now));
    },
    [latest],
  );
  // The host hears of every page the screen turns to, by touch or by itself.
  useEffect(() => {
    if (!controlled) latest.current.onPage?.(pager.page);
  }, [pager.page, controlled, latest]);
  const progress = controlled || editing ? null : pagerProgress(pager, now, layout.turn);

  /* What needs the person (DK-135, DK-136) */
  const [ownAway, setOwnAway] = useState<ReadonlySet<string>>(new Set());
  const away = useMemo(() => (props.away ? new Set(props.away) : ownAway), [props.away, ownAway]);
  const putAway = useCallback(
    (keys: string[]) => {
      if (latest.current.onAway) latest.current.onAway(keys);
      else setOwnAway((prev) => new Set([...prev, ...keys]));
    },
    [latest],
  );
  const [modal, setModal] = useState<ModalState>(MODAL_CLOSED);
  // Keys put away that are gone may come back as new: forget them once they're resolved.
  useEffect(() => {
    if (props.away) return;
    const live = new Set(state.attention.items.map((i) => i.key));
    setOwnAway((prev) =>
      [...prev].every((k) => live.has(k)) ? prev : new Set([...prev].filter((k) => live.has(k))),
    );
  }, [state.attention, props.away]);
  const pillView = pill(state.attention);
  const edge = edgeTone(state.attention);
  const modalOpen = !editing && !props.onlyTime && modalView(state.attention, away, modal).open;

  /* A widget opened big (DK-140) */
  const [big, setBig] = useState<string | null>(null);

  /* The page's widgets */
  const views = useMemo(() => new Map(state.views.map((v) => [v.id, v])), [state.views]);
  const current = pages[page];
  const shown = useMemo(() => {
    if (props.widgets) return [...props.widgets];
    if (!current) return [];
    return pageOn(current, g, (w) => views.get(w.id)?.kind).widgets;
  }, [props.widgets, current, g, views]);
  const bigWidget = big ? shown.find((w) => w.id === big) : undefined;
  useEffect(() => {
    if (big && !bigWidget) setBig(null);
  }, [big, bigWidget]);

  // The context stays the same while the host's callbacks change identity: they're read from the latest props, so the
  // widgets (memoized on what they show) don't draw again for a new callback.
  const has = {
    load: !!props.loadImage,
    face: !!props.renderFace,
    server: !!props.onServer,
    servers: !!props.onServers,
    done: !!props.onDoneToday,
    unlock: !!props.onUnlock,
  };
  const env = useMemo<ScreenEnv>(
    () => ({
      assistant: props.assistant,
      timeZone: props.timeZone,
      loadImage: has.load ? (image) => latest.current.loadImage?.(image) ?? Promise.reject() : undefined,
      renderFace: has.face ? (size) => latest.current.renderFace?.(size) : undefined,
      editing,
      onServer: has.server ? (id) => latest.current.onServer?.(id) : undefined,
      onServers: has.servers ? () => latest.current.onServers?.() : undefined,
      onDoneToday: has.done ? () => latest.current.onDoneToday?.() : undefined,
      onUnlock: has.unlock ? () => latest.current.onUnlock?.() : undefined,
      onAttention: () => setModal({ pill: true, shown: null }),
      onBig: (id) => setBig(id),
    }),
    [
      props.assistant,
      props.timeZone,
      editing,
      has.load,
      has.face,
      has.server,
      has.servers,
      has.done,
      has.unlock,
      latest,
    ],
  );

  /* The top bar: the pages where they don't touch the name, the pill or the chips */
  const barRef = useRef<HTMLElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const namesRef = useRef<HTMLDivElement>(null);
  const [barAt, setBarAt] = useState<PagesAt>(() =>
    g.width < PAGE_NAMES_MIN ? 'dots' : g.width < PAGES_CENTRED_MIN ? 'after' : 'centre',
  );
  // The names' own size changes are watched; a second page appearing brings the names to watch.
  const hasPages = pages.length > 1;
  useLayoutEffect(() => {
    if (!hasPages) return;
    const els = [barRef.current, leftRef.current, chipsRef.current, namesRef.current];
    const [bar, left, chips, names] = els;
    if (!bar || !left || !chips || !names) return;
    const measure = () =>
      setBarAt(
        pagesAt({
          bar: bar.offsetWidth,
          left: left.offsetLeft + left.offsetWidth,
          chips: chips.offsetLeft,
          names: names.offsetWidth,
          dots: names.childElementCount * DOT_W,
        }),
      );
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const o = new ResizeObserver(measure);
    for (const el of els) if (el) o.observe(el);
    return () => o.disconnect();
  }, [hasPages]);

  /* Touch: swipes turn pages, any touch makes the turning wait */
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    if (editing) return;
    swipe.current = { x: e.clientX, y: e.clientY };
    if (!controlled) setPager((p) => pagerTouch(p, now));
    latest.current.onTouch?.();
  };
  const onPointerUp = (e: PointerEvent) => {
    const from = swipe.current;
    swipe.current = null;
    if (!from || editing || big || modalOpen || pages.length < 2) return;
    const dx = (e.clientX - from.x) / (scale * g.zoom);
    const dy = (e.clientY - from.y) / (scale * g.zoom);
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(page + (dx < 0 ? 1 : -1));
  };

  const at = barAt;
  const dots = at === 'dots' || at === 'dotsAfter';
  const tryingS = state.trying ? Math.ceil((Date.parse(state.trying.until) - now) / 1000) : 0;
  const modalWidth = Math.min(860, g.width - 2 * 40);

  return (
    <div
      className={cx(st.frame, props.className)}
      style={{ width: props.width * scale, height: props.height * scale }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the whole screen hears touches (swipes, the turning's wait) and Escape; its parts are real buttons */}
      <div
        className={st.screen}
        data-theme="dark"
        data-screen={state.screen}
        data-editing={editing || undefined}
        style={{ width: g.width, height: g.height, transform: `scale(${g.zoom * scale})` }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipe.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          if (big) setBig(null);
          else if (modal.pill) setModal(MODAL_CLOSED);
        }}
      >
        <EnvProvider value={env}>
          {edge && !editing && <div className={st.edge} data-tone={edge} />}
          <header className={st.bar} ref={barRef}>
            <div className={st.left} ref={leftRef}>
              <span className={st.name}>{props.name}</span>
              {/* While the modal shows what needs the person, the pill would only say it again. */}
              {pillView && !modalOpen && (
                <button
                  type="button"
                  className={cx(st.pill, st.focus)}
                  data-tone={pillView.tone}
                  onClick={editing ? undefined : () => setModal({ pill: true, shown: null })}
                >
                  <i aria-hidden="true" />
                  {pillView.text}
                </button>
              )}
            </div>
            {pages.length > 1 && (
              <div className={cx(st.pages, st.measure)} ref={namesRef} aria-hidden="true">
                {pages.map((p) => (
                  <span key={p.id} className={st.page}>
                    {p.name}
                  </span>
                ))}
              </div>
            )}
            {bigWidget && !editing ? (
              <button
                type="button"
                className={cx(st.back, at !== 'centre' && at !== 'dots' && st.backAfter, st.focus)}
                onClick={() => setBig(null)}
              >
                <span aria-hidden="true">‹</span>
                {SCREEN_WORDS.back}
              </button>
            ) : (
              pages.length > 1 && (
                <nav
                  className={cx(
                    st.pages,
                    (at === 'after' || at === 'dotsAfter') && st.pagesAfter,
                    dots && st.dots,
                  )}
                  aria-label={SCREEN_WORDS.pages}
                >
                  {pages.map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      className={cx(dots ? st.dot : st.page, st.focus)}
                      data-on={i === page || undefined}
                      aria-current={i === page ? 'page' : undefined}
                      aria-label={
                        dots
                          ? fillWords(SCREEN_WORDS.page, { name: p.name, i: i + 1, n: pages.length })
                          : undefined
                      }
                      style={
                        i === page && progress !== null
                          ? ({ '--turn': `${Math.round(progress * 100)}%` } as CSSProperties)
                          : undefined
                      }
                      onClick={() => go(i)}
                    >
                      {dots ? null : p.name}
                    </button>
                  ))}
                </nav>
              )
            )}
            <div className={st.chips} ref={chipsRef}>
              {props.chips}
            </div>
          </header>
          {props.onlyTime ? (
            <div className={st.onlyTime}>
              <div className={st.onlyTimeClock}>{clockText(now, props.timeZone)}</div>
              <div className={st.onlyTimeDate}>{dateText(now, props.timeZone)}</div>
            </div>
          ) : (
            <div className={st.grid}>
              {editing && <Cells g={g} />}
              {shown
                .filter((w) => w.id !== props.hidden)
                .map((w) => (
                  <WidgetBox
                    key={w.id}
                    g={g}
                    widget={w}
                    view={views.get(w.id)}
                    calm={props.calm}
                    now={now}
                    className={editing ? ws.editing : undefined}
                  />
                ))}
              {editing && shown.length === 0 && (
                <div className={st.empty}>
                  <span>{SCREEN_WORDS.editing.empty}</span>
                  <span>{SCREEN_WORDS.editing.emptyMore}</span>
                </div>
              )}
              {props.overlay}
            </div>
          )}
          {tryingS > 0 && <div className={st.trying}>{fillWords(SCREEN_WORDS.trying, { s: tryingS })}</div>}
          {bigWidget && !editing && !props.onlyTime && (
            <BigWidget
              g={g}
              widget={bigWidget}
              view={views.get(bigWidget.id)}
              calm={props.calm}
              now={now}
              onBack={() => setBig(null)}
            />
          )}
          {!editing && !props.onlyTime && (
            <AttentionModal
              attention={state.attention}
              away={away}
              state={modal}
              onState={setModal}
              onAway={putAway}
              now={now}
              width={modalWidth}
              env={env}
              askView={props.askView}
              onAnswer={props.onAnswer}
              renderAsk={props.renderAsk}
              onFix={props.onFix}
              onStep={props.onStep}
              onOpen={props.onOpen}
              answerElsewhere={props.answerElsewhere}
              locked={props.locked}
            />
          )}
        </EnvProvider>
      </div>
    </div>
  );
}

/** A widget in its largest form over the dashboard (DK-140), centred under the top bar. */
function BigWidget({
  g,
  widget,
  view,
  calm,
  now,
  onBack,
}: {
  g: Grid;
  widget: Placed;
  view: DeskWidgetView | undefined;
  calm: ScreenCalm | null | undefined;
  now: number;
  onBack: () => void;
}) {
  const { w, h } = bigSize(sizeOf(widget, view?.kind).max, g);
  const r = cellRect(g, { x: 0, y: 0, w, h });
  const left = PAD + ((g.cols - w) * (g.cw + GAP)) / 2;
  const top = BAR + ((g.rows - h) * (g.ch + GAP)) / 2;
  return (
    <>
      <button type="button" className={st.ov} aria-label={SCREEN_WORDS.back} tabIndex={-1} onClick={onBack} />
      <WidgetView
        widget={widget}
        view={view}
        calm={calm}
        w={w}
        h={h}
        pw={r.width}
        ph={r.height}
        now={widget.type === 'clock' ? now : undefined}
        big
        className={st.bigWidget}
        style={{ left, top, width: r.width, height: r.height, zIndex: 7 }}
      />
    </>
  );
}

/**
 * `<Screen>` scaled to its parent: to its width (`fit` `width`, the default: a thumbnail, a list), or within its width
 * and height, centred (`contain`: the editor's canvas, a full window).
 */
export function FittedScreen({
  fit = 'width',
  ...props
}: Omit<ScreenProps, 'scale'> & { fit?: 'width' | 'contain' }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth / props.width;
      const h = el.clientHeight / props.height;
      const s = fit === 'contain' ? Math.min(w, h) : w;
      if (s > 0) setScale(s);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const o = new ResizeObserver(measure);
    o.observe(el);
    return () => o.disconnect();
  }, [props.width, props.height, fit]);
  const style: CSSProperties =
    fit === 'contain'
      ? { width: '100%', height: '100%', display: 'grid', placeItems: 'center', overflow: 'hidden' }
      : { width: '100%' };
  return (
    <div ref={box} style={style}>
      {scale > 0 && <Screen {...props} scale={scale} />}
    </div>
  );
}

/**
 * One widget alone as the screen draws it at `w` × `h` cells of a `screen`-sized grid (1280×800 by default), scaled to
 * `width` px: the editor's preview of a chosen widget, a catalog's picture. Dark, with the screen's context.
 */
export function WidgetPreview({
  widget,
  view,
  calm,
  w,
  h,
  width,
  screen = { width: 1280, height: 800 },
  assistant,
  timeZone,
  now,
  loadImage,
  renderFace,
}: {
  widget: Pick<DeskWidget, 'id' | 'type' | 'opts'> & { ref?: string | undefined };
  view?: DeskWidgetView | undefined;
  calm?: ScreenCalm | null | undefined;
  w: number;
  h: number;
  width: number;
  screen?: { width: number; height: number };
  assistant: string;
  timeZone?: string | undefined;
  now?: number | undefined;
  loadImage?: ((image: DeskImage) => Promise<string>) | undefined;
  renderFace?: ((size: number) => ReactNode) | undefined;
}) {
  const g = screenGrid(screen.width, screen.height);
  const r = cellRect(g, { x: 0, y: 0, w, h });
  const s = width / r.width;
  const env = useMemo<ScreenEnv>(
    () => ({ assistant, timeZone, loadImage, renderFace, editing: true }),
    [assistant, timeZone, loadImage, renderFace],
  );
  return (
    <div className={st.frame} style={{ width, height: r.height * s }}>
      <div
        className={st.screen}
        data-theme="dark"
        style={{ width: r.width, height: r.height, transform: `scale(${s})`, background: 'transparent' }}
      >
        <EnvProvider value={env}>
          <WidgetView
            widget={widget}
            view={view}
            calm={calm}
            w={w}
            h={h}
            pw={r.width}
            ph={r.height}
            now={now}
            style={{ left: 0, top: 0, width: r.width, height: r.height }}
          />
        </EnvProvider>
      </div>
    </div>
  );
}
