/**
 * A server's lines as quiet notices see them (Whombat quiet-notices.md QN-01…QN-03, QN-10, QN-14, QN-23; contracts
 * 0.122.0 CT-1066, CT-1068; app quiet-notices.md AP-4810…AP-4813): each open alert and hint gets its check from
 * `HOST_WATCH_CHECKS` (`host.<rule>`, `host.hint.<kind>`), its kind (a hint's warning may be another kind than its info),
 * its item (`hostNoticeSubjectId` of its entity, named as people know it: a guest by its name), Ignore's words for who
 * may quiet it, and whether it is quiet now (the runtime's `quiet`; an older runtime's acknowledged alert reads quiet too).
 * What counts for “N to look at”: alerts that ask for attention and aren't quiet, warnings among the hints that aren't
 * heads-ups or quiet. And the server's page the moment a line is quieted or stops being watched. Pure.
 */
import {
  type HostAlert,
  type HostGuest,
  type HostHint,
  type HostSensor,
  type HostServerDetail,
  type HostWatchCheck,
  hostAlertCheck,
  hostEntityName,
  hostHintCheck,
  hostHintNature,
  hostNoticeSubjectId,
  type NoticeIgnore,
  type NoticeNature,
  type NoticeQuiet,
  type NoticeRef,
  type NoticeSubject,
  quietWordsOf,
} from '@whombat/core/domain';
import { untilText } from '../home/time';

/** The parts of a line quiet notices add (`ThingPageNotice`'s `nature`, `check`, `subject`, `ignore`, `quiet`). */
export interface ServerNoticeParts {
  nature: NoticeNature;
  check: string;
  subject?: NoticeSubject;
  ignore?: NoticeIgnore;
  quiet?: NoticeQuiet;
}

export interface ServerNoticeOptions {
  /**
   * May the person quiet the server's lines (QN-10: on a runtime with `things.quiet`; `things.watch`'s
   * `mayChange`): its lines get `ignore`, so the ⋯ menu and Undo show.
   */
  quiet?: boolean;
  /** The server's guests, to name a line about one by its name. */
  guests?: readonly Pick<HostGuest, 'id' | 'name'>[];
  /** The server's sensors, to name a line about one by its label (“CPU package”). */
  sensors?: readonly Pick<HostSensor, 'id' | 'label'>[];
  /** The person's time zone and now (ms), for an older runtime's snoozed alert (“until tomorrow 09:00”). */
  timeZone?: string;
  now?: number;
}

/** A hint's entity: its own, or the part of its id after `<kind>:` (an older field left empty). */
export function hintEntity(h: Pick<HostHint, 'entity' | 'id' | 'kind'>): string {
  if (h.entity) return h.entity;
  const prefix = `${h.kind}:`;
  return h.id?.startsWith(prefix) ? h.id.slice(prefix.length) : (h.id ?? '');
}

/** An item as people know it: a guest by its name, else the entity without the hosts service's prefix. */
function subjectOf(
  c: HostWatchCheck,
  entity: string | undefined,
  opts: ServerNoticeOptions,
): NoticeSubject | undefined {
  const id = hostNoticeSubjectId(c, entity);
  if (!id || !entity) return undefined;
  const bare = hostEntityName(entity);
  const guest = opts.guests?.find((g) => g.id === entity || g.id === bare || g.name === bare);
  const sensor = guest ? undefined : opts.sensors?.find((x) => x.id === entity || x.id === bare);
  return { id, name: (guest?.name || sensor?.label || bare || id).slice(0, 80) };
}

/** What naming a server's items needs from its page: its guests and sensors. */
export function serverNoticeOptions(
  d: Pick<HostServerDetail, 'sensors'>,
  guests: readonly Pick<HostGuest, 'id' | 'name'>[],
  extra: Omit<ServerNoticeOptions, 'guests' | 'sensors'> = {},
): ServerNoticeOptions {
  return { ...extra, guests, sensors: d.sensors ?? [] };
}

/**
 * An alert's quiet (QN-14, QN-23): the runtime's reading of the hosts service's acknowledgement, else (an older runtime)
 * the acknowledgement itself — snoozed until its time, or ignored until it resolves in the check's own words, by nobody
 * Whombat can name.
 */
export function alertQuiet(
  a: Pick<HostAlert, 'quiet' | 'acknowledged' | 'rule'>,
  opts: Pick<ServerNoticeOptions, 'timeZone' | 'now'> = {},
): NoticeQuiet | undefined {
  if (a.quiet) return a.quiet;
  const ack = a.acknowledged;
  if (!ack) return undefined;
  if (ack.until)
    return {
      state: 'snoozed',
      words: untilText(ack.until, opts.now ?? Date.parse(ack.at), opts.timeZone ?? 'UTC'),
      until: ack.until,
      at: ack.at,
    };
  return { state: 'ignored', words: quietWordsOf(hostAlertCheck(a.rule).words), at: ack.at };
}

/** An open alert's parts: its check, kind, item, Ignore and quiet. */
export function alertNoticeParts(a: HostAlert, opts: ServerNoticeOptions = {}): ServerNoticeParts {
  const c = hostAlertCheck(a.rule);
  const subject = subjectOf(c, a.entity, opts);
  const quiet = alertQuiet(a, opts);
  return {
    nature: c.nature,
    check: c.check,
    ...(subject ? { subject } : {}),
    ...(opts.quiet ? { ignore: { lifts: c.lifts, words: c.words } } : {}),
    ...(quiet ? { quiet } : {}),
  };
}

/** A hint's parts: its check, kind (by its severity), item, Ignore and quiet. */
export function hintNoticeParts(h: HostHint, opts: ServerNoticeOptions = {}): ServerNoticeParts {
  const c = hostHintCheck(h.kind);
  const subject = subjectOf(c, hintEntity(h), opts);
  return {
    nature: hostHintNature(c, h.severity),
    check: c.check,
    ...(subject ? { subject } : {}),
    ...(opts.quiet ? { ignore: { lifts: c.lifts, words: c.words } } : {}),
    ...(h.quiet ? { quiet: h.quiet } : {}),
  };
}

/**
 * Whether an alert counts for “N to look at” (QN-14, QN-23): open, asking for attention (not acknowledged, muted or
 * suppressed by the hosts service), not quiet, and not a heads-up (the server's dot leaves those out too, QN-02).
 */
export function alertCounts(a: HostAlert): boolean {
  return (
    a.state === 'open' &&
    a.attention !== false &&
    !alertQuiet(a) &&
    !a.muted &&
    !a.suppressedBy &&
    hostAlertCheck(a.rule).nature !== 'fyi'
  );
}

/** Whether a hint counts: a warning that isn't a heads-up (QN-02) and isn't quiet. */
export function hintCounts(h: HostHint): boolean {
  return h.severity === 'warning' && !h.quiet && hostHintNature(hostHintCheck(h.kind), h.severity) !== 'fyi';
}

/** Whether an alert or hint is the line `ref` names. */
function isAlert(a: HostAlert, ref: NoticeRef): boolean {
  const c = hostAlertCheck(a.rule);
  return c.check === ref.check && (hostNoticeSubjectId(c, a.entity) ?? '') === (ref.subject ?? '');
}

function isHint(h: HostHint, ref: NoticeRef): boolean {
  const c = hostHintCheck(h.kind);
  return c.check === ref.check && (hostNoticeSubjectId(c, hintEntity(h)) ?? '') === (ref.subject ?? '');
}

/** The server's page with one line quiet now (`quiet`) or asking again (null), before the runtime answers. */
export function withServerNoticeQuiet(
  d: HostServerDetail,
  ref: NoticeRef,
  quiet: NoticeQuiet | null,
): HostServerDetail {
  const alerts = d.alerts?.map((a) => {
    if (a.state !== 'open' || !isAlert(a, ref)) return a;
    if (quiet) return { ...a, quiet, attention: false };
    const { quiet: _q, ...rest } = a;
    return { ...rest, acknowledged: null, attention: !rest.muted && !rest.suppressedBy };
  });
  const hints = d.hints.map((h) => {
    if (!isHint(h, ref)) return h;
    if (quiet) return { ...h, quiet };
    const { quiet: _q, ...rest } = h;
    return rest;
  });
  return { ...d, ...(alerts ? { alerts } : {}), hints };
}

/** The server's page without the lines of a check (for one item, or all) once it isn't watched (QN-13). */
export function withoutServerNotices(d: HostServerDetail, check: string, subject?: string): HostServerDetail {
  const ref = (s: string | undefined): NoticeRef => (s ? { check, subject: s } : { check });
  const gone = <T>(x: T, is: (x: T, r: NoticeRef) => boolean, item: string | undefined) =>
    subject === undefined ? is(x, ref(item)) : is(x, ref(subject));
  return {
    ...d,
    ...(d.alerts
      ? {
          alerts: d.alerts.filter(
            (a) => !gone(a, isAlert, hostNoticeSubjectId(hostAlertCheck(a.rule), a.entity)),
          ),
        }
      : {}),
    hints: d.hints.filter((h) => !gone(h, isHint, hostNoticeSubjectId(hostHintCheck(h.kind), hintEntity(h)))),
  };
}
