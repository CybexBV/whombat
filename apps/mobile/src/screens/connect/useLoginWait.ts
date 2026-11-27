/**
 * Asking a sign-in in the browser until it hands over (CX-11; SG-01, SG-02; connection-signin-android.md AP-3952): one
 * loop for Nextcloud's login and the service's own page (Plex's), shared by Connect {Name} and a connection's SIGN-IN.
 * Every `pollEveryMs` it polls the flow (`connections.pollNextcloud` or `connections.pollServiceLogin`, the same answer)
 * until it connects, fails, or the flow's deadline passes. The loop reads the latest handlers, so it runs once per flow.
 */
import { connectProblem } from '@whombat/client/connections';
import { useConnectionWrite } from '@whombat/client/react';
import type { ConnectionView } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useEffect, useRef } from 'react';
import { type PendingLogin, waitEnds, waitStep, waitWords } from '../../data/connectForm';
import { useI18n } from '../../i18n';

export interface LoginWaitHandlers {
  onConnected: (connection: ConnectionView) => void | Promise<void>;
  /** The wait ended without a connection: why, in the person's words. */
  onFailed: (message: string) => void;
}

export function useLoginWait(slug: string, login: PendingLogin | null, handlers: LoginWaitHandlers) {
  const { rawLocale } = useI18n();
  const nextcloud = useConnectionWrite(api.connections.pollNextcloud, slug);
  const service = useConnectionWrite(api.connections.pollServiceLogin, slug);
  const latest = useRef({ handlers, nextcloud: nextcloud.mutateAsync, service: service.mutateAsync });
  latest.current = { handlers, nextcloud: nextcloud.mutateAsync, service: service.mutateAsync };

  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ends = waitEnds(login, Date.now());
    const tick = async () => {
      if (stopped) return;
      const now = latest.current;
      if (Date.now() >= ends) return now.handlers.onFailed(waitWords(login, rawLocale).tooLong);
      try {
        const params = { params: { flowId: login.flow.flowId } };
        const result = await (login.kind === 'nextcloud' ? now.nextcloud(params) : now.service(params));
        if (stopped || result.status !== 'ok') return;
        const step = waitStep(login, result.data, rawLocale);
        if (step.kind === 'connected') return void (await now.handlers.onConnected(step.connection));
        if (step.kind === 'failed') return now.handlers.onFailed(step.message);
      } catch (err) {
        if (!stopped)
          now.handlers.onFailed(
            connectProblem(err, undefined, undefined, rawLocale).message ??
              waitWords(login, rawLocale).failed,
          );
        return;
      }
      timer = setTimeout(() => void tick(), login.flow.pollEveryMs);
    };
    timer = setTimeout(() => void tick(), login.flow.pollEveryMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [login, rawLocale]);
}
