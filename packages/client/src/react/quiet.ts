/**
 * Ignore, Remind me tomorrow and Stop watching, and What Whombat watches (Whombat quiet-notices.md QN-10…QN-17, QN-23;
 * contracts 0.122.0 CT-1063, `things.quiet`, `things.watch`, `things.setWatch`, feature `things.quiet`; app
 * quiet-notices.md AP-4801…AP-4805). The line changes the moment it is pressed (greyed at the bottom, or gone), on a
 * connection's or device's page (`things.page`) and on a server's (`hosts.getServer`, its alerts and hints); a refusal
 * or a failure puts it back and says why. Each says how it went in a short toast with Undo (`QUIET_TOASTS`); the page,
 * What Whombat watches, Home, Watch and the thing's Activity are read again after the answer. Works in React DOM and
 * React Native: the toast is the app's (`note`).
 */
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import {
  type NoticeQuiet,
  type NoticeRef,
  type NoticeSubject,
  parseThingId,
  type ThingPage,
  type ThingPageNotice,
  type ThingWatch,
} from '@whombat/core';
import { api, type QuietHow } from '@whombat/core/contracts';
import type { HostServerDetail } from '@whombat/core/domain';
import { useCallback, useRef, useState } from 'react';
import {
  expectedQuiet,
  noticeRef,
  noticeRefKey,
  QUIET_TOASTS,
  stopName,
  withNoticeQuiet,
  withoutQuietException,
  withoutWatchedLines,
  withWatched,
} from '../home/quiet';
import { commitOutcomeText, hostErrorInfo } from '../hosts/errors';
import { withoutServerNotices, withServerNoticeQuiet } from '../hosts/notices';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

/** What Whombat watches on a thing (`things.watch`): every check, on or off, with its exceptions and `mayChange`. */
export const useThingWatch = queryHook(api.things.watch);

/** How a quiet press went: the toast's words, Undo when it can be taken back, and whether it failed. */
export type QuietNote = (message: string, options?: { undo?: () => void; failed?: boolean }) => void;

/** A line as the actions need it: its ref parts, its title (the toast names it), its Ignore (its words). */
export type QuietTarget = Pick<ThingPageNotice, 'title' | 'check' | 'subject' | 'ignore'>;

export interface QuietActions {
  /** Ignore until it changes (QN-11): greyed at once, “Ignored. You’ll hear if it changes.” with Undo. */
  ignore(line: QuietTarget): void;
  /** Remind me tomorrow (QN-12): until 09:00 tomorrow, “I’ll remind you tomorrow.” with Undo. */
  snooze(line: QuietTarget): void;
  /** Stop watching its item, or the check as a whole (QN-13): gone at once, with Undo. */
  stop(line: QuietTarget): void;
  /** Undo on a quiet line, or on an ignored or snoozed exception in What Whombat watches. */
  undo(ref: NoticeRef): void;
  /** Watch a check again (its switch, or Undo on an item it stopped for); `name` for the toast. */
  watch(check: string, subject: NoticeSubject | undefined, watched: boolean, name: string): void;
  /** Whether this line or switch is being changed now (`noticeRefKey`). */
  busy(ref: NoticeRef): boolean;
}

type Snapshot = [readonly unknown[], unknown][];

/** The server a `server:<id>` thing is, else null. */
function serverOf(thing: string): string | null {
  const parsed = parseThingId(thing);
  return parsed?.kind === 'server' ? parsed.id : null;
}

function snapshot(qc: QueryClient, burrow: string, thing: string): Snapshot {
  const server = serverOf(thing);
  return [
    ...qc.getQueriesData({ queryKey: queryKeys.scope('things.page', { burrow, thing }) }),
    ...qc.getQueriesData({ queryKey: queryKeys.scope('things.watch', { burrow, thing }) }),
    ...(server
      ? qc.getQueriesData({ queryKey: queryKeys.scope('hosts.getServer', { burrow, serverId: server }) })
      : []),
  ];
}

function restore(qc: QueryClient, s: Snapshot): void {
  for (const [key, data] of s) qc.setQueryData(key, data);
}

/** A line quiet now (`quiet`) or asking again (null), wherever its page is cached. */
function applyQuiet(
  qc: QueryClient,
  burrow: string,
  thing: string,
  ref: NoticeRef,
  quiet: NoticeQuiet | null,
) {
  patchEndpoint<ThingPage>(qc, 'things.page', (p) => withNoticeQuiet(p, ref, quiet), { burrow, thing });
  const server = serverOf(thing);
  if (server)
    patchEndpoint<HostServerDetail>(qc, 'hosts.getServer', (d) => withServerNoticeQuiet(d, ref, quiet), {
      burrow,
      serverId: server,
    });
  if (!quiet)
    patchEndpoint<ThingWatch>(qc, 'things.watch', (w) => withoutQuietException(w, ref), { burrow, thing });
}

/** A check switched for an item or the whole thing, wherever its page and watch list are cached. */
function applyWatched(
  qc: QueryClient,
  burrow: string,
  thing: string,
  check: string,
  subject: NoticeSubject | undefined,
  watched: boolean,
) {
  patchEndpoint<ThingWatch>(qc, 'things.watch', (w) => withWatched(w, check, subject, watched, Date.now()), {
    burrow,
    thing,
  });
  if (watched) return;
  patchEndpoint<ThingPage>(qc, 'things.page', (p) => withoutWatchedLines(p, check, subject?.id), {
    burrow,
    thing,
  });
  const server = serverOf(thing);
  if (server)
    patchEndpoint<HostServerDetail>(
      qc,
      'hosts.getServer',
      (d) => withoutServerNotices(d, check, subject?.id),
      {
        burrow,
        serverId: server,
      },
    );
}

/** Everything that shows the thing's lines or follows them, read again after an answer. */
function readAgain(qc: QueryClient, burrow: string, thing: string) {
  void qc.invalidateQueries({ queryKey: queryKeys.scope('things.page', { burrow, thing }) });
  void qc.invalidateQueries({ queryKey: queryKeys.scope('things.watch', { burrow, thing }) });
  const server = serverOf(thing);
  if (server) {
    void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.getServer', { burrow, serverId: server }) });
    void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.fleet', { burrow }) });
  }
  void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview', { burrow }) });
  void qc.invalidateQueries({ queryKey: queryKeys.scope('watch.list', { burrow }) });
  void qc.invalidateQueries({ queryKey: queryKeys.scope('changes.list', { burrow }) });
}

/**
 * The quiet actions of one thing (`thing` its thingId: `connection:con_…`, `device:…`, `server:<id>`), shared by its
 * lines, its banner and its What Whombat watches. `timeZone` is the Whombat's (Remind me tomorrow's 09:00); `note`
 * says how each went.
 */
export function useQuietActions(
  burrow: string,
  thing: string,
  { timeZone, note }: { timeZone: string; note: QuietNote },
): QuietActions {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const noteRef = useRef(note);
  noteRef.current = note;

  const track = useCallback(async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    setRunning((s) => new Set(s).add(key));
    try {
      return await work();
    } finally {
      setRunning((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }, []);

  /** One `things.quiet`; true when it went through. `then` runs after the answer, before the page is read again. */
  const quiet = useCallback(
    async (
      ref: NoticeRef,
      how: QuietHow,
      expected: NoticeQuiet | null,
      done?: () => void,
    ): Promise<boolean> =>
      track(noticeRefKey(ref), async () => {
        const before = snapshot(qc, burrow, thing);
        await qc.cancelQueries({ queryKey: queryKeys.scope('things.page', { burrow, thing }) });
        applyQuiet(qc, burrow, thing, ref, expected);
        let ok = false;
        try {
          const result = await client.request(api.things.quiet, {
            params: { burrow, thing },
            body: { notice: ref, how },
          });
          if (result.status === 'ok') {
            ok = true;
            applyQuiet(qc, burrow, thing, ref, result.data.quiet);
            done?.();
          } else {
            restore(qc, before);
            noteRef.current(commitOutcomeText(result) ?? '', { failed: true });
          }
        } catch (error) {
          restore(qc, before);
          noteRef.current(hostErrorInfo(error).message, { failed: true });
        } finally {
          readAgain(qc, burrow, thing);
        }
        return ok;
      }),
    [client, qc, burrow, thing, track],
  );

  const setWatch = useCallback(
    async (
      check: string,
      subject: NoticeSubject | undefined,
      watched: boolean,
      done?: () => void,
    ): Promise<boolean> =>
      track(noticeRefKey(subject ? { check, subject: subject.id } : { check }), async () => {
        const before = snapshot(qc, burrow, thing);
        applyWatched(qc, burrow, thing, check, subject, watched);
        let ok = false;
        try {
          const result = await client.request(api.things.setWatch, {
            params: { burrow, thing },
            body: { check, ...(subject ? { subject } : {}), watched },
          });
          if (result.status === 'ok') {
            ok = true;
            qc.setQueriesData<ThingWatch>(
              { queryKey: queryKeys.scope('things.watch', { burrow, thing }) },
              () => result.data,
            );
            done?.();
          } else {
            restore(qc, before);
            noteRef.current(commitOutcomeText(result) ?? '', { failed: true });
          }
        } catch (error) {
          restore(qc, before);
          noteRef.current(hostErrorInfo(error).message, { failed: true });
        } finally {
          readAgain(qc, burrow, thing);
        }
        return ok;
      }),
    [client, qc, burrow, thing, track],
  );

  const undo = useCallback((ref: NoticeRef) => void quiet(ref, 'undo', null), [quiet]);

  const ignore = useCallback(
    (line: QuietTarget) => {
      const ref = noticeRef(line);
      if (!ref) return;
      void quiet(ref, 'ignore', expectedQuiet('ignore', line.ignore, Date.now(), timeZone), () =>
        noteRef.current(QUIET_TOASTS.ignored, { undo: () => undo(ref) }),
      );
    },
    [quiet, undo, timeZone],
  );

  const snooze = useCallback(
    (line: QuietTarget) => {
      const ref = noticeRef(line);
      if (!ref) return;
      void quiet(ref, 'snooze', expectedQuiet('snooze', line.ignore, Date.now(), timeZone), () =>
        noteRef.current(QUIET_TOASTS.snoozed, { undo: () => undo(ref) }),
      );
    },
    [quiet, undo, timeZone],
  );

  const watch = useCallback(
    (check: string, subject: NoticeSubject | undefined, watched: boolean, name: string) => {
      void setWatch(check, subject, watched, () =>
        noteRef.current(
          watched ? QUIET_TOASTS.watched(name) : QUIET_TOASTS.stopped(name),
          watched ? undefined : { undo: () => void setWatch(check, subject, true) },
        ),
      );
    },
    [setWatch],
  );

  const stop = useCallback(
    (line: QuietTarget) => {
      if (!line.check) return;
      watch(line.check, line.subject, false, stopName(line));
    },
    [watch],
  );

  const busy = useCallback((ref: NoticeRef) => running.has(noticeRefKey(ref)), [running]);

  return { ignore, snooze, stop, undo, watch, busy };
}
