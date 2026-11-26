/**
 * Settings → Screens → a screen → *Edit layout* (Whombat desk-display.md DK-143, DK-163…DK-168; desk-display-web.md
 * AP-5950…, AP-9970…; the mockups' `editor.html`): the screen at its real shape with live views and its cells showing;
 * pages along the top with *+ Page* and *Tidy up*; *Size* and *Pages turn*; *Add a widget* beside it (search, Whombat's
 * own as tiles, each service once, drag in or *+*); a widget chosen by a touch or the keyboard, moved by dragging it,
 * resized by its corner (it redraws as it grows), its settings beside it. Dropped onto one other widget the two change
 * places; any other taken spot says so in red and nothing is pushed aside. The keys are behind *?* under the screen.
 * Changes are a draft until *Save*; *Try on the screen* shows the draft there for a minute; *Undo* goes back a step.
 */
import {
  DESK_SCREEN_WORDS,
  DESK_SCREENS_TEXT,
  DESK_SIZES,
  DESK_TURNS,
  DESK_WORDS,
  type DeskApi,
  type DeskCatalogItem,
  type DeskScreen,
  type DeskScreenDetail,
  type DeskWidget,
  type DeskWidgetView,
  deskLayoutWidgets,
  draftProblem,
  dragTarget,
  dropSpot,
  EDITOR_DEFAULT_SIZE,
  editorKey,
  fillDeskWords,
  gridText,
  moveSpot,
  pagesText,
  screensErrorText,
  screenWhat,
  widgetSize,
} from '@whombat/client/desk';
import {
  useDesk,
  useDeskClock,
  useDeskScreen,
  useDeskScreenActions,
  useDeskScreenViews,
  useDeskWidgets,
} from '@whombat/client/desk/react';
import { useTheAgent } from '@whombat/client/react';
import { cellAt, cellRect, GAP, type Grid } from '@whombat/screen';
import { Screen, WidgetBox } from '@whombat/screen/react';
import { ChevronLeft, MoreHorizontal, X } from 'lucide-react';
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Input } from '../../../components/Input';
import { Kbd } from '../../../components/Kbd';
import { Modal, ModalTitle } from '../../../components/Modal';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { useToast } from '../../../components/Toast';
import { useDeskHere } from '../../desk/useDeskHere';
import { NO_ATTENTION, useScreenImages } from '../drawing';
import s from '../Screens.module.css';
import e from './Editor.module.css';
import { type ScreenEditor, useScreenEditor } from './useScreenEditor';
import { type CatalogPick, WidgetPanel, widgetName } from './WidgetPanel';

const T = DESK_SCREENS_TEXT;
const E = T.editor;

export interface ScreenEditorPageProps {
  burrow: string;
  id: string;
  onBack: () => void;
}

export function ScreenEditorPage({ burrow, id, onBack }: ScreenEditorPageProps) {
  const here = useDeskHere(burrow);
  const detail = useDeskScreen(here.api, id);
  const desk = useDesk(here.api);
  if (!here.api) return null;
  if (detail.isError)
    return (
      <div className={e.page}>
        <button type="button" className={s.back} onClick={onBack}>
          <Icon icon={ChevronLeft} size={15} />
          {T.back}
        </button>
        <p className={e.gone}>{screensErrorText(detail.error)}</p>
      </div>
    );
  if (!detail.data) return null;
  return (
    <Editor
      // A screen saved elsewhere while nothing was changed here starts again from it.
      key={detail.data.id}
      burrow={burrow}
      api={here.api}
      screen={detail.data}
      desk={desk.data}
      timeZone={here.timeZone}
      onBack={onBack}
    />
  );
}

/** A drag on the screen: moving a widget or its corner, or one coming in from *Add a widget*. */
type Drag =
  | {
      kind: 'widget';
      mode: 'move' | 'resize';
      id: string;
      from: DeskWidget;
      sx: number;
      sy: number;
      moved: boolean;
      to: { x: number; y: number; w: number; h: number };
      ok: boolean;
      /** Moved onto one other widget: where it lands (that one's corner) and where that one goes (DK-167). */
      swap: { at: { x: number; y: number }; id: string; x: number; y: number } | null;
      dx: number;
      dy: number;
    }
  | {
      kind: 'add';
      pick: CatalogPick;
      sx: number;
      sy: number;
      moved: boolean;
      px: number;
      py: number;
      over: boolean;
      to: { x: number; y: number; w: number; h: number } | null;
      ok: boolean;
    };

function Editor({
  burrow,
  api,
  screen,
  desk,
  timeZone,
  onBack,
}: {
  burrow: string;
  api: DeskApi;
  screen: DeskScreenDetail;
  desk: DeskScreen | undefined;
  timeZone: string;
  onBack: () => void;
}) {
  const toast = useToast();
  const actions = useDeskScreenActions(api);
  const { words } = useTheAgent(burrow);
  const assistant = words.name;
  const catalog = useDeskWidgets(api, { screen: screen.id });
  // Each panel's view kind (its sizes): from its view once resolved, from *Add a widget* until then.
  const kinds = useRef(new Map<string, string>());
  const [views, setViews] = useState<ReadonlyMap<string, DeskWidgetView>>(new Map());
  const viewOf = useCallback(
    (w: Pick<DeskWidget, 'id' | 'type'>) =>
      w.type === 'panel' ? (views.get(w.id)?.kind ?? kinds.current.get(w.id)) : undefined,
    [views],
  );
  const nameOf = useCallback(
    (w: Pick<DeskWidget, 'id' | 'type' | 'ref' | 'opts'>) =>
      widgetName(w, views.get(w.id), catalog.data, assistant),
    [views, catalog.data, assistant],
  );
  const ed = useScreenEditor(screen.layout, screen.size, viewOf, nameOf);
  const { draft, page, selected } = ed.state;
  const grid = ed.grid;
  const shape = screen.size ?? EDITOR_DEFAULT_SIZE;
  const now = useDeskClock(true, 15_000);
  const loadImage = useScreenImages(burrow);

  // Live views of the draft's widgets (DK-143), asked again only when what they show changes.
  const specs = useMemo(() => deskLayoutWidgets(draft).slice(0, 64), [draft]);
  const specKey = JSON.stringify(specs.map((w) => [w.id, w.type, w.ref, w.opts]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the widgets' specs change, not their places
  const input = useMemo(() => ({ screen: screen.id, widgets: specs }), [screen.id, specKey]);
  const live = useDeskScreenViews(api, input);
  useEffect(() => {
    if (live.data) setViews(new Map(live.data.views.map((v) => [v.id, v])));
  }, [live.data]);
  const calm = live.data?.calm ?? null;
  const name = live.data?.name ?? '';

  // The screen scaled to the room it has; pointer moves are turned into its pixels with it.
  const viewport = useRef<HTMLDivElement | null>(null);
  // `scale` turns the grid's pixels into the page's (the pointer's), Size's zoom included.
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / grid.width);
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [grid.width]);

  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const edRef = useRef<ScreenEditor>(ed);
  edRef.current = ed;
  const say = (text: string | null) => {
    if (text) toast.show(text);
  };
  const selectedWidget = ed.widgets.find((w) => w.id === selected) ?? null;

  /* Moving and resizing on the screen ------------------------------------------------------------------------------ */

  const onWidgetDown = (event: ReactPointerEvent, w: DeskWidget, mode: 'move' | 'resize') => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start: Drag = {
      kind: 'widget',
      mode,
      id: w.id,
      from: w,
      sx: event.clientX,
      sy: event.clientY,
      moved: false,
      to: { x: w.x, y: w.y, w: w.w, h: w.h },
      ok: true,
      swap: null,
      dx: 0,
      dy: 0,
    };
    setDrag(start);
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (d?.kind !== 'widget') return;
      if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 5) return;
      const k = scaleRef.current || 1;
      const dx = (ev.clientX - d.sx) / k;
      const dy = (ev.clientY - d.sy) / k;
      const now = edRef.current;
      const to = dragTarget(now.grid, d.from, d.mode, dx, dy, widgetSize(d.from, viewOfRef.current), GAP);
      if (d.mode === 'resize') {
        setDrag({ ...d, moved: true, to, ok: fitsHere(now.widgets, to, now.grid, d.id), dx, dy });
        return;
      }
      const spot = moveSpot(now.widgets, now.grid, d.id, to);
      const swap = spot.ok && spot.swap ? { at: { x: spot.x, y: spot.y }, ...spot.swap } : null;
      setDrag({ ...d, moved: true, to, ok: spot.ok, swap, dx, dy });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const d = dragRef.current;
      setDrag(null);
      if (d?.kind !== 'widget') return;
      const now = edRef.current;
      if (d.moved) {
        const changed =
          d.to.x !== d.from.x || d.to.y !== d.from.y || d.to.w !== d.from.w || d.to.h !== d.from.h;
        if (!d.ok) say(d.mode === 'move' ? E.refused.taken : E.refused.noRoom);
        else if (changed)
          say(d.mode === 'move' ? now.move(d.id, d.to) : now.resize(d.id, { w: d.to.w, h: d.to.h }));
      }
      now.select(d.id);
      // The keyboard goes on from the widget let go: its arrows move it.
      canvasRef.current
        ?.querySelector<HTMLElement>(`[data-widget="${d.id}"] button`)
        ?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const viewOfRef = useRef(viewOf);
  viewOfRef.current = viewOf;
  const canvasRef = useRef<HTMLDivElement | null>(null);

  /* Dragging one in from Add a widget ------------------------------------------------------------------------------- */

  const onPickDown = (event: ReactPointerEvent, pick: CatalogPick) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setDrag({
      kind: 'add',
      pick,
      sx: event.clientX,
      sy: event.clientY,
      moved: false,
      px: event.clientX,
      py: event.clientY,
      over: false,
      to: null,
      ok: false,
    });
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (d?.kind !== 'add') return;
      if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 5) return;
      const r = viewport.current?.getBoundingClientRect();
      const k = scaleRef.current || 1;
      const over =
        !!r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!over || !r) {
        setDrag({ ...d, moved: true, px: ev.clientX, py: ev.clientY, over: false, to: null, ok: false });
        return;
      }
      const now = edRef.current;
      const cell = cellAt(now.grid, (ev.clientX - r.left) / k, (ev.clientY - r.top) / k);
      const spot = dropSpot(now.widgets, now.grid, d.pick.size, cell, d.pick.want);
      setDrag({
        ...d,
        moved: true,
        px: ev.clientX,
        py: ev.clientY,
        over: true,
        to: { x: spot.x, y: spot.y, w: spot.w, h: spot.h },
        ok: spot.ok,
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const d = dragRef.current;
      setDrag(null);
      if (d?.kind !== 'add' || !d.moved || !d.over || !d.to) return;
      if (!d.ok) return say(E.refused.drop);
      addPick(d.pick, d.to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  /** *What it shows*: until its new view is read, its sizes are the chosen view's, not the old one's (AP-9975). */
  const choose = (id: string, item: DeskCatalogItem) => {
    const refused = ed.choose(id, item);
    if (refused) return say(refused);
    if (item.view) kinds.current.set(id, item.view);
    else kinds.current.delete(id);
    setViews((was) => {
      if (!was.has(id)) return was;
      const next = new Map(was);
      next.delete(id);
      return next;
    });
  };

  const addPick = (pick: CatalogPick, at?: { x: number; y: number; w: number; h: number }) => {
    // A new panel's view kind until its view arrives (its sizes).
    if (pick.view && pick.widget.id) kinds.current.set(pick.widget.id, pick.view);
    const { text, id } = ed.add(pick.widget, pick.name, at);
    if (id && pick.view) kinds.current.set(id, pick.view);
    say(text);
  };

  /* The keyboard ---------------------------------------------------------------------------------------------------- */

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const target = event.target as HTMLElement;
    const typing = target.closest('input, textarea, select, [contenteditable="true"]');
    const key = editorKey(event);
    if (!key) return;
    if (key.kind === 'undo') {
      if (typing) return;
      event.preventDefault();
      say(ed.undo());
      return;
    }
    // Arrows, Delete and Escape are the screen's only while it has the focus (the segmented controls use arrows too).
    if (!target.closest('[data-editor-canvas]') || !selectedWidget) return;
    event.preventDefault();
    if (key.kind === 'move') say(ed.nudge(selectedWidget.id, key.dx, key.dy));
    else if (key.kind === 'grow') say(ed.grow(selectedWidget.id, key.dim, key.by));
    else if (key.kind === 'remove') say(ed.remove(selectedWidget.id, nameOf(selectedWidget)));
    else ed.select(null);
  };

  /* Save, try, leave ------------------------------------------------------------------------------------------------ */

  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const save = () => {
    if (draftProblem(draft, viewOf)) return say(DESK_WORDS.errors.bad_layout);
    setSaving(true);
    void actions
      .update({ screen: screen.id, layout: draft })
      .then((saved) => {
        ed.markSaved(saved.layout);
        say(E.saved);
      })
      .catch((error) => say(screensErrorText(error)))
      .finally(() => setSaving(false));
  };
  const tryIt = () => {
    void actions
      .tryLayout({ screen: screen.id, layout: draft })
      .then(() => say(E.trying))
      .catch((error) => say(screensErrorText(error)));
  };
  const leave = () => (ed.dirty ? setLeaving(true) : onBack());
  useEffect(() => {
    if (!ed.dirty) return;
    const stay = (ev: BeforeUnloadEvent) => ev.preventDefault();
    window.addEventListener('beforeunload', stay);
    return () => window.removeEventListener('beforeunload', stay);
  }, [ed.dirty]);

  const sub = [
    screenWhat(screen, desk?.display ?? null),
    gridText(grid.cols, grid.rows),
    pagesText(draft.pages.length),
  ].join(' · ');
  const height = grid.height * scale;
  const dragging = drag?.kind === 'widget' && drag.moved ? drag : null;
  const adding = drag?.kind === 'add' && drag.moved ? drag : null;
  // A widget whose corner is dragged is drawn at the size it would get, so it shows what it shows at that size.
  const shownWidgets =
    dragging?.mode === 'resize'
      ? ed.widgets.map((w) => (w.id === dragging.id ? { ...w, ...dragging.to } : w))
      : ed.widgets;

  return (
    <div className={e.page} data-screen-editor={screen.id}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the editor's keys (Undo, and the chosen widget's arrows) */}
      <div className={e.editor} onKeyDown={onKeyDown}>
        <header className={e.head}>
          <button type="button" className={s.back} onClick={leave}>
            <Icon icon={ChevronLeft} size={15} />
            {T.back}
          </button>
          <div className={e.title}>
            <h1 className={e.name}>{screen.name}</h1>
            <span className={e.sub}>{sub}</span>
          </div>
          <div className={e.actions}>
            {ed.dirty ? <span className={e.dirty}>{E.dirty}</span> : null}
            <Button variant="ghost" onClick={() => say(ed.undo())} disabled={ed.state.undo.past.length === 0}>
              {E.undo}
            </Button>
            <Button onClick={tryIt}>{E.try}</Button>
            <Button variant="primary" onClick={save} disabled={!ed.dirty || saving}>
              {saving ? E.saving : E.save}
            </Button>
          </div>
        </header>

        <div className={e.toolbar}>
          <PageTabs ed={ed} say={say} />
          <Button variant="ghost" size="sm" onClick={() => say(ed.tidy())} disabled={ed.widgets.length === 0}>
            {E.tidy}
          </Button>
          <div className={e.options}>
            <span className={e.optionLabel} id="editor-size">
              {E.size}
            </span>
            <SegmentedControl
              variant="soft"
              size="sm"
              role="radiogroup"
              label={E.size}
              value={draft.size}
              onChange={(size) => say(ed.setSize(size))}
              options={DESK_SIZES.map((x) => ({ value: x, label: DESK_SCREEN_WORDS.sizes[x] }))}
            />
            <span className={e.optionLabel}>{E.turn}</span>
            <SegmentedControl
              variant="soft"
              size="sm"
              role="radiogroup"
              label={E.turn}
              value={draft.turn}
              onChange={(turn) => say(ed.setTurn(turn))}
              options={DESK_TURNS.map((x) => ({ value: x, label: DESK_SCREEN_WORDS.turns[x] }))}
            />
          </div>
        </div>

        <div className={e.main}>
          <div className={e.left}>
            {ed.rearranged ? (
              <p className={e.note}>
                <b>{fillDeskWords(E.rearranged, { grid: gridText(grid.cols, grid.rows) })}</b>
                {fillDeskWords(E.rearrangedRest, { from: ed.rearranged.replace('x', ' × ') })}
              </p>
            ) : null}
            <div className={e.bezel}>
              <div
                ref={(el) => {
                  viewport.current = el;
                  canvasRef.current = el;
                }}
                className={e.viewport}
                style={{ height }}
                tabIndex={-1}
                data-editor-canvas=""
                onPointerDown={(ev) => {
                  if (ev.button === 0 && ev.target === ev.currentTarget) ed.select(null);
                }}
              >
                {scale > 0 ? (
                  <Screen
                    width={shape.width}
                    height={shape.height}
                    scale={scale / grid.zoom}
                    grid={{
                      screen: screen.id,
                      layout: draft,
                      views: live.data?.views ?? [],
                      attention: live.data?.attention ?? NO_ATTENTION,
                      popups: screen.popups,
                    }}
                    calm={calm}
                    name={name}
                    assistant={assistant}
                    timeZone={timeZone}
                    now={now}
                    loadImage={loadImage}
                    editing
                    page={page}
                    widgets={shownWidgets}
                    hidden={dragging?.mode === 'move' ? dragging.id : undefined}
                    overlay={
                      <>
                        <div
                          className={e.hit}
                          onPointerDown={(ev) => {
                            if (ev.button === 0) ed.select(null);
                          }}
                        />
                        {shownWidgets.map((w) => (
                          <EditorWidget
                            key={w.id}
                            grid={grid}
                            widget={w}
                            name={nameOf(w)}
                            chosen={selected === w.id}
                            hiddenWhileMoving={dragging?.id === w.id && dragging.mode === 'move'}
                            noFit={dragging?.id === w.id && dragging.mode === 'resize' && !dragging.ok}
                            onDown={onWidgetDown}
                            onFocus={() => ed.select(w.id)}
                            onRemove={() => say(ed.remove(w.id, nameOf(w)))}
                          />
                        ))}
                        {dragging && dragging.mode === 'move' ? (
                          <>
                            <Ghost
                              grid={grid}
                              to={dragging.swap ? { ...dragging.to, ...dragging.swap.at } : dragging.to}
                              ok={dragging.ok}
                            />
                            {dragging.swap ? (
                              <SwapGhost
                                grid={grid}
                                widget={ed.widgets.find((w) => w.id === dragging.swap?.id)}
                                at={dragging.swap}
                                view={views.get(dragging.swap.id)}
                                calm={calm}
                                now={now}
                              />
                            ) : null}
                            <div
                              className={e.moving}
                              style={{ transform: `translate(${dragging.dx}px, ${dragging.dy}px)` }}
                            >
                              <WidgetBox
                                g={grid}
                                widget={dragging.from}
                                view={views.get(dragging.id)}
                                calm={calm}
                                now={now}
                              />
                            </div>
                          </>
                        ) : null}
                        {dragging && dragging.mode === 'resize' && !dragging.ok ? (
                          <Ghost grid={grid} to={dragging.to} ok={false} />
                        ) : null}
                        {adding?.to ? (
                          <>
                            <Ghost grid={grid} to={adding.to} ok={adding.ok} />
                            <div className={e.ghostWidget}>
                              <WidgetBox
                                g={grid}
                                widget={{
                                  id: 'w_ghost',
                                  type: adding.pick.widget.type,
                                  ...(adding.pick.widget.ref ? { ref: adding.pick.widget.ref } : {}),
                                  opts: adding.pick.widget.opts,
                                  ...adding.to,
                                }}
                                calm={calm}
                                now={now}
                              />
                            </div>
                          </>
                        ) : null}
                      </>
                    }
                  />
                ) : null}
              </div>
            </div>
            <KeysHint />
          </div>
          <WidgetPanel
            api={api}
            screen={screen}
            desk={desk}
            catalog={catalog.data}
            ed={ed}
            views={views}
            calm={calm}
            assistant={assistant}
            timeZone={timeZone}
            now={now}
            loadImage={loadImage}
            shape={shape}
            viewOf={viewOf}
            onPickDown={onPickDown}
            onAdd={(pick) => addPick(pick)}
            onChoose={choose}
            say={say}
            nameOf={nameOf}
          />
        </div>
      </div>
      {adding && !adding.over ? (
        <div className={e.floating} style={{ left: adding.px + 14, top: adding.py + 12 }}>
          {adding.pick.name}
        </div>
      ) : null}
      <Modal open={leaving} onOpenChange={setLeaving}>
        <ModalTitle className={s.dialogTitle}>{E.leaveTitle}</ModalTitle>
        <p className={s.dialogLine}>{E.leaveLine}</p>
        <div className={s.dialogButtons}>
          <Button variant="ghost" onClick={() => setLeaving(false)}>
            {E.stay}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setLeaving(false);
              onBack();
            }}
          >
            {E.leave}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function fitsHere(
  widgets: readonly DeskWidget[],
  c: { x: number; y: number; w: number; h: number },
  g: Pick<Grid, 'cols' | 'rows'>,
  ignore: string,
): boolean {
  if (c.x < 0 || c.y < 0 || c.x + c.w > g.cols || c.y + c.h > g.rows) return false;
  return widgets.every(
    (o) => o.id === ignore || !(c.x < o.x + o.w && o.x < c.x + c.w && c.y < o.y + o.h && o.y < c.y + c.h),
  );
}

/**
 * A widget on the editor's screen, over the drawing: a button that chooses it (and is dragged), and for the chosen one
 * its outline, × and the corner that resizes it.
 */
function EditorWidget({
  grid,
  widget,
  name,
  chosen,
  hiddenWhileMoving,
  noFit,
  onDown,
  onFocus,
  onRemove,
}: {
  grid: Grid;
  widget: DeskWidget;
  name: string;
  chosen: boolean;
  hiddenWhileMoving: boolean;
  noFit: boolean;
  onDown: (event: ReactPointerEvent, w: DeskWidget, mode: 'move' | 'resize') => void;
  onFocus: () => void;
  onRemove: () => void;
}) {
  const r = cellRect(grid, widget);
  return (
    <div
      className={cx(e.widget, chosen && e.chosen, noFit && e.noFit, hiddenWhileMoving && e.away)}
      style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
      data-widget={widget.id}
    >
      <button
        type="button"
        className={e.grab}
        aria-label={fillDeskWords(E.widgetLabel, {
          name,
          w: widget.w,
          h: widget.h,
          x: widget.x + 1,
          y: widget.y + 1,
        })}
        aria-pressed={chosen}
        onPointerDown={(ev) => onDown(ev, widget, 'move')}
        onFocus={onFocus}
      />
      {chosen && !hiddenWhileMoving ? (
        <>
          <button
            type="button"
            className={e.remove}
            aria-label={fillDeskWords(E.removeOne, { name })}
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={onRemove}
          >
            <Icon icon={X} size={18} />
          </button>
          <span
            className={e.handle}
            data-handle=""
            aria-hidden="true"
            onPointerDown={(ev) => onDown(ev, widget, 'resize')}
          />
        </>
      ) : null}
    </div>
  );
}

/** Where a dragged widget lands: dashed, red when the spot is taken. */
function Ghost({
  grid,
  to,
  ok,
}: {
  grid: Grid;
  to: { x: number; y: number; w: number; h: number };
  ok: boolean;
}) {
  const r = cellRect(grid, to);
  return (
    <div
      className={cx(e.ghost, !ok && e.ghostNo)}
      style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
      aria-hidden="true"
    />
  );
}

/** The widget a drag swaps with, drawn faint where it goes (DK-167). */
function SwapGhost({
  grid,
  widget,
  at,
  view,
  calm,
  now,
}: {
  grid: Grid;
  widget: DeskWidget | undefined;
  at: { x: number; y: number };
  view: DeskWidgetView | undefined;
  calm: ComponentProps<typeof WidgetBox>['calm'];
  now: number;
}) {
  if (!widget) return null;
  const placed = { ...widget, ...at };
  const r = cellRect(grid, placed);
  return (
    <>
      <div
        className={cx(e.ghost, e.ghostSwap)}
        style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
        aria-hidden="true"
      />
      <div className={e.ghostWidget} aria-hidden="true">
        <WidgetBox g={grid} widget={placed} view={view} calm={calm} now={now} />
      </div>
    </>
  );
}

/**
 * The editor's keys behind a small *?* under the screen (DK-168): dragging, the arrows, Shift, Delete, swapping and
 * *Tidy up*, in a popover that Escape or a click elsewhere closes.
 */
function KeysHint() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (ev: PointerEvent) => {
      if (!box.current?.contains(ev.target as Node)) setOpen(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className={e.keys} ref={box}>
      <button
        ref={button}
        type="button"
        className={e.keysButton}
        aria-label={E.keys}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open ? (
        <div id={id} className={e.keysPop} role="dialog" aria-label={E.keys}>
          <h2 className={e.keysTitle}>{E.keys}</h2>
          <p>
            {E.hint1}
            <i>{E.hintAdd}</i>
            {E.hint2} <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {E.hint3} <Kbd>Shift</Kbd> {E.hint4} <Kbd>Delete</Kbd>.
          </p>
          <p>{E.hintSwap}</p>
          <p>
            <i>{E.tidy}</i>
            {E.hintTidy}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** The pages along the top, *+ Page*, and the open page's menu (rename, move, delete). */
function PageTabs({ ed, say }: { ed: ScreenEditor; say: (text: string | null) => void }) {
  const { draft, page } = ed.state;
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const current = draft.pages[page];
  return (
    <div className={e.pages} role="tablist" aria-label="Pages">
      {draft.pages.map((p, i) => (
        <span key={p.id} className={e.pageTab}>
          <button
            type="button"
            role="tab"
            aria-selected={i === page}
            className={cx(e.pageButton, i === page && e.pageOn)}
            onClick={() => ed.setPage(i)}
          >
            {p.name}
          </button>
          {i === page ? (
            <span className={e.pageMenuWrap}>
              <button
                type="button"
                className={e.pageMenuButton}
                aria-label={fillDeskWords(E.pageMenu, { name: p.name })}
                aria-expanded={menu}
                aria-haspopup="menu"
                onClick={() => setMenu((m) => !m)}
              >
                <Icon icon={MoreHorizontal} size={15} />
              </button>
              {menu ? (
                <div className={e.menu} role="menu" onKeyDown={(ev) => ev.key === 'Escape' && setMenu(false)}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setRenaming(p.name);
                    }}
                  >
                    {E.rename}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={i === 0}
                    onClick={() => {
                      setMenu(false);
                      ed.movePage(i, -1);
                    }}
                  >
                    {E.moveLeft}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={i === draft.pages.length - 1}
                    onClick={() => {
                      setMenu(false);
                      ed.movePage(i, 1);
                    }}
                  >
                    {E.moveRight}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={e.menuDanger}
                    disabled={draft.pages.length <= 1}
                    onClick={() => {
                      setMenu(false);
                      say(ed.deletePage(i));
                    }}
                  >
                    {E.deletePage}
                  </button>
                </div>
              ) : null}
            </span>
          ) : null}
        </span>
      ))}
      <button type="button" className={cx(e.pageButton, e.addPage)} onClick={() => say(ed.addPage())}>
        {E.addPage}
      </button>
      <Modal open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            if (renaming !== null) ed.renamePage(page, renaming);
            setRenaming(null);
          }}
        >
          <ModalTitle className={s.dialogTitle}>{E.renameTitle}</ModalTitle>
          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor="editor-page-name">
              {E.renameLabel}
            </label>
            <Input
              id="editor-page-name"
              value={renaming ?? ''}
              maxLength={24}
              placeholder={current?.name}
              onChange={(ev) => setRenaming(ev.target.value)}
              autoFocus
            />
          </div>
          <div className={s.dialogButtons}>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              {T.addDialog.cancel}
            </Button>
            <Button variant="primary" type="submit">
              {E.rename}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
