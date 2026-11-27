/**
 * The glance (mockup 1, DK-03, DK-37): the time, the assistant's line while something needs you (DK-94), Needs you with
 * the asks and what needs a look (DK-93), Working on, Done today, then the servers, Found on your network and This
 * Whombat in the room left, at its bottom (DK-38…DK-40, DK-91, DK-92, DF-06, `lib/deskFit.ts`), and the power. No home
 * tiles (DK-91). What the runtime leaves out while locked (titles in “A summary”, everything in “Only the time”) simply
 * isn't drawn; the layout keeps its places.
 */
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { BluetoothChip } from '../bluetooth/BluetoothLayer';
import type {
  DeskAsk,
  DeskBox,
  DeskFound,
  DeskGlance,
  DeskLook,
  DeskPaired,
  DeskPower,
  DeskServer,
} from '../lib/desk';
import { ago, clockText, DESK, DESK_WORDS, dateText, fill, foundSay } from '../lib/deskCopy';
import { type FitPlan, planFit } from '../lib/deskFit';
import { assistantLine, type NeedRow, needRows, needsTotal, researchTitle } from '../lib/needsYou';
import { NetworkChip } from '../wifi/WifiLayer';
import { Box, BoxCard } from './Box';
import styles from './desk.module.css';
import { FoundPanel, FoundStrip, foundKey } from './Found';
import { Icon } from './icons';
import { ClockText, Face, LockChip, PowerBanner, ServerCard, TopBar } from './parts';
import { RemoteHelpChip } from './RemoteHelp';

export interface GlanceProps {
  paired: DeskPaired;
  glance: DeskGlance | null;
  power: DeskPower | null;
  burrow: string | null;
  /** Server clock (ms). */
  now: number;
  unlocked: boolean;
  /** Minutes until the screen locks again; null: it stays unlocked until Lock (DK-74). */
  locksIn: number | null;
  /** The camera is on, and it sees someone (DK-28, DK-30): the lock chip says so. */
  camera: boolean;
  present: boolean;
  /** The camera looks for someone in front of the screen (DK-72, DK-73): the lock chip shows the camera mark. */
  looking: boolean;
  onLock: () => void;
  /** A Needs you row: the ask sheet (with the PIN pad while locked). */
  onAsk: (number: number) => void;
  /** “Touch to answer” and a Needs you card without titles: unlock, then the first ask. */
  onAnswer: () => void;
  /** Something that needs a look (DK-95): its card, by its key. */
  onLook: (key: string) => void;
  onTalk: () => void;
  /** The console's `appUrl` (“app.whombat.com”): where Found on your network says to connect (DF-01). */
  appUrl: string;
  /** Found on your network's Not now (DF-04); absent while Whombat is away. */
  onFoundDismiss?: () => void;
  /** Fixtures only: the found services the page had seen before (`foundKey`); the others arrived just now. */
  foundSeen?: readonly string[];
  /**
   * A server card was touched (DK-83): its screen, with the servers it can swipe through (the glance's, in their order,
   * those with an id) and its place among them. Locked too (DK-84). Absent while Whombat is away.
   */
  onServer?: (list: DeskServer[], index: number) => void;
  /** “+N more” was touched (DK-86): every server. */
  onServers?: () => void;
  /** This Whombat's card or panel was touched (DK-87): its own screen. */
  onSelf?: () => void;
}

/** The top bar's chips: Talk (unlocked), the network, Bluetooth, remote help and the lock. */
function Chips({ paired, unlocked, locksIn, camera, present, looking, onLock, onTalk }: GlanceProps) {
  return (
    <>
      {unlocked && paired.voice && (
        <>
          <button
            type="button"
            className={`${styles.chip} ${styles.chipButton}`}
            onClick={(e) => {
              e.stopPropagation();
              onTalk();
            }}
          >
            <Icon name="mic" className={styles.chipIcon} />
            {fill(DESK_WORDS.settings.talkTo, { assistant: paired.assistant.name })}
          </button>
          <span className={styles.sep} />
        </>
      )}
      {/* How the box is connected; opens the Wi-Fi sheet (CG-105). What Bluetooth has connected; its sheet (CG-202). */}
      <NetworkChip after={<span className={styles.sep} />} />
      <BluetoothChip after={<span className={styles.sep} />} />
      {/* While Whombat support may get in: “Remote”, its sheet with Stop (CG-295). */}
      <RemoteHelpChip after={<span className={styles.sep} />} />
      <LockChip
        unlocked={unlocked}
        name={paired.person.name}
        minutes={locksIn}
        camera={camera}
        present={present}
        looking={looking}
        onLock={onLock}
      />
    </>
  );
}

function AskRow({
  ask,
  assistant,
  now,
  onAsk,
}: {
  ask: DeskAsk;
  assistant: string;
  now: number;
  onAsk: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.askRow}
      onClick={(e) => {
        e.stopPropagation();
        onAsk();
      }}
    >
      <span className={styles.dot} />
      <span className={styles.askRowText}>
        <b className={styles.askTitle}>{ask.title}</b>
        <span className={styles.askMeta}>
          {/* Who asks (TF-15): the requester when the runtime names one. */}
          {ask.from ?? assistant} · {ago(ask.at, now)}
        </span>
      </span>
    </button>
  );
}

/** Something that needs a look (DK-93): red when it is down or in trouble, amber otherwise; why, or what it is. */
function LookRow({ look, onLook }: { look: DeskLook; onLook: () => void }) {
  return (
    <button
      type="button"
      className={styles.askRow}
      onClick={(e) => {
        e.stopPropagation();
        onLook();
      }}
    >
      <span className={styles.dot} data-tone={look.state === 'look' ? undefined : 'bad'} />
      <span className={styles.askRowText}>
        <b className={styles.askTitle}>{researchTitle(look)}</b>
        <span className={styles.askMeta}>{look.reason ?? DESK_WORDS.looks.kinds[look.kind]}</span>
      </span>
    </button>
  );
}

/** Shown rows: two fit beside the clock; more are counted. */
const ROWS = 2;

function NeedsYou(props: GlanceProps & { glance: DeskGlance }) {
  const { glance, paired, unlocked, now, onAsk, onAnswer, onLook } = props;
  const count = needsTotal(glance);
  const rows = needRows(glance);
  const head = (
    <div className={styles.needsHead}>
      <span className={styles.label}>{DESK_WORDS.needsYou}</span>
      {count > 0 && <span className={styles.count}>{count}</span>}
    </div>
  );
  // A new box (DK-23): the card keeps its place beside the clock, calm, saying where decisions will show.
  if (count === 0 && glance.box) {
    return (
      <section className={`${styles.card} ${styles.needsCalm}`}>
        <span className={styles.label}>{DESK_WORDS.needsYou}</span>
        <div className={styles.none}>
          <Icon name="check" />
          <div>
            {DESK_WORDS.nothingNeedsYou}
            <span className={styles.noneHint}>{DESK_WORDS.nothingNeedsYouHint}</span>
          </div>
        </div>
      </section>
    );
  }
  if (count === 0) {
    return (
      <section className={`${styles.card} ${styles.needs}`} data-compact>
        {head}
        <div className={styles.calm}>
          <Icon name="check" />
          {DESK_WORDS.nothingNeedsYou}
        </div>
      </section>
    );
  }
  const touch = (
    <>
      <Icon name="lock" />
      {DESK_WORDS.touchToAnswer}
    </>
  );
  // “A summary” while locked with asks only: no titles, the card is one button.
  if (rows.length === 0) {
    return (
      <button
        type="button"
        className={`${styles.card} ${styles.needs} ${styles.needsButton}`}
        data-asks
        data-compact
        onClick={(e) => {
          e.stopPropagation();
          onAnswer();
        }}
      >
        {head}
        <span className={styles.touch}>{touch}</span>
      </button>
    );
  }
  const open = (r: NeedRow) => (r.kind === 'ask' ? onAsk(r.ask.number) : onLook(r.look.key));
  const shown = rows.slice(0, ROWS);
  const rest = count - shown.length;
  const next = rows[ROWS];
  // Locked with asks to answer: the PIN first (“Touch to answer”); else the next row, or the asks it only counts.
  const asksLocked = !unlocked && glance.needsYou.count > 0;
  return (
    <section className={`${styles.card} ${styles.needs}`} data-asks>
      {head}
      {shown.map((r) =>
        r.kind === 'ask' ? (
          <AskRow
            key={`ask-${r.ask.number}`}
            ask={r.ask}
            assistant={paired.assistant.name}
            now={now}
            onAsk={() => open(r)}
          />
        ) : (
          <LookRow key={`look-${r.look.key}`} look={r.look} onLook={() => open(r)} />
        ),
      )}
      {asksLocked ? (
        <button
          type="button"
          className={`${styles.touch} ${styles.plain}`}
          onClick={(e) => {
            e.stopPropagation();
            onAnswer();
          }}
        >
          {touch}
        </button>
      ) : (
        rest > 0 && (
          <button
            type="button"
            className={`${styles.touch} ${styles.plain}`}
            onClick={(e) => {
              e.stopPropagation();
              if (next) open(next);
              else onAnswer();
            }}
          >
            {fill(DESK.more, { n: rest })}
          </button>
        )
      )}
    </section>
  );
}

function Working({ working }: { working: NonNullable<DeskGlance['working']> }) {
  return (
    <section className={`${styles.card} ${styles.work}`}>
      <span className={styles.label}>{DESK_WORDS.workingOn}</span>
      <div className={styles.workTitle}>{working.title}</div>
      {working.steps.length > 0 && (
        <div
          className={styles.steps}
          style={{ gridTemplateColumns: `repeat(${working.steps.length}, minmax(0, 1fr))` }}
        >
          {working.steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are a fixed, ordered list
            <div key={i} className={styles.step} data-state={s.state}>
              <div className={styles.bar} />
              <b className={styles.stepLabel}>{s.label}</b>
              <span className={styles.stepNote}>{DESK_WORDS.steps[s.state]}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DoneToday({ done, timeZone }: { done: DeskGlance['done']; timeZone: string }) {
  return (
    <section className={`${styles.card} ${styles.doneList}`}>
      <span className={styles.label}>{DESK_WORDS.doneToday}</span>
      {done.map((d) => (
        <div key={`${d.at}-${d.text}`} className={styles.doneItem}>
          <Icon name="check" />
          <span className={styles.doneText}>{d.text}</span>
          <span className={styles.doneTime}>{clockText(Date.parse(d.at), timeZone)}</span>
        </div>
      ))}
    </section>
  );
}

/**
 * The assistant's line: what it found on a glance with nothing connected while nothing needs you and nothing is being
 * worked on (DF-09), else only while something needs you, the first thing (DK-94), as a button that opens it.
 */
function sayOf(
  glance: DeskGlance | null,
): { text: string; more: string | null; opens?: NeedRow | null } | null {
  if (!glance) return null;
  const { found } = glance;
  const calm = glance.servers.length === 0 && needsTotal(glance) === 0 && glance.working === null;
  if (found && calm) return foundSay(found);
  return assistantLine(glance);
}

/**
 * The found services that arrived in the last change while the glance showed (`foundKey`): they fade in once and, while
 * the first scan looks, have the brand's edge (DF-10, frame 1). The ones there when the glance first showed are seen.
 */
function useArrived(
  found: DeskFound | null | undefined,
  seenBefore?: readonly string[],
): ReadonlySet<string> {
  const keys = found?.items.map(foundKey) ?? [];
  const sig = keys.join('\n');
  const seen = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() =>
    seenBefore ? new Set(keys.filter((k) => !seenBefore.includes(k))) : new Set(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the keys change exactly when `sig` does
  useLayoutEffect(() => {
    if (!seen.current) {
      seen.current = new Set(seenBefore ?? keys);
      if (!seenBefore) return;
    }
    const added = keys.filter((k) => !seen.current?.has(k));
    for (const k of added) seen.current.add(k);
    if (added.length > 0) setArrived(new Set(added));
  }, [sig]);
  return arrived;
}

/** The assistant's face and words; a button when they are about something that needs you (DK-94). */
function Say({
  say,
  paired,
  unlocked,
  onAsk,
  onAnswer,
  onLook,
}: GlanceProps & { say: NonNullable<ReturnType<typeof sayOf>> }) {
  const words = (
    <>
      {/* A tap pokes the face only where it does nothing else: not on words that open something, nor on a locked
          screen, where a touch opens the PIN pad. */}
      <Face
        face={paired.assistant.face}
        size={54}
        label={paired.assistant.name}
        pokeable={say.opens === undefined && unlocked}
      />
      <p className={styles.sayText}>
        {say.text}
        {say.more && (
          <>
            {' '}
            <span className={styles.sayMore}>{say.more}</span>
          </>
        )}
      </p>
    </>
  );
  if (say.opens === undefined) return <div className={styles.say}>{words}</div>;
  const opens = say.opens;
  return (
    <button
      type="button"
      className={`${styles.say} ${styles.sayButton}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!opens) onAnswer();
        else if (opens.kind === 'ask') onAsk(opens.ask.number);
        else onLook(opens.look.key);
      }}
    >
      {words}
    </button>
  );
}

export function Glance(props: GlanceProps) {
  const { paired, glance, power, burrow, now } = props;
  const tz = paired.timeZone;
  const say = sayOf(glance);
  const working = glance?.working ?? null;
  const done = glance?.done ?? [];
  const battery = power?.source === 'battery';
  const { room, banner, size } = useRoom();
  const plan = fitGlance(glance, size);
  const arrived = useArrived(glance?.found, props.foundSeen);
  return (
    // On battery with every row, the banner fits by closing the gaps a little (`data-tight`).
    <div
      className={styles.glance}
      data-tight={(battery && (working !== null || done.length > 0)) || undefined}
    >
      <TopBar burrow={burrow} power={power}>
        <Chips {...props} />
      </TopBar>
      <div className={styles.hero}>
        <div>
          <div className={styles.clock}>
            <ClockText text={clockText(now, tz)} />
            <span className={styles.date}>{dateText(now, tz)}</span>
          </div>
          {say && <Say say={say} {...props} />}
        </div>
        {glance && <NeedsYou {...props} glance={glance} />}
      </div>
      {(working || done.length > 0) && (
        <div className={working && done.length > 0 ? styles.row : `${styles.row} ${styles.rowOne}`}>
          {working && <Working working={working} />}
          {done.length > 0 && <DoneToday done={done} timeZone={tz} />}
        </div>
      )}
      {/* The room left: measured before paint, planned, drawn; the battery line under it (CG-135). */}
      <div className={styles.fit} ref={room}>
        {glance && plan && (
          <Fitted
            glance={glance}
            assistant={paired.assistant.name}
            plan={plan}
            found={{
              appUrl: props.appUrl,
              now,
              latest: arrived,
              onDismiss: props.onFoundDismiss,
            }}
            onServer={props.onServer}
            onServers={props.onServers}
            onSelf={props.onSelf}
          />
        )}
        {battery && (
          <PowerBanner ref={banner} power={power} assistant={paired.assistant.name} timeZone={tz} compact />
        )}
      </div>
    </div>
  );
}

/** The room under the glance's top part and the gap between its rows, in layout px (the stage's zoom left out). */
interface Room {
  height: number;
  gap: number;
}

/**
 * Measures the room before the browser paints (a layout effect, then a resize observer flushed at once), so the plan
 * never shows one frame late. Computed styles are in layout px whatever the stage's zoom (CG-38).
 */
function useRoom() {
  const room = useRef<HTMLDivElement>(null);
  const banner = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Room | null>(null);
  const read = useCallback(() => {
    const el = room.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const gap = Number.parseFloat(css.rowGap) || 0;
    // The battery line stays under the rows: its height and gap are not theirs.
    const line = banner.current ? (Number.parseFloat(getComputedStyle(banner.current).height) || 0) + gap : 0;
    const next = { height: Math.max(0, (Number.parseFloat(css.height) || 0) - line), gap };
    setSize((s) => (s && s.height === next.height && s.gap === next.gap ? s : next));
  }, []);
  // Every render: the gap (`data-tight`) and the battery line can change without the room's size changing.
  useLayoutEffect(read);
  useLayoutEffect(() => {
    const el = room.current;
    if (!el) return;
    const ro = new ResizeObserver(() => flushSync(read));
    ro.observe(el);
    return () => ro.disconnect();
  }, [read]);
  return { room, banner, size };
}

/** What the found panel and strip need besides `found` (DF-06). */
type FoundView = Omit<Parameters<typeof FoundPanel>[0], 'found' | 'rows'>;

/**
 * The plan drawn: the servers' grid, three to a row (This Whombat's card first, DK-82), “+N more”, Found on your network
 * (the strip, or the panel in This Whombat's place), This Whombat's panel. A card with a server id opens
 * the server's screen, “+N more” every server (DK-83, DK-86); a runtime before 0.115 sends no ids (DK-88).
 */
function Fitted({
  glance,
  assistant,
  plan,
  found,
  onServer,
  onServers,
  onSelf,
}: {
  glance: DeskGlance;
  /** The agent's name, This Whombat's storage part's. */
  assistant: string;
  plan: FitPlan;
  found: FoundView;
  onServer?: GlanceProps['onServer'];
  onServers?: () => void;
  onSelf?: () => void;
}) {
  const whombat: DeskBox | null = glance.box ?? glance.self ?? null;
  const all = [...glance.servers, ...(glance.extraServers ?? [])];
  const servers = all.slice(0, plan.servers);
  // The servers a screen swipes through: the glance's, in their order, those that open.
  const list = all.filter((s) => s.id !== undefined);
  const open = (s: DeskServer) => {
    const index = list.indexOf(s);
    return onServer && index >= 0 ? () => onServer(list, index) : undefined;
  };
  const cards: ReactNode[] = [
    // A server's name never starts with a space (the runtime's names are trimmed): the key can't clash.
    ...(plan.box === 'card' && whombat ? [<BoxCard key=" self" box={whombat} onOpen={onSelf} />] : []),
    ...servers.map((s) => <ServerCard key={s.name} server={s} onOpen={open(s)} />),
  ];
  const more = fill(DESK_WORDS.moreServers, { n: plan.more });
  return (
    <>
      {cards.length > 0 && <div className={styles.serverGrid}>{cards}</div>}
      {plan.more > 0 &&
        (onServers && list.length > 0 ? (
          <button
            type="button"
            className={`${styles.moreServers} ${styles.moreButton}`}
            onClick={(e) => {
              e.stopPropagation();
              onServers();
            }}
          >
            {more}
            <Icon name="chevron" />
          </button>
        ) : (
          <p className={styles.moreServers}>{more}</p>
        ))}
      {glance.found && plan.found === 'panel' && (
        <FoundPanel {...found} found={glance.found} rows={plan.foundRows} />
      )}
      {glance.found && plan.found === 'strip' && (
        <FoundStrip {...found} found={glance.found} alone={plan.serverRows.length === 0} />
      )}
      {/* The hint to connect something only on a new box (DK-22); beside servers or tiles it would be wrong. */}
      {plan.box === 'panel' && whombat && (
        <Box box={whombat} assistant={assistant} hint={glance.box !== null} onOpen={onSelf} />
      )}
    </>
  );
}

/** The plan for a glance in the room measured (DK-38…DK-41). */
function fitGlance(glance: DeskGlance | null, room: Room | null): FitPlan | null {
  if (!glance || !room) return null;
  const extra = glance.extraServers?.length ?? 0;
  return planFit({
    height: room.height,
    gap: room.gap,
    servers: glance.servers.length + extra,
    unsent: Math.max(0, glance.moreServers - extra),
    // No home tiles on the glance (DK-91): Whombat still sends them for older screens.
    tiles: 0,
    box: (glance.box ?? glance.self ?? null) !== null,
    found: glance.found ? { looking: glance.found.progress !== null } : null,
  });
}

/** “Only the time” while locked (DK-03): the clock, the date and the one line. */
export function ClockOnly(props: GlanceProps) {
  const { paired, glance, power, burrow, now } = props;
  const tz = paired.timeZone;
  return (
    <div className={styles.glance}>
      <TopBar burrow={burrow} power={power}>
        <Chips {...props} />
      </TopBar>
      <div className={styles.clockOnly}>
        <div className={styles.bigClock}>
          <ClockText text={clockText(now, tz)} />
        </div>
        <div className={styles.bigDate}>{dateText(now, tz)}</div>
        {glance?.status.text && <p className={styles.bigLine}>{glance.status.text}</p>}
      </div>
      {power?.source === 'battery' && (
        <PowerBanner power={power} assistant={paired.assistant.name} timeZone={tz} compact />
      )}
    </div>
  );
}
