// Power actions (REMOTE-CONSOLE 7): POST .../actions with confirm: true, then
// wait for SSE `action.finished` with the returned action_id. The state lives
// in a small module store keyed by server/guest, so the toolbar chip survives
// switching guests in the side list and coming back. The same runner serves
// the guest row menus (power, snapshots) and the host's reboot / shutdown.

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api, ApiError } from '../../api/client';
import { onServerEvent } from '../../api/events';
import type { ActionFinished, GuestAction, SnapshotArgs } from '../../api/types';
import { t } from '../../lib/i18n';
import { actionText } from './labels';

export const ACTION_TIMEOUT_MS = 90_000;

export interface ActionResult {
  action: GuestAction;
  ok: boolean;
  message: string;
  at: number;
  /** Hub / agent error code ("timeout": the operation still runs on the host). */
  code?: string | null;
}

export interface ActionState {
  pending: { action: GuestAction; actionId: string | null } | null;
  /** Last outcome, shown as a transient chip. */
  result: ActionResult | null;
}

const EMPTY: ActionState = { pending: null, result: null };
const states = new Map<string, ActionState>();
const subs = new Set<() => void>();
// action.finished can arrive before the POST answer; keep the recent ones.
const recentFinished = new Map<string, ActionFinished>();
const waiting = new Map<string, (f: ActionFinished) => void>();
let listening = false;

function key(serverId: string, guestId: string): string {
  return `${serverId}\u0000${guestId}`;
}

function set(k: string, next: ActionState): void {
  states.set(k, next);
  for (const s of subs) s();
}

function ensureListening(): void {
  if (listening) return;
  listening = true;
  onServerEvent('action.finished', (data) => {
    const f = data as unknown as ActionFinished;
    if (!f || typeof f.action_id !== 'string') return;
    const w = waiting.get(f.action_id);
    if (w) {
      waiting.delete(f.action_id);
      w(f);
      return;
    }
    recentFinished.set(f.action_id, f);
    if (recentFinished.size > 50) recentFinished.delete(recentFinished.keys().next().value!);
  });
}

function waitFor(actionId: string, timeoutMs: number): Promise<ActionFinished | null> {
  const early = recentFinished.get(actionId);
  if (early) {
    recentFinished.delete(actionId);
    return Promise.resolve(early);
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiting.delete(actionId);
      resolve(null);
    }, timeoutMs);
    waiting.set(actionId, (f) => {
      clearTimeout(t);
      resolve(f);
    });
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message || t('The hub answered {status}.', { status: err.status });
  return err instanceof Error ? err.message : t('The request failed.');
}

/**
 * Run an action for a guest (HOST_GUEST_ID: the host); resolves with the
 * outcome when it is known (or timed out), or null when another action on
 * the same target is still pending here.
 */
export async function runPowerAction(
  serverId: string,
  guestId: string,
  action: GuestAction,
  opts: { timeoutMs?: number; onDone?: () => void; args?: SnapshotArgs } = {},
): Promise<ActionResult | null> {
  ensureListening();
  const k = key(serverId, guestId);
  const prev = states.get(k) ?? EMPTY;
  if (prev.pending) return null;
  set(k, { pending: { action, actionId: null }, result: null });
  const text = actionText(action);
  let ok = false;
  let message: string;
  let code: string | null = null;
  try {
    const res = await api.guestAction(serverId, guestId, action, opts.args);
    set(k, { pending: { action, actionId: res.action_id }, result: null });
    const f = await waitFor(res.action_id, opts.timeoutMs ?? ACTION_TIMEOUT_MS);
    if (!f) {
      message = t('No result after {n} s; check the guest state and the audit log.', { n: Math.round((opts.timeoutMs ?? ACTION_TIMEOUT_MS) / 1000) });
      code = 'timeout';
    } else {
      ok = f.result === 'ok';
      code = f.code ?? null;
      // Power actions answer without a message; snapshot actions with "snapshot <name>".
      message = ok ? (action.startsWith('snapshot_') || !f.message ? text.done : f.message) : f.message || t('{action} failed', { action: text.label });
    }
  } catch (err) {
    message = errorMessage(err);
    if (err instanceof ApiError) code = err.code ?? null;
  }
  const result: ActionResult = { action, ok, message, at: Date.now(), code };
  set(k, { pending: null, result });
  opts.onDone?.();
  return result;
}

export function clearActionResult(serverId: string, guestId: string): void {
  const k = key(serverId, guestId);
  const cur = states.get(k);
  if (cur?.result) set(k, { ...cur, result: null });
}

export function useActionState(serverId: string, guestId: string): ActionState {
  const k = key(serverId, guestId);
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => states.get(k) ?? EMPTY,
    () => states.get(k) ?? EMPTY,
  );
}

/** What an action can change: the host page, its guest lists, the fleet-wide list and the guest's snapshots. */
export function refreshAfterAction(qc: QueryClient, serverId: string, guestId: string): void {
  for (const queryKey of [['server', serverId], ['guests', serverId], ['guestList'], ['snapshots', serverId, guestId]]) {
    void qc.invalidateQueries({ queryKey });
  }
}

/** Action state plus a runner that refreshes the server afterwards; the result chip clears after 8 s. */
export function usePowerAction(serverId: string, guestId: string) {
  const qc = useQueryClient();
  const state = useActionState(serverId, guestId);
  useEffect(ensureListening, []);
  const run = useCallback(
    (action: GuestAction, args?: SnapshotArgs) =>
      runPowerAction(serverId, guestId, action, {
        args,
        onDone: () => refreshAfterAction(qc, serverId, guestId),
      }),
    [serverId, guestId, qc],
  );
  const resultAt = state.result?.at;
  useEffect(() => {
    if (!resultAt) return;
    const t = setTimeout(() => clearActionResult(serverId, guestId), 8000);
    return () => clearTimeout(t);
  }, [resultAt, serverId, guestId]);
  return { ...state, run };
}
