/**
 * A server's own screen (Whombat desk-display.md DK-83…DK-85, mockup `docs/design/desk-servers/` frame 2; CG-256…,
 * CG-260): opened by its card, to look at. The header (Back, the mark, the name, the OS with its cores and uptime, its
 * state and the lock chip), four figures with their block bars, the chart of the last hour, 24 hours or 7 days, storage
 * per volume, the guests, the network, the dots through the servers it was opened from, and Ask about this server. The
 * runtime writes every figure; the page asks for them at open, every 10 s and on a range chip, and draws what it gets.
 * Nothing on it changes the server (DK-84).
 */
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Client } from '../lib/client';
import {
  type DeskServer,
  type DeskServerPage,
  deskErrorCode,
  parseServerPage,
  RANGE_S,
  SERVER_RANGES,
  type ServerRange,
} from '../lib/desk';
import { topOf } from '../lib/deskBox';
import { DESK, DESK_WORDS, fill } from '../lib/deskCopy';
import {
  chartFoot,
  DOTS_MAX,
  FIGURE_SEGMENTS,
  type Figure,
  figuresOf,
  guestCpu,
  guestTone,
  hasPoints,
  headState,
  isSwipe,
  legend,
  SERVER_REFRESH_MS,
  subLine,
  swipeTo,
  VOLUME_SEGMENTS,
  volumeNote,
} from '../lib/deskServer';
import { useScale } from '../ui/Stage';
import { SeriesChart } from './Box';
import styles from './desk.module.css';
import { Icon } from './icons';
import { Mark, PageHead, Segments } from './parts';

const W = DESK_WORDS.server;

/** Why the screen goes back by itself: the runtime says it may not show (`locked`) or knows no such server. */
export type PageGone = 'locked' | 'not_found' | 'not_paired';
const GONE: readonly string[] = ['locked', 'not_found', 'not_paired'] satisfies PageGone[];

interface Answer {
  id: string;
  page: DeskServerPage | null;
  /** The last ask didn't come back (the hosts service, the socket): the last page stays, with a line under the head. */
  unavailable: boolean;
}

/**
 * The server's page from `/api/desk/server` (CG-257): at once, every 10 s and when the range changes. A page for
 * another server is never shown (a swipe starts empty: the card's figures); one that didn't come keeps the last.
 */
export function useServerPage(
  client: Client,
  id: string,
  range: ServerRange,
  onGone: (code: PageGone) => void,
): Answer {
  const [answer, setAnswer] = useState<Answer>({ id, page: null, unavailable: false });
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    let stopped = false;
    const read = async () => {
      const res = await client.post('/api/desk/server', { id, range }).catch(() => null);
      if (stopped) return;
      const page = res?.status === 200 ? parseServerPage(res.body, id) : null;
      if (page) return setAnswer({ id, page, unavailable: false });
      const code = res && res.status !== 200 ? deskErrorCode(res.body) : null;
      if (code && GONE.includes(code)) return gone.current(code as PageGone);
      setAnswer((a) => (a.id === id ? { ...a, unavailable: true } : { id, page: null, unavailable: true }));
    };
    void read();
    const timer = setInterval(() => void read(), SERVER_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client, id, range]);
  return answer.id === id ? answer : { id, page: null, unavailable: false };
}

/**
 * A swipe across the screen (DK-83): a pointer pressed and let go more than 60 layout px across (and more across than
 * down) goes to the next or the previous; the click that ends a swipe is swallowed (at either end too), so it never
 * opens the PIN pad.
 */
function useSwipe(index: number, length: number, go: (index: number, dir: 'next' | 'prev') => void) {
  const scale = useScale();
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const swipedAt = useRef(0);
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    },
    onPointerUp: (e: ReactPointerEvent) => {
      const s = start.current;
      start.current = null;
      if (!s || s.id !== e.pointerId) return;
      const dx = (e.clientX - s.x) / scale;
      const dy = (e.clientY - s.y) / scale;
      if (!isSwipe(dx, dy)) return;
      // A swipe is never a touch, past either end too (it would open the PIN pad on a locked screen).
      swipedAt.current = Date.now();
      const next = swipeTo(index, length, dx, dy);
      if (next !== null) go(next, next > index ? 'next' : 'prev');
    },
    onPointerCancel: () => {
      start.current = null;
    },
    onClickCapture: (e: { stopPropagation: () => void; preventDefault: () => void }) => {
      // The click a swipe ends with comes as the pointer is let go; a touch after it is a touch.
      if (Date.now() - swipedAt.current < 150) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };
}

/** One of the four figures (This Whombat's `.fig` look): the key and its note, the big value, a 24-block bar. */
function Kpi({ k, f }: { k: string; f: Figure }) {
  return (
    <div className={`${styles.fig} ${styles.pageFig}`} data-tone={f.tone}>
      <div className={styles.figRow}>
        <span className={styles.figKey}>{k}</span>
        {f.note && <span className={styles.figNote}>{f.note}</span>}
      </div>
      <div className={styles.figValue}>
        {f.value}
        {f.unit && <small className={styles.figUnit}>{f.unit}</small>}
      </div>
      <Segments
        value={f.bar?.value ?? 0}
        tone={f.tone}
        max={f.bar?.max ?? 100}
        count={FIGURE_SEGMENTS}
        className={styles.kpiSeg}
      />
    </div>
  );
}

/** The chart's range: three chips, the one shown pressed (each says its range in full to a screen reader). */
function RangeChips({ range, onRange }: { range: ServerRange; onRange: (r: ServerRange) => void }) {
  return (
    <div className={styles.range}>
      {SERVER_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          className={styles.rangeChip}
          aria-pressed={r === range}
          aria-label={W.ranges[r]}
          onClick={(e) => {
            e.stopPropagation();
            onRange(r);
          }}
        >
          {W.rangeChips[r]}
        </button>
      ))}
    </div>
  );
}

/** The chart's card: its range, CPU's peak and memory's average, the range chips, the lines and the times under them. */
function ChartCard({
  server,
  page,
  range,
  timeZone,
  onRange,
}: {
  server: DeskServer;
  page: DeskServerPage | null;
  range: ServerRange;
  timeZone: string;
  onRange: (r: ServerRange) => void;
}) {
  // The page answered for the range asked; until the new range's answer comes, the last one's chart and times.
  const shown = page?.history.range ?? range;
  const foot = useMemo(
    () => chartFoot(shown, page ? Date.parse(page.now) : Date.now(), timeZone),
    [shown, page, timeZone],
  );
  const off = server.state === 'off';
  const words = page && !off ? legend(page, timeZone) : null;
  const h = page?.history;
  let body: ReactNode;
  if (off) body = <div className={styles.chartEmpty}>{fill(W.off, { server: server.name })}</div>;
  else if (!h) body = <div className={styles.chartEmpty} />;
  else if (!hasPoints(h)) body = <div className={styles.chartEmpty}>{W.noFigures}</div>;
  else
    body = (
      <>
        <SeriesChart
          cpu={h.cpu}
          memory={h.memory}
          stepS={h.stepS}
          spanS={RANGE_S[h.range]}
          top={topOf([page?.cpu?.percent, page?.memory?.percent, ...h.cpu, ...h.memory])}
        />
        <div className={styles.chartTicks} aria-hidden="true">
          <span>{foot.start}</span>
          {foot.ticks.map((t) => (
            <span key={t.label} style={{ left: `${t.at * 100}%` }}>
              {t.label}
            </span>
          ))}
          <span>{foot.end}</span>
        </div>
      </>
    );
  return (
    <div className={`${styles.fig} ${styles.pageFig} ${styles.chartCard}`}>
      <div className={styles.chartHead}>
        <span className={styles.figKey}>{W.ranges[shown]}</span>
        {words && (
          <>
            <span className={styles.legend}>
              <i className={styles.swatch} data-line="cpu" />
              {words.cpu}
            </span>
            <span className={styles.legend}>
              <i className={styles.swatch} data-line="memory" />
              {words.memory}
            </span>
          </>
        )}
        {!off && <RangeChips range={range} onRange={onRange} />}
      </div>
      {body}
    </div>
  );
}

function Storage({ volumes }: { volumes: DeskServerPage['volumes'] }) {
  return (
    <div className={`${styles.fig} ${styles.pageFig} ${styles.storageCard}`}>
      <span className={styles.figKey}>{W.storage}</span>
      {volumes.length > 0 && (
        <div className={styles.vols}>
          {volumes.map((v) => (
            <div key={v.name} className={styles.vol}>
              <b className={styles.volName}>{v.name}</b>
              <span className={styles.volNote}>{volumeNote(v)}</span>
              <Segments value={v.percent} tone={v.tone} count={VOLUME_SEGMENTS} className={styles.volSeg} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Guests({ guests }: { guests: DeskServerPage['guests'] | undefined }) {
  return (
    <div className={`${styles.fig} ${styles.pageFig} ${styles.guestsCard}`}>
      <div className={styles.figRow}>
        <span className={styles.figKey}>{W.guests}</span>
        {guests && (
          <span className={styles.figNote}>
            {fill(W.guestsCount, { running: guests.running, off: guests.off })}
          </span>
        )}
      </div>
      {guests && (
        <div className={styles.guestList}>
          {guests.items.map((g) => (
            <div key={`${g.kind}-${g.name}`} className={styles.guest}>
              <i
                className={styles.guestDot}
                data-tone={guestTone(g)}
                role="img"
                aria-label={W.guestStates[g.state]}
              />
              <b className={styles.guestName}>{g.name}</b>
              <span className={styles.guestFig}>{guestCpu(g)}</span>
              <span className={styles.guestFig}>{g.memory}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The open alerts' titles (DK-84: only unlocked or with *Everything*), a line each, above the chart. */
function Alerts({ items }: { items: DeskServerPage['alerts']['items'] }) {
  return (
    <div className={`${styles.fig} ${styles.pageFig} ${styles.alertsCard}`}>
      {items.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two alerts may have the same title
        <div key={i} className={styles.alertRow}>
          <i className={styles.stateDot} data-tone={a.tone} />
          <span className={styles.alertTitle}>{a.title}</span>
        </div>
      ))}
    </div>
  );
}

/** The dots through the servers it was opened from (44 px targets), or “5 of 24” when they wouldn't fit. */
function Dots({ list, index, onIndex }: { list: DeskServer[]; index: number; onIndex: (i: number) => void }) {
  if (list.length < 2) return null;
  if (list.length > DOTS_MAX)
    return <span className={styles.dotsText}>{fill(DESK.serverOf, { n: index + 1, m: list.length })}</span>;
  return (
    <nav className={styles.dots}>
      {list.map((s, i) => (
        <button
          key={s.id ?? s.name}
          type="button"
          className={styles.dotButton}
          aria-label={s.name}
          aria-current={i === index || undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (i !== index) onIndex(i);
          }}
        >
          <i />
        </button>
      ))}
    </nav>
  );
}

export interface ServerScreenProps {
  client: Client;
  /** The servers it was opened from (the glance's or every server's), in their order; `index` the one shown. */
  list: DeskServer[];
  index: number;
  /** How the last swipe went: the page slides in from that side (none with reduced motion). */
  swipe?: 'next' | 'prev';
  timeZone: string;
  /** The assistant's name, for Ask; null: no Ask (Talk's voice is off, CG-53). */
  assistant: string | null;
  /** The lock chip, as on the glance. */
  lock: ReactNode;
  /** Fixtures: the range at the start (24 hours otherwise). */
  initialRange?: ServerRange;
  onBack: () => void;
  onIndex: (index: number, dir: 'next' | 'prev') => void;
  onAsk: (server: DeskServer) => void;
  onGone: (code: PageGone) => void;
}

export function ServerScreen(props: ServerScreenProps) {
  const { client, list, index, timeZone, assistant, lock, onBack, onIndex, onAsk, onGone } = props;
  const card = list[index] ?? list[0];
  const id = card?.id ?? '';
  const [range, setRange] = useState<ServerRange>(props.initialRange ?? '24h');
  const { page, unavailable } = useServerPage(client, id, range, onGone);
  const swipe = useSwipe(index, list.length, onIndex);
  if (!card) return null;
  const server = page?.server ?? card;
  const figures = figuresOf(server, page);
  const state = headState(server, page?.alerts ?? null);
  const items = page?.alerts.items ?? [];
  const side = !page || page.volumes.length > 0 || page.guests !== null;
  return (
    <div className={styles.page} data-page="server" {...swipe}>
      <div className={styles.pageBody} key={id} data-swipe={props.swipe}>
        <PageHead
          mark={<Mark mark={server.mark} fallback="server" size={24} />}
          title={server.name}
          sub={subLine(page)}
          onBack={onBack}
        >
          {state && (
            <>
              <span className={styles.chip} data-tone={state.tone === 'ok' ? undefined : state.tone}>
                <i className={styles.stateDot} data-tone={state.tone} />
                {state.text}
              </span>
              <span className={styles.sep} />
            </>
          )}
          {lock}
        </PageHead>
        {unavailable && <p className={styles.pageNote}>{W.unavailable}</p>}
        <div className={styles.kpis}>
          <Kpi k={W.cpu} f={figures.cpu} />
          <Kpi k={W.memory} f={figures.memory} />
          <Kpi k={W.disk} f={figures.disk} />
          <Kpi k={W.temperature} f={figures.temp} />
        </div>
        <div className={styles.mid} data-side={side || undefined}>
          <div className={styles.midMain}>
            {items.length > 0 && <Alerts items={items} />}
            <ChartCard server={server} page={page} range={range} timeZone={timeZone} onRange={setRange} />
          </div>
          {side && (
            <div className={styles.midSide}>
              {(!page || page.volumes.length > 0) && <Storage volumes={page?.volumes ?? []} />}
              {(!page || page.guests) && <Guests guests={page?.guests} />}
            </div>
          )}
        </div>
        <footer className={styles.pageFoot}>
          <div className={styles.pageNet}>
            {page?.network && (
              <>
                <Icon name="updown" />
                {fill(DESK_WORDS.box.network, { down: page.network.down, up: page.network.up })}
              </>
            )}
          </div>
          <div className={styles.pageDots}>
            <Dots list={list} index={index} onIndex={(i) => onIndex(i, i > index ? 'next' : 'prev')} />
          </div>
          <div className={styles.pageAsk}>
            {assistant && (
              <button
                type="button"
                className={styles.askButton}
                onClick={(e) => {
                  e.stopPropagation();
                  onAsk(server);
                }}
              >
                <Icon name="mic" />
                {fill(W.ask, { assistant, server: server.name })}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
