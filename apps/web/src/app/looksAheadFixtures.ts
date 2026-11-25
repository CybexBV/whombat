/**
 * Looks ahead in fixture mode (Whombat looks-ahead.md): Settings → the assistant → Looks ahead over the real REST
 * contract, kept in memory. Mara's Google account has two calendars (her own on, Family off), incoming mail checks on,
 * one standing rule, one stopped kind, four checks in the last week, four recent checks (a look through new mail and a
 * follow-up among them) and three things kept an eye on.
 */
import { AHEAD_KINDS, AHEAD_RULES_MAX, LooksAheadUpdate, type LooksAheadView } from '@whombat/core';
import { burrow } from '@whombat/fixtures';

const PATH = `/api/v1/burrows/${burrow.slug}/looks-ahead`;
const CHECK_PATH = `${PATH}/check`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createLooksAheadFixtures(seed?: Partial<LooksAheadView>) {
  let view: LooksAheadView = {
    on: true,
    calendars: [
      {
        key: 'con_google:primary',
        name: 'Mara Okafor',
        account: 'mara@example.com',
        on: true,
        primary: true,
      },
      { key: 'con_google:family', name: 'Family', account: 'mara@example.com', on: false, primary: false },
    ],
    calendarsRead: true,
    hasCalendar: true,
    mailOn: true,
    hasMail: true,
    rules: ['I live in Utrecht and usually drive to venues'],
    stopped: ['crowds'],
    week: { checked: 4, told: 1 },
    recent: [
      {
        id: 'ahc_4',
        source: 'mail',
        stage: 'mail',
        title: 'New mail',
        at: '2026-12-13T16:00:00Z',
        state: 'quiet',
        kind: null,
        threadRootId: null,
        feedback: null,
        of: 'triage',
        count: 42,
        picked: 2,
      },
      {
        id: 'ahc_3',
        source: 'mail',
        stage: 'mail',
        title: 'Refund for the cancelled flight',
        at: '2026-12-13T15:30:00Z',
        state: 'told',
        kind: 'deadline',
        threadRootId: 'msg_ahead_2',
        feedback: null,
        of: 'matter',
      },
      {
        id: 'ahc_1',
        source: 'calendar',
        stage: 'eve',
        title: 'The Script',
        at: '2026-12-13T14:15:00Z',
        state: 'told',
        kind: 'time',
        threadRootId: 'msg_ahead_1',
        feedback: null,
      },
      {
        id: 'ahc_2',
        source: 'mail',
        stage: 'mail',
        title: 'Flight KL1234 confirmation',
        at: '2026-12-13T11:00:00Z',
        state: 'quiet',
        kind: null,
        threadRootId: null,
        feedback: null,
      },
    ],
    matters: [
      {
        id: 'ahm_1',
        title: 'Answer the notary about the deed',
        who: 'The notary',
        waitingOn: 'you',
        due: '2026-12-16',
        since: '2026-12-10T09:12:00Z',
        asked: false,
      },
      {
        id: 'ahm_2',
        title: 'Refund for the cancelled flight',
        who: 'The airline',
        waitingOn: 'them',
        since: '2026-12-08T17:40:00Z',
        asked: false,
      },
      {
        id: 'ahm_3',
        title: 'Reply from the plumber about the boiler',
        who: 'The plumber',
        waitingOn: 'them',
        since: '2026-12-12T08:05:00Z',
        asked: true,
      },
    ],
    ...seed,
  };

  async function handle(req: Request): Promise<Response | null> {
    const pathname = new URL(req.url, 'http://fixtures.local').pathname;
    if (pathname === CHECK_PATH && req.method === 'POST') {
      const started = view.on;
      if (started) {
        view = {
          ...view,
          recent: [
            {
              id: `ahc_now_${(view.recent?.length ?? 0) + 1}`,
              source: 'calendar',
              stage: 'early',
              title: 'Weekend Rome',
              at: '2026-12-13T15:00:00Z',
              state: 'checking',
              kind: null,
              threadRootId: null,
              feedback: null,
            },
            ...(view.recent ?? []),
          ],
        };
      }
      return json({ started, view });
    }
    if (pathname !== PATH) return null;
    if (req.method === 'GET') return json(view);
    if (req.method !== 'PUT') return null;
    const parsed = LooksAheadUpdate.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return json({ error: { code: 'invalid', message: 'That change isn’t valid.' } }, 400);
    const u = parsed.data;
    if ('calendar' in u) {
      if (!view.calendars.some((c) => c.key === u.calendar))
        return json({ error: { code: 'not_found', message: 'That calendar isn’t there any more.' } }, 404);
      view = {
        ...view,
        calendars: view.calendars.map((c) => (c.key === u.calendar ? { ...c, on: u.on } : c)),
      };
    } else if ('kind' in u) {
      const stopped = new Set(view.stopped);
      if (u.on) stopped.delete(u.kind);
      else stopped.add(u.kind);
      view = { ...view, stopped: AHEAD_KINDS.filter((k) => stopped.has(k)) };
    } else if ('mailOn' in u) {
      view = { ...view, mailOn: u.mailOn };
    } else if ('addRule' in u) {
      const rule = u.addRule.trim();
      const prev = view.rules ?? [];
      const exists = prev.some((r) => r.toLowerCase() === rule.toLowerCase());
      view = { ...view, rules: exists ? prev : [...prev, rule].slice(-AHEAD_RULES_MAX) };
    } else if ('removeRule' in u) {
      const target = u.removeRule.trim().toLowerCase();
      view = { ...view, rules: (view.rules ?? []).filter((r) => r.toLowerCase() !== target) };
    } else if ('removeMatter' in u) {
      view = { ...view, matters: (view.matters ?? []).filter((m) => m.id !== u.removeMatter) };
    } else view = { ...view, on: u.on };
    return json(view);
  }

  return { handle };
}
