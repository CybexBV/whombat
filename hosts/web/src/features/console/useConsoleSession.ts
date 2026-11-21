// Console session lifecycle (REMOTE-CONSOLE 3): request a session
// (POST .../console-sessions), open the WebSocket with the single-use token,
// track connecting -> connected -> lost/failed, and close it again when the
// guest, the protocol or the panel changes. Reconnect always creates a new
// session and token. Switching guests passes `switch_from` so the hub audits
// `console.switched` and does not count the old session against the limits.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, consoleSocketUrl } from '../../api/client';
import type { ConsoleProtocol, ConsoleSession } from '../../api/types';
import { toast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { ConsoleTransport, type ConsoleStatus, type TransportCloseInfo } from './transport';

export interface SessionError {
  code: string;
  message: string;
  status?: number;
}

export type SessionPhase =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'connecting'; session: ConsoleSession; transport: ConsoleTransport }
  | { kind: 'connected'; session: ConsoleSession; transport: ConsoleTransport }
  | { kind: 'failed'; error: SessionError; transport: ConsoleTransport | null }
  | { kind: 'lost'; reason: string | null; error: SessionError | null; transport: ConsoleTransport };

export const SESSION_LIMIT_TEXT = t('Too many open consoles. Close one and try again.');

/** User-facing text for the hub's close reasons (CONTRACT 4). */
export function closeReasonText(reason: string | null): string {
  switch (reason) {
    case 'idle_timeout':
      return t('Closed after 15 minutes without input');
    case 'max_age':
      return t('The session reached its maximum age');
    case 'revoked':
      return t('The session was revoked');
    case 'remote_control_disabled':
      return t('Remote control was turned off for this server');
    case 'agent_disconnected':
      return t('The agent disconnected');
    case 'guest_stopped':
      return t('The guest was powered off');
    case 'ended':
      return t('The session ended');
    default:
      return '';
  }
}

function errorOf(err: unknown): SessionError {
  if (err instanceof ApiError) {
    const code = err.code ?? `http_${err.status}`;
    const message = code === 'session_limit' ? SESSION_LIMIT_TEXT : err.message || t('The hub answered {status}.', { status: err.status });
    return { code, message, status: err.status };
  }
  return { code: 'network', message: err instanceof Error ? err.message : t('The hub could not be reached.') };
}

interface Options {
  serverId: string;
  guestId: string;
  /** null = the guest's default protocol (the hub picks it). */
  protocol: ConsoleProtocol | null;
  /** False for stopped guests and missing permissions: no session is requested. */
  enabled: boolean;
}

export interface ConsoleSessionState {
  phase: SessionPhase;
  status: ConsoleStatus | null;
  latencyMs: number | null;
  /** Protocol of the current session (the hub's choice when none was requested). */
  protocol: ConsoleProtocol | null;
  /** New session for the same guest and protocol. */
  reconnect: () => void;
}

export function useConsoleSession({ serverId, guestId, protocol, enabled }: Options): ConsoleSessionState {
  const qc = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<SessionPhase>({ kind: 'idle' });
  const [status, setStatus] = useState<ConsoleStatus | null>(null);
  const [latencyMs, setLatency] = useState<number | null>(null);
  const [actualProtocol, setActualProtocol] = useState<ConsoleProtocol | null>(protocol);
  // The previous session of this panel, kept open until the next session is
  // granted when the user switches guests: the hub then closes it itself with
  // reason "switched" and audits `console.switched`.
  const handover = useRef<{ transport: ConsoleTransport; sessionId: string; guestId: string } | null>(null);

  useEffect(() => {
    setStatus(null);
    setLatency(null);
    setActualProtocol(protocol);
    const prev = handover.current;
    handover.current = null;
    const switchFrom = enabled && prev && prev.guestId !== guestId && prev.transport.state !== 'closed' ? prev.sessionId : null;
    if (prev && !switchFrom) prev.transport.close();
    if (!enabled) {
      setPhase({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    let transport: ConsoleTransport | null = null;
    let session: ConsoleSession | null = null;
    let socketOpened = false;
    setPhase({ kind: 'requesting' });

    api
      .createConsoleSession(serverId, guestId, protocol, switchFrom)
      .then((s) => {
        prev?.transport.close();
        if (cancelled) {
          // The panel moved on before the hub answered: release the unused token.
          void api.closeConsoleSession(s.session_id).catch(() => undefined);
          return;
        }
        session = s;
        setActualProtocol(s.protocol);
        const tr = new ConsoleTransport(consoleSocketUrl(s.url), s.token);
        transport = tr;
        tr.on('open', () => {
          socketOpened = true;
        });
        tr.on('connected', () => setPhase({ kind: 'connected', session: s, transport: tr }));
        tr.on('status', (st) => setStatus({ ...st }));
        tr.on('latency', (ms) => setLatency(ms));
        tr.on('close', (info: TransportCloseInfo) => {
          if (info.byClient || cancelled) return;
          if (info.reason === 'guest_stopped' || info.reason === 'remote_control_disabled' || info.reason === 'revoked') {
            void qc.invalidateQueries({ queryKey: ['server', serverId] });
            void qc.invalidateQueries({ queryKey: ['guests', serverId] });
          }
          if (info.reason === 'switched') return;
          if (!info.wasConnected) {
            setPhase({
              kind: 'failed',
              transport: tr,
              error: info.error ?? {
                code: info.reason ?? 'connect_failed',
                message: closeReasonText(info.reason) || t('The console connection could not be established.'),
              },
            });
            return;
          }
          setPhase({ kind: 'lost', reason: info.reason, error: info.error, transport: tr });
        });
        setPhase({ kind: 'connecting', session: s, transport: tr });
      })
      .catch((err: unknown) => {
        prev?.transport.close();
        if (cancelled) return;
        const e = errorOf(err);
        if (e.code === 'session_limit') toast(SESSION_LIMIT_TEXT, 'error');
        if (e.code === 'guest_not_running' || e.code === 'console_disabled' || e.code === 'power_disabled') {
          void qc.invalidateQueries({ queryKey: ['server', serverId] });
          void qc.invalidateQueries({ queryKey: ['guests', serverId] });
        }
        setPhase({ kind: 'failed', error: e, transport: null });
      });

    return () => {
      cancelled = true;
      const tr = transport as ConsoleTransport | null;
      const s = session as ConsoleSession | null;
      if (tr && s && socketOpened && tr.state !== 'closed') {
        // Hand the live session to the next run (closed there, or on unmount).
        handover.current = { transport: tr, sessionId: s.session_id, guestId };
        return;
      }
      tr?.close();
      // A token that never reached the WebSocket still counts against the limits for 30 s.
      if (s && !socketOpened) void api.closeConsoleSession(s.session_id).catch(() => undefined);
    };
  }, [serverId, guestId, protocol, enabled, attempt, qc]);

  // Leaving the console: close whatever is still handed over.
  useEffect(
    () => () => {
      handover.current?.transport.close();
      handover.current = null;
    },
    [],
  );

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  return { phase, status, latencyMs, protocol: actualProtocol, reconnect };
}
