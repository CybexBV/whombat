/**
 * The words and figures of a thing's page (connection-pages.md CP-04, connection-pages-server.md CP-S…): plain, short,
 * a space before units (“5 %”, “30 GB”), the middle dot between facts. Pure.
 */
import type { ThingTextPart } from '@whombat/core';

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** “two” for small counts in a sentence, the figure past ten. */
export function countWords(n: number): string {
  return n >= 0 && n <= 10 ? (NUMBER_WORDS[n] as string) : String(n);
}

/** A figure with thousands separators: “12,033”. */
export function thousands(n: number): string {
  return n.toLocaleString('en-US');
}

/** “1 integration”, “2 integrations”; `many` when the plural isn't the noun with an s. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A sentence's first letter in capitals. */
export function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Cut to `n` characters with an ellipsis. */
export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
}

/** One decimal under ten, whole above: 2.8, 3.0, 12, 140. */
export function figure(n: number): string {
  const a = Math.abs(n);
  if (a >= 10 || Number.isInteger(n)) return a >= 10 ? String(Math.round(n)) : String(n);
  return n.toFixed(1);
}

/** Like `figure` but always one decimal under ten (“3.0 GB” beside “8 GB”). */
export function figure1(n: number): string {
  return Math.abs(n) >= 10 ? String(Math.round(n)) : n.toFixed(1);
}

/** Whole percent: “5 %”. */
export function pct(n: number): string {
  return `${Math.round(n)} %`;
}

const GB = 1e9;

/** Bytes in the largest unit that keeps the figure readable: “2.8 GB”, “640 MB”, “12 kB”. */
export function bytes(n: number): string {
  if (n >= 1e12) return `${figure1(n / 1e12)} TB`;
  if (n >= GB) return `${figure1(n / GB)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${Math.round(n)} B`;
}

/** “2.8 GB” from Home Assistant's recorder size (“2834.56 MiB”, “512 KiB”); null when it isn't one. */
export function sizeTextBytes(text: string): number | null {
  const m = /^\s*([\d.]+)\s*([KMGT]i?B|B)\s*$/i.exec(text);
  if (!m?.[1] || !m[2]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  const base = unit.includes('I') ? 1024 : 1000;
  const power = { B: 0, K: 1, M: 2, G: 3, T: 4 }[unit.charAt(0) as 'B' | 'K' | 'M' | 'G' | 'T'] ?? 0;
  return n * base ** power;
}

/** How long ago, short: “now”, “4 min”, “23 h”, “3 days”, “6 weeks”. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'a moment';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} days`;
  const w = Math.round(d / 7);
  if (w < 9) return `${w} weeks`;
  const mo = Math.round(d / 30);
  return mo < 24 ? `${mo} months` : `${Math.round(d / 365)} years`;
}

/** “8 Oct” in the burrow's zone. */
export function dayMonth(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(at);
}

/** “06:40” in the burrow's zone. */
export function clock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/** “Today 07:31”, “Yesterday 22:10”, “17 Oct”. */
export function when(at: Date, now: Date, timeZone: string): string {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  if (day(at) === day(now)) return `Today ${clock(at, timeZone)}`;
  if (day(at) === day(new Date(now.getTime() - 86_400_000))) return `Yesterday ${clock(at, timeZone)}`;
  return dayMonth(at, timeZone);
}

/** Integrations whose names aren't their domain with a capital. */
const DOMAIN_NAMES: Record<string, string> = {
  knx: 'KNX',
  mqtt: 'MQTT',
  zha: 'ZHA',
  zwave_js: 'Z-Wave',
  esphome: 'ESPHome',
  unifi: 'UniFi',
  unifiprotect: 'UniFi Protect',
  dsmr: 'DSMR',
  upnp: 'UPnP',
  dlna_dmr: 'DLNA',
  homekit: 'HomeKit',
  homekit_controller: 'HomeKit',
  hassio: 'Supervisor',
  homeassistant: 'Home Assistant',
  hacs: 'HACS',
  sql: 'SQL',
  ipp: 'IPP',
  snmp: 'SNMP',
  tplink: 'TP-Link',
  wled: 'WLED',
};

/** A domain as people read it: `mobile_app` → “Mobile app”, `knx` → “KNX”. */
export function domainName(domain: string): string {
  return DOMAIN_NAMES[domain] ?? (cap(domain.replace(/_/g, ' ').trim()) || domain);
}

/** A line's parts: plain words, and `**strong**` runs. */
export function line(text: string): ThingTextPart[] {
  const parts: ThingTextPart[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ text: m[1] as string, strong: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts
    .map((p) => ({ ...p, text: p.text.slice(0, 120) }))
    .filter((p) => p.text.length > 0)
    .slice(0, 8);
}

/** A date from an ISO text or epoch seconds/milliseconds; null otherwise. */
export function dateOf(v: unknown): Date | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v);
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** A finite number from a number or a numeric text; null otherwise. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** A non-empty trimmed text, or null. */
export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** An object's fields, or an empty one. */
export function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** An array, or an empty one. */
export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A date or a moment as a sensor gives it (“2026-10-29”, “2026-10-29T05:00:00+00:00”). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A sensor's date in words: “Today”, “Tomorrow”, “Yesterday”, the day's name within the week either way, else
 * “29 Oct”; a moment adds its time (“Wednesday 06:00”). Null for a state that is no date.
 */
export function dateWords(state: string, now: Date, timeZone: string): string | null {
  const text = state.trim();
  const dateOnly = ISO_DATE.test(text);
  if (!dateOnly && !ISO_MOMENT.test(text)) return null;
  const at = new Date(dateOnly ? `${text}T12:00:00Z` : text);
  if (!Number.isFinite(at.getTime())) return null;
  const dayOf = (d: Date, zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(d);
  // A date is a day wherever it is read; a moment is the day it falls on here.
  const day = dateOnly ? text : dayOf(at, timeZone);
  const days = Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${dayOf(now, timeZone)}T00:00:00Z`)) / 86_400_000,
  );
  const name =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Tomorrow'
        : days === -1
          ? 'Yesterday'
          : Math.abs(days) < 7
            ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(
                new Date(`${day}T12:00:00Z`),
              )
            : dayMonth(new Date(`${day}T12:00:00Z`), 'UTC');
  return dateOnly || Math.abs(days) >= 7 ? name : `${name} ${clock(at, timeZone)}`;
}
