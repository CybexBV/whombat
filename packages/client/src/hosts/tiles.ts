/**
 * A server's figures (docs/decisions/overview-server-connection-final.md): the line that says what's inside it — the
 * CPU written in full with its cores and threads — and four tiles, Processor, Memory, Storage and Temperature, each a
 * plain word (or, on a server that isn't working, its bare figure), a meter of lit segments and a small line with the
 * figures under it. Overview's server rows (`overview.ts`) and the server's page say the same words. Shared by the web
 * and the phone; pure.
 */
import type { HostCpu, HostServer } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTranslator, clientTree } from '../i18n/catalog';
import { HOSTS_DASHBOARD_MORE_WORDS } from '../i18n/messages/connectionsHosts/dashboardMore';
import { DASH, formatNum, formatUptimeShort } from './format';
import { serverHref, shortOs } from './model';
import { diskUsedLevel, type HostTone, hostTone, sensorLevel } from './thresholds';

const NBSP = ' ';

/** The marks a CPU's name carries in `/proc/cpuinfo` (“Intel(R) Core(TM) i9-13900H”), left out of what's shown. */
const MARKS = /\((?:R|TM|C)\)|®|™/gi;

/** The CPU's name in full, without the trademark marks: “Intel Core i9-13900H”, “AMD Ryzen 9 9950X3D 16-Core Processor”. */
export function cpuName(model: string | null | undefined): string {
  return (model ?? '').replace(MARKS, ' ').replace(/\s+/g, ' ').trim();
}

/** What's inside a server: its CPU in full and “16 cores · 32 threads”; null when the server didn't say. */
export function cpuLine(
  cpu: HostCpu | null | undefined,
  locale?: string | null,
): { name: string; detail: string } | null {
  const name = cpuName(cpu?.model);
  if (!cpu || !name) return null;
  const w = clientTree(locale, HOSTS_DASHBOARD_MORE_WORDS).head;
  const parts: string[] = [];
  if (cpu.cores > 0) parts.push(w.cores(cpu.cores));
  if (cpu.threads > 0) parts.push(w.threads(cpu.threads));
  return { name, detail: parts.join(' · ') };
}

/** The line under a server's name: “Proxmox VE 9.2 · up 55 d” (what runs it and for how long). */
export function serverOsLine(
  s: Pick<HostServer, 'os' | 'uptimeS' | 'status'>,
  locale?: string | null,
): string {
  const offline = s.status === 'offline' || s.status === 'pending';
  const up =
    !offline && s.uptimeS != null && Number.isFinite(s.uptimeS)
      ? clientTranslator(locale).t('hosts.overview.uptime', { when: formatUptimeShort(s.uptimeS, locale) })
      : null;
  return [shortOs(s.os), up].filter(Boolean).join(' · ');
}

export type ServerTileKey = 'cpu' | 'memory' | 'storage' | 'temp';

export interface ServerTile {
  key: ServerTileKey;
  /** “Processor”, “Memory”, “Storage”, “Temperature”. */
  label: string;
  /** “Quiet”, “Plenty free”, “10”, “—”. */
  value: string;
  /** “%”, “°C”; empty with a word or “—”. */
  unit: string;
  /** How far the meter is lit, 0…1; null when not known (an unlit meter). */
  share: number | null;
  /**
   * The small line with the figures: “10 % in use · 24 h avg 7 %”, “42 GB free · 76 of 118 GB in use (64 %)”,
   * “1.6 of 3.6 TB · 44 % in use”, “limit 85 °C”; may be empty.
   */
  sub: string;
  /**
   * `ok` draws the meter in the chart colour; `warn` colours the word and the meter. A tile is never red: red is only
   * for what isn't working, and the server's pill says that.
   */
  tone: HostTone;
  /** Where the tile leads: the server's figure with its charts open, or its Storage tab. */
  href: string;
  /** The tile as a screen reader says it: “Processor Quiet, 10 % in use, 24 hour average 7 %”. */
  spoken: string;
}

/** Segments in a meter: 20 on Overview (web and phone) and the web's server page, 10 on the phone's server page. */
export const TILE_SEGMENTS = 20;
export const TILE_SEGMENTS_PHONE = 10;

/** How many of `n` segments are lit: none at 0 or unknown, else at least one so a small figure still shows. */
export function litSegments(share: number | null | undefined, n: number): number {
  if (share == null || !Number.isFinite(share) || share <= 0) return 0;
  return Math.min(n, Math.max(1, Math.round(share * n)));
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** A figure's words by how busy or full it is: the first band its share is under, else the last. */
function band(pct: number, bands: readonly [number, string][], last: string): string {
  for (const [under, v] of bands) if (pct < under) return v;
  return last;
}

/** How busy a processor is, in words (Overview's card and the server's Summary). */
export function processorWords(pct: number, locale?: string | null): string {
  const tr = clientTranslator(locale);
  return band(
    pct,
    [
      [40, tr.t('hosts.overview.figure.quiet')],
      [80, tr.t('hosts.overview.figure.busy')],
      [95, tr.t('hosts.overview.figure.veryBusy')],
    ],
    tr.t('hosts.overview.figure.flatOut'),
  );
}

/** How full memory is, in words. */
export function memoryFullWords(pct: number, locale?: string | null): string {
  const tr = clientTranslator(locale);
  return band(
    pct,
    [
      [70, tr.t('hosts.overview.figure.plentyFree')],
      [85, tr.t('hosts.overview.figure.gettingFull')],
      [95, tr.t('hosts.overview.figure.nearlyFull')],
    ],
    tr.t('hosts.overview.figure.full'),
  );
}

/** How full a disk or storage is, in words (the same bands as its warnings: 80 % and 90 %). */
export function spaceWords(pct: number, locale?: string | null): string {
  const tr = clientTranslator(locale);
  return band(
    pct,
    [
      [70, tr.t('hosts.overview.figure.plentyFree')],
      [80, tr.t('hosts.overview.figure.fillingUp')],
      [95, tr.t('hosts.overview.figure.nearlyFull')],
    ],
    tr.t('hosts.overview.figure.full'),
  );
}

/**
 * Whether a server's tiles may say how it is in words: not while it isn't working (its pill says what failed), so a
 * quiet figure never reads as “Plenty free” beside “Disk array failed”.
 */
export function tilesInWords(s: Pick<HostServer, 'status'>): boolean {
  return s.status !== 'bad';
}

/** A tile is amber at most: red is for what isn't working, and the pill says that. */
export function tileTone(t: HostTone): HostTone {
  return t === 'bad' ? 'warn' : t;
}
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** At 90 % and over a figure is amber (the servers' memory rule, AP-2524). */
const fullTone = (pct: number): HostTone => (pct >= 90 ? 'warn' : 'ok');
/** Good is plain; `mut` (no level) is plain too. */
const levelTone = (t: HostTone): HostTone => (t === 'warn' || t === 'bad' ? t : 'ok');

/** “76 of 118 GB”, “1.2 of 1.5 TB”, “420 GB of 1.8 TB”: both in the total's unit unless the used part is small. */
export function amountOf(usedGb: number | null, totalGb: number, locale?: string | null): string {
  const tr = clientTranslator(locale);
  const num = (n: number) => formatNum(n, locale);
  const tb = totalGb >= 1000;
  const total = tb ? `${num(totalGb / 1000)}${NBSP}TB` : `${num(totalGb)}${NBSP}GB`;
  if (usedGb == null) return tr.t('hosts.overview.of', { a: DASH, b: total });
  if (tb && usedGb < 100) return tr.t('hosts.overview.of', { a: `${num(usedGb)}${NBSP}GB`, b: total });
  return tr.t('hosts.overview.of', { a: num(tb ? usedGb / 1000 : usedGb), b: total });
}

function mean(values: readonly (number | null)[]): number | null {
  const xs = values.filter(finite);
  return xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null;
}

/** Where a server's figure leads: the server's page with that chart open, or one of its tabs (`tab=storage`). */
export function figureHref(serverId: string, search: string): string {
  return `${serverHref(serverId)}?${search}`;
}

/**
 * A server's figures as the tiles and Overview's row read them, each null when not known: the processor now and its
 * 24 hour average, memory and storage in use (a share and “76 of 118 GB”, empty without a total), the hottest sensor
 * and its limit.
 */
export interface ServerFigures {
  cpu: number | null;
  avg: number | null;
  memTotal: number | null;
  memUsed: number | null;
  memPct: number | null;
  memAmount: string;
  diskPct: number | null;
  diskAmount: string;
  maxC: number | null;
  limit: number | null;
}

export function serverFigures(s: HostServer, locale?: string | null): ServerFigures {
  const mem = s.memory;
  const memTotal = finite(mem.totalGb) && mem.totalGb > 0 ? mem.totalGb : null;
  const memUsed = finite(mem.usedGb)
    ? mem.usedGb
    : finite(mem.usedPct) && memTotal
      ? (mem.usedPct / 100) * memTotal
      : null;
  const memPct = finite(mem.usedPct)
    ? mem.usedPct
    : memUsed != null && memTotal
      ? (memUsed / memTotal) * 100
      : null;

  const st = s.storage;
  const capGb = finite(st.capacityTb) && st.capacityTb > 0 ? st.capacityTb * 1000 : null;
  const usedGb = finite(st.usedTb)
    ? st.usedTb * 1000
    : finite(st.usedPct) && capGb
      ? (st.usedPct / 100) * capGb
      : null;
  const diskPct = finite(st.usedPct) ? st.usedPct : usedGb != null && capGb ? (usedGb / capGb) * 100 : null;

  const temp = s.temperature;
  return {
    cpu: finite(s.cpuPct) ? s.cpuPct : null,
    avg: mean(s.cpu24h),
    memTotal,
    memUsed,
    memPct,
    memAmount: memTotal ? amountOf(memUsed, memTotal, locale) : '',
    diskPct,
    diskAmount: capGb ? amountOf(usedGb, capGb, locale) : '',
    maxC: temp && finite(temp.maxC) ? temp.maxC : null,
    limit: temp && finite(temp.limitC) && temp.limitC > 0 ? temp.limitC : null,
  };
}

/** The four tiles of a server's card, in order; offline (or not yet reporting) each says “—” with an unlit meter. */
export function serverTiles(s: HostServer, locale?: string | null): ServerTile[] {
  const offline = s.status === 'offline' || s.status === 'pending';
  const w = clientTree(locale, HOSTS_DASHBOARD_MORE_WORDS).tiles;
  const pct = (n: number) => `${Math.round(n)}${NBSP}%`;
  const tile = (
    key: ServerTileKey,
    label: string,
    href: string,
    t: Partial<Pick<ServerTile, 'value' | 'unit' | 'share' | 'sub' | 'tone'>> & { said?: string },
  ): ServerTile => {
    const value = t.value ?? DASH;
    const unit = value === DASH ? '' : (t.unit ?? '');
    const said =
      value === DASH ? interpolate(w.unknown, { name: label }) : `${label} ${value}${unit ? ` ${unit}` : ''}`;
    return {
      key,
      label,
      value,
      unit,
      share: t.share ?? null,
      sub: t.sub ?? '',
      tone: t.tone ?? 'ok',
      href,
      spoken: [said, t.said].filter(Boolean).join(', '),
    };
  };
  const hrefs = {
    cpu: figureHref(s.id, 'chart=cpu'),
    memory: figureHref(s.id, 'chart=memory'),
    storage: figureHref(s.id, 'tab=storage'),
    temp: figureHref(s.id, 'chart=hottest'),
  };
  if (offline) {
    return [
      tile('cpu', w.processor, hrefs.cpu, {}),
      tile('memory', w.memory, hrefs.memory, {}),
      tile('storage', w.storage, hrefs.storage, {}),
      tile('temp', w.temperature, hrefs.temp, {}),
    ];
  }
  const words = tilesInWords(s);
  const { cpu, avg, memTotal, memUsed, memPct, memAmount, diskPct, diskAmount, maxC, limit } = serverFigures(
    s,
    locale,
  );

  const spoken = (text: string) => text.replaceAll(NBSP, ' ');
  const cpuInUse = words && cpu != null ? interpolate(w.inUse, { amount: pct(cpu) }) : null;
  const avgSub = avg == null ? '' : interpolate(w.avg24h, { pct: pct(avg) });
  const avgSaid = avg == null ? null : interpolate(w.avg24hSaid, { pct: pct(avg) });
  const cpuSub = cpuInUse ? [cpuInUse, avgSub].filter(Boolean).join(' · ') : avgSub;
  const cpuSaid = (cpuInUse ? [cpuInUse, avgSaid] : [avgSaid]).filter(Boolean).join(' · ');
  const cpuTile = tile('cpu', w.processor, hrefs.cpu, {
    value: cpu == null ? DASH : words ? processorWords(cpu, locale) : String(Math.round(cpu)),
    unit: words ? '' : '%',
    share: cpu == null ? null : clamp01(cpu / 100),
    sub: cpuSub,
    said: cpuSaid ? spoken(cpuSaid) : undefined,
    tone: cpu == null ? 'ok' : fullTone(cpu),
  });

  const memFree =
    memTotal && memUsed != null
      ? interpolate(w.free, { amount: `${formatNum(Math.max(0, memTotal - memUsed), locale)}${NBSP}GB` })
      : '';
  const memSub =
    words && memPct != null && memAmount
      ? [memFree, interpolate(w.inUseShare, { amount: memAmount, pct: pct(memPct) })]
          .filter(Boolean)
          .join(' · ')
      : memAmount;
  const memTile = tile('memory', w.memory, hrefs.memory, {
    value: memPct == null ? DASH : words ? memoryFullWords(memPct, locale) : String(Math.round(memPct)),
    unit: words ? '' : '%',
    share: memPct == null ? null : clamp01(memPct / 100),
    sub: memSub,
    said: memSub ? spoken(memSub) : undefined,
    tone: memPct == null ? 'ok' : fullTone(memPct),
  });

  const diskSub =
    words && diskPct != null
      ? [diskAmount, interpolate(w.inUse, { amount: pct(diskPct) })].filter(Boolean).join(' · ')
      : diskAmount;
  const diskTile = tile('storage', w.storage, hrefs.storage, {
    value: diskPct == null ? DASH : words ? spaceWords(diskPct, locale) : String(Math.round(diskPct)),
    unit: words ? '' : '%',
    share: diskPct == null ? null : clamp01(diskPct / 100),
    sub: diskSub,
    said: diskSub ? spoken(diskSub) : undefined,
    tone: tileTone(levelTone(hostTone(diskUsedLevel(diskPct)))),
  });

  // Temperature is always its figure: a word here (“Normal”) could contradict the pill (“Running warm”).
  const limitWords = (sep: string) =>
    limit ? interpolate(w.limit, { temp: `${Math.round(limit)}${sep}°C` }) : '';
  const tempTile = tile('temp', w.temperature, hrefs.temp, {
    value: maxC == null ? DASH : String(Math.round(maxC)),
    unit: '°C',
    share: maxC == null ? null : clamp01(maxC / (limit ?? 100)),
    sub: maxC != null && limit ? limitWords(NBSP) : '',
    said: maxC == null ? undefined : [w.hottest, limitWords(' ')].filter(Boolean).join(', '),
    tone: maxC == null ? 'ok' : tileTone(levelTone(hostTone(sensorLevel(maxC, limit)))),
  });

  return [cpuTile, memTile, diskTile, tempTile];
}

/**
 * When a server's page's readings were taken: the page's moment less how long ago the agent last reported, null when
 * either isn't known (then “Reading time unknown”, never the fetch's time).
 */
export function serverReportAt(d: {
  asOf: string;
  server: { agent: { lastSyncSAgo: number | null } };
}): string | null {
  const asOf = Date.parse(d.asOf);
  const ago = d.server.agent.lastSyncSAgo;
  if (!Number.isFinite(asOf) || ago == null || !Number.isFinite(ago) || ago < 0) return null;
  return new Date(asOf - ago * 1000).toISOString();
}
