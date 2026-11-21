/**
 * The words, thresholds and page pieces the storage kinds share (service-dashboards.md SD-50…SD-57, SD-S17): how full
 * something is (“3.1 of 5.0 TB”, amber from 85 %, red from 95 %), how long ago (“26 h ago”), a disk's temperature, the
 * page's status from Worth a look without heads-ups (quiet-notices.md QN-02), the card from chosen figures, and the page of a service that couldn't be read. Pure.
 */
import type {
  ThingImage,
  ThingImageShape,
  ThingPageButton,
  ThingPageKpi,
  ThingPageNotice,
  ThingStatus,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { imageRef, thingImage } from '../../images';
import type { KindNotice } from '../../quiet/types';
import { figure1, pct, span } from '../../words';
import { pageButton } from '../buttons';
import type { KindSeen } from '../registry';
import { seenFromView } from '../registry';
import type { KindCtx, KindView } from '../types';
import { counts, headWords } from './lines';

const DAY = 86_400_000;

/** Amber from 85 % (SD-50, SD-55: “over 85 %”), red from 95 %. */
export const FULL_WARN_PCT = 85;
export const FULL_BAD_PCT = 95;

/** How full, as a tone. */
export function fullTone(p: number): 'warn' | 'bad' | undefined {
  return p >= FULL_BAD_PCT ? 'bad' : p >= FULL_WARN_PCT ? 'warn' : undefined;
}

/** “3.1 of 5.0 TB”, “660 of 930 GB”, “12 of 64 MB”: both in the unit of the total. */
export function usedOf(used: number, total: number): string {
  const [unit, div] =
    total >= 1e12 ? ['TB', 1e12] : total >= 1e9 ? ['GB', 1e9] : total >= 1e6 ? ['MB', 1e6] : ['kB', 1e3];
  const f = (n: number) => figure1(n / (div as number));
  return `${f(used)} of ${f(total)} ${unit}`;
}

/** “26 h ago”, “3 days ago”, “just now”. */
export function ago(at: Date, now: Date): string {
  const ms = now.getTime() - at.getTime();
  return ms < 60_000 ? 'just now' : `${span(ms)} ago`;
}

/** Days between two moments. */
export const daysBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / DAY;

/** A disk's temperature (°C) as a tone: hard disks amber from 55, red from 60; SSDs and NVMe from 70 and 80. */
export function tempTone(c: number, ssd = false): 'warn' | 'bad' | undefined {
  const [warn, bad] = ssd ? [70, 80] : [55, 60];
  return c >= bad ? 'bad' : c >= warn ? 'warn' : undefined;
}

/** “36 °C”. */
export const celsius = (c: number) => `${Math.round(c)} °C`;

/** A “Used” figure over a total: “62 %” · “3.1 of 5.0 TB”, a bar, amber or red when nearly full. */
export function usedKpi(key: string, label: string, used: number, total: number, sub?: string): ThingPageKpi {
  const p = total > 0 ? (used / total) * 100 : 0;
  const tone = fullTone(p);
  return {
    key,
    label,
    value: pct(p),
    sub: (sub ?? usedOf(used, total)).slice(0, 80),
    meter: Math.min(1, Math.max(0, total > 0 ? used / total : 0)),
    ...(tone ? { tone } : { color: 'blue' as const }),
  };
}

const RANK = { info: 0, warn: 1, bad: 2 } as const;
/** Lines that colour the dot first (QN-02), then by tone. */
const rankOf = (n: ThingPageNotice) => RANK[n.tone] + (counts(n) ? 3 : 0);

/** Worth a look, worst first (what colours the dot before heads-ups), each id once. */
export function worstFirst<T extends ThingPageNotice>(notices: readonly T[]): T[] {
  const seen = new Set<string>();
  return notices
    .filter((n) => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    })
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rankOf(b.n) - rankOf(a.n) || a.i - b.i)
    .map(({ n }) => n);
}

/**
 * The page's status and badge: the worst line of Worth a look that isn't a heads-up (QN-02), its badge or title, else
 * the calm words (“2 pools healthy”). The health pass and the page work it out again without what is quiet (S0).
 */
export function statusOf(
  notices: readonly ThingPageNotice[],
  calm: string,
): { status: Exclude<ThingStatus, 'learning' | 'offline' | 'unknown'>; badge: string } {
  const worst = worstFirst(notices).find(counts);
  if (!worst) return { status: 'ok', badge: calm.slice(0, 60) };
  return { status: worst.tone === 'bad' ? 'bad' : 'warn', badge: headWords(worst).slice(0, 60) };
}

/**
 * The card (SD-05) from chosen figures of the view, in the order given (“Oldest backup, Failed”), and the dot from its
 * Worth a look without heads-ups (QN-02), the reason in the line's short words.
 */
export function cardOf(view: Pick<KindView, 'kpis' | 'notices'>, keys: readonly string[], line: string) {
  const kpis = keys.map((k) => view.kpis?.find((x) => x.key === k)).filter((k): k is ThingPageKpi => !!k);
  const notices = view.notices.filter(counts).map((n) => ({ ...n, title: headWords(n) }));
  return seenFromView({ kpis, notices }, { figures: keys.length, line: line.slice(0, 80) });
}

/**
 * A card's seen with no points (SD-S06; a NAS adds its used space, `nas.ts`), with Worth a look as this pass read it and the
 * checks it couldn't read (QN-11: an Ignore of those doesn't end now).
 */
export function seenOf(
  glance: KindSeen['glance'],
  notices: readonly KindNotice[] = [],
  skipped: readonly string[] = [],
): KindSeen {
  return { glance, points: {}, notices: [...notices], ...(skipped.length ? { skipped: [...skipped] } : {}) };
}

/** The service's own page: the connection's address field, else its base. */
export function serviceUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  const url = typeof row.fields?.url === 'string' && row.fields.url.trim() ? row.fields.url : row.baseUrl;
  return url.trim().replace(/\/+$/, '');
}

/** A page part when nothing could be read: why, and the way to the service itself. */
export function unreadView(
  name: string,
  url: string,
  problem: string | undefined,
  refreshing: boolean,
): KindView {
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    open: { label: `Open ${name}`.slice(0, 40), url },
    actions: [],
    readAt: null,
    suggestions: [],
    ...(problem ? { problem } : {}),
    refreshing,
  };
}

/** A version without a leading “v”: “v3.3.3” → “3.3.3”. */
export function bareVersion(v: string | null | undefined): string | null {
  const s = typeof v === 'string' ? v.trim().replace(/^v(?=\d)/i, '') : '';
  return s ? s.slice(0, 40) : null;
}

/** Whether version `a` is older than `b` (dotted numbers; anything else compares equal). */
export function olderThan(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x !== y) return x < y;
  }
  return false;
}

/* Buttons and pictures (SD-06, SD-07) -------------------------------------------------------------------------------- */

/** The connection, for a page's buttons: whether it is Look only. */
export type ButtonCtx = Pick<KindCtx, 'row'>;

/** A button (CT-1001), allowed unless the connection is Look only, which it says. */
export function button(ctx: ButtonCtx, spec: Omit<ThingPageButton, 'allowed' | 'reason'>): ThingPageButton {
  return pageButton(ctx, spec);
}

/** A picture of a path on the connection (CT-1000), or none when the path can't be named. */
export type Picture = (path: string, alt: string, shape: ThingImageShape) => ThingImage | undefined;

/** Pictures signed for this page (`imageRef`, S0). */
export function picturesOf(ctx: {
  services: Pick<Services, 'custody'>;
  row: Pick<KindCtx['row'], 'id'>;
  now: Date;
}): Picture {
  return (path, alt, shape) => thingImage(imageRef(ctx, { path }), alt, shape);
}

/** No pictures (the health pass). */
export const noPictures: Picture = () => undefined;
