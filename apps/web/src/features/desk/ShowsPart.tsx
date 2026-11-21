/**
 * Settings → Screen → *What it shows*: the preview, and what the screen may show with one choice for everything
 * (*Always · When it matters · Off*) — the top bar's items (remote help and the camera always, with a lock), *The
 * middle* (the assistant's work and what's coming up, the connections and devices, Home's widgets), *Servers* in the
 * strip's order (drag a row, or *Move up* / *Move down*) with This Whombat, and *Around it* (the clock, *Welcome back*,
 * *Done today*). A choice saves at once (`desk.update {show}`), shown before the answer and put back when refused; the
 * preview draws the page's choices, saved or not. On a wide page the preview stays in view beside the choices;
 * narrower, it comes first.
 */
import { isBrandMark } from '@whombat/brand';
import { BrandMark, WhombatLogo } from '@whombat/brand/react';
import {
  DESK_BAR_ITEMS,
  DESK_CLOCKS,
  DESK_PREVIEW_SCENARIOS,
  DESK_SHOW_LEVELS,
  DESK_TRY_S,
  DESK_WORDS,
  type DeskApi,
  type DeskBarItem,
  type DeskPreviewScenario,
  type DeskScreen,
  type DeskShowLevel,
  type DeskShowOption,
  type DeskShowPatch,
  deskErrorText,
  deskShowLevel,
  fillDeskWords,
} from '@whombat/client/desk';
import { useDeskActions, useDeskClock, useDeskPreview } from '@whombat/client/desk/react';
import type { AgentFace } from '@whombat/core';
import {
  BatteryMedium,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Globe,
  GripVertical,
  Headset,
  LayoutGrid,
  Lock,
  type LucideIcon,
  Plug,
  RefreshCw,
  Server,
  Sparkles,
  Wifi,
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
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import styles from '../settings/SettingsScreen.module.css';
import { DeskPreviewScreen } from './DeskPreviewScreen';
import s from './Screen.module.css';
import {
  moveServer,
  placeServer,
  sameOrder,
  scenarioName,
  serverIdOf,
  showGroups,
  stripOrder,
} from './screenTab';

const W = DESK_WORDS.settings;

export const BAR_ICONS: Record<DeskBarItem, LucideIcon> = {
  network: Wifi,
  internet: Globe,
  battery: BatteryMedium,
  updates: RefreshCw,
};

export interface ShowsPartProps {
  api: DeskApi;
  screen: DeskScreen;
  assistant: string;
  /** The assistant's face, for the preview of a look it looked into. */
  face?: AgentFace;
  timeZone: string;
}

export function ShowsPart({ api, screen, assistant, face, timeZone }: ShowsPartProps) {
  const actions = useDeskActions(api);
  const toast = useToast();
  const show = screen.settings.show;
  const groups = showGroups(screen.showOptions ?? []);
  const fill = (text: string) => fillDeskWords(text, { assistant });
  const save = (patch: DeskShowPatch) =>
    void actions.update({ show: patch }).catch((error) => toast.show(deskErrorText(error)));
  const setLevel = (key: string) => (level: DeskShowLevel) => save({ items: { [key]: level } });
  const option = (o: DeskShowOption) => (
    <LevelRow
      key={o.key}
      row={o.key}
      mark={<OptionMark option={o} />}
      name={o.name}
      line={o.line}
      value={deskShowLevel(show, o.key)}
      onChange={setLevel(o.key)}
    />
  );
  return (
    <div className={s.cols}>
      <PreviewCard
        api={api}
        screen={screen}
        assistant={assistant}
        {...(face ? { face } : {})}
        timeZone={timeZone}
      />
      <div className={s.choices}>
        <ChoiceCard title={W.bar} hint={W.barHint} data="bar">
          {DESK_BAR_ITEMS.map((item) => (
            <LevelRow
              key={item}
              row={`bar:${item}`}
              mark={<Icon icon={BAR_ICONS[item]} size={16} />}
              name={W.barItems[item].name}
              line={W.barItems[item].line}
              value={show.bar[item]}
              onChange={(level) => save({ bar: { [item]: level } })}
            />
          ))}
          <div className={cx(styles.row, s.choiceRow)} data-row="bar:fixed">
            <Tile>
              <Icon icon={Headset} size={16} />
            </Tile>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{W.alwaysShown}</span>
              <span className={styles.rowMeta}>{W.alwaysShownHint}</span>
            </span>
            <span className={s.fixed}>
              <Icon icon={Lock} size={13} />
              {W.levels.always}
            </span>
          </div>
        </ChoiceCard>

        <ChoiceCard title={W.middle} hint={fill(W.middleHint)} data="middle">
          {groups.assistant.length > 0 ? (
            <>
              <GroupLabel>{fill(W.groups.assistant)}</GroupLabel>
              {groups.assistant.map((o) => (
                <LevelRow
                  key={o.key}
                  row={o.key}
                  mark={<OptionMark option={o} />}
                  name={o.key === 'work' ? fill(W.work.name) : o.key === 'coming' ? W.coming.name : o.name}
                  line={o.key === 'work' ? fill(W.work.line) : o.key === 'coming' ? W.coming.line : o.line}
                  value={deskShowLevel(show, o.key)}
                  onChange={setLevel(o.key)}
                />
              ))}
            </>
          ) : null}
          {groups.connection.length > 0 ? (
            <>
              <GroupLabel>{W.groups.connection}</GroupLabel>
              {groups.connection.map(option)}
            </>
          ) : null}
          {groups.widget.length > 0 ? (
            <>
              <GroupLabel>{W.groups.widget}</GroupLabel>
              {groups.widget.map(option)}
            </>
          ) : null}
        </ChoiceCard>

        {groups.server.length > 0 || groups.box ? (
          <ChoiceCard title={W.servers} hint={W.serversHint} data="servers">
            <ServerRows
              servers={groups.server}
              order={show.order}
              level={(key) => deskShowLevel(show, key)}
              onLevel={(key, level) => setLevel(key)(level)}
              onOrder={(order) => save({ order })}
            />
            {groups.box ? (
              <LevelRow
                row="box"
                mark={<WhombatLogo height={16} />}
                name={W.box.name}
                line={W.box.line}
                value={deskShowLevel(show, 'box')}
                onChange={setLevel('box')}
              />
            ) : null}
          </ChoiceCard>
        ) : null}

        <ChoiceCard title={W.around} data="around">
          <ClockRow value={show.clock} onChange={(clock) => save({ clock })} />
          <SwitchChoice
            row="welcome-back"
            name={W.welcomeBack.name}
            line={W.welcomeBack.line}
            checked={show.welcomeBack}
            onChange={(welcomeBack) => save({ welcomeBack })}
          />
          <SwitchChoice
            row="done-today"
            name={W.doneToday.name}
            line={fill(W.doneToday.line)}
            checked={show.doneToday}
            onChange={(doneToday) => save({ doneToday })}
          />
        </ChoiceCard>
      </div>
    </div>
  );
}

/**
 * The box's own screen's choices around its widgets (Settings → Screens → This Whombat's screen, 3.6): the top bar's
 * items and *Around it*'s *Welcome back* and *Done today*. The middle and the strip are the *What’s going on* and
 * *Servers* widgets' own settings now (the editor).
 */
export function TopBarPart({ api, screen, assistant }: Pick<ShowsPartProps, 'api' | 'screen' | 'assistant'>) {
  const actions = useDeskActions(api);
  const toast = useToast();
  const show = screen.settings.show;
  const fill = (text: string) => fillDeskWords(text, { assistant });
  const save = (patch: DeskShowPatch) =>
    void actions.update({ show: patch }).catch((error) => toast.show(deskErrorText(error)));
  return (
    <div className={s.choices}>
      <ChoiceCard title={W.bar} hint={W.barHint} data="bar">
        {DESK_BAR_ITEMS.map((item) => (
          <LevelRow
            key={item}
            row={`bar:${item}`}
            mark={<Icon icon={BAR_ICONS[item]} size={16} />}
            name={W.barItems[item].name}
            line={W.barItems[item].line}
            value={show.bar[item]}
            onChange={(level) => save({ bar: { [item]: level } })}
          />
        ))}
        <div className={cx(styles.row, s.choiceRow)} data-row="bar:fixed">
          <Tile>
            <Icon icon={Headset} size={16} />
          </Tile>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{W.alwaysShown}</span>
            <span className={styles.rowMeta}>{W.alwaysShownHint}</span>
          </span>
          <span className={s.fixed}>
            <Icon icon={Lock} size={13} />
            {W.levels.always}
          </span>
        </div>
      </ChoiceCard>
      <ChoiceCard title={W.around} data="around">
        <SwitchChoice
          row="welcome-back"
          name={W.welcomeBack.name}
          line={W.welcomeBack.line}
          checked={show.welcomeBack}
          onChange={(welcomeBack) => save({ welcomeBack })}
        />
        <SwitchChoice
          row="done-today"
          name={W.doneToday.name}
          line={fill(W.doneToday.line)}
          checked={show.doneToday}
          onChange={(doneToday) => save({ doneToday })}
        />
      </ChoiceCard>
    </div>
  );
}

/* The preview ------------------------------------------------------------------------------------------------------ */

/**
 * The box's own calm glance for the page's choices (`desk.preview`), for *Now*, *Something’s wrong* or *{assistant} at
 * work*; *Try “…” on the screen* shows it on the screen itself for a minute (`desk.tryOnScreen`).
 */
function PreviewCard({ api, screen, assistant, face, timeZone }: ShowsPartProps) {
  const id = useId();
  const toast = useToast();
  const [scenario, setScenario] = useState<DeskPreviewScenario>('now');
  const show = screen.settings.show;
  const input = useMemo(() => ({ scenario, show }), [scenario, show]);
  const preview = useDeskPreview(api, input);
  // The preview's clock moves with the minute.
  const now = useDeskClock(true, 15_000);
  const [until, setUntil] = useState<number | null>(null);
  const trying = useDeskClock(until !== null, 1_000) < (until ?? 0);
  useEffect(() => {
    if (until !== null && !trying) setUntil(null);
  }, [until, trying]);
  const name = scenarioName(scenario, assistant);
  const tryIt = () =>
    void api.tryOnScreen(input).then(
      (r) => setUntil(Date.parse(r.until) || Date.now() + DESK_TRY_S * 1000),
      (error) => toast.show(deskErrorText(error)),
    );
  return (
    <section className={cx(styles.card, s.preview)} aria-labelledby={id} data-preview-card="">
      <div className={s.previewHead}>
        <SectionLabel as="h3" id={id}>
          {W.preview}
        </SectionLabel>
        <SegmentedControl
          variant="soft"
          size="sm"
          label={W.preview}
          className={s.scenarios}
          value={scenario}
          onChange={setScenario}
          options={DESK_PREVIEW_SCENARIOS.map((value) => ({ value, label: scenarioName(value, assistant) }))}
        />
      </div>
      {preview.data ? (
        <DeskPreviewScreen
          preview={preview.data}
          assistant={assistant}
          {...(face ? { face } : {})}
          timeZone={timeZone}
          hasBattery={screen.hasBattery}
          now={now}
        />
      ) : (
        <div className={s.previewWait} data-theme="dark" />
      )}
      <p className={s.note}>{W.previewNote}</p>
      <div className={s.tryRow}>
        <Button variant="secondary" size="sm" onClick={tryIt}>
          {fillDeskWords(W.tryOnScreen, { scenario: name })}
        </Button>
        <span className={s.trying} role="status">
          {trying ? W.trying : null}
        </span>
      </div>
    </section>
  );
}

/* Rows ------------------------------------------------------------------------------------------------------------- */

export function ChoiceCard({
  title,
  hint,
  data,
  children,
}: {
  title: string;
  hint?: string;
  data: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={cx(styles.card, s.card)} aria-labelledby={id} data-choices={data}>
      <div className={s.cardHead}>
        <SectionLabel as="h3" id={id}>
          {title}
        </SectionLabel>
        {hint ? <p className={s.cardHint}>{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <SectionLabel as="h4" size="sm" className={s.group}>
      {children}
    </SectionLabel>
  );
}

/** The 28 px tile a row's mark sits in. */
export function Tile({ children }: { children: ReactNode }) {
  return <span className={s.tile}>{children}</span>;
}

/** A choice's mark: the brand's or the system's where there is one, else a line icon for its kind. */
export function OptionMark({ option }: { option: DeskShowOption }) {
  if (option.mark && isBrandMark(option.mark)) return <BrandMark mark={option.mark} size={18} />;
  const icon: LucideIcon =
    option.key === 'work'
      ? Sparkles
      : option.key === 'coming'
        ? CalendarClock
        : option.group === 'widget'
          ? LayoutGrid
          : option.group === 'server'
            ? Server
            : Plug;
  return <Icon icon={icon} size={16} />;
}

/** Always · When it matters · Off, beside what it is about. */
function LevelControl({
  name,
  describedBy,
  value,
  onChange,
}: {
  name: string;
  describedBy: string | undefined;
  value: DeskShowLevel;
  onChange: (level: DeskShowLevel) => void;
}) {
  return (
    <SegmentedControl
      variant="soft"
      size="sm"
      role="radiogroup"
      label={name}
      describedBy={describedBy}
      className={s.level}
      value={value}
      onChange={onChange}
      options={DESK_SHOW_LEVELS.map((level) => ({ value: level, label: W.levels[level] }))}
    />
  );
}

export function LevelRow({
  row,
  mark,
  name,
  line,
  value,
  onChange,
}: {
  row: string;
  mark: ReactNode;
  name: string;
  line: string;
  value: DeskShowLevel;
  onChange: (level: DeskShowLevel) => void;
}) {
  const id = useId();
  return (
    <div className={cx(styles.row, s.choiceRow)} data-row={row} data-level={value}>
      <Tile>{mark}</Tile>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{name}</span>
        {line ? (
          <span className={cx(styles.rowMeta, s.line)} id={`${id}-line`}>
            {line}
          </span>
        ) : null}
      </span>
      <LevelControl
        name={name}
        describedBy={line ? `${id}-line` : undefined}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

/**
 * The servers in the strip's order. A row's grip drags it (a pointer; the rows make room as it passes them, and the
 * order is saved when it's let go); *Move up* and *Move down* do the same from the keyboard or a touch, keeping focus
 * on the button. The order saved is every server listed, as shown.
 */
export function ServerRows({
  servers,
  order,
  level,
  onLevel,
  onOrder,
}: {
  servers: readonly DeskShowOption[];
  order: readonly string[];
  level: (key: string) => DeskShowLevel;
  onLevel: (key: string, level: DeskShowLevel) => void;
  onOrder: (order: string[]) => void;
}) {
  const byId = new Map(servers.map((o) => [serverIdOf(o.key), o]));
  const ids = stripOrder([...byId.keys()], order);
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const live = useRef({ drag, ids, onOrder });
  live.current = { drag, ids, onOrder };
  // A server that went while it was dragged drops out of the rows.
  const shown = (drag?.order ?? ids).filter((id) => byId.has(id));

  const start = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setDrag({ id, order: ids });
    const move = (e: PointerEvent) => {
      const now = live.current.drag;
      if (!now) return;
      // The place among the other rows: after every row whose middle is above the pointer.
      const to = now.order
        .filter((x) => x !== now.id)
        .filter((x) => {
          const r = rows.current.get(x)?.getBoundingClientRect();
          return r ? e.clientY > r.top + r.height / 2 : false;
        }).length;
      const next = placeServer(now.order, now.id, to);
      if (!sameOrder(next, now.order)) setDrag({ id: now.id, order: next });
    };
    const end = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const { drag: done, ids: before, onOrder: save } = live.current;
      setDrag(null);
      if (e.type === 'pointerup' && done && !sameOrder(done.order, before)) save(done.order);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <>
      {shown.map((id, i) => {
        const o = byId.get(id) as DeskShowOption;
        return (
          <ServerRow
            key={o.key}
            ref={(el) => {
              if (el) rows.current.set(id, el);
              else rows.current.delete(id);
            }}
            option={o}
            dragging={drag?.id === id}
            first={i === 0}
            last={i === shown.length - 1}
            value={level(o.key)}
            onLevel={(l) => onLevel(o.key, l)}
            onGrip={(e) => start(e, id)}
            onMove={(by) => {
              const next = moveServer(ids, id, by);
              if (!sameOrder(next, ids)) onOrder(next);
            }}
          />
        );
      })}
    </>
  );
}

function ServerRow({
  ref,
  option,
  dragging,
  first,
  last,
  value,
  onLevel,
  onGrip,
  onMove,
}: {
  ref: (el: HTMLDivElement | null) => void;
  option: DeskShowOption;
  dragging: boolean;
  first: boolean;
  last: boolean;
  value: DeskShowLevel;
  onLevel: (level: DeskShowLevel) => void;
  onGrip: (event: ReactPointerEvent) => void;
  onMove: (by: -1 | 1) => void;
}) {
  const id = useId();
  const name = option.name;
  return (
    <div
      ref={ref}
      className={cx(styles.row, s.choiceRow, s.serverRow)}
      data-row={option.key}
      data-level={value}
      data-dragging={dragging || undefined}
    >
      <span className={s.grip} onPointerDown={onGrip} aria-hidden="true">
        <Icon icon={GripVertical} size={16} />
      </span>
      <Tile>
        <OptionMark option={option} />
      </Tile>
      <span className={styles.rowMain}>
        <span className={cx(styles.rowTitle, s.serverName)}>{name}</span>
        {option.line ? (
          <span className={cx(styles.rowMeta, s.line)} id={`${id}-line`}>
            {option.line}
          </span>
        ) : null}
      </span>
      <span className={s.moves}>
        <button
          type="button"
          className={s.move}
          aria-label={fillDeskWords(W.moveUp, { name })}
          aria-disabled={first || undefined}
          onClick={() => onMove(-1)}
        >
          <Icon icon={ChevronUp} size={16} />
        </button>
        <button
          type="button"
          className={s.move}
          aria-label={fillDeskWords(W.moveDown, { name })}
          aria-disabled={last || undefined}
          onClick={() => onMove(1)}
        >
          <Icon icon={ChevronDown} size={16} />
        </button>
      </span>
      <LevelControl
        name={name}
        describedBy={option.line ? `${id}-line` : undefined}
        value={value}
        onChange={onLevel}
      />
    </div>
  );
}

/** The clock: Big or Small. */
function ClockRow({
  value,
  onChange,
}: {
  value: (typeof DESK_CLOCKS)[number];
  onChange: (clock: (typeof DESK_CLOCKS)[number]) => void;
}) {
  const id = useId();
  return (
    <div className={cx(styles.row, s.choiceRow)} data-row="clock">
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{W.clock.name}</span>
        <span className={cx(styles.rowMeta, s.line)} id={`${id}-line`}>
          {W.clock.line}
        </span>
      </span>
      <SegmentedControl
        variant="soft"
        size="sm"
        role="radiogroup"
        label={W.clock.name}
        describedBy={`${id}-line`}
        className={s.level}
        value={value}
        onChange={onChange}
        options={DESK_CLOCKS.map((clock) => ({ value: clock, label: W.clocks[clock] }))}
      />
    </div>
  );
}

export function SwitchChoice({
  row,
  name,
  line,
  checked,
  onChange,
}: {
  row: string;
  name: string;
  line: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className={cx(styles.row, s.choiceRow)} data-row={row}>
      <span className={styles.rowMain}>
        <label className={styles.rowTitle} htmlFor={`${id}-switch`}>
          {name}
        </label>
        <span className={cx(styles.rowMeta, s.line)} id={`${id}-line`}>
          {line}
        </span>
      </span>
      <Toggle
        id={`${id}-switch`}
        checked={checked}
        aria-describedby={`${id}-line`}
        onCheckedChange={onChange}
      />
    </div>
  );
}
