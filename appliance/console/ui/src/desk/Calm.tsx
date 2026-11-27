/**
 * The calm glance (3.2, CG-350…CG-369; Whombat desk-display.md DK-101…DK-124, mockups `docs/design/desk-calm/`): one
 * frame whose content changes. The top bar is about the box (the Whombat's name, the network, the internet, remote
 * help, updating, the battery, the lock); under it the clock and one sentence that says how things are; the middle
 * holds the one thing that needs you (the hero, with what else waits on a line each) or up to three things going on;
 * the servers sit in a strip along the bottom. The runtime decides all of it (core's planner); this draws it.
 */

import { WhombatLogo } from '@whombat/brand/react';
import { type MouseEvent, type ReactNode, useEffect, useState } from 'react';
import { BluetoothChip } from '../bluetooth/BluetoothLayer';
import { useT } from '../i18n/react';
import {
  awayText,
  barShows,
  type CalmAlso,
  type CalmDigest,
  type CalmHero,
  type CalmMoment,
  type CalmServer,
  type DeskCalm,
  sparkPoints,
} from '../lib/calm';
import type { DeskGlance, DeskLook, DeskPaired, DeskPower } from '../lib/desk';
import { clockText, dateText, deskWordsCopy, duration, elapsedText, fill, powerChip } from '../lib/deskCopy';
import { researchFace } from '../lib/deskFace';
import { type LookStage, lookStep, researchSays } from '../lib/needsYou';
import { chipView } from '../lib/wifiCopy';
import { Bars, Icon as WifiIcon } from '../wifi/icons';
import { useNetwork } from '../wifi/WifiLayer';
import styles from './calm.module.css';
import deskStyles from './desk.module.css';
import { FoundStrip } from './Found';
import { Icon } from './icons';
import { ClockText, Face, LockChip, Mark, PowerBanner } from './parts';
import { useRemoteHelp } from './RemoteHelp';

const NONE: ReadonlySet<string> = new Set();

export interface CalmProps {
  paired: DeskPaired;
  calm: DeskCalm;
  glance: DeskGlance;
  /** The Whombat's name (DK-119), else the org's. */
  name: string;
  power: DeskPower | null;
  /** Server clock (ms). */
  now: number;
  unlocked: boolean;
  locksIn: number | null;
  camera: boolean;
  present: boolean;
  looking: boolean;
  onLock: () => void;
  onTalk: () => void;
  /** An ask's card (the PIN pad first while locked). */
  onAsk: (number: number) => void;
  /** A look's card (DK-95). */
  onLook: (key: string) => void;
  /** *Ask {assistant} to look into it* (DK-96). */
  onFix?: (look: DeskLook) => void;
  /** The step the assistant offers on a look it looked into (3.5, CG-373): the PIN first while locked. */
  onStep?: (look: DeskLook) => void;
  /** *Ignore* on a look, where *Not now* was (CG-373); absent while it can't be quieted. */
  onIgnore?: (look: DeskLook) => void;
  /** The step's button was pressed and Whombat hasn't taken it yet: it waits. */
  stepBusy?: boolean;
  /** A server's screen (DK-83), by its id; absent while Whombat is away. */
  onServer?: (id: string) => void;
  /** “+N”: every server (DK-86). */
  onServers?: () => void;
  /** Welcome back was seen (DK-121): it goes until the next one. */
  onWelcomeSeen?: (id: string) => void;
  /** A Welcome back that was seen already (fixtures and the page's memory). */
  welcomeSeen?: string | null;
  /** The console's `appUrl`, where Found on your network says to connect (DF-01). */
  appUrl?: string;
  /** Found on your network's Not now (DF-04); absent while Whombat is away. */
  onFoundDismiss?: () => void;
}

/* The top bar (DK-110, DK-111) ------------------------------------------------------------------------------------ */

function chipButton(
  key: string,
  label: string,
  children: ReactNode,
  onClick: () => void,
  tone?: 'warn' | 'bad' | 'loud' | 'busy',
) {
  return (
    <button
      key={key}
      type="button"
      className={`${styles.chip} ${deskStyles.chipButton}`}
      data-tone={tone}
      aria-label={label}
      onClick={(e) => {
        // Not the locked glance's “touch to unlock”.
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >
      {children}
    </button>
  );
}

function BatteryIcon({ percent }: { percent: number }) {
  return (
    <svg className={styles.battery} viewBox="0 0 26 24" aria-hidden="true">
      <rect x="1.5" y="6.5" width="20" height="11" rx="2.5" />
      <path d="M23.5 10v4" />
      <rect
        className={styles.batteryFill}
        x="3.6"
        y="8.6"
        width={(15.8 * Math.max(4, percent)) / 100}
        height="6.8"
        rx="1"
      />
    </svg>
  );
}

/** What the top bar's chips need: the calm glance's bar choices and update, and the desk's. */
export type ChipsProps = Pick<
  CalmProps,
  'paired' | 'power' | 'unlocked' | 'locksIn' | 'camera' | 'present' | 'looking' | 'onLock' | 'onTalk'
> & { calm: Pick<DeskCalm, 'bar' | 'update'> };

/**
 * The box's chips on the right of the top bar (DK-110, DK-111): Talk, the network, the internet, Bluetooth, remote
 * help, updating, the battery and the lock. The calm glance's top bar and the screen of widgets' show the same.
 */
export function BarChips(props: ChipsProps & { onSheet: () => void }) {
  const t = useT();
  const W = deskWordsCopy(t).calm;

  const DESK_WORDS = deskWordsCopy(t);

  const { calm, paired, power, unlocked, onSheet } = props;
  const { summary, open: openWifi } = useNetwork();
  const { help, open: openHelp } = useRemoteHelp();
  const chips: ReactNode[] = [];
  if (unlocked && paired.voice)
    chips.push(
      chipButton(
        'talk',
        fill(DESK_WORDS.settings.talkTo, { assistant: paired.assistant.name }),
        <>
          <Icon name="mic" className={styles.chipIcon} />
          {fill(DESK_WORDS.settings.talkTo, { assistant: paired.assistant.name })}
        </>,
        props.onTalk,
      ),
    );
  if (summary) {
    const v = chipView(summary, t);
    const noNetwork = summary.via === 'none';
    if (barShows(calm.bar.network, noNetwork))
      chips.push(
        chipButton(
          'network',
          v.text,
          <>
            {v.icon === 'wifi' ? (
              <Bars signal={4} className={styles.chipIcon} />
            ) : (
              <WifiIcon name={v.icon} className={styles.chipIcon} />
            )}
            {summary.via === 'cable' ? W.bar.cable : noNetwork ? W.bar.noNetwork : v.text}
          </>,
          openWifi,
          noNetwork ? 'warn' : undefined,
        ),
      );
    if (!noNetwork && barShows(calm.bar.internet, !summary.online))
      chips.push(
        chipButton(
          'internet',
          summary.online ? W.bar.online : W.bar.offline,
          <>
            <Icon name="globe" className={styles.chipIcon} />
            {summary.online ? W.bar.online : W.bar.offline}
          </>,
          onSheet,
          summary.online ? undefined : 'warn',
        ),
      );
  }
  chips.push(<BluetoothChip key="bt" />);
  // Remote help always shows while it's on (DK-111): quiet while nobody is in, lit while support is connected.
  if (help)
    chips.push(
      chipButton(
        'help',
        help.connected ? W.bar.remoteLive : W.bar.remoteOn,
        <>
          <Icon name="headset" className={styles.chipIcon} />
          {help.connected ? W.bar.remoteLive : W.bar.remoteOn}
        </>,
        openHelp,
        help.connected ? 'loud' : undefined,
      ),
    );
  if (calm.update && barShows(calm.bar.updates, true))
    chips.push(
      chipButton(
        'update',
        W.bar.updates[calm.update],
        <>
          <Icon name="update" className={styles.chipIcon} />
          {W.bar.updates[calm.update]}
        </>,
        onSheet,
        'busy',
      ),
    );
  if (power) {
    const low = power.source === 'battery' && power.percent <= 15;
    const out = power.source === 'battery';
    if (barShows(calm.bar.battery, out))
      chips.push(
        chipButton(
          'battery',
          powerChip(power, t),
          <>
            <BatteryIcon percent={power.percent} />
            {low
              ? fill(W.bar.low, { n: power.percent })
              : out
                ? power.minutesLeft === null
                  ? fill(W.bar.onBatteryNoTime, { n: power.percent })
                  : fill(W.bar.onBattery, { time: duration(power.minutesLeft, t) })
                : fill(W.bar.charge, { n: power.percent })}
            {!out && power.charging && <Icon name="plug" className={styles.chipIcon} />}
          </>,
          onSheet,
          low ? 'bad' : out ? 'warn' : undefined,
        ),
      );
  }
  return (
    <>
      {chips}
      <LockChip
        unlocked={unlocked}
        name={paired.person.name}
        minutes={props.locksIn}
        camera={props.camera}
        present={props.present}
        looking={props.looking}
        onLock={props.onLock}
      />
    </>
  );
}

function TopBar(props: CalmProps & { onSheet: () => void }) {
  return (
    <header className={styles.top}>
      {/* The brand's full face at 24 px, as the Talk top bar draws it: the stage shows it at 48 px on the Z13. */}
      <WhombatLogo variant="symbol" height={48} className={styles.logo} />
      <b className={styles.name}>{props.name}</b>
      <div className={styles.spacer} />
      <BarChips {...props} />
    </header>
  );
}

/** A sheet over the calm glance: its own keys and touches stay in it; the backdrop and Close close it. */
export function CalmSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const W = deskWordsCopy(useT()).calm;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: catches bubbling keys and clicks, nothing of its own
    <div
      className={styles.layer}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={styles.scrim}
        aria-label={W.sheet.close}
        tabIndex={-1}
        onClick={onClose}
      />
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className={styles.sheetTitle}>{title}</h2>
        {children}
        <button type="button" className={`${deskStyles.btn} ${styles.sheetClose}`} onClick={onClose}>
          {W.sheet.close}
        </button>
      </section>
    </div>
  );
}

/** The status sheet (DK-110): the bar's details in one place; the network and remote help open their own sheets. */
export function StatusSheet({
  calm,
  power,
  onClose,
}: {
  calm: Pick<DeskCalm, 'update'>;
  power: DeskPower | null;
  onClose: () => void;
}) {
  const t = useT();
  const W = deskWordsCopy(t).calm;

  const { summary, open: openWifi } = useNetwork();
  const { help, open: openHelp } = useRemoteHelp();
  const rows: [string, string, (() => void) | null][] = [];
  if (summary) {
    const v = chipView(summary, t);
    rows.push([W.sheet.network, summary.via === 'cable' ? W.bar.cable : v.text, openWifi]);
    rows.push([W.sheet.internet, summary.online ? W.bar.online : W.bar.offline, null]);
  }
  if (power) rows.push([W.sheet.battery, powerChip(power, t), null]);
  if (help) rows.push([W.sheet.remoteHelp, help.connected ? W.bar.remoteLive : W.bar.remoteOn, openHelp]);
  if (calm.update) rows.push([W.sheet.updates, W.bar.updates[calm.update], null]);
  return (
    <CalmSheet title={W.sheet.title} onClose={onClose}>
      {rows.map(([k, v, open]) =>
        open ? (
          <button
            key={k}
            type="button"
            className={styles.sheetRow}
            onClick={() => {
              onClose();
              open();
            }}
          >
            <span>{k}</span>
            <span className={styles.sheetValue}>
              {v} <Icon name="chevron" className={styles.chevron} />
            </span>
          </button>
        ) : (
          <div key={k} className={styles.sheetRow}>
            <span>{k}</span>
            <span className={styles.sheetValue}>{v}</span>
          </div>
        ),
      )}
    </CalmSheet>
  );
}

/* The middle (DK-113…DK-115) ------------------------------------------------------------------------------------- */

/** Where the assistant is with the hero's look (3.5, CG-373): none for an ask, without research or once it failed. */
function heroStage(hero: CalmHero): LookStage | null {
  return hero.kind === 'look' && hero.research && hero.research !== 'failed' ? hero.research : null;
}

function Hero(props: CalmProps & { hero: CalmHero }) {
  const t = useT();
  const W = deskWordsCopy(t).calm;

  const DESK_WORDS = deskWordsCopy(t);

  const { hero, glance, now, paired, onFix, onStep, onIgnore, onServer } = props;
  const look = hero.look ? glance.needsYou.looks?.find((l) => l.key === hero.look) : undefined;
  const open = () =>
    hero.ask !== null ? props.onAsk(hero.ask) : hero.look ? props.onLook(hero.look) : undefined;
  // A look the assistant looked into (LR-09, CG-373): its words beside its face, green once fixed, no age then.
  const stage = heroStage(hero);
  const title = stage && stage !== 'looking' && look?.research?.title ? look.research.title : hero.title;
  const says = stage ? researchSays(look, stage, hero.detail, t) : null;
  const since =
    hero.since && stage !== 'fixed'
      ? fill(W.since, {
          clock: clockText(Date.parse(hero.since), paired.timeZone),
          ago: elapsedText(hero.since, now, t),
        })
      : null;
  const stop = (f: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    f();
  };
  return (
    <section className={styles.hero} data-tone={stage === 'fixed' ? 'ok' : hero.tone}>
      <button type="button" className={styles.heroBody} onClick={stop(open)}>
        {since && <span className={styles.since}>{since}</span>}
        <span className={styles.heroTitle}>{title}</span>
        {says ? (
          <span className={styles.heroSays}>
            <Face face={paired.assistant.face} size={36} state={researchFace(stage)} />
            <span className={styles.heroSaysText}>
              {(stage === 'looking' || stage === 'fixing') && (
                <span className={styles.spinner} aria-hidden="true" />
              )}
              {says}
            </span>
          </span>
        ) : (
          hero.detail && <span className={styles.heroDetail}>{hero.detail}</span>
        )}
      </button>
      <div className={styles.heroButtons}>
        {stage ? (
          // The step first (it is the go-ahead, LR-08), Ignore where Not now was (LR-10), Open for a server; nothing to
          // press while the assistant takes the step but Open, nothing once it is fixed.
          <>
            {stage === 'found' && hero.fix && look && lookStep(look) && onStep && (
              <button
                type="button"
                className={`${deskStyles.btn} ${styles.primary}`}
                aria-disabled={props.stepBusy || undefined}
                data-busy={props.stepBusy || undefined}
                onClick={stop(() => onStep(look))}
              >
                {hero.fix}
              </button>
            )}
            {(stage === 'looking' || stage === 'found') && look?.notice && onIgnore && (
              <button type="button" className={deskStyles.btn} onClick={stop(() => onIgnore(look))}>
                {W.ignore}
              </button>
            )}
            {stage !== 'fixed' && hero.server && onServer && look && (
              <button
                type="button"
                className={deskStyles.btn}
                onClick={stop(() => onServer(hero.server as string))}
              >
                {fill(W.open, { name: look.name })}
              </button>
            )}
          </>
        ) : hero.kind === 'ask' ? (
          <button
            type="button"
            className={`${deskStyles.btn} ${styles.primary}`}
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
          >
            {W.answer}
          </button>
        ) : (
          <>
            {look && onFix && look.nature !== 'you' && (
              <button
                type="button"
                className={`${deskStyles.btn} ${styles.primary}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onFix(look);
                }}
              >
                {fill(DESK_WORDS.looks.fix, { assistant: paired.assistant.name })}
              </button>
            )}
            {hero.server && onServer && look && (
              <button
                type="button"
                className={deskStyles.btn}
                onClick={(e) => {
                  e.stopPropagation();
                  onServer(hero.server as string);
                }}
              >
                {fill(W.open, { name: look.name })}
              </button>
            )}
            {look && onIgnore && look.notice && (
              <button
                type="button"
                className={`${deskStyles.btn} ${styles.quiet}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onIgnore(look);
                }}
              >
                {W.ignore}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function AlsoLine({ also, onOpen }: { also: CalmAlso; onOpen: () => void }) {
  const W = deskWordsCopy(useT()).calm;

  return (
    <button
      type="button"
      className={styles.also}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <span className={styles.alsoDot} data-tone={also.tone} />
      <b className={styles.alsoName}>{also.name}</b>
      <span className={styles.alsoText}>{also.text}</span>
      <span className={styles.alsoLook}>{W.look} ›</span>
    </button>
  );
}

function Moment({ m, paired }: { m: CalmMoment; paired: DeskPaired }) {
  const W = deskWordsCopy(useT()).calm;

  return (
    <div className={styles.moment} data-pinned={m.pinned || undefined} data-kind={m.kind}>
      <span className={styles.momentName}>
        {m.kind === 'work' ? (
          <Face face={paired.assistant.face} size={22} />
        ) : (
          <Mark mark={m.mark} fallback="generic" size={20} />
        )}
        {m.kind === 'work' ? paired.assistant.name : m.name}
        {m.pinned && <span className={styles.pinned}>· {W.pinned}</span>}
      </span>
      <span className={styles.momentValue}>{m.value}</span>
      {m.progress !== null ? (
        <span className={styles.bar} role="img" aria-label={`${m.progress} %`}>
          <i className={styles.barFill} style={{ width: `${m.progress}%` }} />
        </span>
      ) : (
        m.detail && <span className={styles.momentDetail}>{m.detail}</span>
      )}
    </div>
  );
}

/* The strip (DK-116, DK-117) ------------------------------------------------------------------------------------- */

function StripChip({ s, onServer }: { s: CalmServer; onServer?: (id: string) => void }) {
  const t = useT();
  const W = deskWordsCopy(t).calm;

  const DESK_WORDS = deskWordsCopy(t);

  const say = s.work === 'done' ? W.strip.done : s.work === 'next' ? W.strip.next : s.say;
  const inner = (
    <>
      <span className={styles.chipHead}>
        <Mark mark={s.mark} fallback="server" size={16} />
        <span className={styles.chipName}>{s.name}</span>
      </span>
      {say ? (
        <span className={styles.chipSay} data-work={s.work ?? undefined}>
          {say}
        </span>
      ) : s.spark.length > 1 ? (
        <svg className={styles.spark} viewBox="0 0 112 26" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={sparkPoints(s.spark, 112, 24)} />
        </svg>
      ) : (
        <span className={styles.chipSay} />
      )}
      {s.work === 'now' && (
        <span className={styles.chipBar}>
          <i className={styles.chipBarFill} style={{ width: `${s.progress ?? 50}%` }} />
        </span>
      )}
    </>
  );
  const common = {
    className: styles.server,
    'data-state': s.state,
    'data-work': s.work ?? undefined,
  };
  return s.id && onServer ? (
    <button
      type="button"
      {...common}
      aria-label={fill(DESK_WORDS.card.open, { name: s.name })}
      onClick={(e) => {
        e.stopPropagation();
        onServer(s.id as string);
      }}
    >
      {inner}
    </button>
  ) : (
    <div {...common}>{inner}</div>
  );
}

/* Welcome back (DK-120…DK-122) ------------------------------------------------------------------------------------ */

function Welcome({ digest, props }: { digest: CalmDigest; props: CalmProps }) {
  const t = useT();
  const W = deskWordsCopy(t).calm;

  const tz = props.paired.timeZone;
  return (
    <section className={styles.welcome}>
      <h1 className={styles.welcomeTitle}>{W.welcome.title}</h1>
      <p className={styles.welcomeAway}>{fill(W.welcome.away, { time: awayText(digest.awayS, t) })}</p>
      <ul className={styles.welcomeList}>
        {digest.items.map((it) => (
          <li key={`${it.icon}-${it.text}`} className={styles.welcomeRow} data-icon={it.icon}>
            <span className={styles.welcomeIcon} aria-hidden="true">
              {it.icon === 'ask'
                ? '?'
                : it.icon === 'done' || it.icon === 'up'
                  ? '✓'
                  : it.icon === 'down'
                    ? '!'
                    : '↗'}
            </span>
            <span className={styles.welcomeText}>{it.text}</span>
            {it.ask !== null ? (
              <button
                type="button"
                className={`${deskStyles.btn} ${styles.primary} ${styles.small}`}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onAsk(it.ask as number);
                }}
              >
                {W.answer}
              </button>
            ) : (
              it.at && <span className={styles.welcomeAt}>{clockText(Date.parse(it.at), tz)}</span>
            )}
          </li>
        ))}
      </ul>
      <p className={styles.welcomeBack}>{W.welcome.back}</p>
    </section>
  );
}

/* The glance ----------------------------------------------------------------------------------------------------- */

export function CalmGlance(props: CalmProps) {
  const t = useT();
  const W = deskWordsCopy(t).calm;

  const DESK_WORDS = deskWordsCopy(t);

  const { calm, paired, glance, now, power } = props;
  const tz = paired.timeZone;
  const [sheet, setSheet] = useState<'status' | 'done' | null>(null);
  const digest = calm.digest && calm.digest.id !== props.welcomeSeen ? calm.digest : null;
  // Welcome back goes after a minute (DK-121); a touch ends it sooner (the page's touch handler).
  useEffect(() => {
    if (!digest || !props.onWelcomeSeen) return;
    const seen = props.onWelcomeSeen;
    const timer = setTimeout(() => seen(digest.id), 60_000);
    return () => clearTimeout(timer);
  }, [digest, props.onWelcomeSeen]);
  const hero = calm.hero;
  const small = calm.clock === 'small' || digest !== null;
  const sample = calm.sample && Date.parse(calm.sample.until) > now ? calm.sample : null;
  const openAlso = (a: CalmAlso) =>
    a.ask !== null ? props.onAsk(a.ask) : a.look ? props.onLook(a.look) : undefined;
  // With more to count, the last place is “+N” (DK-116): seven servers and the count.
  const strip = calm.moreStrip > 0 ? calm.strip.slice(0, 7) : calm.strip;
  const more = calm.moreStrip + (calm.strip.length - strip.length);
  const doneWords =
    calm.doneCount === null
      ? null
      : fill(calm.doneCount === 1 ? W.doneOne : W.doneMany, {
          assistant: paired.assistant.name,
          n: calm.doneCount,
        });
  return (
    <div className={styles.calm} data-tone={hero?.tone ?? calm.headline.tone} data-small={small || undefined}>
      {hero && <div className={styles.edge} data-tone={heroStage(hero) === 'fixed' ? 'ok' : hero.tone} />}
      {sample && (
        <div className={styles.sample}>
          {W.sample} · {Math.max(0, Math.ceil((Date.parse(sample.until) - now) / 1000))}
          {t('desk.calm.s')}
        </div>
      )}
      <TopBar {...props} onSheet={() => setSheet('status')} />
      <div className={styles.head}>
        <div className={styles.time}>
          <div className={styles.clock}>
            <ClockText text={clockText(now, tz)} />
          </div>
          <div className={styles.date}>{dateText(now, tz, t.locale)}</div>
        </div>
        {!digest && (
          <div className={styles.headline} data-tone={calm.headline.tone}>
            <p className={styles.headlineText}>
              <span className={styles.headlineDot} data-tone={calm.headline.tone} />
              {calm.headline.text}
            </p>
            {calm.headline.more && !hero && <p className={styles.headlineMore}>{calm.headline.more}</p>}
          </div>
        )}
      </div>
      <div className={styles.middle}>
        {digest ? (
          <Welcome digest={digest} props={props} />
        ) : hero ? (
          <>
            <Hero {...props} hero={hero} />
            {calm.also.map((a) => (
              <AlsoLine key={`${a.name}-${a.text}`} also={a} onOpen={() => openAlso(a)} />
            ))}
            {calm.moreNeeds > 0 && (
              <p className={styles.moreNeeds}>{fill(W.moreNeeds, { n: calm.moreNeeds })}</p>
            )}
          </>
        ) : (
          (calm.moments.length > 0 || doneWords) && (
            <>
              <div className={styles.nowHead}>
                {calm.moments.length > 0 && <span className={deskStyles.label}>{W.now}</span>}
                <span className={styles.spacer} />
                {doneWords && glance.done.length > 0 ? (
                  <button
                    type="button"
                    className={styles.done}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSheet('done');
                    }}
                  >
                    {doneWords} ›
                  </button>
                ) : (
                  doneWords && <span className={styles.done}>{doneWords}</span>
                )}
              </div>
              <div className={styles.moments} data-n={calm.moments.length}>
                {calm.moments.map((m) => (
                  <Moment key={m.key} m={m} paired={paired} />
                ))}
              </div>
            </>
          )
        )}
      </div>
      {power?.source === 'battery' && !hero && (
        <PowerBanner power={power} assistant={paired.assistant.name} timeZone={tz} compact />
      )}
      {/* Found on your network beside the servers (DF-06): its strip above theirs. */}
      {glance.found && !hero && !digest && (
        <FoundStrip
          found={glance.found}
          appUrl={props.appUrl ?? ''}
          now={now}
          latest={NONE}
          onDismiss={props.onFoundDismiss}
          alone={strip.length === 0}
        />
      )}
      {strip.length > 0 && (
        <div
          className={styles.strip}
          style={{
            gridTemplateColumns: `repeat(${strip.length + (more > 0 ? 1 : 0)}, minmax(0, 1fr))`,
          }}
        >
          {strip.map((s) => (
            <StripChip key={s.id ?? s.name} s={s} onServer={props.onServer} />
          ))}
          {more > 0 &&
            (props.onServers ? (
              <button
                type="button"
                className={`${styles.server} ${styles.more}`}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onServers?.();
                }}
              >
                {fill(W.strip.more, { n: more })}
              </button>
            ) : (
              <div className={`${styles.server} ${styles.more}`}>{fill(W.strip.more, { n: more })}</div>
            ))}
        </div>
      )}
      {sheet === 'status' && <StatusSheet calm={calm} power={power} onClose={() => setSheet(null)} />}
      {sheet === 'done' && (
        <CalmSheet title={DESK_WORDS.doneToday} onClose={() => setSheet(null)}>
          {glance.done.map((d) => (
            <div key={`${d.at}-${d.text}`} className={styles.sheetRow}>
              <span>✓ {d.text}</span>
              <span className={styles.sheetValue}>{clockText(Date.parse(d.at), tz)}</span>
            </div>
          ))}
        </CalmSheet>
      )}
    </div>
  );
}
