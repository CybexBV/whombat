import type { Translate } from '../i18n/translate';
/** The desk's shared pieces: the top bar, the agent's face, a server card, a home tile, the power line. */
import { type FaceState, LiveFace } from '@whombat/avatars/live';
import { isBrandMark } from '@whombat/brand';
import { BrandMark, WhombatLogo } from '@whombat/brand/react';
import { createContext, type ReactNode, type Ref, useContext } from 'react';
import { useT } from '../i18n/react';
import type { AgentFace, DeskMeter, DeskPower, DeskServer, DeskTile } from '../lib/desk';
import { deskWordsCopy, fill, percent, powerBanner, powerChip, unlockedText } from '../lib/deskCopy';
import styles from './desk.module.css';
import { Icon, TILE_ICON } from './icons';

/**
 * The time as the clocks draw it (DK-90): the colon in a span of its own, so it keeps a little room from the digits
 * however tight they sit. Read as one time.
 */
export function ClockText({ text }: { text: string }) {
  const at = text.indexOf(':');
  if (at < 0) return <>{text}</>;
  return (
    <>
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true">
        {text.slice(0, at)}
        <span className={styles.colon}>:</span>
        {text.slice(at + 1)}
      </span>
    </>
  );
}

/**
 * What the desk's faces show when nothing else says (`deskMood`): asleep while nobody's there and in quiet hours, a
 * hello once they woke. The sheets' faces stay outside it.
 */
export const FaceMood = createContext<FaceState>('idle');

/**
 * The agent's round face on its drawing's colour (the mockups' avatar), alive: it shows what the agent is doing.
 * Always `calm`: the box's screen draws without a graphics chip, where blinks, pose changes and gestures cost about 1 %
 * of a core but anything that moves without end costs 5–9 %; the page can't tell whether a chip draws it.
 */
export function Face({
  face,
  size,
  label,
  state,
  level,
  pokeable = false,
}: {
  face: AgentFace;
  size: number;
  label?: string;
  /** What the agent is doing; the desk's mood (`FaceMood`) without it. */
  state?: FaceState;
  /** The voice's loudness now, 0–1, while listening or speaking: the same function from render to render. */
  level?: (() => number) | null;
  /** A tap pokes it: only where a tap does nothing else. */
  pokeable?: boolean;
}) {
  const mood = useContext(FaceMood);
  return (
    <LiveFace
      face={face}
      size={size}
      state={state ?? mood}
      level={level}
      pokeable={pokeable}
      motion="calm"
      eager
      label={label}
      crop="head"
      className={styles.face}
      style={{ background: `var(--face-${face})` }}
    />
  );
}

export function TopBar({
  burrow,
  power,
  children,
}: {
  burrow: string | null;
  power: DeskPower | null;
  /** The chips on the right, after the power chip. */
  children?: ReactNode;
}) {
  const t = useT();

  return (
    <header className={styles.top}>
      {/* The full face at 24 px (mockups 1–3): the stage draws it at 48 px on the Z13, where the brand picks it. */}
      <WhombatLogo variant="symbol" height={48} label="Whombat" style={{ width: 30.4, height: 24 }} />
      {burrow && <b className={styles.burrow}>{burrow}</b>}
      <div className={styles.spacer} />
      {power && (
        <>
          <span className={styles.chip} data-tone={power.source === 'battery' ? 'warn' : undefined}>
            <Icon
              name={power.source === 'battery' ? 'battery' : 'plug'}
              className={
                power.source === 'battery' ? `${styles.chipIcon} ${styles.chipWarn}` : styles.chipIcon
              }
            />
            {powerChip(power, t)}
          </span>
          {children && <span className={styles.sep} />}
        </>
      )}
      {children}
    </header>
  );
}

/** The camera mark (DK-30, DK-73): an outline camera from the desk's icons, muted, its meaning as its label. */
export function CameraMark({ label, className }: { label: string; className?: string }) {
  return (
    <span className={className ?? styles.cameraMark} role="img" aria-label={label} title={label}>
      <Icon name="camera" className={styles.cameraIcon} />
    </span>
  );
}

/**
 * The lock chip (DK-04): “Locked · touch to use”, or “Unlocked as John · locks in 2 min” as the lock button, “Unlocked
 * as John” without minutes when it stays unlocked until Lock (DK-74); while the camera is on, its mark before the
 * words, and while it sees someone “· stays unlocked while you’re here” (DK-28, DK-30, CG-132). One mark when the
 * camera is on for both the lock and the clock (DK-73, CG-174): the lock's, locked or not.
 */
export function LockChip({
  unlocked,
  name,
  minutes,
  camera = false,
  present = false,
  looking = false,
  onLock,
}: {
  unlocked: boolean;
  name: string;
  /** Minutes until it locks again; null: it stays unlocked until Lock (`lock.stays`). */
  minutes: number | null;
  /** The camera is on for the lock (`lock.camera`). */
  camera?: boolean;
  /** The camera sees someone (`lock.present`). */
  present?: boolean;
  /** The camera looks for someone in front of the screen (`presence.camera`, DK-72). */
  looking?: boolean;
  onLock: () => void;
}) {
  const t = useT();
  const DESK_WORDS = deskWordsCopy(t);

  const text = unlockedText(name, minutes, present, t);
  const cameraLabel = camera ? DESK_WORDS.cameraOn : looking ? DESK_WORDS.cameraLooking : null;
  const mark = cameraLabel && <CameraMark label={cameraLabel} />;
  if (!unlocked) {
    return (
      <span className={styles.chip}>
        <Icon name="lock" className={styles.chipIcon} />
        {mark}
        {DESK_WORDS.locked}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${styles.chip} ${styles.chipButton}`}
      onClick={(e) => {
        e.stopPropagation();
        onLock();
      }}
      // The button's label is what it says: the camera's words too (a label hides what is inside).
      aria-label={[text, cameraLabel, DESK_WORDS.lock].filter(Boolean).join('. ')}
    >
      <Icon name="unlock" className={styles.chipIcon} />
      {mark}
      {text}
    </button>
  );
}

/** Segments lit up to the value: twelve by default (temperatures: `max` fills the bar). */
export function Segments({
  value,
  tone,
  max = 100,
  count = 12,
  className,
}: {
  value: number;
  tone: DeskMeter['tone'];
  max?: number;
  count?: number;
  className?: string;
}) {
  const on = Math.round((Math.min(max, Math.max(0, value)) / max) * count);
  return (
    <div className={[styles.seg, className].filter(Boolean).join(' ')} data-tone={tone} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of segments
        <i key={i} data-on={i < on || undefined} />
      ))}
    </div>
  );
}

/** A card's bar: 20 segments now that the bar has a line of its own (DK-80). */
export const CARD_SEGMENTS = 20;

/** One of a card's lines (DK-80): the short label, the block bar and the percentage; none: an empty bar and “–”. */
function CardLine({ k, meter }: { k: string; meter: DeskMeter | null | undefined }) {
  const C = deskWordsCopy(useT()).card;

  return (
    <span className={styles.cardLine}>
      <span className={styles.cardKey}>{k}</span>
      <Segments
        value={meter?.value ?? 0}
        tone={meter?.tone ?? 'ok'}
        count={CARD_SEGMENTS}
        className={styles.cardSeg}
      />
      <span className={styles.cardValue}>{meter ? percent(meter.value) : C.none}</span>
    </span>
  );
}

export interface CardFigures {
  cpu: DeskMeter | null;
  memory: DeskMeter | null;
  /** Absent from a runtime before 0.115: “–” (DK-88). */
  disk?: DeskMeter | null;
}

/** CPU, MEM and DISK, each on a line of its own (DK-80, mockup frame 1). */
export function CardLines({ cpu, memory, disk }: CardFigures) {
  const C = deskWordsCopy(useT()).card;

  return (
    <span className={styles.cardLines}>
      <CardLine k={C.cpu} meter={cpu} />
      <CardLine k={C.memory} meter={memory} />
      <CardLine k={C.disk} meter={disk} />
    </span>
  );
}

/** A card's button label (DK-83): “Open pve-01. up 41 d. CPU 18 %, MEM 54 %, DISK 33 %”. */
export function cardLabel(name: string, note: string, f: CardFigures, t: Translate): string {
  const C = deskWordsCopy(t).card;

  const v = (m: DeskMeter | null | undefined) => (m ? percent(m.value) : C.none);
  const figures = `${C.cpu} ${v(f.cpu)}, ${C.memory} ${v(f.memory)}, ${C.disk} ${v(f.disk)}`;
  return [fill(C.open, { name }), note, figures].filter(Boolean).join('. ');
}

export function Mark({
  mark,
  fallback,
  size = 18,
}: {
  mark: string | null;
  fallback: Parameters<typeof Icon>[0]['name'];
  size?: number;
}) {
  return mark && isBrandMark(mark) ? <BrandMark mark={mark} size={size} /> : <Icon name={fallback} />;
}

/**
 * A card that opens when it can (DK-83, DK-87): a real button around the card's parts (spans, so it stays a button's
 * content), else the same card as a `div` (a runtime before 0.115 sends no server id; the conversation's card).
 */
export function OpenCard({
  className,
  state,
  label,
  onOpen,
  children,
}: {
  className: string;
  state?: string;
  label: string;
  onOpen?: () => void;
  children: ReactNode;
}) {
  if (!onOpen)
    return (
      <div className={className} data-state={state}>
        {children}
      </div>
    );
  return (
    <button
      type="button"
      className={`${className} ${styles.cardButton}`}
      data-state={state}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {children}
    </button>
  );
}

/** A server: its mark, name and note, then CPU, memory and disk on lines of their own (DK-80, mockup frame 1). */
export function ServerCard({
  server,
  className,
  onOpen,
}: {
  server: DeskServer;
  className?: string;
  /** Opens the server's own screen (DK-83); absent: the card doesn't open. */
  onOpen?: () => void;
}) {
  const t = useT();
  return (
    <OpenCard
      className={[styles.card, styles.server, className].filter(Boolean).join(' ')}
      state={server.state}
      label={cardLabel(server.name, server.note, server, t)}
      onOpen={onOpen}
    >
      <span className={styles.serverHead}>
        <span className={styles.markTile}>
          <Mark mark={server.mark} fallback="server" />
        </span>
        <b className={styles.serverName}>{server.name}</b>
        {server.note && <span className={styles.serverNote}>{server.note}</span>}
      </span>
      <CardLines cpu={server.cpu} memory={server.memory} disk={server.disk} />
    </OpenCard>
  );
}

export function Tile({ tile }: { tile: DeskTile }) {
  return (
    <div className={`${styles.card} ${styles.tile}`} data-tone={tile.tone ?? undefined}>
      <span className={styles.tileIcon}>
        {tile.mark && isBrandMark(tile.mark) ? (
          <BrandMark mark={tile.mark} size={20} />
        ) : (
          <Icon name={TILE_ICON[tile.icon]} />
        )}
      </span>
      <div className={styles.tileText}>
        <b className={styles.tileValue}>{tile.value}</b>
        {tile.label && (
          <span className={styles.tileLabelLine}>
            <span className={styles.tileLabel}>{tile.label}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** On battery: the night's banner (mockup 4), or the glance's one-line version. */
export function PowerBanner({
  power,
  assistant,
  timeZone,
  compact,
  ref,
}: {
  power: DeskPower;
  assistant: string;
  timeZone: string;
  compact?: boolean;
  /** The glance measures the one-line version to plan the room above it (CG-135). */
  ref?: Ref<HTMLDivElement>;
}) {
  const t = useT();

  const b = powerBanner(power, assistant, timeZone, t);
  if (!b) return null;
  return (
    <div ref={ref} className={compact ? styles.battery : styles.power} role="status">
      <Icon name="battery" />
      <div>
        <b>{b.lead}</b> {b.rest}
      </div>
    </div>
  );
}

/**
 * A screen a card opened (DK-83, DK-86, DK-87; mockup frame 2): Back (44 px), the mark in its 40 px tile, the name in
 * the mono face with its line under it, then whatever the screen puts on the right (its state, the lock chip).
 */
export function PageHead({
  mark,
  title,
  sub,
  onBack,
  children,
}: {
  mark?: ReactNode;
  title: string;
  /** The line under the name; absent: the name alone. */
  sub?: string;
  onBack: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const DESK_WORDS = deskWordsCopy(t);

  return (
    <header className={styles.pageHead}>
      <button
        type="button"
        className={styles.back}
        aria-label={DESK_WORDS.server.back}
        onClick={(e) => {
          e.stopPropagation();
          onBack();
        }}
      >
        <Icon name="back" />
      </button>
      {mark && <span className={styles.pageMark}>{mark}</span>}
      <div className={styles.pageWho}>
        <b className={styles.pageName}>{title}</b>
        {sub !== undefined && (
          <span className={styles.pageSubLine}>
            <span className={styles.pageSub}>{sub}</span>
          </span>
        )}
      </div>
      <div className={styles.spacer} />
      {children}
    </header>
  );
}
