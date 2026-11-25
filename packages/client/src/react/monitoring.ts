/**
 * Monitoring's reads and changes on a thing's page (session
 * minor 9): Keep quiet and End now (`things.keepQuiet`, `things.endQuiet`), What happened (`things.history`,
 * only asked of a Whombat that has it) and a server check's limit (`things.setWatchLimit`, Undo through
 * `changes.undo`). Each says how it went through the app's `note` (a toast), with Undo where it can be taken back; the
 * page, Home and the watch lists are read again after the answer. Works in React DOM and React Native.
 */
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import {
  type KeepQuietBody,
  type KeptQuiet,
  type NoticeSubject,
  parseThingId,
  type ThingPage,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import type { HostServerDetail, ThingWatch } from '@whombat/core/domain';
import { protocolAtLeast, THING_HISTORY_MINOR } from '@whombat/protocol/session';
import { useCallback, useRef, useState } from 'react';
import { undoOutcome } from '../home/changes';
import { endedToast, keptToast, LIMIT_WORDS, limitText } from '../home/monitoring';
import { commitOutcomeText, hostErrorInfo } from '../hosts/errors';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';
import { useSessionProtocol, useWhombat } from './context';
import { useUndoChange } from './home';
import { queryHook } from './queries';

/** How a press went: the toast's words, Undo when it can be taken back, and whether it failed. */
export type MonitoringNote = (message: string, options?: { undo?: () => void; failed?: boolean }) => void;

/** The server a `server:<id>` thing is, else null. */
function serverOf(thing: string): string | null {
  const parsed = parseThingId(thing);
  return parsed?.kind === 'server' ? parsed.id : null;
}

/** The page's kept quiet as the answer says, wherever the thing's page is cached. */
function applyKept(qc: QueryClient, burrow: string, thing: string, kept: KeptQuiet | null) {
  const set = <T extends { keptQuiet?: KeptQuiet }>(p: T): T => {
    if (kept) return { ...p, keptQuiet: kept };
    if (!p.keptQuiet) return p;
    const { keptQuiet: _k, ...rest } = p;
    return rest as T;
  };
  patchEndpoint<ThingPage>(qc, 'things.page', set, { burrow, thing });
  const server = serverOf(thing);
  if (server) patchEndpoint<HostServerDetail>(qc, 'hosts.getServer', set, { burrow, serverId: server });
}

/** Everything that shows the thing's state, read again after an answer. */
function readAgain(qc: QueryClient, burrow: string, thing: string) {
  void qc.invalidateQueries({ queryKey: queryKeys.scope('things.page', { burrow, thing }) });
  void qc.invalidateQueries({ queryKey: queryKeys.scope('things.watch', { burrow, thing }) });
  void qc.invalidateQueries({ queryKey: queryKeys.scope('things.history', { burrow, thing }) });
  const server = serverOf(thing);
  if (server) {
    void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.getServer', { burrow, serverId: server }) });
    void qc.invalidateQueries({ queryKey: queryKeys.scope('hosts.fleet', { burrow }) });
  }
  void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview', { burrow }) });
  void qc.invalidateQueries({ queryKey: queryKeys.scope('watch.list', { burrow }) });
  void qc.invalidateQueries({ queryKey: queryKeys.scope('changes.list', { burrow }) });
}

/* Keep quiet and End now ------------------------------------------------------------------------------------------- */

export interface KeepQuietActions {
  /**
   * Keep it quiet (`things.keepQuiet`); true when it went through. The toast says until when, with Undo
   * (`changes.undo` of that change: the person's earlier window back, or theirs ended; Whombat's own stays).
   */
  keep(body: KeepQuietBody): Promise<boolean>;
  /** End now (`things.endQuiet`); true when it went through. */
  end(): Promise<boolean>;
  busy: boolean;
}

/**
 * Keep quiet and End now for one thing (`thing` its thingId: `connection:con_…`, `device:…`, `server:<id>`). `name` is
 * the thing's name for the toasts; `timeZone` the Whombat's.
 */
export function useKeepQuiet(
  burrow: string,
  thing: string,
  { name, timeZone, note }: { name: string; timeZone: string; note: MonitoringNote },
): KeepQuietActions {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const undo = useUndoChange(burrow);
  const [busy, setBusy] = useState(false);
  const noteRef = useRef(note);
  noteRef.current = note;

  // Undo takes back that one change only, not every window holding the thing as End now does.
  const takeBack = useCallback(
    async (changeId: string) => {
      try {
        const result = await undo.mutateAsync(changeId);
        if (result.status !== 'ok') {
          noteRef.current(commitOutcomeText(result) ?? '', { failed: true });
          return;
        }
        noteRef.current(undoOutcome(result.data).message);
      } catch (error) {
        noteRef.current(hostErrorInfo(error).message, { failed: true });
      } finally {
        readAgain(qc, burrow, thing);
      }
    },
    [undo, qc, burrow, thing],
  );

  const end = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await client.request(api.things.endQuiet, { params: { burrow, thing } });
      if (result.status !== 'ok') {
        noteRef.current(commitOutcomeText(result) ?? '', { failed: true });
        return false;
      }
      applyKept(qc, burrow, thing, null);
      noteRef.current(endedToast(name));
      return true;
    } catch (error) {
      noteRef.current(hostErrorInfo(error).message, { failed: true });
      return false;
    } finally {
      setBusy(false);
      readAgain(qc, burrow, thing);
    }
  }, [client, qc, burrow, thing, name]);

  const keep = useCallback(
    async (body: KeepQuietBody): Promise<boolean> => {
      setBusy(true);
      try {
        const result = await client.request(api.things.keepQuiet, { params: { burrow, thing }, body });
        if (result.status !== 'ok') {
          noteRef.current(commitOutcomeText(result) ?? '', { failed: true });
          return false;
        }
        const { keptQuiet: kept, changeId } = result.data;
        applyKept(qc, burrow, thing, kept);
        if (kept)
          noteRef.current(
            keptToast(kept.until, Date.now(), timeZone),
            changeId ? { undo: () => void takeBack(changeId) } : undefined,
          );
        return true;
      } catch (error) {
        noteRef.current(hostErrorInfo(error).message, { failed: true });
        return false;
      } finally {
        setBusy(false);
        readAgain(qc, burrow, thing);
      }
    },
    [client, qc, burrow, thing, timeZone, takeBack],
  );

  return { keep, end, busy };
}

/* What happened ---------------------------------------------------------------------------------------------------- */

const useThingHistoryQuery = queryHook(api.things.history);

/**
 * A thing's incidents, uptime and (for a server) past alerts over the last `days` (`things.history`). Asked only of a
 * Whombat at session minor 9 or later; `supported` false on an older one, which draws no list.
 */
export function useThingHistory(burrow: string, thing: string, days: 30 | 90 = 30) {
  const supported = protocolAtLeast(useSessionProtocol(), THING_HISTORY_MINOR);
  const query = useThingHistoryQuery(supported ? { params: { burrow, thing }, query: { days } } : null, {
    retry: false,
    staleTime: 60_000,
  });
  return { supported, ...query };
}

/* Change the limit ------------------------------------------------------------------------------------------------- */

export interface WatchLimitActions {
  /**
   * Set a check's limit for the server or one item, or clear it (`limit` null: Use the default); true when it went
   * through. The toast says the new limit with Undo (`changes.undo`).
   */
  set(input: {
    check: string;
    subject?: NoticeSubject | null;
    name: string;
    unit: string;
    limit: number | null;
  }): Promise<boolean>;
  busy: boolean;
}

/** `things.setWatchLimit` for a server's checks (`thing` is `server:<id>`). */
export function useSetWatchLimit(
  burrow: string,
  thing: string,
  { note, assistantName }: { note: MonitoringNote; assistantName?: string | null },
): WatchLimitActions {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const undo = useUndoChange(burrow);
  const [busy, setBusy] = useState(false);
  const noteRef = useRef(note);
  noteRef.current = note;

  const putBack = useCallback(
    async (changeId: string) => {
      try {
        const result = await undo.mutateAsync(changeId);
        if (result.status !== 'ok') {
          noteRef.current(commitOutcomeText(result) ?? '', { failed: true });
          return;
        }
        const outcome = undoOutcome(result.data, assistantName);
        noteRef.current(outcome.message);
      } catch (error) {
        noteRef.current(hostErrorInfo(error).message, { failed: true });
      } finally {
        readAgain(qc, burrow, thing);
      }
    },
    [undo, qc, burrow, thing, assistantName],
  );

  const set = useCallback<WatchLimitActions['set']>(
    async ({ check, subject, name, unit, limit }) => {
      setBusy(true);
      try {
        const result = await client.request(api.things.setWatchLimit, {
          params: { burrow, thing },
          body: { check, ...(subject ? { subject } : {}), limit },
        });
        if (result.status !== 'ok') {
          noteRef.current(commitOutcomeText(result) ?? '', { failed: true });
          return false;
        }
        qc.setQueriesData<ThingWatch>(
          { queryKey: queryKeys.scope('things.watch', { burrow, thing }) },
          () => result.data.watch,
        );
        const changeId = result.data.changeId;
        noteRef.current(
          limit === null ? LIMIT_WORDS.cleared(name) : LIMIT_WORDS.set(name, limitText(limit, unit)),
          changeId ? { undo: () => void putBack(changeId) } : undefined,
        );
        return true;
      } catch (error) {
        noteRef.current(hostErrorInfo(error).message, { failed: true });
        return false;
      } finally {
        setBusy(false);
        readAgain(qc, burrow, thing);
      }
    },
    [client, qc, burrow, thing, putBack],
  );

  return { set, busy };
}
