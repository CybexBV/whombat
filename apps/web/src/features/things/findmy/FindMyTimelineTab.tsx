/**
 * The Find My connection's Timeline tab (docs/implementation/macos/findmy-timeline.md §1, its mockup
 * `findmy-timeline-mockup.html`): before it's on, one card to tick whose days to keep; when it's on, a bar to step
 * through the last 30 days or see the last seven, everyone's day as strips with the places' colours, one person's day on
 * a map the Mac draws with the stops numbered and as a list, a week of strips with its totals, and the timeline's
 * settings at the end (whose, how long, whether the assistant reads it, delete, stop). Days are cut in the device's
 * time zone. The tab names the Mac (`ThingPageTab.server`) only for its name in the gaps' words.
 */
import { HUMAN_TONES, initialsFor } from '@whombat/avatars';
import { HumanAvatar } from '@whombat/avatars/react';
import {
  type FindMyAxis,
  type FindMyStripPart,
  findMyAxis,
  findMyDayMeta,
  findMyDayTitle,
  findMyDeviceTimeZone,
  findMyEvery,
  findMyEveryoneMeta,
  findMyFirstDay,
  findMyFirstName,
  findMyKeptSince,
  findMyLegend,
  findMyListRows,
  findMyMapAsk,
  findMyMinutes,
  findMyNowAt,
  findMyNowMark,
  findMyPickedPerson,
  findMyPlaceOrder,
  findMyStopTones,
  findMyStrip,
  findMyTimelineLines,
  findMyTimelineMarks,
  findMyTimelineOn,
  findMyTimelinePace,
  findMyToday,
  findMyTones,
  findMyWeekDay,
  findMyWeekRange,
  findMyWeekTotals,
  findMyWhoseAfter,
  hostErrorInfo,
  FIND_MY_TIMELINE_WORDS as W,
} from '@whombat/client/hosts';
import {
  useFindMyTimeline,
  useFindMyTimelineAssistant,
  useFindMyTimelineChange,
  useFindMyTimelineFresh,
  useFindMyTimelineMap,
  useHostsFleet,
} from '@whombat/client/hosts/react';
import { useTheAgent } from '@whombat/client/react';
import {
  FIND_MY_TIMELINE_SPAN_MAX,
  type FindMyTimeline,
  type FindMyTimelineDay,
  type FindMyTimelinePerson,
  type FindMyTimelineSegment,
  findMyDateAdd,
  findMyTimelinePins,
} from '@whombat/core/domain';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../../app/theme/ThemeProvider';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { useToast } from '../../../components/Toast';
import { Toggle } from '../../../components/Toggle';
import { useNow } from '../../messaging/useRoom';
import { Card, ConfirmDialog, Empty, ErrorLine, Skeleton } from '../parts';
import styles from '../Things.module.css';
import t from './FindMyTimeline.module.css';

/** The places' colours by tone (`findMyPlaceTone`): the chart series, then one more. */
const PLACE_COLOURS = ['var(--chart1)', 'var(--chart2)', 'var(--chart3)', 'var(--chart4)', 'var(--mut)'];
const colour = (tone: number) => PLACE_COLOURS[tone] ?? PLACE_COLOURS[0];

type Mode = 'day' | 'week';

interface Who {
  person: FindMyTimelinePerson;
  first: string;
  tone: string;
}

/** The tab of the Find My connection `connectionId`, whose Mac is `serverId`. */
export function FindMyTimelineTab({
  burrow,
  connectionId,
  serverId,
}: {
  burrow: string;
  connectionId: string;
  serverId: string;
}) {
  const tz = useMemo(findMyDeviceTimeZone, []);
  const now = useNow(30_000);
  const today = findMyToday(now, tz);
  const [mode, setMode] = useState<Mode>('day');
  const [chosen, setChosen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const date = mode === 'week' ? today : (chosen ?? today);
  const days = mode === 'week' ? FIND_MY_TIMELINE_SPAN_MAX : 1;
  const read = useFindMyTimeline({ burrow, connectionId, date, days, tz, live: date === today });
  useFindMyTimelineFresh(connectionId, read.data?.readAt);
  const fleet = useHostsFleet({ params: { burrow } }, { retry: false, staleTime: 60_000 });
  const mac = fleet.data?.servers.find((s) => s.id === serverId)?.name ?? serverId;
  // Each place keeps its colour while the tab is open (Home first).
  const order = useRef<string[]>([]);
  if (read.data) order.current = findMyPlaceOrder(order.current, read.data.days);

  const data = read.data;
  if (!data)
    return read.error ? (
      <Card id="findmy-timeline" title={W.everyone}>
        <ErrorLine error={read.error} onRetry={() => void read.refetch()} />
      </Card>
    ) : (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the timeline"
        style={{ display: 'grid', gap: 18 }}
      >
        <Skeleton height={44} />
        <Skeleton height={200} />
        <Skeleton height={420} />
      </div>
    );

  const tones = findMyTones(data.people.map((p) => p.id));
  const who: Who[] = data.people.map((person, i) => ({
    person,
    first: findMyFirstName(person.name),
    tone: HUMAN_TONES[tones[i] ?? 0] ?? HUMAN_TONES[0],
  }));
  const ctx: TabContext = {
    burrow,
    connectionId,
    tz,
    now,
    today,
    mac,
    order: order.current,
    who,
    timeline: data,
  };

  if (!findMyTimelineOn(data.people))
    return (
      <div className={t.tab}>
        <BeforeItsOn ctx={ctx} />
      </div>
    );

  const person = findMyPickedPerson(data.people, picked);
  return (
    <div className={t.tab} aria-busy={read.isPlaceholderData || undefined}>
      <DayBar
        mode={mode}
        date={date}
        today={today}
        onStep={(n) => setChosen(findMyDateAdd(date, n))}
        onMode={(m) => {
          setMode(m);
          if (m === 'week') setChosen(null);
        }}
      />
      {mode === 'day' ? (
        <>
          <Everyone ctx={ctx} day={data.days.at(-1)} picked={person} onPick={setPicked} />
          {person ? <PersonDay ctx={ctx} day={data.days.at(-1)} id={person} /> : null}
        </>
      ) : (
        <Week
          ctx={ctx}
          picked={person}
          onPick={setPicked}
          onDay={(d) => {
            setMode('day');
            setChosen(d === today ? null : d);
          }}
        />
      )}
      <Settings ctx={ctx} picked={person} />
    </div>
  );
}

interface TabContext {
  burrow: string;
  connectionId: string;
  tz: string;
  now: number;
  today: string;
  /** The Mac's name as the page shows it. */
  mac: string;
  order: readonly string[];
  who: Who[];
  timeline: FindMyTimeline;
}

/* The bar ---------------------------------------------------------------------------------------------- */

function DayBar({
  mode,
  date,
  today,
  onStep,
  onMode,
}: {
  mode: Mode;
  date: string;
  today: string;
  onStep: (n: number) => void;
  onMode: (m: Mode) => void;
}) {
  const week = mode === 'week';
  const title = findMyDayTitle(date, today);
  return (
    <div className={t.bar}>
      <div className={t.day}>
        <button
          type="button"
          className={t.step}
          aria-label={W.dayBefore}
          title={W.dayBefore}
          disabled={week || date <= findMyFirstDay(today)}
          onClick={() => onStep(-1)}
        >
          <Icon icon={ChevronLeft} size={16} />
        </button>
        <button
          type="button"
          className={t.step}
          aria-label={W.dayAfter}
          title={W.dayAfter}
          disabled={week || date >= today}
          onClick={() => onStep(1)}
        >
          <Icon icon={ChevronRight} size={16} />
        </button>
        <b className={t.dayTitle} aria-live="polite">
          {week ? W.lastWeek : title.title}
        </b>
        {week ? null : <span className={t.dayDate}>{title.date}</span>}
      </div>
      <SegmentedControl<Mode>
        variant="soft"
        options={[
          { value: 'day', label: W.day },
          { value: 'week', label: W.week },
        ]}
        value={mode}
        onChange={onMode}
        label={W.dayOrWeek}
      />
    </div>
  );
}

/* Strips ----------------------------------------------------------------------------------------------- */

function partStyle(p: FindMyStripPart): CSSProperties {
  return {
    left: `${(p.at * 100).toFixed(3)}%`,
    width: `${(p.width * 100).toFixed(3)}%`,
    ...(p.kind === 'stay' ? { background: colour(p.tone) } : {}),
  };
}

function Strip({
  segments,
  day,
  ctx,
  label,
}: {
  segments: readonly FindMyTimelineSegment[];
  day: Pick<FindMyTimelineDay, 'from' | 'to'>;
  ctx: TabContext;
  label: string;
}) {
  const parts = findMyStrip(segments, day, ctx.order, ctx.tz);
  const nowAt = findMyNowAt(day, ctx.now);
  return (
    <div className={t.strip} role="img" aria-label={label}>
      {parts.map((p, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one strip, in order
          key={i}
          className={p.kind === 'trip' ? t.trip : p.kind === 'gap' ? t.gap : undefined}
          style={partStyle(p)}
          title={p.title}
        />
      ))}
      {nowAt !== null ? <i className={t.nowLine} style={{ left: `${(nowAt * 100).toFixed(3)}%` }} /> : null}
    </div>
  );
}

function Axis({ axis, end = true }: { axis: FindMyAxis; end?: boolean }) {
  return (
    <div className={cx(t.axis, !end && t.axisWeek)} aria-hidden="true">
      <span />
      <div className={t.ticks}>
        {axis.ticks.map((tick, i) => (
          <span
            key={tick.label}
            className={cx(i === 0 && t.first, i === axis.ticks.length - 1 && t.last, tick.near && t.near)}
            style={{ left: `${tick.at * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
        {axis.now ? (
          <span className={t.nowTick} style={{ left: `${axis.now.at * 100}%` }}>
            {axis.now.label}
          </span>
        ) : null}
      </div>
      {end ? <span /> : null}
    </div>
  );
}

function Swatch({ kind, tone }: { kind: 'stay' | 'trip' | 'gap'; tone?: number }) {
  return (
    <i
      className={cx(t.swatch, kind === 'trip' && t.trip, kind === 'gap' && t.gap)}
      style={kind === 'stay' ? { background: colour(tone ?? 0) } : undefined}
      aria-hidden="true"
    />
  );
}

function Avatar({ who, size = 30, label }: { who: Who; size?: number; label?: boolean }) {
  return (
    <HumanAvatar
      initials={initialsFor(who.person.name)}
      tone={who.tone}
      size={size}
      label={label ? who.person.name : undefined}
    />
  );
}

/* Everyone --------------------------------------------------------------------------------------------- */

function Everyone({
  ctx,
  day,
  picked,
  onPick,
}: {
  ctx: TabContext;
  day: FindMyTimelineDay | undefined;
  picked: string | null;
  onPick: (id: string) => void;
}) {
  const change = useFindMyTimelineChange(ctx.burrow, ctx.connectionId);
  const toast = useToast();
  if (!day) return null;
  const isToday = day.date === ctx.today;
  const title = findMyDayTitle(day.date, ctx.today).title;
  const segmentsOf = (id: string) => day.people.find((p) => p.person === id)?.segments ?? [];
  const kept = ctx.who.filter((w) => w.person.kept);
  const legend = findMyLegend(
    ctx.order,
    kept.map((w) => segmentsOf(w.person.id)),
  );
  return (
    <Card
      id="findmy-timeline-everyone"
      title={W.everyone}
      meta={findMyEveryoneMeta(ctx.timeline, isToday, ctx.tz)}
    >
      <div className={t.strips}>
        {ctx.who.map((w) => {
          const nowAt = isToday ? (w.person.now?.place ?? '') : '';
          if (!w.person.kept)
            return (
              <div key={w.person.id} className={t.row}>
                <span className={t.who}>
                  <Avatar who={w} label />
                  <span className={t.name}>{w.first}</span>
                </span>
                <div className={cx(t.strip, t.off)}>
                  {W.notKept} ·{' '}
                  <button
                    type="button"
                    className={t.link}
                    disabled={change.pending}
                    onClick={() =>
                      void change
                        .change({
                          kind: 'set',
                          people: findMyWhoseAfter(ctx.timeline.people, w.person.id, true),
                        })
                        .then((problem) => problem && toast.show(problem))
                    }
                  >
                    {W.keepToo(w.first)}
                  </button>
                </div>
                <span className={t.nowAt}>{nowAt}</span>
              </div>
            );
          return (
            <button
              key={w.person.id}
              type="button"
              className={cx(t.row, t.pick)}
              aria-pressed={picked === w.person.id}
              onClick={() => onPick(w.person.id)}
            >
              <span className={t.who}>
                <Avatar who={w} label />
                <span className={t.name}>{w.first}</span>
              </span>
              <Strip
                segments={segmentsOf(w.person.id)}
                day={day}
                ctx={ctx}
                label={W.stripLabel(w.first, title)}
              />
              <span className={t.nowAt}>{nowAt}</span>
            </button>
          );
        })}
        <Axis axis={findMyAxis(day, ctx.tz, isToday ? ctx.now : null)} />
      </div>
      <div className={t.legend}>
        {legend.map((l) => (
          <span key={l.key}>
            <Swatch kind="stay" tone={l.tone} />
            {l.label}
          </span>
        ))}
        <span>
          <Swatch kind="trip" />
          {W.onTheWay}
        </span>
        <span>
          <Swatch kind="gap" />
          {W.notRead}
        </span>
      </div>
    </Card>
  );
}

/* One person's day ------------------------------------------------------------------------------------- */

function PersonDay({ ctx, day, id }: { ctx: TabContext; day: FindMyTimelineDay | undefined; id: string }) {
  const w = ctx.who.find((x) => x.person.id === id);
  if (!w || !day) return null;
  const segments = day.people.find((p) => p.person === id)?.segments ?? [];
  const rows = findMyListRows(segments, {
    tz: ctx.tz,
    day,
    person: w.person,
    mac: ctx.mac,
    order: ctx.order,
  });
  const pace = findMyTimelinePace(ctx.timeline.paceMinutes);
  return (
    <section className={styles.card} aria-labelledby="findmy-timeline-person">
      <header className={cx(styles.cardHead, t.personHead)}>
        <Avatar who={w} />
        <h2 id="findmy-timeline-person">{w.person.name}</h2>
        <span className={styles.meta}>{findMyDayMeta(segments, w.person)}</span>
      </header>
      <DayMap ctx={ctx} who={w} date={day.date} segments={segments} />
      <div className={cx(styles.cardNote, t.note)}>
        <p>{W.linesNote(w.first)}</p>
        <p>{W.spotsNote(findMyMinutes(pace))}</p>
      </div>
      {rows.length === 0 ? (
        <Empty>{W.nothingKept(w.first)}</Empty>
      ) : (
        <ol className={t.list}>
          {rows.map((r) => (
            <li key={r.key} className={cx(r.kind === 'trip' && t.isTrip, r.kind === 'gap' && t.isGap)}>
              <span className={t.time}>{r.time}</span>
              <span className={t.rail}>
                {r.kind === 'stay' ? (
                  <span className={t.dot} style={{ background: colour(r.tone) }} aria-hidden="true">
                    {r.n}
                  </span>
                ) : null}
              </span>
              <div className={t.body}>
                {r.kind === 'stay' ? (
                  <>
                    <b>{r.place}</b>
                    {r.ongoing ? <span className={cx(t.pill, t.pillNow)}>{W.now}</span> : null}
                    {r.nearby ? <span className={cx(t.pill, t.pillOk)}>{W.nearby}</span> : null}
                    <span className={t.sub}>
                      {r.sub}
                      <span className={t.durIn}>
                        {r.sub ? ' · ' : ''}
                        {r.duration}
                      </span>
                    </span>
                    {r.holes.map((h) => (
                      <span key={h} className={t.sub}>
                        {h}
                      </span>
                    ))}
                  </>
                ) : (
                  <>
                    <b>{r.title}</b>
                    <span className={t.sub}>
                      {r.sub}
                      <span className={t.durIn}>
                        {r.sub ? ' · ' : ''}
                        {r.duration}
                      </span>
                    </span>
                  </>
                )}
              </div>
              <span className={t.dur}>{r.duration}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The size of an element in CSS pixels, following it as the page changes. */
function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * The person's day on the Mac's map: each distinct spot numbered (“2, 4”), dashed lines between the stops in order,
 * dotted where Whombat didn't read in between, and the person over the stop they're at now. A calm line while it draws
 * or when the day has no spot.
 */
function DayMap({
  ctx,
  who,
  date,
  segments,
}: {
  ctx: TabContext;
  who: Who;
  date: string;
  segments: readonly FindMyTimelineSegment[];
}) {
  const { theme } = useTheme();
  const [ref, box] = useBoxSize<HTMLDivElement>();
  const spots = findMyTimelinePins(segments).length > 0;
  const map = useFindMyTimelineMap({
    burrow: ctx.burrow,
    connectionId: ctx.connectionId,
    person: who.person.id,
    date,
    tz: ctx.tz,
    ask: findMyMapAsk(box),
    dark: theme === 'dark',
    enabled: spots,
  });
  const shown = map.shown;
  const marks = shown
    ? findMyTimelineMarks(shown.map.points, shown.ask, box, findMyStopTones(segments, ctx.order))
    : [];
  const lines = findMyTimelineLines(segments, marks);
  const here = findMyNowMark(segments, marks);
  const quiet =
    !spots || map.noSpots ? W.noSpots(who.first) : map.error ? hostErrorInfo(map.error).message : W.drawing;
  return (
    <div ref={ref} className={t.map} aria-busy={map.drawing || undefined}>
      {shown && spots ? (
        <>
          <img
            className={t.picture}
            src={`data:image/${shown.map.format};base64,${shown.map.imageB64}`}
            alt={W.mapAlt(who.first)}
            draggable={false}
          />
          <svg className={t.lines} width={box.w} height={box.h} aria-hidden="true">
            {lines.map((l) => (
              <line
                key={`${l.x1},${l.y1},${l.x2},${l.y2}`}
                x1={l.x1}
                y1={l.y1}
                x2={l.x2}
                y2={l.y2}
                className={l.dotted ? t.dotted : t.dashed}
              />
            ))}
          </svg>
          {marks.map((m) => (
            <span
              key={m.label}
              className={t.mark}
              style={{ left: m.x, top: m.y, background: colour(m.tone) }}
              aria-hidden="true"
            >
              {m.label}
            </span>
          ))}
          {here ? (
            <span className={t.here} style={{ left: here.x, top: here.y }} aria-hidden="true">
              <HumanAvatar
                initials={initialsFor(who.person.name)}
                tone={who.tone}
                size={30}
                className={t.hereAvatar}
              />
              <i className={t.hereStem} />
            </span>
          ) : null}
        </>
      ) : (
        <span className={t.quiet} role={map.error ? 'status' : undefined}>
          {quiet}
        </span>
      )}
    </div>
  );
}

/* The week --------------------------------------------------------------------------------------------- */

function Week({
  ctx,
  picked,
  onPick,
  onDay,
}: {
  ctx: TabContext;
  picked: string | null;
  onPick: (id: string) => void;
  onDay: (date: string) => void;
}) {
  const kept = ctx.who.filter((w) => w.person.kept);
  const w = kept.find((x) => x.person.id === picked) ?? kept[0];
  if (!w) return null;
  const days = ctx.timeline.days;
  const segmentsOf = (d: FindMyTimelineDay) => d.people.find((p) => p.person === w.person.id)?.segments ?? [];
  const totals = findMyWeekTotals(days.map(segmentsOf), ctx.order);
  const first = days[0];
  const last = days.at(-1);
  return (
    <>
      <div className={t.chips}>
        {kept.map((k) => (
          <button
            key={k.person.id}
            type="button"
            className={t.chip}
            aria-pressed={k.person.id === w.person.id}
            onClick={() => onPick(k.person.id)}
          >
            <Avatar who={k} size={28} />
            {k.first}
          </button>
        ))}
      </div>
      <Card
        id="findmy-timeline-week"
        title={W.weekTitle(w.first)}
        meta={first && last ? findMyWeekRange(first.date, last.date) : null}
      >
        <div className={t.strips}>
          {days.map((d) => {
            const isToday = d.date === ctx.today;
            const name = isToday ? W.today : findMyWeekDay(d.date);
            return (
              <button
                key={d.date}
                type="button"
                className={cx(t.weekRow, t.pick)}
                onClick={() => onDay(d.date)}
              >
                <span className={t.dayName}>{isToday ? <b>{name}</b> : name}</span>
                <Strip segments={segmentsOf(d)} day={d} ctx={ctx} label={W.stripLabel(w.first, name)} />
              </button>
            );
          })}
          {last ? <Axis axis={findMyAxis(last, ctx.tz, null)} end={false} /> : null}
        </div>
        <div className={t.totals}>
          {totals.map((total) => (
            <span key={total.key}>
              <Swatch
                kind={total.tone === 'trip' ? 'trip' : total.tone === 'gap' ? 'gap' : 'stay'}
                tone={typeof total.tone === 'number' ? total.tone : undefined}
              />
              {total.label} <b>{total.value}</b>
            </span>
          ))}
        </div>
        <p className={styles.cardNote}>{W.pickDay}</p>
      </Card>
    </>
  );
}

/* Before it's on --------------------------------------------------------------------------------------- */

function BeforeItsOn({ ctx }: { ctx: TabContext }) {
  const change = useFindMyTimelineChange(ctx.burrow, ctx.connectionId);
  const toast = useToast();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const every = findMyEvery(findMyTimelinePace(ctx.timeline.paceMinutes));
  const items = [W.introPlaces(every), W.introOnly, W.introDays];
  return (
    <section className={styles.card} aria-labelledby="findmy-timeline-intro">
      <div className={t.intro}>
        <h2 id="findmy-timeline-intro">{W.introTitle}</h2>
        <p>{W.introBody}</p>
        <ul>
          {items.map((text) => (
            <li key={text}>
              <Icon icon={Check} size={16} />
              <span>{text}</span>
            </li>
          ))}
        </ul>
        {ctx.who.length === 0 ? (
          <p className={t.muted}>{W.noRead}</p>
        ) : (
          <div className={t.whose}>
            {ctx.who.map((w) => (
              <label key={w.person.id}>
                <Avatar who={w} size={28} />
                <span>{w.person.name}</span>
                <input
                  type="checkbox"
                  checked={ticked.has(w.person.id)}
                  aria-label={W.keepLabel(w.first)}
                  onChange={(e) => {
                    const next = new Set(ticked);
                    if (e.target.checked) next.add(w.person.id);
                    else next.delete(w.person.id);
                    setTicked(next);
                  }}
                />
              </label>
            ))}
          </div>
        )}
        <Button
          variant="primary"
          disabled={ticked.size === 0 || change.pending}
          aria-busy={change.pending || undefined}
          onClick={() =>
            void change
              .change({
                kind: 'set',
                people: ctx.who.filter((w) => ticked.has(w.person.id)).map((w) => w.person.id),
              })
              .then((problem) => problem && toast.show(problem))
          }
        >
          {W.keep}
        </Button>
        <p className={t.muted}>{W.shouldKnow}</p>
      </div>
    </section>
  );
}

/* Settings --------------------------------------------------------------------------------------------- */

type Ask = { kind: 'untick'; who: Who } | { kind: 'delete' } | { kind: 'stop' };

function Settings({ ctx, picked }: { ctx: TabContext; picked: string | null }) {
  const toast = useToast();
  const change = useFindMyTimelineChange(ctx.burrow, ctx.connectionId);
  const assistant = useFindMyTimelineAssistant(ctx.burrow, ctx.connectionId);
  const { words } = useTheAgent(ctx.burrow);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const example =
    ctx.who.find((w) => w.person.id === picked)?.first ??
    ctx.who.find((w) => w.person.kept)?.first ??
    'Ruben';
  const reads = assistant.asked ?? ctx.timeline.assistantReads;
  const keptCount = ctx.timeline.people.filter((p) => p.kept).length;

  const close = () => {
    setAsk(null);
    setProblem(null);
  };
  const run = async (c: Parameters<typeof change.change>[0], done: string | null) => {
    const no = await change.change(c);
    if (no) return setProblem(no);
    close();
    if (done) toast.show(done);
  };
  const confirm = (() => {
    if (!ask) return null;
    if (ask.kind === 'untick' && keptCount > 1)
      return {
        title: W.untickAsk(ask.who.first),
        body: W.untickBody(ask.who.person.name),
        confirm: W.untickConfirm(ask.who.first),
        go: () =>
          run({ kind: 'set', people: findMyWhoseAfter(ctx.timeline.people, ask.who.person.id, false) }, null),
      };
    if (ask.kind === 'delete')
      return {
        title: W.deleteAsk,
        body: W.deleteBody,
        confirm: W.deleteConfirm,
        go: () => run({ kind: 'delete' }, W.deleted),
      };
    // Stop, or unticking the last one kept: the same thing.
    return {
      title: W.stopAsk,
      body: W.stopBody,
      confirm: W.stopConfirm,
      go: () => run({ kind: 'set', people: [] }, W.stopped),
    };
  })();

  return (
    <Card id="findmy-timeline-settings" title={W.settings}>
      <div className={t.set}>
        <div className={t.lab}>
          <b>{W.whose}</b>
          <span>{W.whoseHint}</span>
        </div>
        <div className={t.whose}>
          {ctx.who.map((w) => {
            const asked = change.asked?.kind === 'set' ? change.asked.people.includes(w.person.id) : null;
            return (
              <label key={w.person.id}>
                <Avatar who={w} size={28} />
                <span>{w.person.name}</span>
                <em>{w.person.keptSince ? findMyKeptSince(w.person.keptSince, ctx.tz) : ''}</em>
                <input
                  type="checkbox"
                  checked={asked ?? w.person.kept}
                  disabled={change.pending}
                  aria-label={W.keepLabel(w.first)}
                  onChange={(e) => {
                    if (!e.target.checked) return setAsk({ kind: 'untick', who: w });
                    void change
                      .change({
                        kind: 'set',
                        people: findMyWhoseAfter(ctx.timeline.people, w.person.id, true),
                      })
                      .then((no) => no && toast.show(no));
                  }}
                />
              </label>
            );
          })}
        </div>
      </div>
      <div className={t.set}>
        <div className={t.lab}>
          <b>{W.keptDays}</b>
          <span>{W.keptDaysHint}</span>
        </div>
      </div>
      <div className={t.set}>
        <div className={t.lab}>
          <b id="findmy-timeline-assistant">{W.assistantReads(words.Name)}</b>
          <span>{W.assistantHint(example)}</span>
        </div>
        <Toggle
          checked={reads}
          disabled={assistant.pending}
          aria-label={W.assistantLabel(words.Name)}
          onCheckedChange={(on) => void assistant.set(on).then((no) => no && toast.show(no))}
        />
      </div>
      <p className={t.keeps}>{W.onlyYou(words.name)}</p>
      <div className={t.set}>
        <div className={t.lab}>
          <b>{W.deleteTitle}</b>
          <span>{W.deleteHint}</span>
        </div>
        <Button className={t.danger} onClick={() => setAsk({ kind: 'delete' })}>
          {W.deleteButton}
        </Button>
      </div>
      <div className={t.set}>
        <div className={t.lab}>
          <b>{W.stopTitle}</b>
          <span>{W.stopHint}</span>
        </div>
        <Button className={t.danger} onClick={() => setAsk({ kind: 'stop' })}>
          {W.stopButton}
        </Button>
      </div>
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ''}
        body={confirm?.body}
        confirm={confirm?.confirm ?? ''}
        serious
        busy={change.pending}
        error={problem}
        onConfirm={() => void confirm?.go()}
        onClose={close}
      />
    </Card>
  );
}
