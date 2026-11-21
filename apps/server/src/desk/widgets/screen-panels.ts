/**
 * Widgets a page doesn't have as a panel, made from what the page shows (`PanelHint.from`, docs/decisions/
 * service-dashboards.md “Service widgets”): a calm line with only what's late, today's figures from a chart, tonight's
 * episodes from the week's. Each is made only where the page has what it needs, so only a connection with the data
 * offers it. Pure: a page in, a panel out (or null).
 *
 * A made list's big line travels as its `meta` (`ownHead` reads it back), so the line and the rows come from one pass.
 */
import type { ThingPage, ThingPageCell, ThingPageItem, ThingPageKpi, ThingPageRow } from '@whombat/core';
import { startOfLocalDay } from '../../home/time';
import { plural, thousands } from '../../things/words';
import { headFigures, type Panel, type PanelsAt, pagePanels } from './thing-views';

type PanelOf<K extends Panel['kind']> = Extract<Panel, { kind: K }>;

function panelOf<K extends Panel['kind']>(page: ThingPage, id: string, kind: K): PanelOf<K> | null {
  const p = pagePanels(page).find((x) => x.id === id);
  return p?.kind === kind ? (p as PanelOf<K>) : null;
}

/** The big line a made list carries as its `meta`. */
export const ownHead = (_page: ThingPage, p: Panel | null): string | null =>
  p && 'meta' in p ? (p.meta ?? null) : null;

const sameDay = (a: Date, b: Date, timeZone: string) => {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  return day(a) === day(b);
};

/* Ads kept out today (Pi-hole, AdGuard Home) ------------------------------------------------------------------------ */

/**
 * What was blocked since midnight, from the page's lookups per hour, its share of the lookups and a small line by the
 * hour; red with the page's own words while blocking is off. Null without the hourly chart (AdGuard counting by days).
 */
export function adsKeptOut(page: ThingPage, at: PanelsAt): Panel | null {
  const chart = panelOf(page, 'queries', 'chart');
  const blocked = chart?.series.find((s) => s.key === 'blocked');
  const allowed = chart?.series.find((s) => s.key === 'allowed');
  if (!chart || !blocked || !allowed) return null;
  const start = startOfLocalDay(at.now, at.timeZone).getTime();
  const today = chart.timestamps.flatMap((t, i) => (Date.parse(t) >= start ? [i] : []));
  const kept = today.map((i) => blocked.values[i] ?? 0);
  const all = today.reduce((n, i) => n + (blocked.values[i] ?? 0) + (allowed.values[i] ?? 0), 0);
  const total = kept.reduce((n, v) => n + v, 0);
  const off = headFigures(page).find((k) => k.key === 'blocked' && k.tone);
  const kpis: ThingPageKpi[] = [
    {
      key: 'kept',
      label: 'Kept out today',
      value: thousands(total),
      rest: 'blocked',
      sub:
        off?.sub ||
        (all ? `${Math.round((total / all) * 100)} % of ${thousands(all)} lookups` : 'No lookups yet today'),
      ...(off ? { tone: 'bad' as const } : {}),
      ...(kept.length >= 2 ? { spark: kept } : {}),
      color: 'orange',
    },
  ];
  return { kind: 'kpis', id: 'kept-out', items: kpis };
}

/* Weather (Home Assistant) ----------------------------------------------------------------------------------------- */

/**
 * The weather as figures, from the page's Weather list (now, then today and the next two days): the temperature now
 * large with its unit, the condition as its label and line; each day's highest and lowest.
 */
export function weatherFigures(page: ThingPage): Panel | null {
  const list = panelOf(page, 'forecast', 'list');
  const [now, ...days] = list?.items ?? [];
  if (!now?.right) return null;
  const [value, ...unit] = now.right.split(' ');
  const items: ThingPageKpi[] = [
    {
      key: 'now',
      label: now.title.slice(0, 30),
      value: value || now.right,
      ...(unit.length ? { rest: unit.join(' ') } : {}),
      sub: [now.title, now.detail?.toLowerCase()].filter(Boolean).join(' · ').slice(0, 80),
    },
    ...days.flatMap((d): ThingPageKpi[] =>
      d.right
        ? [
            {
              key: d.id.slice(0, 40),
              label: d.title.slice(0, 30),
              value: d.right,
              ...(d.detail ? { sub: d.detail.slice(0, 80) } : {}),
            },
          ]
        : [],
    ),
  ];
  return { kind: 'kpis', id: 'weather', items: items.slice(0, 4) };
}

/* Tonight on TV (Sonarr) -------------------------------------------------------------------------------------------- */

/** “S03E05” → “S3 E5”. */
const episode = (code: string) => {
  const m = /^S(\d+)E(\d+)$/.exec(code);
  return m ? `S${Number(m[1])} E${Number(m[2])}` : code;
};

/**
 * Today's episodes from the page's Coming up, by when they air: the series, the episode, and whether it's in (“Ready”),
 * still to come, or aired and not in yet. Its big line: “3 tonight · 1 ready”.
 */
export function tonightOnTv(page: ThingPage, at: PanelsAt): Panel | null {
  const coming = panelOf(page, 'upcoming', 'gallery');
  if (!coming) return null;
  const items: ThingPageItem[] = coming.items.flatMap((i) => {
    const when = i.at ? new Date(i.at) : null;
    if (!when || !Number.isFinite(when.getTime()) || !sameDay(when, at.now, at.timeZone)) return [];
    const code = (i.sub ?? '').split(' · ')[0] ?? '';
    const ready = i.badge?.tone === 'ok';
    const aired = when.getTime() <= at.now.getTime();
    return [
      {
        id: i.id,
        title: i.title,
        detail: [episode(code), i.note].filter(Boolean).join(' · ').slice(0, 300),
        at: when.toISOString(),
        right: ready ? 'Ready' : aired ? 'Not in yet' : 'Coming',
        ...(ready ? { tone: 'ok' as const } : aired ? { tone: 'warn' as const } : {}),
      },
    ];
  });
  const ready = items.filter((i) => i.tone === 'ok').length;
  return {
    kind: 'list',
    id: 'tonight',
    title: 'Tonight on TV',
    ...(items.length ? { meta: `${items.length} tonight${ready ? ` · ${ready} ready` : ''}` } : {}),
    items,
    empty: 'Nothing on tonight.',
  };
}

/* All backed up (Proxmox Backup Server, Synology Hyper Backup, TrueNAS) ---------------------------------------------- */

const cellText = (c: ThingPageCell | undefined) => c?.text ?? '';

/** “All 12 guests backed up”, “10 of 12 guests backed up”, “The guest is backed up”. */
function standing(good: number, all: number, one: string, many: string, done: string): string {
  if (good === all) return all === 1 ? `The ${one} is ${done}` : `All ${all} ${many} ${done}`;
  return `${good} of ${plural(all, one, many)} ${done}`;
}

function backedUp(meta: string, items: ThingPageItem[]): Panel {
  return { kind: 'list', id: 'backed-up', title: 'All backed up', meta, items, empty: 'Nothing is late.' };
}

/** Proxmox Backup Server: guests whose last backup is late or damaged, and jobs that failed (its Jobs list's red lines). */
export function pbsBackedUp(page: ThingPage): Panel | null {
  const guests = panelOf(page, 'guests', 'table');
  if (!guests) return null;
  const counted = guests.rows.filter((r) => r.cells.last?.dot === 'ok' || r.cells.last?.dot === 'bad');
  const late = counted.filter((r) => r.cells.last?.dot === 'bad');
  const items: ThingPageItem[] = [
    ...late.map((r) => ({
      id: r.id,
      title: cellText(r.cells.guest),
      detail: `Last backup ${cellText(r.cells.last)}`,
      tone: 'bad' as const,
    })),
    ...guests.rows
      .filter((r) => r.cells.verified?.dot === 'bad')
      .map((r) => ({
        id: `${r.id}:damaged`.slice(0, 200),
        title: cellText(r.cells.guest),
        detail: 'Damage found in its backups',
        tone: 'bad' as const,
      })),
    ...(panelOf(page, 'jobs', 'list')?.items ?? [])
      .filter((i) => i.tone === 'bad')
      .map((i) => ({
        id: `job:${i.id}`.slice(0, 200),
        title: i.title,
        // “Failed · 3 h ago”: when it runs next stays on the page.
        ...(i.detail ? { detail: i.detail.split(' · ').slice(0, 2).join(' · ') } : {}),
        tone: 'bad' as const,
      })),
  ].filter((i) => i.title);
  if (!counted.length) return null;
  return backedUp(
    standing(counted.length - late.length, counted.length, 'guest', 'guests', 'backed up'),
    items,
  );
}

/**
 * Synology's Hyper Backup tasks (the page's Live rows): the late and failed ones, by their tag; a task that never ran and
 * the storage work running now aren't counted.
 */
export function synologyBackedUp(page: ThingPage): Panel | null {
  const live = panelOf(page, 'backups', 'gallery');
  const counted = (live?.items ?? []).filter((i) => i.id.startsWith('task-') && i.note !== 'Never ran');
  if (!counted.length) return null;
  const wrong = counted.filter((i) => i.badge?.tone === 'warn' || i.badge?.tone === 'bad');
  return backedUp(
    standing(counted.length - wrong.length, counted.length, 'backup', 'backups', 'OK'),
    wrong.map((i) => ({
      id: i.id,
      title: i.title,
      detail: [i.badge?.text, i.note].filter(Boolean).join(' · '),
      tone: i.badge?.tone === 'bad' ? ('bad' as const) : ('warn' as const),
    })),
  );
}

/** TrueNAS's data protection tasks (snapshots, replication, cloud sync and backup): the failed and stopped ones. */
export function truenasBackedUp(page: ThingPage): Panel | null {
  const tasks = panelOf(page, 'tasks', 'list');
  if (!tasks?.items.length) return null;
  const wrong = tasks.items.filter((i) => i.tone === 'bad' || i.detail?.startsWith('Stopped'));
  return backedUp(
    standing(tasks.items.length - wrong.length, tasks.items.length, 'task', 'tasks', 'OK'),
    wrong.map((i) => ({
      id: i.id,
      title: i.title,
      // “Failed 6 h ago”: TrueNAS's own error stays on the page.
      ...(i.detail ? { detail: i.detail.split(' · ')[0] } : {}),
      tone: i.tone === 'bad' ? ('bad' as const) : ('warn' as const),
    })),
  );
}

/* Today vs last week (Mollie) --------------------------------------------------------------------------------------- */

const lineWords = (l: readonly { text: string }[] | undefined) => (l ?? []).map((p) => p.text).join('');

/**
 * What came in today against the same weekday last week by this time, from the page's Today by the hour: “€ 1,240”
 * paid today, its line “€ 860 last Tuesday by now” (one figure, so every size keeps the line).
 */
export function todayVsLastWeek(page: ThingPage): Panel | null {
  const chart = panelOf(page, 'today', 'chart');
  const today = chart?.series.find((s) => s.key === 'today');
  if (!chart?.figure || !today || !chart.series.some((s) => s.key === 'week')) return null;
  const spark = today.values.filter((v): v is number => v !== null);
  // The more or less stays on the chart: with it the line is cut on every size.
  const line = lineWords(chart.stats?.[0]);
  return {
    kind: 'kpis',
    id: 'today-vs-week',
    items: [
      {
        key: 'today',
        label: 'Paid today',
        value: chart.figure.value,
        ...(line ? { sub: line.slice(0, 80) } : {}),
        ...(spark.length >= 2 ? { spark } : {}),
        color: 'green',
      },
    ],
  };
}

/* Waiting for your review (GitLab, Forgejo) ---------------------------------------------------------------------- */

/**
 * The merge or pull requests waiting for the person's review, without the failing branches Waiting for you starts with;
 * its big line “2 to review”. Made from the page's Waiting for you; null without it.
 */
export function gitReviews(page: ThingPage): Panel | null {
  const waiting = panelOf(page, 'waiting', 'list');
  if (!waiting) return null;
  const items = waiting.items.filter((i) => i.id.startsWith('review-'));
  const total = /(\d[\d,]*) to review/.exec(waiting.meta ?? '')?.[1];
  return {
    kind: 'list',
    id: 'reviews',
    title: 'Waiting for your review',
    ...(total ? { meta: `${total} to review` } : {}),
    items,
    empty: 'Nothing waits for your review.',
  };
}

/* Builds (GitHub Actions) ------------------------------------------------------------------------------------------ */

/** A cell's words, or nothing for one that says there's nothing (“—”). */
const said = (c: ThingPageCell | undefined) => {
  const t = cellText(c).trim();
  return t && t !== '—' ? t : '';
};

/** “Today 08:28” in a sentence: “today 08:28” (a date stays as it is). */
const inSentence = (t: string) =>
  /^(Today|Yesterday) /.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;

/**
 * What runs now and how the default branch stands, in one widget: each run with its branch, runner and step and how
 * long it has left as its bar, then each workflow failing on the default branch, then those that pass; its big line
 * “Main checks failing · 1 running”, “All pass on main”. Made from the page's Running now (its live rows) and Last
 * runs; null without them.
 */
export function actionsBuilds(page: ThingPage): Panel | null {
  const running = panelOf(page, 'running', 'gallery');
  const latest = panelOf(page, 'latest', 'table');
  if (!running || !latest) return null;
  const branch = latest.title.replace(/^Last runs on /, '');
  // A run that has started says how long it has run; one that waits for a runner doesn't yet.
  const busy = running.items.filter((i) => i.note);
  const waiting = running.items.length - busy.length;
  const failing = latest.rows.filter((r) => r.cells.result?.dot === 'bad');
  const rows: ThingPageRow[] = [
    ...running.items.map((i) => ({
      id: `run:${i.id}`.slice(0, 200),
      cells: {
        what: { text: i.title },
        where: { text: i.sub || '—' },
        state: {
          text: i.noteEnd || '—',
          ...(i.progress !== undefined ? { meter: i.progress } : {}),
          // A run taking longer than usual is amber; one waiting says so in its words.
          ...(i.note && i.badge ? { tone: 'warn' as const } : {}),
        },
      },
    })),
    ...[...failing, ...latest.rows.filter((r) => r.cells.result?.dot !== 'bad')].map((r) => ({
      id: `last:${r.id}`.slice(0, 200),
      cells: {
        what: {
          text: cellText(r.cells.workflow),
          ...(r.cells.workflow?.note ? { note: r.cells.workflow.note } : {}),
          ...(r.cells.result?.dot ? { dot: r.cells.result.dot } : {}),
        },
        where: {
          text: [said(r.cells.result), inSentence(said(r.cells.when))].filter(Boolean).join(' ') || '—',
        },
        state: { text: said(r.cells.took) || '—' },
      },
    })),
  ];
  // What fails first: on a narrow widget the line is cut at its end.
  const head = [
    failing.length === 1
      ? `${cellText(failing[0]?.cells.workflow)} failing`
      : failing.length
        ? `${failing.length} failing on ${branch}`
        : latest.rows.length
          ? `All pass on ${branch}`
          : '',
    busy.length ? `${busy.length} running` : '',
    waiting ? `${waiting} waiting` : '',
  ].filter(Boolean);
  return {
    kind: 'table',
    id: 'builds',
    title: 'Builds',
    meta: (head.join(' · ') || 'Nothing running').slice(0, 120),
    columns: [
      { key: 'what', label: 'Workflow' },
      { key: 'where', label: 'Where' },
      { key: 'state', label: '', numeric: true },
    ],
    rows: rows.slice(0, 12),
    empty: 'Nothing ran yet.',
  };
}

/* Every repository (GitHub Actions) ---------------------------------------------------------------------------------- */

/**
 * Each repository and how its default branch stands, for a board: red with how many workflows fail there, green when
 * they pass, grey when none finished; its big line “1 of 4 failing”, “All 4 pass”. Made from the page's Last runs, whose
 * rows name their repository when it watches more than one; null for one repository (Last runs says it all then).
 */
export function actionsRepos(page: ThingPage): Panel | null {
  const latest = panelOf(page, 'latest', 'table');
  if (!latest) return null;
  const repos = new Map<string, { failing: number; passing: number }>();
  for (const r of latest.rows) {
    const repo = r.cells.workflow?.note;
    if (!repo) continue;
    const seen = repos.get(repo) ?? { failing: 0, passing: 0 };
    if (r.cells.result?.dot === 'bad') seen.failing++;
    else if (r.cells.result?.dot === 'ok') seen.passing++;
    repos.set(repo, seen);
  }
  if (repos.size < 2) return null;
  const items: ThingPageItem[] = [...repos].map(([repo, n]) => ({
    id: `repo:${repo}`.slice(0, 200),
    title: repo,
    ...(n.failing
      ? { tone: 'bad' as const, right: `${n.failing} failing` }
      : n.passing
        ? { tone: 'ok' as const, right: 'Passing' }
        : { right: 'No result' }),
  }));
  const failing = items.filter((i) => i.tone === 'bad').length;
  return {
    kind: 'list',
    id: 'repositories',
    title: 'Every repository',
    meta: failing ? `${failing} of ${items.length} failing` : `All ${items.length} pass`,
    items,
  };
}

/* Coding agents (T3 Code) ------------------------------------------------------------------------------------------- */

/**
 * The coding agents at a glance, fine for a passer-by: its big line “2 waiting for you · 2 working · 2 done today”,
 * waiting first because a narrow widget cuts the end, then each project with something going on (“2 waiting for you”,
 * “1 working”). No thread's title: that is the person's work. Made from the page's Your coding agents (a thread that
 * waits for the person carries its tag), Finished today and Projects; null without Your coding agents.
 */
export function t3CodingAgents(page: ThingPage): Panel | null {
  const now = panelOf(page, 'now', 'gallery');
  if (!now) return null;
  const waiting = Math.max(t3Count(page, 'waiting') ?? 0, now.items.filter((i) => i.badge).length);
  const working = Math.max(t3Count(page, 'working') ?? 0, now.items.filter((i) => !i.badge).length);
  const today = headFigures(page).find((k) => k.key === 'f-finished-today');
  const done = Number.parseInt(today?.value ?? '', 10) || 0;
  const failed = /^\d+ failed$/.test(today?.sub ?? '') ? (today?.sub ?? '') : '';
  const big = [
    waiting ? `${waiting} waiting for you` : '',
    working ? `${working} working` : '',
    done ? `${today?.value} done today` : '',
    failed,
  ].filter(Boolean);
  const items: ThingPageItem[] = (panelOf(page, 'projects', 'list')?.items ?? []).flatMap((p) => {
    const [first, ...rest] = (p.detail ?? '').split(' · ').filter(Boolean);
    if (!first) return [];
    return [
      {
        id: p.id,
        title: p.title,
        right: first.slice(0, 40),
        ...(rest.length ? { detail: rest.join(' · ') } : {}),
        ...(p.tone ? { tone: p.tone } : {}),
      },
    ];
  });
  return {
    kind: 'list',
    id: 'agents',
    title: 'Coding agents',
    meta: (big.join(' · ') || 'Nothing is working').slice(0, 120),
    items: items.slice(0, 12),
    empty: 'Nothing is working.',
  };
}

/**
 * How many threads work or wait in all, from Your coding agents' line (“2 waiting for you · 12 working”): its rows are
 * only the first ten. Null when the line doesn't say (none, or a page without it).
 */
function t3Count(page: ThingPage, what: 'working' | 'waiting'): number | null {
  const meta = panelOf(page, 'now', 'gallery')?.meta ?? '';
  const m = meta.match(what === 'waiting' ? /(\d+) waiting for you/ : /(\d+) working/);
  return m ? Number(m[1]) : null;
}

/**
 * One half of Your coding agents as a list: the threads at work (with their project and model, how long, their state)
 * or those waiting for the person (with what they wait for, its tag on the right); its big line “2 working”, “2
 * threads”. The widgets a screen had before the page was in slots; null without Your coding agents.
 */
function t3Half(page: ThingPage, waits: boolean): Panel | null {
  const now = panelOf(page, 'now', 'gallery');
  if (!now) return null;
  const items: ThingPageItem[] = now.items
    .filter((i) => !!i.badge === waits)
    .map((i) => ({
      id: i.id,
      title: i.title,
      ...(i.sub ? { detail: i.sub } : {}),
      ...(waits
        ? { right: i.badge?.text, tone: i.badge?.tone }
        : i.note
          ? { right: i.note.replace(/^For /, '') }
          : {}),
    }));
  const n = Math.max(items.length, t3Count(page, waits ? 'waiting' : 'working') ?? 0);
  return {
    kind: 'list',
    id: waits ? 'waiting' : 'working',
    title: waits ? 'Waiting for you' : 'Working now',
    ...(n ? { meta: waits ? plural(n, 'thread') : `${n} working` } : {}),
    items,
    empty: waits ? 'Nothing waits for you.' : 'Nothing is working.',
  };
}

export const t3Working = (page: ThingPage) => t3Half(page, false);
export const t3Waiting = (page: ThingPage) => t3Half(page, true);
