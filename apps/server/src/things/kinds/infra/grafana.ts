/**
 * Grafana's page (service-dashboards.md SD-46): which alerts fire and which are about to, whether its data sources work,
 * its version, and the dashboards starred by the account Whombat uses. Read only, with the service account's token:
 * `/api/health`, the alert instances of Grafana's own Alertmanager (`/api/alertmanager/grafana/api/v2/alerts`), the
 * rules' states (`/api/prometheus/grafana/api/v1/rules`), `/api/datasources` and each one's health (at most 12, kept 5
 * minutes; a plugin without a health check is “can’t be checked”, not failing), `/api/search?starred=true`. Its page is
 * in slots (docs/decisions/service-slots.md): what fires now, what it holds, and how often an alert started firing each
 * day of the last week, from its alert state history (`/api/annotations?type=alert`, the default history Grafana keeps)
 * and its dashboards' count, both kept 10 minutes.
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPageBar,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { shortHash } from '../../quiet/items';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, line, list, num, plural, rec, span, str, thousands } from '../../words';
import { cachedRead, getJson } from '../read';
import type { KindModule } from '../registry';
import { seenFromView } from '../registry';
import {
  countByDay,
  countLine,
  dayKey,
  inventory,
  lastDays,
  liveRows,
  slotPanels,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  badgeOf,
  dotLines,
  idOf,
  itemLines,
  linesSeen,
  okStatus,
  optional,
  readAnswer,
  serviceUrl,
  snapshotReader,
  uniqueById,
  unreadView,
  worstFirst,
} from './shared';

const NAME = 'Grafana';
/** Data sources whose health one read asks for (SD-S05), and how long each answer is kept. */
export const HEALTH_MAX = 12;
const HEALTH_CACHE_MS = 5 * 60_000;
/** The alert state history and the dashboards' count change slowly: read again after 10 minutes. */
const WEEK_CACHE_MS = 10 * 60_000;
/** Two weeks of alert state changes: this week's days and the week before for the change. */
const HISTORY_DAYS = 14;
/** State changes one read asks for; a fuller answer leaves its oldest days unknown. */
export const HISTORY_MAX = 1000;
const DAY = 86_400_000;
const SEVERE = new Set(['critical', 'crit', 'emergency', 'page', 'p1', 'disaster']);
/** Severities that only inform (catalogue-infra-media.md): a heads-up. */
const CALM = new Set(['info', 'none', 'informational']);
/** Grafana's own alerts about a data source without data or with an error: typical noise, a heads-up (QN-04). */
const DATASOURCE_ALERTS = new Set(['DatasourceNoData', 'DatasourceError']);

export interface GrafanaAlert {
  id: string;
  /** Its rule's uid (`__alert_rule_uid__`): one line per rule, whatever the instances. */
  rule?: string | null;
  /** Information only: severity info or none, or Grafana's own no-data and error alerts. */
  calm?: boolean;
  name: string;
  folder: string | null;
  summary: string | null;
  critical: boolean;
  since: Date | null;
  /** Its page in Grafana. */
  url: string | null;
}

export type SourceHealth = 'ok' | 'failing' | 'unknown';

export interface GrafanaSource {
  uid: string;
  name: string;
  type: string;
  health: SourceHealth;
  message: string | null;
}

export interface GrafanaSnapshot {
  readAt: Date;
  version: string | null;
  database: string | null;
  /** Firing now (not silenced); null when the alerts couldn't be read. */
  firing: GrafanaAlert[] | null;
  silenced: number;
  /** Rules about to fire; null when the rules couldn't be read. */
  pending: { name: string; folder: string | null }[] | null;
  rules: number | null;
  /** Rules Grafana can't evaluate (`health: error`). */
  ruleErrors?: number;
  /** Null when the token may not list them (a Viewer in recent versions). */
  sources: GrafanaSource[] | null;
  starred: { uid: string; title: string; folder: string | null; url: string | null }[] | null;
  /** How many dashboards the account sees; null when not read. */
  dashboards?: number | null;
  /** The alert state history of the last two weeks; null when it couldn't be read. */
  history?: GrafanaHistory | null;
}

/** When an alert started firing, from Grafana's alert state history. */
export interface GrafanaHistory {
  /** Each change into Alerting (from Normal or Pending), the newest first. */
  firings: Date[];
  /** How many changes of any kind the answer had: none at all means Grafana may keep its history elsewhere. */
  changes: number;
  /** The oldest change in the answer. */
  oldest: Date | null;
  /** The answer had as many as were asked for: days before its oldest change are unknown. */
  full: boolean;
}

const dateOf = (v: unknown): Date | null => {
  const t = Date.parse(str(v) ?? '');
  return Number.isFinite(t) && t > 0 ? new Date(t) : null;
};

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;

/**
 * A page of Grafana for the browser: Grafana's own link unless it names this machine (`root_url` left at
 * `http://localhost:3000/`), then the same path on the connection's address.
 */
export function grafanaLink(raw: string | null, base: string, fallbackPath: string | null): string | null {
  if (raw) {
    try {
      const u = new URL(raw);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !LOCAL.test(u.hostname)) return u.toString();
      return `${base}${u.pathname}${u.search}`.slice(0, 500);
    } catch {
      // A relative link: on the connection's address.
      if (raw.startsWith('/')) return `${base}${raw}`.slice(0, 500);
    }
  }
  return fallbackPath ? `${base}${fallbackPath}`.slice(0, 500) : null;
}

/** `/api/alertmanager/grafana/api/v2/alerts`: the active ones, and how many are silenced. */
export function parseAlerts(body: unknown, base: string): { firing: GrafanaAlert[]; silenced: number } {
  const firing: GrafanaAlert[] = [];
  let silenced = 0;
  for (const raw of list(body).slice(0, 500)) {
    const a = rec(raw);
    const state = str(rec(a.status).state) ?? 'active';
    if (state === 'suppressed') {
      silenced++;
      continue;
    }
    if (state !== 'active') continue;
    const labels = rec(a.labels);
    const annotations = rec(a.annotations);
    const rule = str(labels.__alert_rule_uid__);
    const name = str(labels.alertname) ?? 'An alert';
    firing.push({
      id: (str(a.fingerprint) ?? `${rule ?? name}-${firing.length}`).slice(0, 100),
      rule: rule ? rule.slice(0, 100) : null,
      calm: CALM.has((str(labels.severity) ?? '').toLowerCase()) || DATASOURCE_ALERTS.has(name),
      name: clip(name, 120),
      folder: str(labels.grafana_folder),
      summary: str(annotations.summary) ?? str(annotations.description),
      critical: SEVERE.has((str(labels.severity) ?? '').toLowerCase()),
      since: dateOf(a.startsAt),
      url: grafanaLink(
        str(a.generatorURL),
        base,
        rule ? `/alerting/grafana/${encodeURIComponent(rule)}/view` : null,
      ),
    });
  }
  firing.sort(
    (a, b) =>
      Number(b.critical) - Number(a.critical) || (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0),
  );
  return { firing, silenced };
}

/** `/api/prometheus/grafana/api/v1/rules`: the alerting rules about to fire, and how many rules there are. */
export function parseRules(body: unknown): {
  pending: { name: string; folder: string | null }[];
  rules: number;
  errors: number;
} {
  const pending: { name: string; folder: string | null }[] = [];
  let rules = 0;
  let errors = 0;
  for (const g of list(rec(rec(body).data).groups).slice(0, 500)) {
    const group = rec(g);
    for (const r of list(group.rules).slice(0, 500)) {
      const rule = rec(r);
      if (str(rule.type) && str(rule.type) !== 'alerting') continue;
      rules++;
      if (str(rule.health)?.toLowerCase() === 'error') errors++;
      if (str(rule.state)?.toLowerCase() === 'pending')
        pending.push({ name: clip(str(rule.name) ?? 'A rule', 120), folder: str(group.file) });
    }
  }
  return { pending, rules, errors };
}

/**
 * `/api/annotations?type=alert`: Grafana's alert state history (each change of an alert's state, “Normal” →
 * “Alerting”). A firing is a change into Alerting (“Alerting”, “Alerting (NoData)”) from a state that wasn't.
 */
export function parseHistory(body: unknown, asked = HISTORY_MAX): GrafanaHistory {
  const firings: Date[] = [];
  let oldest: Date | null = null;
  const all = list(body);
  for (const raw of all.slice(0, asked)) {
    const a = rec(raw);
    const t = num(a.time);
    if (t === null || t <= 0) continue;
    const at = new Date(t);
    if (!oldest || at < oldest) oldest = at;
    const into = (str(a.newState) ?? '').toLowerCase();
    const from = (str(a.prevState) ?? '').toLowerCase();
    if (into.startsWith('alerting') && !from.startsWith('alerting')) firings.push(at);
  }
  firings.sort((a, b) => b.getTime() - a.getTime());
  return { firings, changes: all.length, oldest, full: all.length >= asked };
}

/** `/api/datasources/uid/{uid}/health`: OK, an error, or a plugin that has no check (SD-46: not failing). */
export function sourceHealth(
  status: number,
  body: unknown,
): { health: SourceHealth; message: string | null } {
  const b = rec(body);
  const said = str(b.status)?.toUpperCase();
  const message = str(b.message) ? clip(str(b.message) as string, 160) : null;
  if (status === 200 && said === 'OK') return { health: 'ok', message };
  if ((status === 200 || status === 400) && said === 'ERROR') return { health: 'failing', message };
  return { health: 'unknown', message: null };
}

export function parseSources(body: unknown): Omit<GrafanaSource, 'health' | 'message'>[] {
  return list(body)
    .slice(0, 200)
    .map((raw) => {
      const d = rec(raw);
      const uid = str(d.uid);
      return uid
        ? {
            uid: uid.slice(0, 100),
            name: clip(str(d.name) ?? uid, 80),
            type: clip(str(d.typeName) ?? str(d.type) ?? '', 40),
          }
        : null;
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
}

export function parseStarred(body: unknown, base: string): NonNullable<GrafanaSnapshot['starred']> {
  return list(body)
    .slice(0, 50)
    .map((raw) => {
      const d = rec(raw);
      const uid = str(d.uid);
      if (!uid || (str(d.type) && str(d.type) !== 'dash-db')) return null;
      return {
        uid: uid.slice(0, 100),
        title: clip(str(d.title) ?? uid, 120),
        folder: str(d.folderTitle),
        url: grafanaLink(str(d.url), base, null),
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
}

async function healthOf(services: Services, row: CatalogConnectionRow, uid: string) {
  return cachedRead(
    services,
    `grafana-ds:${row.id}:${uid}`,
    row,
    async () => {
      const a = await readAnswer(
        services,
        row,
        NAME,
        `/api/datasources/uid/${encodeURIComponent(uid)}/health`,
        {
          maxBytes: 64 * 1024,
        },
      );
      return sourceHealth(a.status, a.json);
    },
    HEALTH_CACHE_MS,
  ).catch(() => ({ health: 'unknown' as const, message: null }));
}

/** The last two weeks' alert state history and the dashboards' count, kept 10 minutes apart from the 30-second read. */
function weekRead(services: Services, row: CatalogConnectionRow, now: Date) {
  const get = (path: string, query?: Record<string, string>) => getJson(services, row, NAME, path, query);
  return cachedRead(
    services,
    `grafana-week:${row.id}`,
    row,
    async () => {
      const [history, dashboards] = await Promise.all([
        optional(
          get('/api/annotations', {
            type: 'alert',
            from: String(now.getTime() - HISTORY_DAYS * DAY),
            to: String(now.getTime()),
            limit: String(HISTORY_MAX),
          }),
        ),
        optional(get('/api/search', { type: 'dash-db', limit: '5000' })),
      ]);
      return {
        history: history === null ? null : parseHistory(history),
        dashboards: dashboards === null ? null : list(dashboards).length,
      };
    },
    WEEK_CACHE_MS,
  ).catch(() => ({ history: null, dashboards: null }));
}

export const grafanaReader = snapshotReader<GrafanaSnapshot>(NAME, 'grafana', async (services, row, now) => {
  const base = serviceUrl(row);
  const get = (path: string, query?: Record<string, string>) => getJson(services, row, NAME, path, query);
  const [health, alerts, rules, sources, starred, week] = await Promise.all([
    optional(get('/api/health')),
    optional(get('/api/alertmanager/grafana/api/v2/alerts')),
    optional(get('/api/prometheus/grafana/api/v1/rules')),
    optional(get('/api/datasources')),
    optional(get('/api/search', { starred: 'true', type: 'dash-db', limit: '20' })),
    weekRead(services, row, now),
  ]);
  // Nothing at all answered: the read failed (the reason from a required read).
  if (health === null && alerts === null && rules === null) await get('/api/health');
  const listed = sources ? parseSources(sources) : null;
  const checked = listed
    ? await Promise.all(
        listed.map(async (s, i) =>
          i < HEALTH_MAX
            ? { ...s, ...(await healthOf(services, row, s.uid)) }
            : { ...s, health: 'unknown' as const, message: null },
        ),
      )
    : null;
  const parsedAlerts = alerts ? parseAlerts(alerts, base) : null;
  const parsedRules = rules ? parseRules(rules) : null;
  return {
    readAt: now,
    version: str(rec(health).version)?.slice(0, 40) ?? null,
    database: str(rec(health).database),
    firing: parsedAlerts?.firing ?? null,
    silenced: parsedAlerts?.silenced ?? 0,
    pending: parsedRules?.pending ?? null,
    rules: parsedRules?.rules ?? null,
    ruleErrors: parsedRules?.errors ?? 0,
    sources: checked,
    starred: starred ? parseStarred(starred, base) : null,
    dashboards: week.dashboards,
    history: week.history,
  };
});

/* What it means ------------------------------------------------------------------------------------------------------- */

const failing = (s: GrafanaSnapshot) => (s.sources ?? []).filter((d) => d.health === 'failing');

export function grafanaKpis(s: GrafanaSnapshot): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  if (s.firing) {
    const critical = s.firing.filter((a) => a.critical).length;
    out.push({
      key: 'firing',
      label: 'Firing',
      value: String(s.firing.length),
      sub: s.firing.length
        ? critical
          ? `${critical} critical`
          : plural(new Set(s.firing.map((a) => a.name)).size, 'rule')
        : s.silenced
          ? `${s.silenced} silenced`
          : 'all quiet',
      ...(critical ? { tone: 'bad' as const } : s.firing.length ? { tone: 'warn' as const } : {}),
    });
  }
  if (s.pending)
    out.push({
      key: 'pending',
      label: 'Pending',
      value: String(s.pending.length),
      sub: s.pending.length ? 'about to fire' : 'none',
    });
  if (s.sources?.length) {
    const bad = failing(s).length;
    const unknown = s.sources.filter((d) => d.health === 'unknown').length;
    out.push({
      key: 'sources',
      label: 'Data sources',
      value: String(s.sources.length - bad),
      rest: `of ${s.sources.length}`,
      sub: bad ? `${bad} failing` : unknown ? `${unknown} can’t be checked` : 'all working',
      meter: (s.sources.length - bad) / s.sources.length,
      ...(bad ? { tone: 'warn' as const } : { color: 'green' as const }),
    });
  }
  if (s.version)
    out.push({
      key: 'version',
      label: 'Grafana',
      value: s.version,
      ...(s.database
        ? {
            sub: s.database === 'ok' ? 'database fine' : `database ${s.database}`,
            ...(s.database !== 'ok' ? { tone: 'bad' as const } : {}),
          }
        : {}),
    });
  return out;
}

function alertDetail(a: GrafanaAlert): string | undefined {
  const parts = [a.summary, a.folder].filter((x): x is string => !!x);
  return parts.length ? clip(parts.join(' · '), 200) : undefined;
}

/** Every check Grafana's page can raise (QN-15). */
export const GRAFANA_CHECKS: readonly KindCheck[] = [
  {
    check: 'grafana.database',
    name: 'Grafana’s database',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  { check: 'grafana.alert', name: 'Firing alerts', nature: 'problem', perItem: true, startsOn: true },
  {
    check: 'grafana.source',
    name: 'Data sources failing',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
];

/** What this read couldn't see (QN-11): a part that didn't answer, data sources past the first 12 checked. */
export function grafanaSkipped(s: GrafanaSnapshot): string[] {
  const out: string[] = [];
  if (!s.database) out.push('grafana.database');
  if (!s.firing) out.push('grafana.alert');
  if (!s.sources || s.sources.length > HEALTH_MAX) out.push('grafana.source');
  return out;
}

/** Firing alerts by rule (QN-03: Stop watching a rule), the worst first, then the oldest. */
function byRule(firing: readonly GrafanaAlert[]): GrafanaAlert[][] {
  const groups = new Map<string, GrafanaAlert[]>();
  for (const a of firing) {
    const key = a.rule ? `rule:${a.rule}` : `alert:${a.id}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.values()];
}

function alertLine(alerts: GrafanaAlert[], now: Date): KindNotice {
  const a = alerts[0] as GrafanaAlert;
  const critical = alerts.some((x) => x.critical);
  const calm = alerts.every((x) => x.calm);
  const oldest = alerts.reduce<Date | null>((o, x) => (x.since && (!o || x.since < o) ? x.since : o), null);
  const detail = [alerts.length > 1 ? `${alerts.length} of them` : null, alertDetail(a)]
    .filter((x): x is string => !!x)
    .join(' · ');
  return {
    id: idOf('alert', a.rule ?? a.id),
    tone: calm ? 'info' : critical ? 'bad' : 'warn',
    icon: 'warn',
    title: clip(`${a.name} is firing${oldest ? ` for ${span(now.getTime() - oldest.getTime())}` : ''}`, 120),
    ...(detail ? { detail: clip(detail, 200) } : {}),
    ...(calm
      ? a.url
        ? { link: { kind: 'url' as const, label: 'Open in Grafana', url: a.url } }
        : {}
      : {
          link: {
            kind: 'ask' as const,
            label: 'Look into it',
            question: clip(`Why is the Grafana alert “${a.name}” firing?`, 300),
          },
        }),
    nature: calm ? 'fyi' : 'problem',
    check: 'grafana.alert',
    subject: { id: clip(a.rule ? `rule:${a.rule}` : `alert:${a.id}`, 160), name: clip(a.name, 80) },
    // Each firing (an instance starting again, another instance) is new: the Ignore ends with it.
    episode: shortHash(alerts.map((x) => `${x.id}@${x.since?.toISOString() ?? ''}`)),
    ignore: { lifts: 'newer', words: 'Until this firing ends.' },
    badge: badgeOf(`${a.name} firing`),
  };
}

/** Worth a look (SD-46; quiet-notices.md QN-01…QN-04): its database, one line per firing rule and failing source. */
export function grafanaNotices(s: GrafanaSnapshot, base: string, now: Date): KindNotice[] {
  const out: KindNotice[] = [];
  if (s.database && s.database !== 'ok')
    out.push({
      id: 'database',
      tone: 'bad',
      icon: 'database',
      title: 'Grafana can’t reach its database',
      link: { kind: 'ask', label: 'Look into it', question: 'Why can’t Grafana reach its database?' },
      nature: 'problem',
      check: 'grafana.database',
      ignore: { lifts: 'fixed', words: 'Until it’s reachable again.' },
      badge: 'Database unreachable',
    });
  const alerts = worstFirst(byRule(s.firing ?? []).map((g) => alertLine(g, now)));
  out.push(
    ...itemLines(alerts, (rest) => ({
      id: 'alerts-more',
      title: `${plural(rest.length, 'more alert is', 'more alerts are')} firing`,
      detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
      link: { kind: 'url', label: 'Show them', url: `${base}/alerting/list` },
      badge: badgeOf(`${dotLines(alerts).length} alerts firing`),
    })),
  );
  const sources = failing(s).map(
    (d): KindNotice => ({
      id: idOf('source', d.uid),
      tone: 'warn',
      icon: 'plug',
      title: clip(`Data source failing: ${d.name}`, 120),
      ...(d.message ? { detail: d.message } : {}),
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: clip(`Why is the Grafana data source ${d.name} failing?`, 300),
      },
      nature: 'problem',
      check: 'grafana.source',
      subject: { id: clip(`source:${d.uid}`, 160), name: clip(d.name, 80) },
      ignore: { lifts: 'fixed', words: 'Until it works again.' },
      badge: badgeOf(`${d.name} failing`),
    }),
  );
  out.push(
    ...itemLines(sources, (rest) => ({
      id: 'source-more',
      title: `${plural(rest.length, 'more data source is', 'more data sources are')} failing`,
      detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
      link: { kind: 'url', label: 'Open them', url: `${base}/connections/datasources` },
    })),
  );
  return uniqueById(out);
}

/** The head when nothing is worth a look (QN-S30): what fires, if anything; the lines say what's wrong. */
export function grafanaStatus(s: GrafanaSnapshot): NonNullable<KindView['status']> {
  if (!s.firing) return okStatus('Answering');
  return okStatus(s.firing.length ? `${plural(s.firing.length, 'alert')} firing` : 'Nothing firing');
}

/** Firing now (Live): each firing alert, the worst first, then the rules about to fire. */
export function grafanaLive(s: GrafanaSnapshot, base: string, now: Date) {
  if (!s.firing && !s.pending) return null;
  const firing = s.firing ?? [];
  const pending = s.pending ?? [];
  const items: ThingGalleryItem[] = firing.slice(0, 40).map((a) => {
    const sub = alertDetail(a);
    return {
      id: a.id,
      title: clip(a.name, 120),
      ...(sub ? { sub: clip(sub, 120) } : {}),
      // A heads-up (severity info, Grafana's own no-data alerts) gets a quiet tag.
      badge: a.critical
        ? { text: 'Critical', tone: 'bad' as const }
        : { text: 'Firing', tone: 'warn' as const },
      ...(a.calm && !a.critical ? { paused: true } : {}),
      ...(a.since
        ? { at: a.since.toISOString(), noteEnd: `for ${span(now.getTime() - a.since.getTime())}` }
        : {}),
      ...(a.url ? { url: a.url } : {}),
    };
  });
  for (const [i, p] of pending.slice(0, 48 - items.length).entries())
    items.push({
      id: `pending-${i}`,
      title: clip(p.name, 120),
      ...(p.folder ? { sub: clip(p.folder, 120) } : {}),
      // Not firing yet: a quiet tag.
      badge: { text: 'About to fire', tone: 'warn' },
      paused: true,
    });
  const meta = [
    firing.length ? `${firing.length} firing` : null,
    pending.length ? `${pending.length} about to fire` : null,
    s.silenced ? `${s.silenced} silenced` : null,
  ].filter((x): x is string => !!x);
  return liveRows({
    id: 'firing',
    title: 'Firing now',
    // Alerts have no pictures: the row's square says the name's first letter.
    shape: 'square',
    ...(meta.length ? { meta: meta.join(' · ') } : {}),
    link: { kind: 'url', label: 'All alerts', url: `${base}/alerting/list` },
    items,
    empty: 'Nothing is firing.',
  });
}

/** In Grafana (Inventory): its alert rules, data sources, dashboards and what is silenced, each opening its page. */
export function grafanaInventory(s: GrafanaSnapshot, base: string) {
  const lines: ThingPageItem[] = [];
  if (s.rules !== null) {
    const firing = s.firing ? new Set(s.firing.map((a) => a.rule ?? a.id)).size : 0;
    const errors = s.ruleErrors ?? 0;
    lines.push(
      countLine({
        id: 'rules',
        title: 'Alert rules',
        icon: 'shield',
        value: thousands(s.rules),
        ...(firing
          ? { note: `${firing} firing`, noteTone: 'warn' as const }
          : errors
            ? { note: `${errors} can’t run`, noteTone: 'warn' as const }
            : s.firing
              ? { note: 'All quiet' }
              : {}),
        ...(errors && firing ? { detail: plural(errors, 'rule can’t run', 'rules can’t run') } : {}),
        url: `${base}/alerting/list`,
      }),
    );
  }
  if (s.sources?.length) {
    const bad = failing(s).length;
    const unknown = s.sources.filter((d) => d.health === 'unknown').length;
    lines.push(
      countLine({
        id: 'sources',
        title: 'Data sources',
        icon: 'database',
        value: thousands(s.sources.length),
        ...(bad
          ? { note: `${bad} failing`, noteTone: 'warn' as const }
          : unknown
            ? { note: `${unknown} can’t be checked` }
            : { note: 'All working', noteTone: 'ok' as const }),
        url: `${base}/connections/datasources`,
      }),
    );
  }
  if (s.dashboards != null)
    lines.push(
      countLine({
        id: 'dashboards',
        title: 'Dashboards',
        icon: 'info',
        value: thousands(s.dashboards),
        ...(s.starred?.length ? { note: `${s.starred.length} starred` } : {}),
        url: `${base}/dashboards`,
      }),
    );
  if (s.silenced)
    lines.push(
      countLine({
        id: 'silenced',
        title: 'Silenced',
        icon: 'clock',
        value: thousands(s.silenced),
        url: `${base}/alerting/silences`,
      }),
    );
  if (!lines.length) return null;
  return inventory({ id: 'inventory', title: 'In Grafana', items: lines });
}

/**
 * Alerts this week (Trend): how often an alert started firing each day of the last 7, from Grafana's alert state
 * history, with the change on the week before once the history reaches back that far. Left out without any state
 * change in two weeks (Grafana may keep its history elsewhere, then none is no answer). Pure.
 */
export function grafanaWeek(
  history: GrafanaHistory | null | undefined,
  now: Date,
  timeZone: string,
): ReturnType<typeof trend> | null {
  if (!history?.changes || !history.oldest) return null;
  const days = lastDays(now, timeZone);
  const counted = countByDay(history.firings, days.keys, timeZone);
  // A full answer says nothing about the days before its oldest change.
  const from = history.full ? dayKey(history.oldest, timeZone) : null;
  const values = days.keys.map((k, i) => (from && k < from ? null : (counted[i] ?? 0)));
  const total = values.reduce<number>((a, b) => a + (b ?? 0), 0);
  const first = days.at[0] as Date;
  const before = history.firings.filter(
    (d) => d.getTime() < first.getTime() && d.getTime() >= first.getTime() - 7 * DAY,
  ).length;
  // The week before is known when the history reaches into it and the answer wasn't cut short.
  const known = !history.full && history.oldest.getTime() < first.getTime() - 6 * DAY;
  return trend({
    id: 'week',
    title: 'Alerts this week',
    meta: 'Times an alert started firing',
    days,
    values,
    label: 'Firings',
    figure: total
      ? { value: thousands(total), rest: total === 1 ? 'firing this week' : 'firings this week' }
      : { value: 'None', rest: 'fired this week' },
    change: known ? weekChange(total, before) : null,
    color: 'red',
  });
}

/** Grafana's own lines in its machine card: its version, and whether it reaches its database. */
export function grafanaMachineLines(s: GrafanaSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version) out.push({ id: 'grafana-version', label: 'Grafana', value: clip(s.version, 40), pct: null });
  if (s.database)
    out.push({
      id: 'grafana-database',
      label: 'Database',
      pct: null,
      ...(s.database === 'ok' ? { value: 'Fine' } : { value: 'Can’t reach it', tone: 'bad' as const }),
    });
  return out;
}

/** Starred dashboards, below the slots. */
function starredPanel(s: GrafanaSnapshot, base: string): ThingPagePanel[] {
  if (!s.starred?.length) return [];
  return [
    {
      kind: 'list',
      id: 'starred',
      place: 'main',
      title: 'Starred dashboards',
      link: { kind: 'url', label: 'All dashboards', url: `${base}/dashboards` },
      items: s.starred.slice(0, 20).map((d) => ({
        id: d.uid,
        title: d.title,
        ...(d.folder ? { detail: d.folder } : {}),
        ...(d.url ? { url: d.url } : {}),
      })),
    },
  ];
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): what fires now beside what Grafana holds, then how often an
 * alert fired this week beside its machine; no shelf (dashboards have no pictures in Grafana OSS) and no people (a
 * Viewer's token can't see who uses it). Starred dashboards below.
 */
export function grafanaSlots(
  s: GrafanaSnapshot,
  base: string,
  now: Date,
  timeZone: string,
): Pick<KindView, 'panels' | 'slots'> {
  return slotPanels({
    live: grafanaLive(s, base, now),
    inventory: grafanaInventory(s, base),
    trend: grafanaWeek(s.history, now, timeZone),
    more: starredPanel(s, base),
    machine: grafanaMachineLines(s),
  });
}

export function grafanaFacts(s: GrafanaSnapshot): ThingLine[] {
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`Grafana **${s.version}**`));
  if (s.rules !== null) facts.push(line(`**${plural(s.rules, 'alert rule')}**`));
  return facts;
}

export interface GrafanaInput {
  snapshot: GrafanaSnapshot;
  url: string;
  now: Date;
  timeZone: string;
}

/** The page's Grafana part (SD-46), in slots; pure. */
export function grafanaView({ snapshot: s, url, now, timeZone }: GrafanaInput): KindView {
  return {
    // In slots its counts are in Firing now and In Grafana; the card keeps its figures (`grafanaKpis` in `seen`).
    kpis: [],
    machine: 'after',
    charts: [],
    notices: grafanaNotices(s, url, now),
    ...grafanaSlots(s, url, now, timeZone),
    tabs: [],
    facts: grafanaFacts(s),
    status: grafanaStatus(s),
    open: { label: 'Open Grafana', url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Alerts this week', 'A dashboard’s panels', 'Data source errors'],
  };
}

export async function grafanaPage(ctx: KindCtx): Promise<KindView> {
  const url = serviceUrl(ctx.row);
  const read = await grafanaReader.latest(ctx.services, ctx.row, ctx.now);
  if (!read.ok) return unreadView(read, NAME, { label: 'Open Grafana', url }, []);
  return {
    ...grafanaView({ snapshot: read.value, url, now: ctx.now, timeZone: ctx.timeZone }),
    refreshing: read.refreshing,
  };
}

export const GRAFANA_KIND: KindModule = {
  page: grafanaPage,
  seen: async (services, row, now, timeZone) => {
    const s = await grafanaReader.cached(services, row, now);
    const view = grafanaView({ snapshot: s, url: serviceUrl(row), now, timeZone });
    return {
      // The page has no row of figures; the card keeps Firing.
      glance: seenFromView(
        { kpis: grafanaKpis(s), notices: view.notices },
        { figures: 1, ...(s.version ? { line: `Grafana ${s.version}` } : {}) },
      ),
      points: {},
      tracked: { version: s.version ?? null },
      ...linesSeen(view, grafanaSkipped(s)),
    };
  },
  checks: GRAFANA_CHECKS,
};
