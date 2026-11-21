// The check form: its fields per kind, validation that mirrors the hub
// (internal/checks Validate, hub applyCheck), the request body, and the
// wording of a check in lists.

import type { Check, CheckInput, CheckKind, CheckStatus } from '../../api/types';
import { plural } from '../../lib/format';
import { t } from '../../lib/i18n';

export const KINDS: { value: CheckKind; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'tcp', label: 'TCP' },
  { value: 'ping', label: 'Ping' },
  { value: 'dns', label: 'DNS' },
  { value: 'heartbeat', label: 'Heartbeat' },
];
export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'] as const;

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
export const INTERVALS = [30, MIN, 5 * MIN, 15 * MIN, HOUR];
export const PERIODS = [MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 6 * HOUR, 12 * HOUR, DAY, 7 * DAY];
export const GRACES = [0, MIN, 5 * MIN, 15 * MIN, HOUR, 6 * HOUR, DAY];

export interface CheckForm {
  name: string;
  kind: CheckKind;
  target: string;
  runner: string;
  interval_s: number;
  /** Heartbeat. */
  period_s: number;
  grace_s: number;
  expect_status: string;
  keyword: string;
  tls: boolean;
  insecure: boolean;
  cert_warn_days: string;
  dns_type: string;
  dns_server: string;
  expect: string;
}

export type FormErrors = Partial<Record<keyof CheckForm, string>>;

export function emptyForm(kind: CheckKind = 'http'): CheckForm {
  return {
    name: '',
    kind,
    target: '',
    runner: 'hub',
    interval_s: MIN,
    period_s: DAY,
    grace_s: HOUR,
    expect_status: '',
    keyword: '',
    tls: false,
    insecure: false,
    cert_warn_days: '',
    dns_type: 'A',
    dns_server: '',
    expect: '',
  };
}

export function formOf(c: Check): CheckForm {
  const o = c.options ?? {};
  const hb = c.kind === 'heartbeat';
  return {
    ...emptyForm(c.kind),
    name: c.name,
    target: c.target,
    runner: c.runner || 'hub',
    interval_s: hb ? MIN : c.interval_s,
    period_s: hb ? c.interval_s : DAY,
    grace_s: hb ? c.grace_s : HOUR,
    expect_status: o.expect_status ?? '',
    keyword: o.keyword ?? '',
    tls: !!o.tls,
    insecure: !!o.insecure,
    cert_warn_days: o.cert_warn_days ? String(o.cert_warn_days) : '',
    dns_type: o.dns_type || 'A',
    dns_server: o.dns_server ?? '',
    expect: o.expect ?? '',
  };
}

const LABEL = /^(?!-)[A-Za-z0-9_-]{1,63}$/;

/** An IP address or a DNS name (letters, digits, '-' and '_', labels up to 63). */
export function validHost(h: string): boolean {
  if (!h || h.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h.split('.').every((p) => Number(p) <= 255);
  if (h.includes(':')) return /^[0-9a-fA-F:.]+$/.test(h) && h.split(':').length >= 3;
  return h.split('.').every((l) => LABEL.test(l));
}

/** "host:port" or "[v6]:port". */
export function splitHostPort(s: string): { host: string; port: number } | null {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^\s:[\]]+)):(\d{1,5})$/.exec(s);
  if (!m) return null;
  const host = m[1] ?? m[2] ?? '';
  const port = Number(m[3]);
  if (!validHost(host) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** "200-299,301": codes or ranges of 100 to 599 ("" = the default 200-399). */
export function validStatusRanges(s: string): boolean {
  if (!s.trim()) return true;
  const parts = s.split(',');
  if (parts.length > 16) return false;
  return parts.every((p) => {
    const m = /^\s*(\d{3})\s*(?:-\s*(\d{3})\s*)?$/.exec(p);
    if (!m) return false;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return a >= 100 && b <= 599 && a <= b;
  });
}

function validUrl(s: string): boolean {
  if (/\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '';
  } catch {
    return false;
  }
}

export function validate(f: CheckForm): FormErrors {
  const e: FormErrors = {};
  if (!f.name.trim()) e.name = t('Give the check a name.');
  else if (f.name.trim().length > 80) e.name = t('At most 80 characters.');
  const target = f.target.trim();
  switch (f.kind) {
    case 'http':
      if (!validUrl(target)) e.target = t('An http:// or https:// address.');
      if (!validStatusRanges(f.expect_status)) e.expect_status = t('Codes or ranges such as 200-299,301.');
      if (f.keyword.length > 256) e.keyword = t('At most 256 characters.');
      break;
    case 'tcp':
      if (!splitHostPort(target)) e.target = t('A host and port, such as db.lan:5432 or [2001:db8::1]:443.');
      break;
    case 'ping':
      if (!validHost(target)) e.target = t('A host name or IP address.');
      break;
    case 'dns':
      if (!validHost(target.replace(/\.$/, ''))) e.target = t('A DNS name, such as example.com.');
      if (f.dns_server.trim() && !validHost(f.dns_server.trim().replace(/^\[(.*)\]$/, '$1')) && !splitHostPort(f.dns_server.trim())) e.dns_server = t('A resolver address, such as 1.1.1.1 or 10.0.0.1:53.');
      if (f.expect.length > 256) e.expect = t('At most 256 characters.');
      break;
    case 'heartbeat':
      if (f.period_s < MIN || f.period_s > 31 * DAY) e.period_s = t('From 1 minute to 31 days.');
      if (f.grace_s < 0 || f.grace_s > 7 * DAY) e.grace_s = t('Up to 7 days.');
      break;
  }
  if (f.kind !== 'heartbeat' && (f.interval_s < 30 || f.interval_s > HOUR)) e.interval_s = t('From 30 seconds to 1 hour.');
  const tlsCert = f.kind === 'http' || (f.kind === 'tcp' && f.tls);
  if (tlsCert && f.cert_warn_days.trim() && !/^(\d{1,3})$/.test(f.cert_warn_days.trim())) e.cert_warn_days = t('Whole days, 0 to 365.');
  else if (tlsCert && Number(f.cert_warn_days) > 365) e.cert_warn_days = t('Whole days, 0 to 365.');
  return e;
}

/** The request body: only the fields of the form's kind. */
export function toInput(f: CheckForm): CheckInput {
  const base: CheckInput = { name: f.name.trim(), kind: f.kind };
  if (f.kind === 'heartbeat') return { ...base, interval_s: f.period_s, grace_s: f.grace_s, options: {} };
  const options: CheckInput['options'] = {};
  const warn = f.cert_warn_days.trim() ? Number(f.cert_warn_days) : undefined;
  switch (f.kind) {
    case 'http':
      if (f.expect_status.trim()) options.expect_status = f.expect_status.replace(/\s+/g, '');
      if (f.keyword) options.keyword = f.keyword;
      if (f.insecure) options.insecure = true;
      if (warn) options.cert_warn_days = warn;
      break;
    case 'tcp':
      if (f.tls) {
        options.tls = true;
        if (f.insecure) options.insecure = true;
        if (warn) options.cert_warn_days = warn;
      }
      break;
    case 'dns':
      if (f.dns_type && f.dns_type !== 'A') options.dns_type = f.dns_type;
      if (f.dns_server.trim()) options.dns_server = f.dns_server.trim();
      if (f.expect) options.expect = f.expect;
      break;
  }
  return { ...base, target: f.target.trim(), runner: f.runner || 'hub', interval_s: f.interval_s, options };
}

// ---------------------------------------------------------------- wording

/** "30 s", "5 min", "1 h", "1 day", "1 week". */
export function formatSeconds(s: number): string {
  if (s === 0) return t('none');
  if (s % (7 * DAY) === 0) return plural(s / (7 * DAY), 'week');
  if (s % DAY === 0) return plural(s / DAY, 'day');
  if (s % HOUR === 0) return `${s / HOUR} ${t('h')}`;
  if (s % MIN === 0) return `${s / MIN} min`;
  return `${s} s`;
}

/** Preset durations plus the current value when it is not one of them, ascending. */
export function durationOptions(presets: number[], current: number): number[] {
  return presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
}

/** What the check looks at: "https://… ", "db.lan:5432 · TLS", "MX example.com @1.1.1.1", "every 1 day, 1 h grace". */
export function targetText(c: Pick<Check, 'kind' | 'target' | 'interval_s' | 'grace_s' | 'options'>): string {
  const o = c.options ?? {};
  switch (c.kind) {
    case 'tcp':
      return o.tls ? `${c.target} · TLS` : c.target;
    case 'dns':
      return `${o.dns_type || 'A'} ${c.target}${o.dns_server ? ` @${o.dns_server}` : ''}`;
    case 'heartbeat':
      return c.grace_s ? t('every {period}, {grace} grace', { period: formatSeconds(c.interval_s), grace: formatSeconds(c.grace_s) }) : t('every {period}', { period: formatSeconds(c.interval_s) });
    default:
      return c.target;
  }
}

export const KIND_LABEL: Record<CheckKind, string> = { http: 'HTTP', tcp: 'TCP', ping: 'Ping', dns: 'DNS', heartbeat: 'Heartbeat' };

export const STATUS: Record<CheckStatus, { label: string; color: string }> = {
  up: { label: t('Up'), color: 'var(--good)' },
  down: { label: t('Down'), color: 'var(--critical)' },
  pending: { label: t('Waiting for a result'), color: 'var(--info)' },
  disabled: { label: t('Paused'), color: 'var(--muted)' },
};

/** Down first, then waiting, up and paused; by name within. */
export function sortChecks(list: readonly Check[]): Check[] {
  const rank: Record<CheckStatus, number> = { down: 0, pending: 1, up: 2, disabled: 3 };
  return [...list].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

/** "99.9%" (one decimal below 100). */
export function formatUptime(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 100 ? '100%' : `${v.toFixed(1)}%`;
}

/** Ping URL lines for a cron job. */
export function pingExamples(url: string): string {
  const c = `curl -fsS -m 10 --retry 3`;
  return `${c} ${url}\n${c} ${url}/start\n${c} ${url}/$?`;
}
