/**
 * Quiet notices on servers in fixture mode (Whombat quiet-notices.md QN-10…QN-15, QN-23; contracts 0.122.0 CT-1063,
 * CT-1068; app quiet-notices.md AP-4814): `things.quiet`, `things.watch` and `things.setWatch` for `server:<id>`, and a
 * server's page read through them — an ignored or snoozed alert or hint carries `quiet` (an alert no longer asks for
 * attention), a check switched off for the server or its item leaves its lines out, as the runtime does. What Whombat
 * watches lists the checks of the lines the server has now and a few every server has. The person may change them
 * (`mayChange`).
 */
import {
  HOST_WATCH_CHECKS,
  type HostAlert,
  type HostHint,
  type HostServerDetail,
  hostAlertCheck,
  hostHintCheck,
  hostHintNature,
  hostNoticeSubjectId,
  type NoticeQuiet,
  type NoticeSubject,
  QUIET_WORDS,
  quietWordsOf,
  type ThingWatch,
  type ThingWatchCheck,
  type ThingWatchException,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest } from './fixtures';
import { detailGuests } from './model';
import { alertNoticeParts, hintEntity, hintNoticeParts, serverNoticeOptions } from './notices';

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

/** Checks every server's What Whombat watches lists, also while they raise nothing. */
const ALWAYS = [
  'host.agent.heartbeat_missing',
  'host.disk.space_high',
  'host.sensor.temp_high',
  'host.hint.system.updates',
];

export interface HostsQuietFixtures {
  /** The hosts routes, a server's page read through what is quiet or switched off. */
  handle: Handle;
  /** `things.quiet` (`what` quiet, POST) and `things.watch` / `things.setWatch` (`what` watch) for a server. */
  things(req: {
    method: string;
    serverId: string;
    what: 'quiet' | 'watch';
    body: Record<string, unknown>;
  }): HostsFixtureAnswer;
}

const refuse = (status: number, code: string, message: string): HostsFixtureAnswer => ({
  status,
  body: { error: { code, message } },
});

export function withQuietFixtures(next: Handle, opts: { now?: number } = {}): HostsQuietFixtures {
  const now = () => opts.now ?? Date.now();
  const by = { id: 'prn_mara', name: 'Mara' } as NoticeQuiet['by'];
  /** `server|check|subject` → how it is quiet, and the item's name for What Whombat watches. */
  const quiets = new Map<string, { quiet: NoticeQuiet; subject?: NoticeSubject }>();
  /** `server|check|subject` (`''` the whole check) → when it was switched off. */
  const offs = new Map<string, { at: string; subject?: NoticeSubject }>();
  const key = (server: string, check: string, subject?: string) => `${server}|${check}|${subject ?? ''}`;
  const off = (server: string, check: string, subject?: string) =>
    offs.has(key(server, check)) || (subject !== undefined && offs.has(key(server, check, subject)));

  function alertRef(a: HostAlert) {
    const c = hostAlertCheck(a.rule);
    return { c, subject: hostNoticeSubjectId(c, a.entity) };
  }
  function hintRef(h: HostHint) {
    const c = hostHintCheck(h.kind);
    return { c, subject: hostNoticeSubjectId(c, hintEntity(h)) };
  }

  /** The page as the runtime gives it: quiet lines marked, lines not watched left out, lifted snoozes gone. */
  function decorate(d: HostServerDetail): HostServerDetail {
    const server = d.server.id;
    const live = (k: string) => {
      const q = quiets.get(k);
      if (q?.quiet.until && Date.parse(q.quiet.until) <= now()) quiets.delete(k);
      return quiets.get(k)?.quiet;
    };
    const alerts = d.alerts
      ?.filter((a) => {
        const { c, subject } = alertRef(a);
        return !off(server, c.check, subject);
      })
      .map((a) => {
        const { c, subject } = alertRef(a);
        const quiet = a.state === 'open' ? live(key(server, c.check, subject)) : undefined;
        return quiet ? { ...a, quiet, attention: false } : a;
      });
    const hints = d.hints
      .filter((h) => {
        const { c, subject } = hintRef(h);
        return !off(server, c.check, subject);
      })
      .map((h) => {
        const { c, subject } = hintRef(h);
        const quiet = live(key(server, c.check, subject));
        return quiet ? { ...h, quiet } : h;
      });
    return { ...d, ...(alerts ? { alerts } : {}), hints };
  }

  function detail(serverId: string): HostServerDetail | null {
    const a = next({ method: 'GET', path: `/servers/${encodeURIComponent(serverId)}`, query: {}, body: {} });
    return a && a.status === 200 ? (a.body as HostServerDetail) : null;
  }

  const handle: Handle = (req) => {
    const answer = next(req);
    const seg = req.path.split('/').filter(Boolean);
    if (answer?.status === 200 && req.method === 'GET' && seg[0] === 'servers' && seg.length === 2)
      return { ...answer, body: decorate(answer.body as HostServerDetail) };
    return answer;
  };

  function watch(serverId: string, d: HostServerDetail): ThingWatch {
    const raised = new Map<string, { nature: ThingWatchCheck['nature'] }>();
    for (const a of d.alerts ?? [])
      raised.set(hostAlertCheck(a.rule).check, { nature: hostAlertCheck(a.rule).nature });
    for (const h of d.hints)
      raised.set(hostHintCheck(h.kind).check, { nature: hostHintNature(hostHintCheck(h.kind), h.severity) });
    for (const [k] of offs) {
      const [s, check] = k.split('|');
      if (s === serverId && check) raised.set(check, raised.get(check) ?? { nature: 'problem' });
    }
    for (const [k] of quiets) {
      const [s, check] = k.split('|');
      if (s === serverId && check) raised.set(check, raised.get(check) ?? { nature: 'problem' });
    }
    const checks = HOST_WATCH_CHECKS.filter((c) => raised.has(c.check) || ALWAYS.includes(c.check)).map(
      (c): ThingWatchCheck => {
        const whole = offs.get(key(serverId, c.check));
        const exceptions: ThingWatchException[] = [];
        for (const [k, o] of offs)
          if (o.subject && k === key(serverId, c.check, o.subject.id))
            exceptions.push({
              subject: o.subject,
              state: 'stopped',
              words: QUIET_WORDS.always,
              by,
              at: o.at,
            });
        for (const [k, q] of quiets)
          if (k.startsWith(`${serverId}|${c.check}|`))
            exceptions.push({
              ...(q.subject ? { subject: q.subject } : {}),
              state: q.quiet.state,
              words: q.quiet.words,
              ...(q.quiet.until ? { until: q.quiet.until } : {}),
              by,
              at: q.quiet.at,
            });
        return {
          check: c.check,
          name: c.name,
          nature: c.nature,
          on: !whole,
          perItem: c.perItem,
          ...(whole ? { off: { by, at: whole.at } } : {}),
          exceptions,
        };
      },
    );
    return { checks, mayChange: true };
  }

  function things(req: {
    method: string;
    serverId: string;
    what: 'quiet' | 'watch';
    body: Record<string, unknown>;
  }): HostsFixtureAnswer {
    const d = detail(req.serverId);
    if (!d) return refuse(404, 'not_found', 'There’s nothing here by that name.');
    if (req.what === 'watch' && req.method === 'GET') return { status: 200, body: watch(req.serverId, d) };
    if (req.method !== 'POST') return refuse(404, 'not_found', 'Not here.');
    if (req.what === 'watch') {
      const check = String(req.body.check ?? '');
      const subject = req.body.subject as NoticeSubject | undefined;
      if (!HOST_WATCH_CHECKS.some((c) => c.check === check))
        return refuse(404, 'not_found', 'Whombat doesn’t watch that here.');
      const k = key(req.serverId, check, subject?.id);
      if (req.body.watched) offs.delete(k);
      else offs.set(k, { at: new Date(now()).toISOString(), ...(subject ? { subject } : {}) });
      return { status: 200, body: watch(req.serverId, d) };
    }
    const notice = req.body.notice as { check: string; subject?: string };
    const how = req.body.how as 'ignore' | 'snooze' | 'undo';
    const k = key(req.serverId, notice.check, notice.subject);
    if (how === 'undo') {
      if (!quiets.delete(k)) return refuse(404, 'not_found', 'There’s nothing to take back.');
      return { status: 200, body: { notice, quiet: null } };
    }
    const names = serverNoticeOptions(d, detailGuests(d));
    const line =
      (d.alerts ?? [])
        .filter((a) => a.state === 'open')
        .map((a) => ({ c: hostAlertCheck(a.rule), parts: alertNoticeParts(a, names) }))
        .find((x) => x.parts.check === notice.check && x.parts.subject?.id === notice.subject) ??
      d.hints
        .map((h) => ({ c: hostHintCheck(h.kind), parts: hintNoticeParts(h, names) }))
        .find((x) => x.parts.check === notice.check && x.parts.subject?.id === notice.subject);
    if (!line) return refuse(404, 'not_found', 'That isn’t on this page any more.');
    const at = new Date(now()).toISOString();
    const tomorrow = new Date(now());
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(7, 0, 0, 0);
    const quiet: NoticeQuiet =
      how === 'ignore'
        ? { state: 'ignored', words: quietWordsOf(line.c.words), by, at }
        : { state: 'snoozed', words: 'until tomorrow 09:00', until: tomorrow.toISOString(), by, at };
    const subject = line.parts.subject;
    quiets.set(k, { quiet, ...(subject ? { subject } : {}) });
    return { status: 200, body: { notice, quiet } };
  }

  return { handle, things };
}
