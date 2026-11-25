/**
 * Looks ahead in fixture mode (Whombat looks-ahead.md): Settings → the assistant → Looks ahead over the real REST
 * contract, kept in memory. Mara's Google account has two calendars, her own on, Family off; she stopped one kind of
 * finding, and the last week had four checks and one finding told.
 */
import { AHEAD_KINDS, LooksAheadUpdate, type LooksAheadView } from '@whombat/core';
import { burrow } from '@whombat/fixtures';

const PATH = `/api/v1/burrows/${burrow.slug}/looks-ahead`;

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
    stopped: ['crowds'],
    week: { checked: 4, told: 1 },
    ...seed,
  };

  async function handle(req: Request): Promise<Response | null> {
    if (new URL(req.url, 'http://fixtures.local').pathname !== PATH) return null;
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
    } else view = { ...view, on: u.on };
    return json(view);
  }

  return { handle };
}
