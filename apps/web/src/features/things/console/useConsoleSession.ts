/**
 * A console session's life (ported from Rackoon's `useConsoleSession`; the session part of ONE-13's `ConsoleSession`):
 * `hosts.createConsole` gives a single-use token (30 s), the transport opens on Whombat's WebSocket path, or on the
 * session's console stream for a box reached through the relay (contracts 0.80.1), and the phase goes starting →
 * connecting → connected → ended (with the words for why). A new attempt is a new session; a token that never reached
 * the socket is handed back; switching guests or protocols, or closing, ends the session.
 */
import {
  consoleCloseText,
  consoleSocketUrl,
  consoleSubprotocols,
  hostErrorInfo,
} from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import type { HostConsoleProtocol, HostConsoleSession } from '@whombat/core/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalAppServices } from '../../../app/providers';
import { ConsoleTransport } from './transport';

export type SessionPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'connecting'; transport: ConsoleTransport; session: HostConsoleSession }
  | { kind: 'connected'; transport: ConsoleTransport; session: HostConsoleSession }
  /** `ended`: the shell exited (logout, Ctrl+D) rather than something going wrong. */
  | { kind: 'ended'; message: string; ended?: boolean };

export interface ConsoleSessionState {
  phase: SessionPhase;
  latencyMs: number | null;
  resolution: string | null;
  reconnect: () => void;
}

export function useConsoleSession({
  burrow,
  serverId,
  guestId,
  protocol,
  enabled,
}: {
  burrow: string;
  serverId: string;
  guestId?: string;
  protocol: HostConsoleProtocol | null;
  /** False for a stopped guest or a switched-off console: no session is asked for. */
  enabled: boolean;
}): ConsoleSessionState {
  const create = useHostsChange(api.hosts.createConsole);
  const close = useHostsChange(api.hosts.closeConsole);
  const services = useOptionalAppServices();
  const servicesRef = useRef(services);
  servicesRef.current = services;
  const createRef = useRef(create.mutateAsync);
  createRef.current = create.mutateAsync;
  const closeRef = useRef(close.mutateAsync);
  closeRef.current = close.mutateAsync;
  const [phase, setPhase] = useState<SessionPhase>({ kind: enabled ? 'starting' : 'idle' });
  const [latencyMs, setLatency] = useState<number | null>(null);
  const [resolution, setResolution] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new session per attempt
  useEffect(() => {
    setLatency(null);
    setResolution(null);
    if (!enabled) {
      setPhase({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    let transport: ConsoleTransport | null = null;
    let session: HostConsoleSession | null = null;
    let opened = false;
    setPhase({ kind: 'starting' });
    createRef
      .current({
        params: { burrow, serverId },
        body: { ...(guestId ? { guestId } : {}), ...(protocol ? { protocol } : {}) },
      })
      .then((r) => {
        if (r.status !== 'ok') {
          setPhase({
            kind: 'ended',
            message: r.status === 'pending_approval' ? 'That needs an approval first.' : r.message,
          });
          return;
        }
        session = r.data;
        if (cancelled) {
          void closeRef.current({ params: { burrow, sessionId: r.data.sessionId } }).catch(() => undefined);
          return;
        }
        const s = r.data;
        const appSession = servicesRef.current?.session;
        const viaSession = appSession ?? null;
        const tr = new ConsoleTransport(
          consoleSocketUrl(s, window.location.origin),
          consoleSubprotocols(s),
          viaSession
            ? {
                socket: () => {
                  const socket = viaSession.openConsole({ burrow, sessionId: s.sessionId, token: s.token });
                  if (!socket) throw new Error('This Whombat can’t open consoles from here yet.');
                  return socket;
                },
              }
            : {},
        );
        transport = tr;
        tr.on('open', () => {
          opened = true;
        });
        tr.on('connected', () => setPhase({ kind: 'connected', transport: tr, session: s }));
        tr.on('latency', setLatency);
        tr.on('status', (st) => setResolution(st.resolution?.replace('x', '×') ?? null));
        tr.on('close', (info) => {
          if (info.byClient || cancelled) return;
          setPhase({
            kind: 'ended',
            ended: info.reason === 'ended',
            message:
              consoleCloseText(info.reason) ||
              info.error?.message ||
              (info.wasConnected ? 'The console closed.' : 'The console couldn’t connect.'),
          });
        });
        setPhase({ kind: 'connecting', transport: tr, session: s });
      })
      .catch((err: unknown) => {
        if (!cancelled) setPhase({ kind: 'ended', message: hostErrorInfo(err).message });
      });
    return () => {
      cancelled = true;
      transport?.close();
      const s = session as HostConsoleSession | null;
      if (s && !opened)
        void closeRef.current({ params: { burrow, sessionId: s.sessionId } }).catch(() => undefined);
    };
  }, [burrow, serverId, guestId, protocol, enabled, attempt]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  return { phase, latencyMs, resolution, reconnect };
}
