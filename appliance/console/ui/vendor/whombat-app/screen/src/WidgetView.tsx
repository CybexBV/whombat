/**
 * `<WidgetView>`: one widget in the form it has room for (DK-131), from its view (DK-142) or, for Whombat's own *How
 * things are*, *What’s going on* and *Servers*, the calm glance. A problem replaces the content with its words in red,
 * a locked view says to unlock, a tone colours the card; touching it opens it big (DK-140), a server's own screen, or
 * what Whombat's own opened before.
 */
import { type CSSProperties, memo, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  BOARD_TILE_STACKED,
  chartForm,
  clockForm,
  clockSizes,
  figuresForm,
  fitFont,
  headInCorner,
  listForm,
  meterBlocks,
  meterRowsFit,
  meterRowsForm,
  nowForm,
  photoEveryMs,
  pictureGrid,
  postersForm,
  postersInRow,
  rowsThatFit,
  serverForm,
  statusForm,
  stripForm,
  tilesThatFit,
  tileValueFits,
  viewTone,
  WEATHER_DAY_H,
  weatherCredit,
  weatherForm,
  weatherHourPicks,
} from './forms';
import {
  Bar,
  Blocks,
  cx,
  Face,
  Header,
  type IconName,
  IconTile,
  keyed,
  Line,
  Mark,
  Meter,
  Picture,
  strokeOf,
  toneClass,
  useBlockCount,
  useEnv,
  useImage,
} from './parts';
import { METER_TONES, type OwnWidget, type WidgetType } from './specs';
import type {
  DeskBoardView,
  DeskCameraView,
  DeskChartView,
  DeskFiguresView,
  DeskListView,
  DeskMoment,
  DeskPhotoView,
  DeskPostersView,
  DeskServerView,
  DeskStripServer,
  DeskTextView,
  DeskViewFigure,
  DeskViewMeter,
  DeskViewRow,
  DeskWeatherView,
  DeskWidget,
  DeskWidgetView,
  ScreenCalm,
} from './types';
import { WeatherIcon } from './WeatherIcon';
import s from './widgets.module.css';
import { clockText, dateText, fillWords, SCREEN_WORDS, weekdayText } from './words';

const W = SCREEN_WORDS;

export interface WidgetViewProps {
  widget: Pick<DeskWidget, 'id' | 'type' | 'opts'> & { ref?: string | undefined };
  /** What the runtime resolved for it; Whombat's own clock, *How things are*, *What’s going on* and *Servers* have none. */
  view?: DeskWidgetView | undefined;
  /** The calm glance, for Whombat's own widgets. */
  calm?: ScreenCalm | null | undefined;
  /** Its size in cells and in the screen's logical pixels. */
  w: number;
  h: number;
  pw: number;
  ph: number;
  /** The time, for the clock (ms). */
  now?: number | undefined;
  /** Where it sits (absolute, in the screen's pixels); absent fills its parent. */
  style?: CSSProperties | undefined;
  /** Drawn open big (DK-140): nothing to touch but its own buttons. */
  big?: boolean | undefined;
  className?: string | undefined;
}

/** Whombat's own widgets drawn without a card. */
const BARE: ReadonlySet<WidgetType> = new Set<WidgetType>(['clock', 'status', 'now', 'strip']);

const unitText = (f: Pick<DeskViewFigure, 'value' | 'unit'>) =>
  f.unit ? `${f.value}\u00a0${f.unit}` : f.value;
/** A figure in words: “Humidity 48 %” when its label is a name, “3.1 TB free of 26 TB” when it goes on from the value. */
export const figureText = (f: DeskViewFigure) =>
  /^\p{Lu}/u.test(f.label) ? `${f.label} ${unitText(f)}` : `${unitText(f)} ${f.label}`;
/** A figure that says all is well gets a green tick before it. */
function FigureValue({ f }: { f: DeskViewFigure }) {
  return (
    <>
      {f.tone === 'ok' && <span className={s.cOk}>✓ </span>}
      {unitText(f)}
    </>
  );
}
const capital = (t: string) => (t ? t[0]?.toUpperCase() + t.slice(1) : t);

/** A big line that shrinks to fit its width (down to two thirds) rather than lose its end. */
function FitLine({
  text,
  width,
  max,
  className,
  children,
}: {
  text: string;
  width: number;
  max: number;
  className: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className={className} style={{ fontSize: fitFont(text, width, max) }}>
      {children ?? text}
    </div>
  );
}

/* Whombat's own ---------------------------------------------------------------------------------------------------- */

function ClockBody({ w, h, pw, ph, now }: { w: number; h: number; pw: number; ph: number; now: number }) {
  const { timeZone } = useEnv();
  const form = clockForm(w, h);
  const size = clockSizes(form, pw, ph);
  const time = clockText(now, timeZone);
  const at = time.indexOf(':');
  return (
    <div className={cx(s.ck, form === 'row' && s.ckRow)}>
      <div className={s.ckTime} style={{ fontSize: size.time }}>
        <span aria-hidden="true">
          {time.slice(0, at)}
          <span className={s.colon}>:</span>
          {time.slice(at + 1)}
        </span>
        <span
          style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}
        >
          {time}
        </span>
      </div>
      {form !== 'time' && (
        <div className={s.ckDate} style={{ fontSize: size.date }}>
          {dateText(now, timeZone)}
        </div>
      )}
    </div>
  );
}

function StatusBody({ calm, w, h }: { calm: ScreenCalm | null | undefined; w: number; h: number }) {
  if (!calm) return null;
  const { form, more } = statusForm(w, h);
  const line = form === 'line';
  return (
    <div className={s.st}>
      <div className={s.stHead} style={{ fontSize: line ? 30 : 46 }}>
        <span
          className={s.stDot}
          data-tone={calm.headline.tone}
          style={{ width: line ? 16 : 20, height: line ? 16 : 20 }}
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{calm.headline.text}</span>
      </div>
      {more && calm.headline.more && (
        <div className={cx(s.stMore, line && s.stMoreLine)}>{calm.headline.more}</div>
      )}
    </div>
  );
}

function MomentMark({ m }: { m: DeskMoment }) {
  if (m.kind === 'work') return <Face size={22} />;
  if (m.kind === 'coming' && !m.mark) return <IconTile name="cal" size={22} />;
  return <Mark mark={m.mark} name={m.name} size={22} />;
}

function NowBody({ calm, w, ph }: { calm: ScreenCalm | null | undefined; w: number; ph: number }) {
  const env = useEnv();
  const moments = calm?.moments ?? [];
  const { cols, rows, done } = nowForm(w, ph, moments.length);
  const shown = moments.slice(0, cols * rows);
  const n = calm?.doneCount ?? 0;
  const doneWords =
    done && n > 0
      ? fillWords(n === 1 ? W.now.doneOne : W.now.doneMany, { assistant: env.assistant, n })
      : null;
  return (
    <div className={s.nw}>
      <div className={s.nwHead}>
        <span className={s.lab}>{W.own.now.name}</span>
        {doneWords &&
          (env.onDoneToday && !env.editing ? (
            <button type="button" className={cx(s.press, s.nwDone)} onClick={env.onDoneToday}>
              {doneWords} ›
            </button>
          ) : (
            <span className={s.nwDone}>{doneWords} ›</span>
          ))}
      </div>
      {shown.length === 0 ? (
        <div className={s.nwEmpty}>{W.now.empty}</div>
      ) : (
        <div
          className={s.nwCards}
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {shown.map((m) => (
            <div key={m.key} className={s.mc} data-pinned={m.pinned || undefined}>
              <div className={s.hd}>
                <MomentMark m={m} />
                <span className={s.hdName}>{m.kind === 'work' ? env.assistant : m.name}</span>
              </div>
              <div className={s.big} style={{ fontSize: w < 4 ? 24 : 30 }}>
                {m.value}
              </div>
              {m.progress !== undefined ? (
                <Bar pct={m.progress} colour={m.kind === 'work' ? 'face' : 'ok'} />
              ) : (
                m.detail && <div className={s.d}>{m.detail}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StripChip({ srv, tall, editing }: { srv: DeskStripServer; tall: boolean; editing: boolean }) {
  const env = useEnv();
  const say = srv.work === 'done' ? W.strip.done : srv.work === 'next' ? W.strip.next : srv.say;
  const words = say ?? (srv.state === 'off' ? W.strip.off : undefined);
  const inner = (
    <>
      <span className={s.chipHead}>
        <Mark mark={srv.mark} name={srv.name} size={19} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{srv.name}</span>
      </span>
      {words ? (
        <span className={s.chipSay}>{words}</span>
      ) : (
        srv.spark &&
        srv.spark.length > 1 && (
          <span className={cx(s.chipSpark, tall && s.chipSparkTall)} style={{ display: 'block' }}>
            <Line series={[{ points: srv.spark, colour: 'var(--ok)' }]} minSpan={20} floor={0} />
          </span>
        )
      )}
      {srv.work === 'now' && <Bar pct={srv.progress ?? 50} colour="sand" thin />}
    </>
  );
  const props = {
    className: cx(s.chip, tall && s.chipTall),
    'data-state': srv.state,
    'data-work': srv.work,
  };
  return srv.id && env.onServer && !editing ? (
    <button
      type="button"
      {...props}
      className={cx(props.className, s.press)}
      aria-label={srv.name}
      onClick={() => env.onServer?.(srv.id as string)}
    >
      {inner}
    </button>
  ) : (
    <div {...props}>{inner}</div>
  );
}

function StripBody({ calm, w, h }: { calm: ScreenCalm | null | undefined; w: number; h: number }) {
  const env = useEnv();
  if (!calm) return null;
  const total = calm.strip.length + calm.moreStrip;
  if (total === 0) return null;
  const { shown, more, tall } = stripForm(w, h, total);
  const list = calm.strip.slice(0, shown);
  const extra = more + (shown - list.length);
  const slots = list.length + (extra > 0 ? 1 : 0);
  const moreText = fillWords(W.strip.more, { n: extra });
  return (
    <div className={s.sp} style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}>
      {list.map((srv) => (
        <StripChip key={srv.id ?? srv.name} srv={srv} tall={tall} editing={env.editing} />
      ))}
      {extra > 0 &&
        (env.onServers && !env.editing ? (
          <button type="button" className={cx(s.chip, s.chipMore, s.press)} onClick={env.onServers}>
            {moreText}
          </button>
        ) : (
          <div className={cx(s.chip, s.chipMore)}>{moreText}</div>
        ))}
    </div>
  );
}

function WorkBody({ v, w, h, ph }: { v: DeskListView | undefined; w: number; h: number; ph: number }) {
  const { assistant } = useEnv();
  const rows = v?.rows ?? [];
  const done = rows.filter((r) => r.tone === 'ok').length;
  const nowAt = rows.findIndex((r) => r.tone !== 'ok');
  return (
    <>
      <Header
        mark={<Face size={24} />}
        name={assistant}
        right={w >= 3 && rows.length > 0 ? fillWords(W.work.steps, { done, n: rows.length }) : undefined}
      />
      {v?.head ? (
        <div className={s.mid} style={{ whiteSpace: 'nowrap' }}>
          {v.head}
        </div>
      ) : (
        rows.length === 0 && <div className={s.d}>{v?.empty ?? W.list.empty}</div>
      )}
      {v?.progress !== undefined && <Bar pct={v.progress} colour="face" />}
      {h >= 2 && rows.length > 0 && (
        <div className={s.rows} style={{ marginTop: 12 }}>
          {keyed(rows.slice(0, rowsThatFit(ph, 110, 38)), (x) => x.title).map(([key, r], i) => (
            <div key={key} className={s.rw}>
              <span className={r.tone === 'ok' ? s.check : s.step}>
                {r.tone === 'ok' ? '✓' : i === nowAt ? '…' : ''}
              </span>
              <span className={s.rwL}>{r.title}</span>
              <span className={s.rwS}>
                {r.meta ?? (r.tone === 'ok' ? '' : i === nowAt ? W.work.now : W.work.next)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ComingBody({ v, h, ph }: { v: DeskListView | undefined; h: number; ph: number }) {
  const rows = v?.rows ?? [];
  const first = rows[0];
  return (
    <>
      <Header mark={<IconTile name="cal" />} name={W.own.coming.name} />
      {!first ? (
        <div className={s.d}>{v?.empty ?? W.list.empty}</div>
      ) : h === 1 ? (
        <>
          <div className={s.big} style={{ fontSize: 28 }}>
            {first.time ? `${first.title} · ${first.time}` : first.title}
          </div>
          {first.detail && <div className={s.d}>{first.detail}</div>}
        </>
      ) : (
        <TimeRows rows={rows} max={rowsThatFit(ph, 40, rows.some((r) => r.detail) ? 54 : 40)} />
      )}
    </>
  );
}

function DoneBody({ v, h, ph }: { v: DeskListView | undefined; h: number; ph: number }) {
  const { assistant } = useEnv();
  const rows = v?.rows ?? [];
  const n = v?.count ?? rows.length;
  const title =
    n === 0 ? W.own.done.name : fillWords(n === 1 ? W.now.doneOne : W.now.doneMany, { assistant, n });
  return (
    <>
      <Header mark={<IconTile name="check" />} name={title} />
      {rows.length === 0 ? (
        <div className={s.d}>{v?.empty ?? W.done.empty}</div>
      ) : h === 1 ? (
        <div className={s.mid} style={{ whiteSpace: 'nowrap' }}>
          {rows[0]?.title}
        </div>
      ) : (
        <div className={s.rows}>
          {keyed(rows.slice(0, rowsThatFit(ph, 40, 40)), (x) => x.title).map(([key, r]) => (
            <div key={key} className={s.rw}>
              <span className={s.cOk}>✓</span>
              <span className={s.rwL}>{r.title}</span>
              {r.time && <span className={cx(s.rwS, s.mono)}>{r.time}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* The views ------------------------------------------------------------------------------------------------------- */

function ViewHeader({ v, right, short }: { v: DeskWidgetView; right?: ReactNode; short?: boolean }) {
  return (
    <Header
      mark={<Mark mark={v.mark} name={v.name ?? v.title} />}
      name={v.name ?? v.title}
      title={v.name && !short ? v.title : undefined}
      right={right}
    />
  );
}

function FiguresBody({
  v,
  w,
  h,
  pw,
  ph,
}: {
  v: DeskFiguresView;
  w: number;
  h: number;
  pw: number;
  ph: number;
}) {
  const form = figuresForm(v, w, h);
  const [first, second, ...rest] = v.items;
  if (!first) return <ViewHeader v={v} />;
  const colour = first.tone === 'ok' ? undefined : (first.tone ?? (v.tone !== 'ok' ? v.tone : undefined));
  if (form === 'tile') {
    // One cell: the value with the first word of its unit when it's a sign (“12 %”, “21.4°”), its label under it.
    const sign = first.unit?.split(' ')[0] ?? '';
    const unit = sign.startsWith('°') ? '°' : [...sign].length <= 2 ? sign : '';
    const value = `${first.value}${unit === '°' ? unit : unit ? ` ${unit}` : ''}`;
    return (
      <div className={s.tile}>
        {/* A long value (“€ 1,241”) gets smaller rather than cut at the edge. */}
        <FitLine className={cx(s.tileValue, toneClass(colour))} width={pw - 36} max={40} text={value} />
        <div className={s.d} style={{ marginTop: 2 }}>
          {first.label}
        </div>
      </div>
    );
  }
  const under = second ? figureText(second) : (v.line ?? first.label);
  if (form === 'inline')
    return (
      <>
        <ViewHeader v={v} />
        <div className={s.inline}>
          {v.items.slice(0, w >= 4 ? 3 : 2).map((f) => (
            <div key={f.label}>
              <b className={toneClass(f.tone === 'ok' ? undefined : f.tone)}>
                <FigureValue f={f} />
              </b>
              <span>{f.label}</span>
            </div>
          ))}
        </div>
      </>
    );
  if (form === 'line')
    return (
      <>
        <ViewHeader v={v} />
        <FitLine className={cx(s.big, toneClass(colour))} width={pw - 36} max={34} text={unitText(first)}>
          <FigureValue f={first} />
        </FitLine>
        {v.progress !== undefined ? (
          <Bar pct={v.progress} colour={colour} />
        ) : (
          <div className={s.d}>{under}</div>
        )}
      </>
    );
  const spark = v.spark && v.spark.length > 1 ? v.spark : null;
  // A second figure beside the first (a sensor's “48 %”) makes the first big and the line a caption under the chart;
  // alone, the figure is the usual size and its line says what it means, under it.
  // Only a short one with its unit fits beside it (“48 %”); a longer one (“174 devices”) or a bare number, which says
  // nothing without its label, goes under with its label, so neither gets cut off.
  const beside =
    !!second?.unit && v.progress === undefined && form !== 'split' && [...unitText(second)].length <= 8;
  const figure = (
    <>
      <div className={s.figRow}>
        <FitLine
          className={cx(s.big, toneClass(colour))}
          width={form === 'split' ? (pw - 36) * 0.4 : pw - 36 - (beside ? 70 : 0)}
          max={form === 'split' ? 30 : beside ? 44 : 34}
          text={unitText(first)}
        >
          <FigureValue f={first} />
        </FitLine>
        {beside && second && <span className={s.d}>{unitText(second)}</span>}
      </div>
      {v.progress !== undefined && <Bar pct={v.progress} colour={colour} />}
    </>
  );
  const sparkLine = spark && (
    <div
      className={s.chartBox}
      style={beside ? { marginTop: 12, flex: 'none', height: Math.max(30, ph - 178) } : { marginTop: 12 }}
    >
      <Line series={[{ points: spark, colour: strokeOf(v.tone === 'ok' ? undefined : v.tone) }]} fill />
    </div>
  );
  if (form === 'split')
    return (
      <>
        <ViewHeader v={v} />
        <div className={s.split}>
          <div className={s.splitLeft}>
            {figure}
            <div className={s.d}>{v.line ?? (second ? figureText(second) : first.label)}</div>
          </div>
          <div className={s.splitRight}>
            <div className={s.chartBox}>
              <Line series={[{ points: spark ?? [], colour: strokeOf(undefined) }]} fill grid />
            </div>
          </div>
        </div>
      </>
    );
  return (
    <>
      <ViewHeader v={v} />
      {figure}
      {v.line && (!spark || !beside) && <div className={cx(s.d, !spark && s.wrap)}>{v.line}</div>}
      {!spark &&
        (beside ? rest : [second, ...rest])
          .filter((f): f is DeskViewFigure => !!f)
          .map((f) => (
            <div key={f.label} className={s.d}>
              {figureText(f)}
            </div>
          ))}
      {sparkLine}
      {spark && beside && v.line && <div className={s.d}>{v.line}</div>}
    </>
  );
}

function TimeRows({ rows, max }: { rows: DeskViewRow[]; max: number }) {
  return (
    <div className={s.rows}>
      {keyed(rows.slice(0, max), (x) => x.title).map(([key, r]) => (
        <div key={key} className={s.rw}>
          <span className={s.rwT}>{r.time}</span>
          <div className={s.two}>
            <b className={toneClass(r.tone === 'ok' ? undefined : r.tone)}>{r.title}</b>
            {r.detail && <span>{r.detail}</span>}
          </div>
          {r.meta && <span className={s.rwS}>{r.meta}</span>}
        </div>
      ))}
    </div>
  );
}

function ListRow({ r, queue }: { r: DeskViewRow; queue: boolean }) {
  const tone = r.tone === 'ok' ? undefined : r.tone;
  if (r.state)
    return (
      <div className={s.rw}>
        <span className={cx(s.light, r.tone === 'ok' && s.lightOk)} data-on={r.state === 'on' || undefined} />
        <span className={cx(s.rwL, toneClass(tone))}>{r.title}</span>
        <span className={s.rwS}>{r.meta ?? r.detail}</span>
      </div>
    );
  return (
    <div className={s.rw}>
      {r.image && <Picture image={r.image} width={30} height={r.image.shape === 'poster' ? 44 : 30} />}
      {r.time && <span className={s.rwT}>{r.time}</span>}
      <div className={cx(s.two, queue && s.queue)}>
        <b className={toneClass(tone)}>{r.title}</b>
        {r.progress !== undefined && r.progress > 0 ? (
          <Bar pct={r.progress} thin colour={tone} />
        ) : (
          r.detail && <span>{r.detail}</span>
        )}
      </div>
      {r.meta && <span className={s.rwS}>{r.meta}</span>}
    </div>
  );
}

/** One limit as the server card's line: its short name, the blocks, its words and, where there's room, its reset. */
function MeterLine({
  m,
  withKey,
  reset,
  tight,
}: {
  m: DeskViewMeter;
  withKey: boolean;
  reset: boolean;
  tight: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const count = useBlockCount(ref);
  return (
    <div
      className={cx(s.lim, !withKey && s.limNoKey, reset && s.limReset, tight && s.limTight)}
      role="img"
      aria-label={[m.key, m.text, m.reset].filter(Boolean).join(' ')}
    >
      {withKey && <span className={s.meterKey}>{m.key ?? ''}</span>}
      <span ref={ref} className={s.limBlocks}>
        <Blocks pct={m.pct} tone={m.tone ?? 'ok'} count={count} />
      </span>
      <b className={s.limWords}>{m.text}</b>
      {reset && <span className={s.limWhen}>{m.reset ?? ''}</span>}
    </div>
  );
}

/** A row's brand mark (Claude's, ChatGPT's); a brand without one, its name's first letter. */
function RowMark({ r, size }: { r: DeskViewRow; size: number }) {
  if (!r.mark) return null;
  return (
    <span className={cx(s.rowMark, r.tone === 'off' && s.rowMarkOff)}>
      <Mark mark={r.mark} name={r.mark} size={size} />
    </span>
  );
}

/**
 * Rows of limits (Fusebox's subscriptions): wide, each with its mark, name and plan, its limits as blocks with
 * when they reset, and how it is; half as wide, the limits beside the name with how it is under it; narrow, the name
 * with the last limit's words and its blocks under it (what isn't fine says so instead). Where they don't all fit so,
 * each is one tight line with its last limit, its name in the colour of how it is.
 */
function MeterRows({ v, pw, ph }: { v: DeskListView; pw: number; ph: number }) {
  const form = meterRowsForm(pw);
  // The padding, the header and the space under it.
  const used = 30 + 24 + 8;
  const fit = meterRowsFit(v.rows, form, ph - used);
  const tight = fit.tight;
  const shown = v.rows.slice(0, fit.count);
  const keys = v.rows.some((r) => r.meters?.some((m) => m.key));
  const more = v.count !== undefined ? v.count : v.rows.length;
  const right = v.head ?? (more > shown.length ? fillWords(W.list.count, { n: more }) : undefined);
  return (
    <>
      <ViewHeader v={v} right={right} />
      <div className={cx(s.limRows, form === 'wide' && s.limRowsWide)}>
        {keyed(shown, (x) => x.title).map(([key, r]) => {
          const meters = r.meters ?? [];
          const tone = r.tone === 'ok' ? undefined : r.tone;
          if (form === 'narrow') {
            const last = meters[meters.length - 1];
            const says = (!r.tone || r.tone === 'ok') && last ? last.text : (r.meta ?? last?.text);
            return (
              <div key={key} className={cx(s.limRow, s.limNarrow, tight && s.limNarrowTight)}>
                <div className={s.limTop}>
                  <RowMark r={r} size={tight ? 15 : 17} />
                  <b className={cx(s.limTopTitle, r.tone === 'off' && s.cOff)}>{r.title}</b>
                  {says && <em className={cx(s.limSays, toneClass(tone))}>{says}</em>}
                </div>
                {last && <MeterBlocks m={last} />}
              </div>
            );
          }
          const wide = form === 'wide';
          const under = tight ? '' : wide ? r.detail : [r.detail, r.meta].filter(Boolean).join(' · ');
          const lines = tight ? meters.slice(-1) : meters;
          return (
            <div
              key={key}
              className={cx(s.limRow, wide ? s.limWide : s.limMid, tight && s.limMidTight)}
              style={wide ? { minHeight: fit.rowH } : undefined}
            >
              <div className={s.limWho}>
                <RowMark r={r} size={wide ? 28 : tight ? 18 : 22} />
                <div className={s.limName}>
                  <b
                    className={cx(s.limTitle, toneClass(tight ? tone : r.tone === 'off' ? 'off' : undefined))}
                  >
                    {r.title}
                  </b>
                  {under && <span className={s.limSub}>{under}</span>}
                </div>
              </div>
              <div className={s.lims}>
                {keyed(lines, (m) => m.key ?? m.text).map(([mk, m]) => (
                  <MeterLine key={mk} m={m} withKey={keys} reset={wide} tight={!wide} />
                ))}
              </div>
              {wide && (
                <div className={s.limSt}>
                  {r.meta && (
                    <span>
                      <i className={cx(s.limDot, toneClass(r.tone ?? 'ok'))} />
                      <b className={cx(s.limState, toneClass(tone))}>{r.meta}</b>
                    </span>
                  )}
                  {r.note && <span className={s.limNote}>{r.note}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** A narrow row's blocks, as wide as the row. */
function MeterBlocks({ m }: { m: DeskViewMeter }) {
  const ref = useRef<HTMLSpanElement>(null);
  const count = useBlockCount(ref);
  return (
    <span ref={ref} className={s.limBar} role="img" aria-label={[m.key, m.text].filter(Boolean).join(' ')}>
      <Blocks pct={m.pct} tone={m.tone ?? 'ok'} count={count} />
    </span>
  );
}

function ListBody({ v, w, h, pw, ph }: { v: DeskListView; w: number; h: number; pw: number; ph: number }) {
  const form = listForm(h);
  if (form === 'rows' && v.rows.some((r) => r.meters?.length)) return <MeterRows v={v} pw={pw} ph={ph} />;
  const corner = headInCorner(v.head);
  const count =
    v.count !== undefined && v.count > v.rows.length ? fillWords(W.list.count, { n: v.count }) : null;
  if (v.rows.length === 0 && !v.head)
    return (
      <>
        <ViewHeader v={v} />
        <div className={s.empty}>{v.empty ?? W.list.empty}</div>
      </>
    );
  if (form === 'line') {
    const first = v.rows[0];
    return (
      <>
        <ViewHeader v={v} right={v.head && headInCorner(v.head) ? v.head : w >= 3 ? count : undefined} />
        {v.head ? (
          <>
            <FitLine className={s.big} width={pw - 36} max={30} text={v.head} />
            {v.progress !== undefined ? (
              <Bar pct={v.progress} />
            ) : (
              <div className={s.d}>
                {v.rows
                  .filter((r) => r.state !== 'off')
                  .slice(0, 3)
                  .map((r) => r.title)
                  .join(v.rows.some((r) => r.state) ? ', ' : ' · ')}
              </div>
            )}
          </>
        ) : (
          first && (
            <>
              <div className={s.big} style={{ fontSize: 28 }}>
                {first.time ? `${first.title} · ${first.time}` : first.title}
              </div>
              {first.detail && <div className={s.d}>{first.detail}</div>}
            </>
          )
        )}
      </>
    );
  }
  const queue = v.rows.some((r) => r.progress !== undefined);
  const timed = v.rows.some((r) => r.time) && !v.rows.some((r) => r.image || r.state);
  const twoLine = v.rows.some((r) => r.detail || r.progress !== undefined || r.image);
  const rowH = v.rows.some((r) => r.state) ? 38 : queue ? 50 : twoLine ? 54 : 40;
  // The header (and the big line over the rows, with room under the last row) take this much.
  const used = 44 + (v.head && !corner ? 46 : 0);
  const max = rowsThatFit(ph, used, rowH);
  return (
    <>
      <ViewHeader v={v} right={v.head && corner ? v.head : count} />
      {v.head && !corner && (
        <div className={s.mid} style={{ marginTop: 8, whiteSpace: 'nowrap' }}>
          {v.head}
        </div>
      )}
      {v.rows.length === 0 ? (
        <div className={s.empty}>{v.empty ?? W.list.empty}</div>
      ) : timed ? (
        <TimeRows rows={v.rows} max={max} />
      ) : (
        <div className={s.rows} style={queue ? { marginTop: 6 } : undefined}>
          {keyed(v.rows.slice(0, max), (x) => x.title).map(([key, r]) => (
            <ListRow key={key} r={r} queue={queue} />
          ))}
        </div>
      )}
    </>
  );
}

function PostersBody({
  v,
  w,
  h,
  pw,
  ph,
}: {
  v: DeskPostersView;
  w: number;
  h: number;
  pw: number;
  ph: number;
}) {
  const form = postersForm(v, w, h);
  if (v.items.length === 0)
    return (
      <>
        <ViewHeader v={v} />
        <div className={s.empty}>{v.empty ?? W.list.empty}</div>
      </>
    );
  if (form === 'count')
    return (
      <>
        <ViewHeader v={v} short={w < 3} />
        <FitLine className={s.big} width={pw - 36} max={34} text={v.head ?? String(v.items.length)} />
        <div className={s.d}>{v.items.map((p) => p.title).join(' · ')}</div>
      </>
    );
  if (form === 'rows')
    return (
      <>
        <ViewHeader v={v} short />
        <div className={s.rows}>
          {keyed(v.items.slice(0, rowsThatFit(ph, 44, 66)), (x) => x.title).map(([key, p]) => (
            <div key={key} className={s.rw}>
              <div className={s.two}>
                <b>{p.title}</b>
                {p.who && <span>{p.who}</span>}
                {p.progress !== undefined && <Bar pct={p.progress} colour="sand" thin />}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  if (form === 'row') {
    const inner = pw - 36;
    const high = ph - 30 - 44;
    const ratio = v.shape === 'wide' ? 9 / 16 : v.shape === 'square' ? 1 : 1.5;
    // Wide pictures (every camera) fill the room as a grid; posters keep to one row.
    if (v.shape === 'wide') {
      const g = pictureGrid(v.items.length, inner, high, ratio);
      return (
        <>
          <ViewHeader v={v} right={w >= 4 ? v.head : undefined} />
          <div className={s.posterGrid} style={{ gridTemplateColumns: `repeat(${g.cols}, ${g.width}px)` }}>
            {keyed(v.items.slice(0, g.count), (x) => x.title).map(([key, p]) => (
              <Picture key={key} image={p.image} width={g.width} height={g.width * ratio} label={p.title} />
            ))}
          </div>
        </>
      );
    }
    const n = Math.min(v.items.length, postersInRow(inner, high, v.shape));
    const each = (inner - (n - 1) * 10) / n;
    return (
      <>
        <ViewHeader v={v} right={w >= 4 ? v.head : undefined} />
        <div className={s.posterRow}>
          {keyed(v.items.slice(0, n), (x) => x.title).map(([key, p]) => (
            <Picture
              key={key}
              image={p.image}
              width={each}
              height={Math.min(high, each * ratio)}
              label={p.title}
            />
          ))}
        </div>
      </>
    );
  }
  const tall = h >= 3;
  const rowH = Math.min(tall ? 170 : 104, (ph - 30 - 44) / 2);
  // The header and its gap take 53 px; a card may lose a few pixels at the bottom edge rather than go.
  const n = Math.max(1, Math.floor((ph - 53 + 24) / (rowH + 14)));
  return (
    <>
      <ViewHeader v={v} right={v.head} />
      <div className={s.cards}>
        {keyed(v.items.slice(0, n), (x) => x.title).map(([key, p]) => (
          <div key={key} className={s.card} style={{ height: rowH }}>
            <Picture image={p.image} width={rowH * 0.68} height={rowH} />
            <div className={s.cardText}>
              <div className={s.cardTitle} style={{ fontSize: tall ? 24 : 20 }}>
                {p.title}
              </div>
              {p.detail && (
                <div className={s.d} style={{ marginTop: 3 }}>
                  {p.detail}
                </div>
              )}
              {p.who && (
                <div className={s.d} style={{ marginTop: 2 }}>
                  {p.who}
                </div>
              )}
              {(p.progress !== undefined || p.time) && (
                <div className={s.cardBar}>
                  <div>{p.progress !== undefined && <Bar pct={p.progress} colour="sand" thin />}</div>
                  {p.time && <span className={s.cardTime}>{p.time}</span>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ChartBody({ v, h }: { v: DeskChartView; h: number }) {
  const form = chartForm(h);
  // A percentage starts at nothing and spans at least a fifth, so a quiet line stays quiet.
  const scale = v.unit === '%' ? { minSpan: 20, floor: 0 } : {};
  const series = v.series.map((x, i) => ({ points: x.points, colour: strokeOf(x.tone, i) }));
  const figure = v.figure && (
    <div className={s.figRow}>
      <div className={cx(s.big, toneClass(v.figure.tone === 'ok' ? undefined : v.figure.tone))}>
        {v.figure.value}
      </div>
      {v.figure.rest && <span className={s.d}>{v.figure.rest}</span>}
    </div>
  );
  if (form === 'spark')
    return (
      <>
        <ViewHeader v={v} />
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
          {figure}
          <div style={{ flex: 1, height: 40, paddingBottom: 6 }}>
            <Line series={series} limit={v.limit} {...scale} />
          </div>
        </div>
      </>
    );
  return (
    <>
      <ViewHeader v={v} right={v.series.length > 1 ? v.series.map((x) => x.label).join(' · ') : undefined} />
      {figure}
      <div className={s.chartBox} style={{ marginTop: 12 }}>
        <Line series={series} fill={series.length === 1} grid limit={v.limit} {...scale} />
      </div>
      {v.stats && v.stats.length > 0 && <div className={s.d}>{v.stats.join(' · ')}</div>}
      {v.foot && v.foot.length > 0 && (
        <div className={s.inline} style={{ marginTop: 10, gap: 24 }}>
          {v.foot.map((f) => (
            <div key={f.label}>
              <b style={{ fontSize: 18 }}>{f.value}</b>
              <span>{f.label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CameraBody({ v, h }: { v: DeskCameraView; h: number }) {
  const { timeZone } = useEnv();
  const url = useImage(v.locked ? undefined : v.image);
  if (v.locked)
    return (
      <div className={s.cam}>
        <div className={s.camLocked}>
          <span>{v.title}</span>
          <span>{W.locked.hidden}</span>
        </div>
      </div>
    );
  return (
    <div className={s.cam}>
      {url && <img src={url} alt={v.image?.alt ?? v.title} decoding="async" />}
      <div className={s.camTop}>
        <Mark mark={v.mark} name={v.name ?? v.title} size={22} />
        <span>{v.title}</span>
        {v.at && <span className={s.camTime}>{clockText(Date.parse(v.at), timeZone)}</span>}
      </div>
      {h >= 2 && v.event && (
        <div className={s.camEvent}>
          <span className={s.live} />
          {v.event}
        </div>
      )}
    </div>
  );
}

/**
 * One picture filling the widget, its words over a soft dark fade at the bottom, the next one every `every` seconds with
 * no motion between them (the box draws in software). Editing shows the first and holds still.
 */
function PhotoBody({ v, h }: { v: DeskPhotoView; h: number }) {
  const { editing } = useEnv();
  const [at, setAt] = useState(0);
  const n = v.items.length;
  useEffect(() => {
    if (editing || n < 2) return;
    const timer = setInterval(() => setAt((i) => (i + 1) % n), photoEveryMs(v.every));
    return () => clearInterval(timer);
  }, [editing, n, v.every]);
  const item = editing ? v.items[0] : v.items[at % Math.max(1, n)];
  const url = useImage(v.locked ? undefined : item?.image);
  // The next one loads while this one shows, so the change is one draw.
  useImage(v.locked || editing || n < 2 ? undefined : v.items[(at + 1) % n]?.image);
  if (v.locked)
    return (
      <div className={s.cam}>
        <div className={s.camLocked}>
          <span>{v.title}</span>
          <span>{W.locked.hidden}</span>
        </div>
      </div>
    );
  return (
    <div className={s.cam}>
      {url && <img src={url} alt={item?.image.alt ?? item?.caption ?? v.title} decoding="async" />}
      <div className={s.photoTop} />
      <div className={s.camTop}>
        <Mark mark={v.mark} name={v.name ?? v.title} size={22} />
        <span className={s.hdName}>{v.title}</span>
      </div>
      {(item?.caption || item?.time) && (
        <div className={cx(s.photoWords, h >= 3 && s.photoWordsBig)}>
          {item.caption && <div className={s.photoCaption}>{item.caption}</div>}
          {item.time && <div className={s.photoTime}>{item.time}</div>}
        </div>
      )}
    </div>
  );
}

/** A board: its tiles in a grid that fills the widget, each its tone's dot, its name and a short value. */
function BoardBody({ v, w, pw, ph }: { v: DeskBoardView; w: number; pw: number; ph: number }) {
  // A short head goes in the header's corner; a longer one over the tiles, or in the corner when the widget is one
  // cell high and wide enough, else not at all.
  const low = ph < 200;
  const short = headInCorner(v.head);
  const corner = v.head && (short || (low && w >= 3)) ? v.head : undefined;
  const over = v.head && !short && !low;
  if (v.items.length === 0)
    return (
      <>
        <ViewHeader v={v} right={corner} />
        <div className={s.empty}>{v.empty ?? W.list.empty}</div>
      </>
    );
  // The padding, the header and its gap, and the line over the tiles take this much.
  const high = ph - 30 - 34 - (over ? 38 : 0);
  const form = tilesThatFit(v.items.length, v.count ?? v.items.length, pw - 36, high);
  const stacked = form.tileH >= BOARD_TILE_STACKED;
  return (
    <>
      <ViewHeader v={v} right={corner} short={w < 3} />
      {over && (
        <div className={s.mid} style={{ whiteSpace: 'nowrap', fontSize: 20 }}>
          {v.head}
        </div>
      )}
      <div
        className={s.board}
        style={{
          gridTemplateColumns: `repeat(${form.cols}, minmax(0, 1fr))`,
          gridAutoRows: form.tileH,
        }}
      >
        {keyed(v.items.slice(0, form.shown), (x) => x.label).map(([key, t]) => (
          <div key={key} className={cx(s.bt, stacked && s.btStacked)} data-tone={t.tone}>
            <span className={s.btDot} />
            <span className={s.btL}>{t.label}</span>
            {t.value && (stacked || tileValueFits(t.label, t.value, form.tileW)) && (
              <span className={cx(s.btV, toneClass(t.tone === 'ok' ? undefined : t.tone))}>{t.value}</span>
            )}
          </div>
        ))}
        {form.more > 0 && (
          <div className={cx(s.bt, s.btMore)}>{fillWords(W.strip.more, { n: form.more })}</div>
        )}
      </div>
    </>
  );
}

function ServerBody({
  v,
  w,
  h,
  pw,
  ph,
}: {
  v: DeskServerView;
  w: number;
  h: number;
  pw: number;
  ph: number;
}) {
  const down = !!v.problem || v.state === 'bad' || v.state === 'off';
  const form = serverForm(w, h, down);
  const header = (right?: ReactNode) => (
    <Header mark={<Mark mark={v.mark} name={v.title} />} name={v.title} right={right} />
  );
  if (form === 'down') {
    const off = v.state === 'off' && !v.problem;
    return (
      <>
        {header(w >= 3 ? v.line : undefined)}
        <div className={cx(s.big, off ? s.cOff : s.cBad)} style={{ fontSize: 28 }}>
          {v.problem?.text ?? capital(v.say ?? (off ? W.server.off : W.server.bad))}
        </div>
        {(v.problem?.detail ?? v.line) && <div className={s.d}>{v.problem?.detail ?? v.line}</div>}
      </>
    );
  }
  // The card's note (DK-152): why it isn't fine in its colour, else how long it's been up.
  const note = v.say ? (
    <span className={toneClass(v.state === 'ok' ? undefined : v.state)}>{v.say}</span>
  ) : (
    v.uptime
  );
  const inner = pw - 36;
  const meters = (width: number, tight?: boolean) => {
    const count = meterBlocks(width);
    return (
      <div className={cx(s.meters, tight && s.metersTight)}>
        <Meter
          k={W.server.keys.cpu}
          label={W.server.processor}
          pct={v.cpu}
          at={METER_TONES.cpu}
          count={count}
        />
        <Meter
          k={W.server.keys.memory}
          label={W.server.memory}
          pct={v.memory}
          at={METER_TONES.memory}
          count={count}
        />
        <Meter
          k={W.server.keys.disk}
          label={W.server.disk}
          pct={v.disk}
          at={METER_TONES.storage}
          count={count}
        />
      </div>
    );
  };
  const spark = v.spark && v.spark.length > 1 ? v.spark : null;
  const range = W.server.ranges[v.range ?? '24h'];
  if (form === 'figure')
    return (
      <>
        {header()}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
          <div className={s.big}>
            {v.cpu ?? '–'}&nbsp;%
            <div className={s.d} style={{ marginTop: 2 }}>
              {W.server.cpu}
            </div>
          </div>
          <div style={{ flex: 1, height: 40, paddingBottom: 6, marginBottom: 14 }}>
            {spark && <Line series={[{ points: spark, colour: 'var(--ok)' }]} minSpan={20} floor={0} />}
          </div>
        </div>
      </>
    );
  if (form === 'card')
    return (
      <>
        {header(note)}
        <div style={{ marginTop: 10 }}>{meters(inner, true)}</div>
      </>
    );
  if (form === 'meters')
    return (
      <>
        {header(w >= 3 ? note : undefined)}
        <div className={s.d} style={{ marginTop: 2 }}>
          {v.line ?? v.uptime}
        </div>
        <div style={{ marginTop: 14 }}>{meters(inner)}</div>
        {spark && (
          <div
            style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', marginTop: 16 }}
          >
            <div className={s.d} style={{ margin: '0 0 6px' }}>
              {fillWords(W.server.chart, { range })}
            </div>
            <div className={s.chartBox}>
              <Line series={[{ points: spark, colour: 'var(--ok)' }]} fill minSpan={20} floor={0} />
            </div>
          </div>
        )}
      </>
    );
  const tall = h >= 3;
  return (
    <>
      {header(v.line)}
      <div style={{ display: 'flex', gap: 22, marginTop: 14, flex: '1 1 0', minHeight: 0 }}>
        <div style={{ width: '42%', flex: 'none' }}>
          {meters(inner * 0.42)}
          {(v.say || v.uptime) && (
            <div
              className={cx(s.d, toneClass(v.say && v.state !== 'ok' ? v.state : undefined))}
              style={{ marginTop: 10 }}
            >
              {v.say ? capital(v.say) : v.uptime}
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div className={s.d} style={{ margin: '0 0 6px' }}>
            {fillWords(W.server.chart, { range })}
          </div>
          <div className={s.chartBox} style={{ maxHeight: ph - 30 - 44 - (tall ? 34 : 0) }}>
            {spark && (
              <Line series={[{ points: spark, colour: 'var(--ok)' }]} fill grid minSpan={20} floor={0} />
            )}
          </div>
          {tall && v.stats && v.stats.length > 0 && <div className={s.d}>{v.stats.join(' · ')}</div>}
        </div>
      </div>
    </>
  );
}

function TextBody({ v }: { v: DeskTextView }) {
  return (
    <>
      <ViewHeader v={v} />
      <div className={s.body}>{v.body}</div>
    </>
  );
}

/* The weather and the news ------------------------------------------------------------------------------------------ */

/** A temperature as a person writes it: a true minus sign below zero (“−4°”), not a hyphen. */
const minus = (t: number) => (t < 0 ? `\u2212${-t}` : `${t}`);
const degrees = (t: number) => `${minus(t)}°`;

/** The next hours as columns: “Now”, then each hour's time, its sign and its temperature (and its rain, with `rain`). */
function WeatherHours({ v, inner, rain }: { v: DeskWeatherView; inner: number; rain?: boolean }) {
  const { timeZone } = useEnv();
  const picks = weatherHourPicks(v.hours.length, inner);
  return (
    <div className={s.wxHours} style={{ gridTemplateColumns: `repeat(${picks.length}, minmax(0, 1fr))` }}>
      {picks.map((i, n) => {
        const hour = v.hours[i];
        if (!hour) return null;
        const wet = rain && hour.rainMm !== undefined && hour.rainMm >= 0.1;
        return (
          <div key={hour.at} className={s.wxHour}>
            <span className={s.wxAt}>
              {n === 0 ? W.weather.now : clockText(Date.parse(hour.at), timeZone)}
            </span>
            <WeatherIcon symbol={hour.symbol} size={28} />
            <b>{degrees(hour.temp)}</b>
            {rain && (
              <span className={s.wxWet}>
                {wet ? fillWords(W.weather.rain, { mm: hour.rainMm ?? 0 }) : ''}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The days ahead as rows: the day, its sign, its rain, its lowest and highest on the week's scale. */
function WeatherDays({ v, max, inner }: { v: DeskWeatherView; max: number; inner: number }) {
  // A narrow card leaves the rain out rather than squeeze it.
  const rain = inner >= 420;
  const days = v.days.slice(0, max);
  const lo = Math.min(...v.days.map((d) => d.low));
  const hi = Math.max(...v.days.map((d) => d.high));
  const span = hi - lo || 1;
  return (
    <div className={s.wxDays}>
      {days.map((d, i) => (
        <div key={d.date} className={cx(s.wxDay, !rain && s.wxDayDry)}>
          <span className={s.wxDayName}>{i === 0 ? W.weather.today : weekdayText(d.date)}</span>
          <WeatherIcon symbol={d.symbol} size={26} />
          {rain && (
            <span className={s.wxWet}>
              {d.rainMm !== undefined && d.rainMm >= 0.1 ? fillWords(W.weather.rain, { mm: d.rainMm }) : ''}
            </span>
          )}
          <span className={s.wxLow}>{degrees(d.low)}</span>
          <span className={s.wxRange} aria-hidden="true">
            <i
              className={s.wxSpan}
              style={{ left: `${((d.low - lo) / span) * 100}%`, right: `${((hi - d.high) / span) * 100}%` }}
            />
          </span>
          <b className={s.wxHigh}>{degrees(d.high)}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * The weather in the form it has room for (Whombat weather-news.md): the sign and the temperature, then the highest and
 * lowest and what the sky does, the next hours, the days; MET Norway's credit wherever there's room.
 */
function WeatherBody({
  v,
  w,
  h,
  pw,
  ph,
}: {
  v: DeskWeatherView;
  w: number;
  h: number;
  pw: number;
  ph: number;
}) {
  const { timeZone } = useEnv();
  const form = weatherForm(w, h);
  const now = v.now;
  const head = <Header mark={<IconTile name="weather" />} name={v.place ?? v.title} />;
  if (!now)
    return (
      <>
        {head}
        <div className={s.empty}>{v.place ? W.weather.problem : W.weather.noPlace}</div>
      </>
    );
  const temp = degrees(now.temp);
  const today = v.today;
  const short = today
    ? fillWords(W.weather.short, { high: minus(today.high), low: minus(today.low) })
    : undefined;
  const highLow = today
    ? fillWords(W.weather.highLow, { high: minus(today.high), low: minus(today.low) })
    : undefined;
  const inner = pw - 36;
  const credit = weatherCredit(w, h) && <div className={s.wxCredit}>{v.credit}</div>;
  if (form === 'tile')
    return (
      <div className={s.wxTile}>
        <WeatherIcon symbol={now.symbol} size={38} />
        <FitLine className={s.wxTemp} width={inner} max={36} text={temp} />
        {short && <div className={s.d}>{short}</div>}
      </div>
    );
  // The sign, the temperature with the highest and lowest beside it, and what the sky does under them.
  const nowRow = (icon: number, size: number, more?: ReactNode) => (
    <div className={s.wxNow}>
      <WeatherIcon symbol={now.symbol} size={icon} />
      <div className={s.wxNowWords}>
        <div className={s.wxTempRow}>
          <span className={s.wxTemp} style={{ fontSize: size }}>
            {temp}
          </span>
          {short && !more && <span className={s.d}>{short}</span>}
        </div>
        <div className={cx(s.d, s.wxSays)}>{now.text}</div>
        {more}
      </div>
    </div>
  );
  if (form === 'line') return <div className={s.wxFill}>{nowRow(62, 40)}</div>;
  if (form === 'strip')
    return (
      <div className={s.wxSplit}>
        <div className={s.wxLeft} style={{ width: Math.min(250, inner * 0.5) }}>
          {nowRow(58, 38)}
        </div>
        <WeatherHours v={v} inner={inner - Math.min(250, inner * 0.5) - 16} />
      </div>
    );
  const feels = [
    now.feels !== undefined && now.feels !== now.temp
      ? fillWords(W.weather.feels, { t: minus(now.feels) })
      : null,
    now.wind,
  ]
    .filter((x): x is string => !!x)
    .join(' · ');
  const chance =
    today?.rainChance !== undefined ? fillWords(W.weather.rainChance, { n: today.rainChance }) : null;
  const sun = v.sun?.polar
    ? v.sun.polar === 'day'
      ? W.weather.polarDay
      : W.weather.polarNight
    : v.sun?.rise && v.sun.set
      ? fillWords(W.weather.sun, {
          rise: clockText(Date.parse(v.sun.rise), timeZone),
          set: clockText(Date.parse(v.sun.set), timeZone),
        })
      : null;
  if (form === 'block') {
    // The header, the now row, the hours and the credit take this much; days fill what's left.
    const days =
      h >= 3 ? Math.min(v.days.length, Math.floor((ph - 30 - 34 - 76 - 92 - 34) / WEATHER_DAY_H)) : 0;
    return (
      <>
        {head}
        {nowRow(56, 42)}
        <div className={s.wxPush} />
        <WeatherHours v={v} inner={inner} />
        {days > 0 && <WeatherDays v={v} max={days} inner={inner} />}
        {credit}
      </>
    );
  }
  const details = (
    <>
      {highLow && <div className={s.d}>{highLow}</div>}
      {feels && <div className={s.d}>{feels}</div>}
      {chance && <div className={s.d}>{chance}</div>}
      {form === 'large' && sun && <div className={s.d}>{sun}</div>}
    </>
  );
  const left = Math.max(260, inner * 0.4);
  const top = (
    <div className={cx(s.wxSplit, form === 'large' && s.wxTop)}>
      <div className={s.wxLeft} style={{ width: left }}>
        {nowRow(w >= 6 ? 76 : 56, w >= 6 ? 58 : 50, details)}
      </div>
      <WeatherHours v={v} inner={inner - left - 16} rain />
    </div>
  );
  if (form === 'wide')
    return (
      <>
        {head}
        {top}
        {credit}
      </>
    );
  // The padding, the header, the now band and the credit take this much; days fill what's left.
  const days = Math.min(v.days.length, Math.floor((ph - 30 - 34 - 176 - 36) / WEATHER_DAY_H));
  return (
    <>
      {head}
      {top}
      {days > 0 && <WeatherDays v={v} max={days} inner={inner} />}
      {credit}
    </>
  );
}

/** The news (a list): each headline with its site and when, the first one alone when the widget is one cell high. */
function NewsBody({ v, h, ph }: { v: DeskListView | undefined; h: number; ph: number }) {
  const rows = v?.rows ?? [];
  const meta = (r: DeskViewRow) => [r.detail, r.time].filter(Boolean).join(' · ');
  const first = rows[0];
  return (
    <>
      <Header mark={<IconTile name="news" />} name={v?.title ?? W.own.news.name} />
      {!first ? (
        <div className={s.empty}>{v?.empty ?? W.news.empty}</div>
      ) : h === 1 ? (
        <>
          <div className={cx(s.mid, s.nwsOne)}>{first.title}</div>
          <div className={s.d}>{meta(first)}</div>
        </>
      ) : (
        <div className={s.rows}>
          {keyed(rows.slice(0, rowsThatFit(ph, 44, 56)), (x) => x.title).map(([key, r]) => (
            <div key={key} className={s.rw}>
              <div className={s.two}>
                <b>{r.title}</b>
                <span>{meta(r)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* One widget ------------------------------------------------------------------------------------------------------ */

const OWN_SIGN: Partial<Record<WidgetType, IconName>> = {
  coming: 'cal',
  done: 'check',
  weather: 'weather',
  news: 'news',
};

function OwnOrViewHeader({ type, v }: { type: WidgetType; v: DeskWidgetView }) {
  const { assistant } = useEnv();
  if (type === 'work') return <Header mark={<Face size={24} />} name={assistant} />;
  const sign = OWN_SIGN[type];
  // The weather is named by where it is for.
  const name = v.kind === 'weather' ? (v.place ?? v.title) : v.title;
  if (sign) return <Header mark={<IconTile name={sign} />} name={name} />;
  return <ViewHeader v={v} />;
}

function ownName(type: OwnWidget, assistant: string): string {
  return fillWords(W.own[type].name, { assistant });
}

/** The words a widget's button says: what it is. */
export function widgetLabel(
  widget: Pick<DeskWidget, 'type'>,
  view: DeskWidgetView | undefined,
  assistant: string,
): string {
  if (view) return view.name && view.name !== view.title ? `${view.name} · ${view.title}` : view.title;
  return widget.type in W.own ? ownName(widget.type as OwnWidget, assistant) : widget.type;
}

function Body(props: WidgetViewProps) {
  const { widget, view: v, calm, w, h, pw, ph } = props;
  // Whombat's own keep their sign and name over what they say instead.
  const head = v && <OwnOrViewHeader type={widget.type} v={v} />;
  if (v?.problem && v.kind !== 'server')
    return (
      <>
        {head}
        {/* One cell has room for the words only a little smaller. */}
        <div className={cx(s.mid, s.cBad)} style={w === 1 ? { fontSize: 17 } : undefined}>
          {v.problem.text}
        </div>
        {v.problem.detail && <div className={cx(s.d, s.wrap)}>{v.problem.detail}</div>}
      </>
    );
  if (v?.locked && v.kind !== 'camera' && v.kind !== 'photo')
    return (
      <>
        {head}
        <div className={s.locked}>{W.locked.hidden}</div>
      </>
    );
  switch (widget.type) {
    case 'clock':
      return <ClockBody w={w} h={h} pw={pw} ph={ph} now={props.now ?? Date.now()} />;
    case 'status':
      return <StatusBody calm={calm} w={w} h={h} />;
    case 'now':
      return <NowBody calm={calm} w={w} ph={ph} />;
    case 'strip':
      return <StripBody calm={calm} w={w} h={h} />;
    case 'work':
      return <WorkBody v={v?.kind === 'list' ? v : undefined} w={w} h={h} ph={ph} />;
    case 'coming':
      return <ComingBody v={v?.kind === 'list' ? v : undefined} h={h} ph={ph} />;
    case 'done':
      return <DoneBody v={v?.kind === 'list' ? v : undefined} h={h} ph={ph} />;
    case 'news':
      return <NewsBody v={v?.kind === 'list' ? v : undefined} h={h} ph={ph} />;
  }
  if (!v) return null;
  switch (v.kind) {
    case 'figures':
      return <FiguresBody v={v} w={w} h={h} pw={pw} ph={ph} />;
    case 'list':
      return <ListBody v={v} w={w} h={h} pw={pw} ph={ph} />;
    case 'posters':
      return <PostersBody v={v} w={w} h={h} pw={pw} ph={ph} />;
    case 'chart':
      return <ChartBody v={v} h={h} />;
    case 'camera':
      return <CameraBody v={v} h={h} />;
    case 'server':
      return <ServerBody v={v} w={w} h={h} pw={pw} ph={ph} />;
    case 'text':
      return <TextBody v={v} />;
    case 'photo':
      return v.items.length === 0 ? (
        <>
          <ViewHeader v={v} />
          <div className={s.empty}>{v.empty ?? W.list.empty}</div>
        </>
      ) : (
        <PhotoBody v={v} h={h} />
      );
    case 'board':
      return <BoardBody v={v} w={w} pw={pw} ph={ph} />;
    case 'weather':
      return <WeatherBody v={v} w={w} h={h} pw={pw} ph={ph} />;
  }
}

/** What touching a widget does (DK-140): nothing, the pill's modal, a server's screen, unlock, or open it big. */
function useTouch(props: WidgetViewProps): { label: string; onPress: () => void } | null {
  const env = useEnv();
  const { widget, view } = props;
  if (env.editing || props.big) return null;
  const label = widgetLabel(widget, view, env.assistant);
  if (widget.type === 'clock' || widget.type === 'now' || widget.type === 'strip') return null;
  if (widget.type === 'status') return env.onAttention ? { label, onPress: env.onAttention } : null;
  if (view?.locked) return env.onUnlock ? { label, onPress: env.onUnlock } : null;
  if (view?.kind === 'server' && !view.problem) {
    const id = view.server;
    return env.onServer ? { label, onPress: () => env.onServer?.(id) } : null;
  }
  // A server's part (its storage, its memory…) opens the server's own screen too.
  if (widget.type === 'server' && view && !view.problem && view.kind !== 'text' && widget.ref) {
    const id = widget.ref.slice(widget.ref.indexOf(':') + 1);
    return env.onServer ? { label, onPress: () => env.onServer?.(id) } : null;
  }
  if (!view) return null;
  return env.onBig ? { label, onPress: () => env.onBig?.(widget.id) } : null;
}

function WidgetViewInner(props: WidgetViewProps) {
  const { widget, view } = props;
  const touch = useTouch(props);
  const bare = BARE.has(widget.type);
  const tone = bare ? null : viewTone(view);
  // A picture fills its card: a camera's still, a photo view's picture (not its empty or problem form).
  const flush =
    view?.kind === 'camera' ||
    (view?.kind === 'photo' && !view.problem && (view.locked || view.items.length > 0));
  return (
    <div
      className={cx(s.w, bare && s.bare, flush && s.flush, props.className)}
      data-tone={tone ?? undefined}
      data-widget={widget.id}
      data-type={widget.type}
      data-view={view?.kind}
      style={props.style ?? { position: 'absolute', inset: 0 }}
    >
      {touch && <button type="button" className={s.hit} aria-label={touch.label} onClick={touch.onPress} />}
      <Body {...props} />
    </div>
  );
}

/**
 * One widget, drawn again only when what it shows, its size or its place changed (the box draws in software): the
 * host's view objects may be new on every poll, so they're compared by content.
 */
export const WidgetView = memo(WidgetViewInner, (a, b) => {
  return (
    a.widget.id === b.widget.id &&
    a.widget.type === b.widget.type &&
    a.w === b.w &&
    a.h === b.h &&
    a.pw === b.pw &&
    a.ph === b.ph &&
    a.big === b.big &&
    a.className === b.className &&
    sameStyle(a.style, b.style) &&
    (a.widget.type !== 'clock' || minute(a.now) === minute(b.now)) &&
    same(a.view, b.view) &&
    (!CALM_READERS.has(a.widget.type) || same(a.calm, b.calm))
  );
});

const CALM_READERS: ReadonlySet<WidgetType> = new Set<WidgetType>(['status', 'now', 'strip']);
const minute = (ms: number | undefined) => (ms === undefined ? -1 : Math.floor(ms / 60_000));
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
function sameStyle(a: CSSProperties | undefined, b: CSSProperties | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}
