/**
 * Reports to the Whombat Team in fixture mode (Whombat team-reports.md), over the real REST contract and kept in
 * memory: Mara's list, a report with its conversation, sending, replying, It works / Still happening / Withdraw, and an
 * assistant's draft (`draft_fixture_backups`). Off by default, so every other screen stays as drawn: the list then says
 * Mara isn't invited and has no reports, and nothing shows. `seeded` has five reports (one asks Mara something, one has
 * a fix to try, two are closed), `empty` none yet, `stale` the seeded list as the box's copy.
 */
import type { TeamReport, TeamReportMessage, TeamReportRow, TeamReportStatus } from '@whombat/core';
import { burrow } from '@whombat/fixtures';

export type TeamReportFixtureKind = 'off' | 'seeded' | 'empty' | 'stale';

/** The visual suite's and a person's switch: `localStorage['whombat:fixture-team-reports']`. */
export const TEAM_REPORTS_FIXTURE_KEY = 'whombat:fixture-team-reports';

const KINDS: readonly TeamReportFixtureKind[] = ['off', 'seeded', 'empty', 'stale'];

/** `option`, else `VITE_FIXTURE_TEAM_REPORTS`, else the switch in localStorage, else off. */
export function teamReportFixtureKind(option: TeamReportFixtureKind | undefined): TeamReportFixtureKind {
  if (option) return option;
  const env = import.meta.env.VITE_FIXTURE_TEAM_REPORTS;
  if (KINDS.includes(env as TeamReportFixtureKind)) return env as TeamReportFixtureKind;
  try {
    const kept = typeof localStorage === 'undefined' ? null : localStorage.getItem(TEAM_REPORTS_FIXTURE_KEY);
    if (KINDS.includes(kept as TeamReportFixtureKind)) return kept as TeamReportFixtureKind;
  } catch {
    // Storage may be shut: off.
  }
  return 'off';
}

const B = `/api/v1/burrows/${burrow.slug}`;
const SIGNED = '\n\nWhombat Team (AI assistant)';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const notFound = () => json({ error: { code: 'not_found', message: 'That report isn’t here.' } }, 404);

interface Kept {
  report: TeamReport;
  read: number;
}

function seed(now: number): Kept[] {
  const at = (hoursAgo: number) => Math.floor(now / 1000 - hoursAgo * 3600);
  const msg = (
    id: string,
    author: TeamReportMessage['author'],
    text: string,
    hoursAgo: number,
    status?: TeamReportStatus,
  ) => ({ id, author, text, at: at(hoursAgo), ...(status ? { status } : {}) }) as TeamReportMessage;
  const report = (
    n: number,
    over: Partial<TeamReport> & Pick<TeamReport, 'kind' | 'title' | 'status' | 'text'>,
    createdHoursAgo: number,
  ): TeamReport => {
    const messages = over.messages ?? [];
    const updated = messages.length ? Math.max(...messages.map((m) => m.at)) : at(createdHoursAgo);
    return {
      id: `tr_fixture${String(n).padStart(13, '0')}`,
      number: n,
      expected: '',
      context: { runtimeVersion: '0.304.0', channel: 'development', client: 'web', appVersion: '3.158.0' },
      createdAt: at(createdHoursAgo),
      updatedAt: updated,
      revision: messages.filter((m) => m.author === 'team').length,
      messages,
      ...over,
    };
  };
  const asks = report(
    14,
    {
      kind: 'bug',
      title: 'Backups page stays empty after restoring',
      status: 'needs_information',
      text: 'After I restored from my USB stick, the Backups page shows nothing. The backups still run at night.',
      expected: 'To see my backups, like before the restore.',
      messages: [
        msg('m14a', 'team', '', 26, 'investigating'),
        msg(
          'm14b',
          'team',
          `Thanks, we’re looking into it. Does the page stay empty after a reload, or only right after you open it?${SIGNED}`,
          3,
          'needs_information',
        ),
      ],
    },
    28,
  );
  const fix = report(
    12,
    {
      kind: 'bug',
      title: 'The phone app forgets dark mode',
      status: 'available',
      text: 'Every time I open the Android app it starts in light mode, even though I picked dark.',
      messages: [
        msg('m12a', 'team', '', 70, 'investigating'),
        msg('m12b', 'team', '', 50, 'in_progress'),
        msg(
          'm12c',
          'team',
          `A fix is in today’s update. Could you check that the app now keeps dark mode, and tell us here?${SIGNED}`,
          20,
          'available',
        ),
      ],
    },
    96,
  );
  const working = report(
    15,
    {
      kind: 'idea',
      title: 'Show tomorrow’s weather on the desk screen',
      status: 'in_progress',
      text: 'It would be nice if the desk screen showed tomorrow’s weather in the evening.',
      messages: [
        msg('m15a', 'team', '', 30, 'planned'),
        msg('m15b', 'team', `Good idea. We’re building it now.${SIGNED}`, 8, 'in_progress'),
      ],
    },
    40,
  );
  const done = report(
    9,
    {
      kind: 'bug',
      title: 'Search misses files in shared folders',
      status: 'confirmed',
      text: 'Searching for “invoice” doesn’t find the PDFs in my shared folder.',
      messages: [
        msg('m9a', 'team', '', 400, 'investigating'),
        msg('m9b', 'team', `Fixed in 0.298.0. Could you check?${SIGNED}`, 300, 'available'),
        msg('m9c', 'reporter', '', 280, 'confirmed'),
      ],
    },
    420,
  );
  const notPlanned = report(
    7,
    {
      kind: 'idea',
      title: 'A Windows app',
      status: 'not_planned',
      text: 'Could Whombat have its own Windows app?',
      messages: [
        msg(
          'm7a',
          'team',
          `Thanks! The web app works on Windows, so we won’t make a separate one for now.${SIGNED}`,
          600,
          'not_planned',
        ),
      ],
    },
    700,
  );
  return [
    { report: asks, read: asks.revision - 1 },
    { report: fix, read: fix.revision },
    { report: working, read: working.revision },
    { report: done, read: done.revision },
    { report: notPlanned, read: notPlanned.revision },
  ];
}

const DRAFT = {
  id: 'draft_fixture_backups',
  kind: 'bug' as const,
  text: 'The Backups page stays empty after I restored my Whombat from the USB stick.',
  expected: 'To see my backups there.',
};

export function createTeamReportFixtures(options: { kind?: TeamReportFixtureKind } = {}) {
  const kind = teamReportFixtureKind(options.kind);
  let kept: Kept[] = kind === 'seeded' || kind === 'stale' ? seed(Date.now()) : [];
  let next = 20;
  let draftDone = false;

  const row = (k: Kept): TeamReportRow => {
    const { text: _t, expected: _e, context: _c, messages: _m, ...summary } = k.report;
    return { ...summary, unread: k.report.revision > k.read };
  };

  async function body<T>(req: Request): Promise<T> {
    const text = await req.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  function change(k: Kept, author: TeamReportMessage['author'], text: string, status?: TeamReportStatus) {
    const at = Math.floor(Date.now() / 1000);
    k.report = {
      ...k.report,
      ...(status ? { status } : {}),
      updatedAt: at,
      messages: [...k.report.messages, { id: `m${next++}`, author, text, at, ...(status ? { status } : {}) }],
    };
  }

  async function handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url, 'http://fixtures.local').pathname;
    if (!path.startsWith(`${B}/team-report`)) return null;
    const rest = path.slice(B.length);
    const route = `${req.method} ${rest}`;
    if (route === 'GET /team-reports') {
      if (kind === 'off') return json({ available: false, reason: 'not_invited', reports: [], stale: false });
      return json({
        available: kind !== 'stale',
        reason: kind === 'stale' ? 'unreachable' : null,
        stale: kind === 'stale',
        reports: kept.map(row),
      });
    }
    if (route === 'POST /team-reports') {
      if (kind === 'off' || kind === 'stale')
        return json(
          { error: { code: 'unavailable', message: 'The Whombat Team can’t be reached right now.' } },
          503,
        );
      const b = await body<{
        kind: 'bug' | 'idea';
        text: string;
        expected?: string;
        context?: object;
        draftId?: string;
      }>(req);
      const at = Math.floor(Date.now() / 1000);
      const number = 16 + kept.length;
      const line = b.text.split('\n').find((l) => l.trim()) ?? 'Report';
      const report: TeamReport = {
        id: `tr_fixture${String(number).padStart(13, '0')}`,
        number,
        kind: b.kind,
        title: line.length > 80 ? `${line.slice(0, 79)}…` : line,
        status: 'new',
        createdAt: at,
        updatedAt: at,
        revision: 0,
        text: b.text,
        expected: b.expected ?? '',
        context: { runtimeVersion: '0.304.0', channel: 'development', ...(b.context ?? {}) },
        messages: [],
      };
      if (b.draftId === DRAFT.id) draftDone = true;
      kept = [{ report, read: 0 }, ...kept];
      return json({ report }, 201);
    }
    const draft = /^\/team-report-drafts\/([A-Za-z0-9_-]{8,64})$/.exec(rest);
    if (draft && req.method === 'GET')
      return draft[1] === DRAFT.id ? json({ draft: { ...DRAFT, done: draftDone } }) : notFound();
    const one = /^\/team-reports\/(tr_[A-Za-z0-9_-]{20})(\/replies|\/act)?$/.exec(rest);
    if (!one) return null;
    const k = kept.find((x) => x.report.id === one[1]);
    if (!k) return notFound();
    if (req.method === 'GET' && !one[2]) {
      k.read = k.report.revision;
      return json({ report: k.report });
    }
    if (req.method === 'POST' && one[2] === '/replies') {
      const b = await body<{ text: string }>(req);
      change(k, 'reporter', b.text.trim());
      return json({ report: k.report });
    }
    if (req.method === 'POST' && one[2] === '/act') {
      const b = await body<{ action: 'works' | 'still_happening' | 'withdraw' }>(req);
      if (b.action === 'withdraw') {
        kept = kept.filter((x) => x !== k);
        return json({ report: null });
      }
      change(k, 'reporter', '', b.action === 'works' ? 'confirmed' : 'investigating');
      return json({ report: k.report });
    }
    return null;
  }

  return { handle };
}
