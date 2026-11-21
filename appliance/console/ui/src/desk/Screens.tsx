/**
 * The screen of widgets on the box (contracts 3.6; Whombat desk-display.md “Screens of widgets”, mockups
 * `docs/design/desk-widgets/`): when the runtime sends the box's grid, the glance is that grid under the console's own
 * top bar chips (the network, the internet, Bluetooth, remote help, updating, the battery, the lock), and each monitor
 * plugged into the box shows its own screen beside it. The drawing is `@whombat/screen`'s; this file is the console's
 * side of it: the chips, the pictures (fetched through the console server, which asks the runtime), what the modal's
 * buttons do (the ask's card, the look's step, a server's screen), and telling the runtime which outputs there are.
 */
import type { ScreenCalm } from '@whombat/screen';
import { type AskView, Screen, type ScreenProps } from '@whombat/screen/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeskCalm } from '../lib/calm';
import { DEFAULT_BAR } from '../lib/calm';
import type { Client } from '../lib/client';
import type { AgentFace, DeskFound } from '../lib/desk';
import { clockText, DESK, DESK_WORDS, dateText } from '../lib/deskCopy';
import type { DeskAttentionItem, DeskGrid, DeskImage, DeskOutputGrid } from '../lib/grid';
import { type PlacedOutput, SIZE_AGAIN_MS, sizeReport } from '../lib/outputs';
import { useStageSize } from '../ui/Stage';
import { useNetwork } from '../wifi/WifiLayer';
import { BarChips, CalmSheet, type ChipsProps, StatusSheet } from './Calm';
import calmStyles from './calm.module.css';
import { FoundStrip } from './Found';
import { Icon } from './icons';
import { ClockText, Face } from './parts';
import styles from './screens.module.css';

const NONE: ReadonlySet<string> = new Set();

/* The pictures ---------------------------------------------------------------------------------------------------- */

/** Pictures kept as blob URLs (the newest); every widget of every page of a screen fits. */
const IMAGES_KEPT = 96;

/**
 * The drawing's image loader: a picture a widget names, fetched once through the console server (with the page's
 * token) and shown from a blob URL; the oldest let go past IMAGES_KEPT. A refusal is no picture.
 */
export function useImageLoader(client: Client): (image: DeskImage) => Promise<string> {
  const cache = useRef(new Map<string, Promise<string>>());
  useEffect(() => {
    const kept = cache.current;
    return () => {
      for (const p of kept.values()) p.then(URL.revokeObjectURL, () => {});
      kept.clear();
    };
  }, []);
  return useCallback(
    (image: DeskImage) => {
      const kept = cache.current;
      const key = `${image.thing} ${image.ref}`;
      const hit = kept.get(key);
      if (hit) {
        kept.delete(key);
        kept.set(key, hit);
        return hit;
      }
      const path = `/api/desk/image?thing=${encodeURIComponent(image.thing)}&ref=${encodeURIComponent(image.ref)}`;
      const p = client.blob(path).then((b) => {
        if (!b) throw new Error('no picture');
        return URL.createObjectURL(b);
      });
      p.catch(() => kept.delete(key));
      kept.set(key, p);
      for (const [k, old] of kept) {
        if (kept.size <= IMAGES_KEPT) break;
        kept.delete(k);
        old.then(URL.revokeObjectURL, () => {});
      }
      return p;
    },
    [client],
  );
}

/* The outputs ----------------------------------------------------------------------------------------------------- */

/**
 * Tells the runtime which outputs the page shows on and how big they are: at start, whenever they change, when the
 * runtime is back after being away (it may have restarted and forgotten), and again every SIZE_AGAIN_MS. Not while
 * `on` is false (no desk, Whombat away).
 */
export function useSizeReport(client: Client, placed: PlacedOutput[], on: boolean) {
  const body = useMemo(() => JSON.stringify(sizeReport(placed)), [placed]);
  const sent = useRef<{ body: string; at: number } | null>(null);
  useEffect(() => {
    if (!on) {
      sent.current = null;
      return;
    }
    const say = () => {
      sent.current = { body, at: Date.now() };
      void client.post('/api/desk/size', JSON.parse(body)).then(
        (r) => {
          // Refused or not understood (an older runtime): asked again in a minute, not on every poll.
          if (r.status !== 200 && sent.current) sent.current.at = Date.now() - SIZE_AGAIN_MS + 60_000;
        },
        () => {
          if (sent.current) sent.current.at = Date.now() - SIZE_AGAIN_MS + 60_000;
        },
      );
    };
    if (sent.current?.body !== body) say();
    const timer = setInterval(() => {
      if (!sent.current || Date.now() - sent.current.at >= SIZE_AGAIN_MS) say();
    }, 60_000);
    return () => clearInterval(timer);
  }, [client, body, on]);
}

/* The drawing ----------------------------------------------------------------------------------------------------- */

/** Whombat's own widgets read the calm glance: the page's (lib/calm.ts) as the drawing has it. */
export function screenCalm(c: DeskCalm | null): ScreenCalm | null {
  if (!c) return null;
  const some = <T,>(v: T | null): T | undefined => (v === null ? undefined : v);
  return {
    headline: { tone: c.headline.tone, text: c.headline.text, more: some(c.headline.more) },
    moments: c.moments.map((m) => ({
      key: m.key,
      kind: m.kind,
      name: m.name,
      mark: some(m.mark),
      value: m.value,
      detail: some(m.detail),
      progress: some(m.progress),
      pinned: m.pinned || undefined,
    })),
    strip: c.strip.map((x) => ({
      id: some(x.id),
      name: x.name,
      mark: x.mark,
      state: x.state,
      say: some(x.say),
      spark: x.spark,
      work: some(x.work),
      progress: some(x.progress),
    })),
    moreStrip: c.moreStrip,
    doneCount: some(c.doneCount),
  };
}

/** What the screen's buttons do on the box's own display. */
export interface ScreenActions {
  /** An ask's card (the PIN pad beside it while locked). */
  onAsk?: (number: number) => void;
  /** A question's own words and answers in the pop-up (DK-151, CG-397); without it the pop-up offers the card. */
  askView?: (item: DeskAttentionItem) => AskView | null;
  /** A look's card. */
  onLook?: (key: string) => void;
  /** The step the assistant offers on a look (the PIN first while locked). */
  onStep?: (key: string) => void;
  /** *Ask {assistant} to fix it* (the PIN first while locked). */
  onFix?: (key: string) => void;
  /** A server's own screen. */
  onServer?: (id: string) => void;
  /** Every server. */
  onServers?: () => void;
  /** The PIN pad (a widget that hides its words while locked was touched). */
  onUnlock?: () => void;
  /** *Not now*: the modal's items it showed are put away (it opens again only for something new). */
  onNotNow?: (keys: string[]) => void;
}

/** The modal's buttons as the box's display answers them: the item's look or ask, through the page's own cards. */
function attentionActions(a: ScreenActions): Partial<ScreenProps> {
  const look = (f?: (key: string) => void) =>
    f ? (item: DeskAttentionItem) => (item.look ? f(item.look) : undefined) : undefined;
  return {
    askView: a.askView,
    onAnswer: a.onAsk ? (ask) => a.onAsk?.(ask) : undefined,
    onFix: look(a.onFix),
    onStep: look(a.onStep),
    // *Open {name}*: a server's own screen, else the look's card (the thing's page is the apps').
    onOpen: (item) => {
      if (item.server && a.onServer) a.onServer(item.server);
      else if (item.look) a.onLook?.(item.look);
    },
  };
}

/* The box's own display ------------------------------------------------------------------------------------------- */

export interface GridGlanceProps extends Omit<ChipsProps, 'calm'>, ScreenActions {
  grid: DeskGrid;
  calmGlance: DeskCalm | null;
  /** What Done today lists (the glance's `done`). */
  done: { text: string; at: string }[];
  name: string;
  now: number;
  notNow: readonly string[];
  loadImage: (image: DeskImage) => Promise<string>;
  /** Found on your network: the strip over the grid's bottom while something was found, with its *Not now*. */
  found: DeskFound | null;
  appUrl: string;
  onFoundDismiss?: () => void;
}

/** The glance as a screen of widgets: the grid at the stage's size, the console's chips in its top bar. */
export function GridGlance(props: GridGlanceProps) {
  const stage = useStageSize();
  const [sheet, setSheet] = useState<'status' | 'done' | null>(null);
  const bar = props.calmGlance ?? { bar: DEFAULT_BAR, update: null };
  const calm = useMemo(() => screenCalm(props.calmGlance), [props.calmGlance]);
  const face = props.paired.assistant.face;
  const renderFace = useCallback((size: number) => <Face face={face} size={size} />, [face]);
  return (
    <div className={styles.glance}>
      <Screen
        width={stage.width}
        height={stage.height}
        grid={props.grid}
        calm={calm}
        name={props.name}
        assistant={props.paired.assistant.name}
        timeZone={props.paired.timeZone}
        now={props.now}
        chips={<BarChips {...props} calm={bar} onSheet={() => setSheet('status')} />}
        loadImage={props.loadImage}
        renderFace={renderFace}
        away={props.notNow}
        onAway={props.onNotNow}
        onServer={props.onServer}
        onServers={props.onServers}
        onDoneToday={props.done.length > 0 ? () => setSheet('done') : undefined}
        onUnlock={props.unlocked ? undefined : props.onUnlock}
        locked={!props.unlocked}
        {...attentionActions(props)}
        overlay={
          props.found && (
            <div className={styles.found}>
              <FoundStrip
                found={props.found}
                appUrl={props.appUrl}
                now={props.now}
                latest={NONE}
                onDismiss={props.onFoundDismiss}
                alone={false}
              />
            </div>
          )
        }
      />
      {sheet === 'status' && <StatusSheet calm={bar} power={props.power} onClose={() => setSheet(null)} />}
      {sheet === 'done' && (
        <CalmSheet title={DESK_WORDS.doneToday} onClose={() => setSheet(null)}>
          {props.done.map((d) => (
            <div key={`${d.at}-${d.text}`} className={calmStyles.sheetRow}>
              <span>✓ {d.text}</span>
            </div>
          ))}
        </CalmSheet>
      )}
    </div>
  );
}

/* The monitors ---------------------------------------------------------------------------------------------------- */

/** How a monitor shows while the box's own display is dark (the night, black, pairing) or dimmed (nobody there). */
export type MonitorMode = 'screen' | 'dim' | 'dark';

/** A monitor's chips: whether the box is online, and whether it is locked; it only shows them. */
function MonitorChips({ unlocked }: { unlocked: boolean }) {
  const { summary } = useNetwork();
  return (
    <>
      {summary && summary.via !== 'none' && (
        <span className={calmStyles.chip} data-tone={summary.online ? undefined : 'warn'}>
          <Icon name="globe" className={calmStyles.chipIcon} />
          {summary.online ? DESK_WORDS.calm.bar.online : DESK_WORDS.calm.bar.offline}
        </span>
      )}
      <span className={calmStyles.chip}>
        {!unlocked && <Icon name="lock" className={calmStyles.chipIcon} />}
        {unlocked ? DESK.monitorUnlocked : DESK.monitorLocked}
      </span>
    </>
  );
}

/**
 * Every monitor on the box, each in its rectangle of the window with its own screen: its grid when the runtime sent one
 * for it, else only the time (the lock's *Only the time*, or before the runtime knows the monitor). A monitor only
 * shows: its pages turn and its widgets open big, but its modal says to answer on the phone or at the box's own
 * screen, as a screen elsewhere's does.
 */
export function MonitorScreens({
  monitors,
  grids,
  mode,
  calm,
  name,
  assistant,
  face,
  now,
  timeZone,
  unlocked,
  onlyTime,
  loadImage,
}: {
  monitors: PlacedOutput[];
  grids: DeskOutputGrid[];
  mode: MonitorMode;
  calm: DeskCalm | null;
  name: string;
  assistant: string;
  face: AgentFace | null;
  now: number;
  timeZone: string;
  unlocked: boolean;
  /** Locked into *Only the time* (DK-138): the clock alone, on every screen. */
  onlyTime: boolean;
  loadImage: (image: DeskImage) => Promise<string>;
}) {
  const screenCalmOf = useMemo(() => screenCalm(calm), [calm]);
  const renderFace = useCallback((size: number) => (face ? <Face face={face} size={size} /> : null), [face]);
  return (
    <>
      {monitors.map((o) => {
        const grid = grids.find((x) => x.key === o.key)?.grid ?? null;
        return (
          <div
            key={o.key}
            className={styles.monitor}
            style={{ left: o.left, top: o.top, width: o.width, height: o.height }}
            data-monitor={o.key}
            data-mode={mode}
          >
            {mode === 'dark' ? null : grid ? (
              <Screen
                width={o.logical.width}
                height={o.logical.height}
                scale={o.width / o.logical.width}
                grid={grid}
                calm={screenCalmOf}
                name={name}
                assistant={assistant}
                timeZone={timeZone}
                now={now}
                chips={<MonitorChips unlocked={unlocked} />}
                loadImage={loadImage}
                renderFace={renderFace}
                answerElsewhere
                locked={!unlocked}
                onlyTime={onlyTime}
              />
            ) : (
              <div className={styles.time} style={{ zoom: o.width / o.logical.width }}>
                <div className={styles.timeClock}>
                  <ClockText text={clockText(now, timeZone)} />
                </div>
                <div className={styles.timeDate}>{dateText(now, timeZone)}</div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Whether an event happened on a monitor: the box's own display's touch rules don't apply there. */
export const onMonitor = (t: EventTarget | null) =>
  t instanceof Element && t.closest('[data-monitor]') !== null;
