/**
 * The Overview's summary card and Today (docs/decisions/overview-arranged.md OVA-07, OVA-10): Live, the greeting, the
 * broken thing with *Look into it* or how things are, then the four figures the person chose; and the day as a line
 * with its moments under it.
 */
import { Link } from '@tanstack/react-router';
import { ARRANGE_WORDS, type FigureFace, OVERVIEW_PAGE_WORDS, type TodayMoment } from '@whombat/client';
import { ChevronRight, Settings } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { INBOX_PATH } from '../../app/shell/location';
import { Icon } from '../../components/Icon';
import { AppLink } from '../things/parts';
import s from './Arranged.module.css';
import { Spark } from './Spark';

export interface PulseFigure {
  key: string;
  face: FigureFace;
  /** The thing's colour and logo, for a thing's figure. */
  color?: string;
  logo?: ReactNode;
}

export interface PulseProps {
  tone: 'ok' | 'warn' | 'bad';
  greeting: string;
  heading: ReactNode;
  body: string | null;
  actions: ReactNode;
  figures: readonly PulseFigure[];
  editing: boolean;
  onGear: (index: number) => void;
}

export function OverviewPulse({
  tone,
  greeting,
  heading,
  body,
  actions,
  figures,
  editing,
  onGear,
}: PulseProps) {
  return (
    <section
      className={`${s.card} ${s.pulse}`}
      data-tone={tone}
      aria-labelledby="overview-pulse"
      data-overview="pulse"
    >
      <div className={s.pulseTop}>
        <div className={s.say}>
          <div className={s.greet}>
            <span className={s.live}>
              <i aria-hidden="true" />
              {OVERVIEW_PAGE_WORDS.live}
            </span>
            <span>{greeting}</span>
          </div>
          <h2 id="overview-pulse">{heading}</h2>
          {body ? <p>{body}</p> : null}
        </div>
        {actions ? <div className={s.act}>{actions}</div> : null}
      </div>
      <div className={s.figs}>
        {figures.map((f, i) => (
          <FigureCell key={f.key} figure={f} editing={editing} onGear={() => onGear(i)} />
        ))}
      </div>
    </section>
  );
}

export function FigureCell({
  figure,
  editing,
  onGear,
}: {
  figure: PulseFigure;
  editing: boolean;
  onGear?: () => void;
}) {
  const { face } = figure;
  const total = face.parts?.reduce((n, p) => n + p.n, 0) ?? 0;
  return (
    <div className={s.fig} style={figure.color ? { ['--c' as string]: figure.color } : undefined}>
      {editing && onGear ? (
        <button type="button" className={s.gear} aria-label={ARRANGE_WORDS.changeFigure} onClick={onGear}>
          <Icon icon={Settings} size={17} />
        </button>
      ) : null}
      <span className={s.lab}>
        {figure.logo ? (
          <span className={s.mini} aria-hidden="true">
            {figure.logo}
          </span>
        ) : null}
        <span>{face.label}</span>
      </span>
      <span className={s.val} data-tone={face.tone === 'bad' || face.tone === 'warn' ? face.tone : undefined}>
        {face.value || '—'}
        {face.unit ? <small>{face.unit}</small> : null}
      </span>
      {face.line ? <span className={s.sub}>{face.line}</span> : null}
      {face.parts && total ? (
        <div className={s.stack} aria-hidden="true">
          {face.parts
            .filter((p) => p.n > 0)
            .map((p) => (
              <i key={p.tone} data-tone={p.tone} style={{ flex: p.n }} />
            ))}
        </div>
      ) : face.spark ? (
        <Spark points={face.spark} />
      ) : null}
    </div>
  );
}

const TONE: Record<TodayMoment['tone'], string> = {
  done: 'var(--ok)',
  bad: 'var(--bad)',
  plan: 'var(--mut)',
};

/** Today: the day's line with Now, and the moments as chips (on a narrow page the three nearest Now, then Show all). */
export function OverviewToday({
  moments,
  now,
  done,
  planned,
}: {
  moments: readonly TodayMoment[];
  now: number;
  done: number;
  planned: number;
}) {
  const [hot, setHot] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const pct = (m: number) => `${((m / 1440) * 100).toFixed(2)}%`;
  // The three nearest Now: the last two before it and the next one.
  const before = moments.filter((m) => m.minute <= now);
  const near = new Set(
    [...before.slice(-2), ...moments.filter((m) => m.minute > now).slice(0, 1)].map((m) => m.key),
  );
  if (near.size < 3) for (const m of moments.slice(-3)) near.add(m.key);
  return (
    <section className={`${s.card} ${s.today}`} aria-labelledby="overview-today" data-overview="today">
      <div className={s.sech}>
        <h2 id="overview-today">{OVERVIEW_PAGE_WORDS.today}</h2>
        <span className={s.meta}>{OVERVIEW_PAGE_WORDS.todayLine(done, planned)}</span>
        <span className={s.links}>
          <Link to={INBOX_PATH}>{OVERVIEW_PAGE_WORDS.allActivity}</Link>
        </span>
      </div>
      <div className={s.track} aria-hidden="true">
        <div className={s.rail} />
        <div className={s.past} style={{ width: pct(now) }} />
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} className={s.hr} style={{ left: `${(h / 24) * 100}%` }}>
            {String(h).padStart(2, '0')}:00
          </span>
        ))}
        <div className={s.nowm} style={{ left: pct(now) }}>
          <span>{OVERVIEW_PAGE_WORDS.now}</span>
        </div>
        {moments.map((m) => (
          <span
            key={m.key}
            className={s.ev}
            data-tone={m.tone}
            data-hot={hot === m.key}
            style={{ left: pct(m.minute), ['--t' as string]: TONE[m.tone] }}
          />
        ))}
      </div>
      <div className={s.chips} data-all={all}>
        {moments.map((m) => {
          const inner = (
            <>
              <i aria-hidden="true" />
              <b>{m.text}</b>
              <span>
                {m.time} · {m.from}
              </span>
            </>
          );
          const props = {
            className: s.chip,
            'data-tone': m.tone,
            'data-hot': hot === m.key,
            'data-near': near.has(m.key),
            style: { ['--t' as string]: TONE[m.tone] },
            onPointerEnter: () => setHot(m.key),
            onPointerLeave: () => setHot(null),
            onFocus: () => setHot(m.key),
            onBlur: () => setHot(null),
          };
          return m.href ? (
            <AppLink key={m.key} href={m.href} {...props}>
              {inner}
            </AppLink>
          ) : (
            <div key={m.key} {...props}>
              {inner}
            </div>
          );
        })}
        {moments.length > 3 ? (
          <button type="button" className={s.moreChips} onClick={() => setAll((a) => !a)} aria-expanded={all}>
            {all ? OVERVIEW_PAGE_WORDS.showFewer : OVERVIEW_PAGE_WORDS.showAll(moments.length)}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** The broken thing's heading and its actions, as the summary card shows them. */
export function BrokenActions({
  busyWords,
  others,
  disabled,
  onLook,
  look,
}: {
  busyWords: string | null;
  others: string | null;
  disabled: boolean;
  onLook: () => void;
  look: string;
}) {
  return (
    <>
      {busyWords ? (
        <span className={s.busy}>{busyWords}</span>
      ) : (
        <button
          type="button"
          className={s.btn}
          disabled={disabled}
          onClick={onLook}
          aria-describedby="overview-pulse"
        >
          {look}
        </button>
      )}
      {others ? (
        <Link to={INBOX_PATH} className={s.others}>
          {others}
          <Icon icon={ChevronRight} size={14} />
        </Link>
      ) : null}
    </>
  );
}
