/**
 * The calm glance as the page reads it (3.2, CG-350…; Whombat desk-display.md DK-101…DK-125): the desk socket's
 * `DeskGlance.calm` (`DeskCalm` of the contracts' `desk-glance.ts`), checked member by member like the rest of the
 * state (CG-41): what the page doesn't understand goes, a part without the words it needs goes, and the glance stays
 * drawable. Plus the top bar's few pure decisions (which chips show, in which tone) and the durations it says.
 */
import { english, type Translate } from '../i18n/translate';
import { LOOK_FIX_LABEL_MAX, LOOK_RESEARCH_STATES, type LookResearchState } from './research';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null =>
  values.includes(v as T) ? (v as T) : null;
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
const time = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
/** A display string cut to `max` code points; null when it isn't one or is empty. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const one = v.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  const points = Array.from(one);
  return points.length <= max ? one : points.slice(0, max).join('');
}
const markRe = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const mark = (v: unknown): string | null => (typeof v === 'string' && markRe.test(v) ? v : null);
const serverIdRe = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const serverId = (v: unknown): string | null => (typeof v === 'string' && serverIdRe.test(v) ? v : null);
const askNumber = (v: unknown) => int(v, 1, 1_000_000_000);

export const SHOW_LEVELS = ['always', 'matters', 'off'] as const;
export type ShowLevel = (typeof SHOW_LEVELS)[number];
export const BAR_ITEMS = ['network', 'internet', 'battery', 'updates'] as const;
export type BarItem = (typeof BAR_ITEMS)[number];
export type BarChoices = Record<BarItem, ShowLevel>;
/** The defaults (DK-105): what the bar shows when the runtime sends no choices. */
export const DEFAULT_BAR: BarChoices = {
  network: 'always',
  internet: 'always',
  battery: 'always',
  updates: 'matters',
};

export const HEADLINE_TONES = ['ok', 'busy', 'warn', 'bad'] as const;
export type HeadlineTone = (typeof HEADLINE_TONES)[number];
export const HERO_TONES = ['bad', 'warn'] as const;
export type HeroTone = (typeof HERO_TONES)[number];
export const MOMENT_KINDS = ['work', 'activity', 'figure', 'coming'] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];
export const STRIP_STATES = ['ok', 'warn', 'bad', 'off'] as const;
export type StripState = (typeof STRIP_STATES)[number];
export const STRIP_WORK = ['done', 'now', 'next'] as const;
export type StripWork = (typeof STRIP_WORK)[number];
export const DIGEST_ICONS = ['ask', 'done', 'down', 'up', 'look'] as const;
export type DigestIcon = (typeof DIGEST_ICONS)[number];
export const UPDATE_STATES = ['downloading', 'installing', 'restarting'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];
export const PREVIEW_SCENARIOS = ['now', 'wrong', 'busy'] as const;
export const CLOCKS = ['big', 'small'] as const;

/** At most three things in the middle, eight servers in the strip, five lines in Welcome back (the contract's). */
export const MOMENTS_MAX = 3;
export const STRIP_MAX = 8;
export const DIGEST_MAX = 5;
export const SPARK_POINTS = 30;
/** Welcome back goes back to the glance after this long (DK-121). */
export const WELCOME_SHOW_MS = 60_000;

/** Something that needs the person, opened by its ask's number or its look's key (DK-113, DK-114). */
export interface CalmRef {
  ask: number | null;
  look: string | null;
  server: string | null;
}

export interface CalmHero extends CalmRef {
  kind: 'ask' | 'look';
  tone: HeroTone;
  title: string;
  detail: string | null;
  since: string | null;
  /**
   * A look's research (3.5, CG-373): where the assistant is with it, and the label of the step it offers (only once
   * `found`), the hero's first button. Null on an ask's hero and from an older runtime.
   */
  research: LookResearchState | null;
  fix: string | null;
}

export interface CalmAlso extends CalmRef {
  tone: HeroTone;
  name: string;
  text: string;
}

export interface CalmMoment {
  key: string;
  kind: MomentKind;
  name: string;
  mark: string | null;
  value: string;
  detail: string | null;
  progress: number | null;
  pinned: boolean;
}

export interface CalmServer {
  id: string | null;
  name: string;
  mark: string;
  state: StripState;
  say: string | null;
  spark: number[];
  work: StripWork | null;
  progress: number | null;
}

export interface CalmDigestItem extends CalmRef {
  icon: DigestIcon;
  text: string;
  at: string | null;
}

export interface CalmDigest {
  id: string;
  awayS: number;
  items: CalmDigestItem[];
}

export interface DeskCalm {
  headline: { tone: HeadlineTone; text: string; more: string | null };
  clock: 'big' | 'small';
  hero: CalmHero | null;
  also: CalmAlso[];
  moreNeeds: number;
  moments: CalmMoment[];
  strip: CalmServer[];
  moreStrip: number;
  bar: BarChoices;
  doneCount: number | null;
  digest: CalmDigest | null;
  update: UpdateState | null;
  sample: { scenario: (typeof PREVIEW_SCENARIOS)[number]; until: string } | null;
}

function ref(v: Obj): CalmRef {
  return { ask: askNumber(v.ask), look: text(v.look, 120), server: serverId(v.server) };
}

function parseBar(v: unknown): BarChoices {
  const b = isObj(v) ? v : {};
  const out = { ...DEFAULT_BAR };
  for (const item of BAR_ITEMS) out[item] = oneOf(b[item], SHOW_LEVELS) ?? DEFAULT_BAR[item];
  return out;
}

/** The calm glance, or null when there is none or it can't be drawn (no sentence): the page then draws the old one. */
export function parseCalm(v: unknown): DeskCalm | null {
  if (!isObj(v)) return null;
  const h = isObj(v.headline) ? v.headline : {};
  const tone = oneOf(h.tone, HEADLINE_TONES);
  const headlineText = text(h.text, 80);
  if (!tone || !headlineText) return null;
  const heroObj = isObj(v.hero) ? v.hero : null;
  const heroKind = heroObj ? oneOf(heroObj.kind, ['ask', 'look'] as const) : null;
  const heroTone = heroObj ? oneOf(heroObj.tone, HERO_TONES) : null;
  const heroTitle = heroObj ? text(heroObj.title, 120) : null;
  const research = heroObj && heroKind === 'look' ? oneOf(heroObj.research, LOOK_RESEARCH_STATES) : null;
  const hero: CalmHero | null =
    heroObj && heroKind && heroTone && heroTitle
      ? {
          kind: heroKind,
          tone: heroTone,
          title: heroTitle,
          detail: text(heroObj.detail, 200),
          since: time(heroObj.since),
          ...ref(heroObj),
          research,
          fix: research === 'found' ? text(heroObj.fix, LOOK_FIX_LABEL_MAX) : null,
        }
      : null;
  const also = list(v.also, 2).flatMap((a): CalmAlso[] => {
    if (!isObj(a)) return [];
    const t = oneOf(a.tone, HERO_TONES);
    const name = text(a.name, 40);
    const words = text(a.text, 120);
    return t && name && words ? [{ tone: t, name, text: words, ...ref(a) }] : [];
  });
  const moments = list(v.moments, MOMENTS_MAX).flatMap((m): CalmMoment[] => {
    if (!isObj(m)) return [];
    const kind = oneOf(m.kind, MOMENT_KINDS);
    const key = text(m.key, 220);
    const name = text(m.name, 40);
    const value = text(m.value, 40);
    if (!kind || !key || !name || !value) return [];
    return [
      {
        key,
        kind,
        name,
        mark: mark(m.mark),
        value,
        detail: text(m.detail, 80),
        progress: int(m.progress, 0, 100),
        pinned: m.pinned === true,
      },
    ];
  });
  const strip = list(v.strip, STRIP_MAX).flatMap((s): CalmServer[] => {
    if (!isObj(s)) return [];
    const name = text(s.name, 40);
    const state = oneOf(s.state, STRIP_STATES);
    if (!name || !state) return [];
    const say = text(s.say, 40);
    return [
      {
        id: serverId(s.id),
        name,
        mark: mark(s.mark) ?? 'server',
        state,
        say,
        spark: say
          ? []
          : list(s.spark, SPARK_POINTS).flatMap((p) => {
              const n = int(p, 0, 100);
              return n === null ? [] : [n];
            }),
        work: oneOf(s.work, STRIP_WORK),
        progress: int(s.progress, 0, 100),
      },
    ];
  });
  const d = isObj(v.digest) ? v.digest : null;
  const digestId = d && typeof d.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(d.id) ? d.id : null;
  const digestItems = d
    ? list(d.items, DIGEST_MAX).flatMap((it): CalmDigestItem[] => {
        if (!isObj(it)) return [];
        const icon = oneOf(it.icon, DIGEST_ICONS);
        const words = text(it.text, 120);
        return icon && words ? [{ icon, text: words, at: time(it.at), ...ref(it) }] : [];
      })
    : [];
  const sample = isObj(v.sample) ? v.sample : null;
  const scenario = sample ? oneOf(sample.scenario, PREVIEW_SCENARIOS) : null;
  const until = sample ? time(sample.until) : null;
  return {
    headline: { tone, text: headlineText, more: text(h.more, 200) },
    // Something that needs the person makes the clock small (DK-107).
    clock: hero ? 'small' : (oneOf(v.clock, CLOCKS) ?? 'big'),
    hero,
    also: hero ? also : [],
    moreNeeds: hero ? (int(v.moreNeeds, 0, 1_000_000) ?? 0) : 0,
    moments: hero ? [] : moments,
    strip,
    moreStrip: int(v.moreStrip, 0, 1_000_000) ?? 0,
    bar: parseBar(v.bar),
    doneCount: int(v.doneCount, 1, 1_000_000),
    digest:
      digestId && digestItems.length > 0 && d
        ? { id: digestId, awayS: int(d.awayS, 0, 31_536_000) ?? 0, items: digestItems }
        : null,
    update: oneOf(v.update, UPDATE_STATES),
    sample: scenario && until ? { scenario, until } : null,
  };
}

/** “2 h 10 min”, “45 min”, “3 days”: how long, for Welcome back (DK-120). */
export function awayText(seconds: number, t: Translate = english): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return t('calm.min', { min });
  const h = Math.floor(min / 60);
  if (h < 24) {
    const rest = min % 60;
    return rest ? t('calm.hMin', { h, rest }) : `${h} ${h === 1 ? t('calm.hour') : t('calm.hours')}`;
  }
  const days = Math.floor(h / 24);
  return `${days} ${days === 1 ? t('calm.day') : t('calm.days')}`;
}

/** Whether a top bar chip shows (DK-110): *Always*, *When it matters* only while `off` is true, never *Off*. */
export function barShows(level: ShowLevel, off: boolean): boolean {
  return level === 'always' || (level === 'matters' && off);
}

/** A sparkline's points for a box `w`×`h` (whole percent, oldest first): an SVG polyline's `points`. */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  if (values.length < 2) return '';
  const step = w / (values.length - 1);
  // Scaled to the hour's own peak (at least a quarter), so a quiet server still shows its shape.
  const top = Math.max(25, ...values);
  return values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (Math.max(0, Math.min(top, v)) / top) * h).toFixed(1)}`)
    .join(' ');
}
