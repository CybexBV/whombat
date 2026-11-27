/**
 * The box's calm glance as Settings → Screen previews it (`DeskPreview`, from `desk.preview`): the screen's 1280×800
 * frame drawn at that size and scaled to the card, in the screen's dark look (the dark theme's tokens). The top bar
 * with the Whombat's name and quiet chips, the clock with the sentence, the hero and what else waits or what's going
 * on, and the servers in a strip with their last hour's line. A picture, not a control: one label says what it shows.
 * A look the assistant looked into (look-research-web.md AP-5907) shows its words by its face, and the screen's buttons
 * for it: the step first, Open, Ignore (`deskHeroButtons`).
 */
import { WhombatAvatar } from '@whombat/avatars/react';
import { isBrandMark } from '@whombat/brand';
import { BrandMark, WhombatLogo } from '@whombat/brand/react';
import { deskHeroButtons } from '@whombat/client';
import {
  DESK_WORDS,
  type DeskCalm,
  type DeskMoment,
  type DeskPreview,
  type DeskStripServer,
  fillDeskWords,
  formatPowerLeft,
} from '@whombat/client/desk';
import type { AgentFace } from '@whombat/core';
import { formatClock, formatWeekday, zonedParts } from '@whombat/core/text';
import { BatteryMedium, Globe, Lock, type LucideIcon, RefreshCw, Server, Wifi } from 'lucide-react';
import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { StatusDot } from '../../components/StatusDot';
import { longMonthName } from '../../i18n/dates';
import { currentLocale } from '../../i18n/provider';
import p from './DeskPreview.module.css';

const C = DESK_WORDS.calm;
/** The screen's design size: every length in the stylesheet is in its pixels. */
const WIDTH = 1280;

export interface DeskPreviewScreenProps {
  preview: DeskPreview;
  assistant: string;
  timeZone: string;
  /** The assistant's face, by what it says about a look it looked into. */
  face?: AgentFace;
  /** The box has a battery: the top bar keeps a chip for it. */
  hasBattery: boolean;
  now: number;
}

export function DeskPreviewScreen({
  preview,
  assistant,
  face,
  timeZone,
  hasBattery,
  now,
}: DeskPreviewScreenProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.36);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => {
      if (el.clientWidth) setScale(el.clientWidth / WIDTH);
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const calm = preview.calm;
  const words = { assistant };
  const label = [calm.headline.text, calm.headline.more].filter(Boolean).join('. ');
  return (
    <div className={p.bezel} data-theme="dark">
      <div
        ref={frame}
        className={p.frame}
        role="img"
        aria-label={`${DESK_WORDS.settings.preview}: ${label}`}
        data-desk-preview=""
        data-tone={calm.headline.tone}
      >
        <div className={p.screen} style={{ '--s': scale } as CSSProperties} aria-hidden="true">
          {calm.hero ? (
            <span className={p.glow} data-tone={calm.hero.research === 'fixed' ? 'ok' : calm.hero.tone} />
          ) : null}
          <TopBar name={preview.name} calm={calm} hasBattery={hasBattery} />
          <Clock calm={calm} now={now} timeZone={timeZone} />
          <Headline calm={calm} />
          {calm.hero ? (
            <Hero calm={calm} words={words} face={face} now={now} timeZone={timeZone} />
          ) : calm.moments.length > 0 || calm.doneCount ? (
            <Moments calm={calm} words={words} />
          ) : null}
          <Strip calm={calm} />
        </div>
      </div>
    </div>
  );
}

/**
 * The top bar: the Whombat's name on the left; on the right the chips the person keeps on *Always*, in their calm look
 * (the screen knows the Wi-Fi's name and the charge itself, the preview only which chips show), *Updating* while
 * Whombat updates itself, and the lock.
 */
function TopBar({ name, calm, hasBattery }: { name: string; calm: DeskCalm; hasBattery: boolean }) {
  const always = (item: keyof DeskCalm['bar']) => calm.bar[item] === 'always';
  return (
    <div className={p.bar}>
      <span className={p.who}>
        <WhombatLogo height={26} />
        {name}
      </span>
      {always('network') ? <Chip icon={Wifi} /> : null}
      {always('internet') ? <Chip icon={Globe} text={C.bar.online} /> : null}
      {calm.update ? (
        <Chip icon={RefreshCw} text={C.bar.updates[calm.update]} tone="work" />
      ) : always('updates') ? (
        <Chip icon={RefreshCw} />
      ) : null}
      {hasBattery && always('battery') ? <Chip icon={BatteryMedium} /> : null}
      <Chip icon={Lock} text={C.bar.locked} />
    </div>
  );
}

function Chip({ icon, text, tone }: { icon: LucideIcon; text?: string; tone?: 'work' }) {
  return (
    <span className={p.chip} data-tone={tone}>
      <Icon icon={icon} size={24} />
      {text}
    </span>
  );
}

/** “Tuesday 20 October”. */
function longDate(now: number, timeZone: string): string {
  const d = zonedParts(now, timeZone);
  return `${formatWeekday(now, timeZone, currentLocale())} ${d.day} ${longMonthName(d.month - 1, currentLocale())}`;
}

function Clock({ calm, now, timeZone }: { calm: DeskCalm; now: number; timeZone: string }) {
  return (
    <div className={p.clockBox} data-clock={calm.clock}>
      <span className={p.clock}>{formatClock(now, timeZone)}</span>
      <span className={p.date}>{longDate(now, timeZone)}</span>
    </div>
  );
}

const HEADLINE_DOT = { ok: 'ok', busy: 'brand', warn: 'warn', bad: 'bad' } as const;

/** The sentence by the clock, in its colour's dot, and the muted line under it. */
function Headline({ calm }: { calm: DeskCalm }) {
  const small = calm.clock === 'small';
  return (
    <div className={p.headline} data-clock={calm.clock}>
      <span className={p.headlineText}>
        <StatusDot
          tone={HEADLINE_DOT[calm.headline.tone]}
          size={small ? 18 : 22}
          halo={calm.headline.tone === 'busy'}
          label={null}
        />
        {calm.headline.text}
      </span>
      {calm.headline.more && !small ? (
        <span className={p.headlineMore}>
          {/* A sentence a line, as the screen breaks it. */}
          {calm.headline.more.split(/(?<=[.!?])\s+/).map((sentence) => (
            <span key={sentence}>{sentence}</span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The one thing that takes the middle, with its buttons, and what else waits on a line each. A look the assistant
 * looked into says so by its face, with a spinner while it works on it, green once fixed.
 */
function Hero({
  calm,
  words,
  face,
  now,
  timeZone,
}: {
  calm: DeskCalm;
  words: { assistant: string };
  face: AgentFace | undefined;
  now: number;
  timeZone: string;
}) {
  const hero = calm.hero as NonNullable<DeskCalm['hero']>;
  const since = hero.since
    ? fillDeskWords(C.since, {
        clock: formatClock(hero.since, timeZone),
        ago: formatPowerLeft(Math.max(1, (now - Date.parse(hero.since)) / 60_000), currentLocale()),
      })
    : null;
  // The hero names a server by its hosts id; the button by the name the strip shows.
  const server = hero.server ? (calm.strip.find((s) => s.id === hero.server)?.name ?? hero.server) : null;
  const buttons = deskHeroButtons(hero, { assistant: words.assistant, server });
  const research = hero.kind === 'look' && hero.research !== 'failed' ? hero.research : undefined;
  const busy = research === 'looking' || research === 'fixing';
  return (
    <>
      <div className={p.hero} data-tone={research === 'fixed' ? 'ok' : hero.tone} data-research={research}>
        {since ? <span className={p.heroSince}>{since}</span> : null}
        <span className={p.heroTitle}>{hero.title}</span>
        {hero.detail && research && face ? (
          <span className={p.heroSays}>
            <WhombatAvatar face={face} crop="head" size={40} decorative className={p.heroFace} />
            <span className={p.heroDetail}>
              {busy ? <span className={p.spin} /> : null}
              {hero.detail}
            </span>
          </span>
        ) : hero.detail ? (
          <span className={p.heroDetail}>{hero.detail}</span>
        ) : null}
        <span className={p.heroActions}>
          {buttons.map((b) => (
            <span key={b.label} className={cx(p.button, p[b.look])}>
              {b.label}
            </span>
          ))}
        </span>
      </div>
      {calm.also.length > 0 || calm.moreNeeds > 0 ? (
        <div className={p.also}>
          {calm.also.map((a) => (
            <span key={`${a.name}-${a.text}`} className={p.alsoRow} data-tone={a.tone}>
              <StatusDot tone={a.tone} size={12} label={null} />
              <span className={p.alsoName}>{a.name}</span>
              <span className={p.alsoText}>{a.text}</span>
              <span className={p.alsoLook}>{C.look} ›</span>
            </span>
          ))}
          {calm.moreNeeds > 0 ? (
            <span className={p.alsoMore}>{fillDeskWords(C.moreNeeds, { n: calm.moreNeeds })}</span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** What's going on: the label, *Done today* on its right, and up to three cards. */
function Moments({ calm, words }: { calm: DeskCalm; words: { assistant: string } }) {
  const done = calm.doneCount
    ? fillDeskWords(calm.doneCount === 1 ? C.doneOne : C.doneMany, { ...words, n: calm.doneCount })
    : null;
  // The assistant's work is the widest thing to say: it takes twice the room of the others. Without it, three equal
  // places, so one or two cards keep the size they'd have beside others.
  const work = calm.moments.some((m) => m.kind === 'work');
  const columns = work
    ? calm.moments.map((m) => (m.kind === 'work' ? '2fr' : '1fr')).join(' ')
    : 'repeat(3, minmax(0, 1fr))';
  return (
    <div className={p.moments}>
      <div className={p.momentsHead}>
        <span className={p.label}>{C.now.toUpperCase()}</span>
        {done ? <span className={p.done}>{done} ›</span> : null}
      </div>
      <div className={p.cards} style={{ gridTemplateColumns: columns }}>
        {calm.moments.map((m) => (
          <MomentCard key={m.key} moment={m} />
        ))}
      </div>
    </div>
  );
}

function MomentCard({ moment }: { moment: DeskMoment }) {
  return (
    <div className={p.card} data-kind={moment.kind} data-pinned={moment.pinned || undefined}>
      <span className={p.cardName}>
        <Mark mark={moment.mark} size={26} />
        {moment.pinned ? `${moment.name} · ${C.pinned}` : moment.name}
      </span>
      <span className={p.cardValue}>{moment.value}</span>
      {moment.progress !== undefined ? (
        <span className={p.progress}>
          <i style={{ width: `${moment.progress}%` }} />
        </span>
      ) : moment.detail ? (
        <span className={p.cardDetail}>{moment.detail}</span>
      ) : null}
    </div>
  );
}

/** A brand or OS mark, else a server's line icon. */
function Mark({ mark, size }: { mark: string | undefined; size: number }) {
  if (mark && isBrandMark(mark)) return <BrandMark mark={mark} size={size} />;
  return <Icon icon={Server} size={size} />;
}

/** The servers in a strip: at least five places, so a few servers don't stretch across the screen. */
function Strip({ calm }: { calm: DeskCalm }) {
  if (calm.strip.length === 0) return null;
  const places = Math.max(5, calm.strip.length + (calm.moreStrip > 0 ? 1 : 0));
  return (
    <div className={p.strip} style={{ gridTemplateColumns: `repeat(${places}, minmax(0, 1fr))` }}>
      {calm.strip.map((s) => (
        <StripChip key={s.id ?? s.name} server={s} />
      ))}
      {calm.moreStrip > 0 ? (
        <span className={cx(p.stripChip, p.stripMore)}>
          {fillDeskWords(C.strip.more, { n: calm.moreStrip })}
        </span>
      ) : null}
    </div>
  );
}

function StripChip({ server }: { server: DeskStripServer }) {
  const say =
    server.work === 'done'
      ? C.strip.done
      : server.work === 'next'
        ? C.strip.next
        : (server.say ?? (server.state === 'off' ? C.strip.off : null));
  return (
    <span className={p.stripChip} data-state={server.state} data-work={server.work}>
      <span className={p.stripHead}>
        <Mark mark={server.mark} size={18} />
        <span className={p.stripName}>{server.name}</span>
      </span>
      {say ? (
        <>
          <span className={p.stripSay}>{say}</span>
          {server.work === 'now' && server.progress !== undefined ? (
            <span className={cx(p.progress, p.stripProgress)}>
              <i style={{ width: `${server.progress}%` }} />
            </span>
          ) : null}
        </>
      ) : server.spark && server.spark.length > 1 ? (
        <Spark points={server.spark} />
      ) : null}
    </span>
  );
}

/** The last hour's processor as a line, oldest on the left; the line's height is the hour's own range. */
function Spark({ points }: { points: readonly number[] }) {
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = Math.max(10, hi - lo);
  const step = 112 / (points.length - 1);
  const line = points.map((v, i) => `${(i * step).toFixed(1)},${(27 - ((v - lo) / span) * 24).toFixed(1)}`);
  return (
    <svg className={p.spark} viewBox="0 0 112 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={line.join(' ')} />
    </svg>
  );
}
