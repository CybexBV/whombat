/**
 * A provider's answer to a sign-in started on this phone, finished (phone-connect.md PC-05, PC-10; AP-2906): once this
 * Whombat's session is open, the code and state go to it once (`connections.finishOAuth`, or Google's and Microsoft's
 * own), the way the web's `/connect/…` route does (`finishGoogleConnection`, `googleFinishStep`). Then “{Name} connected.”
 * and the connection's page — replacing Connect {Name} when that is on top — or, refused, the entry's form saying why.
 * A session that can't get through gives up with `exchange_failed`, so the screen never waits for ever.
 */
import { StackActions } from '@react-navigation/native';
import { finishGoogleConnection, type GoogleReturn, googleFinishStep } from '@whombat/client/managed';
import type { ApplianceSession, ConnectionState } from '@whombat/client/session';
import { catalogEntry } from '@whombat/core';
import { useEffect } from 'react';
import {
  connectOutcome,
  failedReturnUrl,
  onConnectReturn,
  type PendingConnectReturn,
  takeConnectReturn,
  thingOfUrl,
} from '../managed/connectReturn';
import { useManaged } from '../managed/context';
import { showNotice } from '../screens/feedback';
import { navigationRef, openAppUrl } from './hooks';
import { appUrlForPath } from './routes';

/** Opens what the Whombat answered: a connection's page in place of Connect {Name}, else as a link would. */
function open(url: string) {
  const top = navigationRef.isReady() ? navigationRef.getCurrentRoute() : undefined;
  const thingId = top?.name === 'Connect' ? thingOfUrl(url) : null;
  if (thingId) {
    navigationRef.dispatch(StackActions.replace('Thing', { thingId }));
    return;
  }
  openAppUrl(url);
}

/** Sends the answer once the session is open (only once); gives up when it can't get through. */
function finish(session: ApplianceSession, item: PendingConnectReturn): () => void {
  let sent = false;
  const done = (returnPath: string) => {
    const outcome = connectOutcome(returnPath);
    if (outcome.connected && !outcome.error) {
      const name = catalogEntry(outcome.connected)?.name ?? outcome.connected;
      showNotice(`${name} connected.`);
    }
    open(appUrlForPath(returnPath));
  };
  const failed = () => open(failedReturnUrl(item.entry));
  const step = (state: ConnectionState) => {
    const next = googleFinishStep(state, sent);
    if (next === 'wait') return;
    // Sent, or given up on: either way the code goes no further.
    sent = true;
    if (next === 'give_up') failed();
    else finishGoogleConnection(session, item.back as GoogleReturn).then(done, failed);
  };
  step(session.state());
  return session.onState(step);
}

export function ConnectReturnBridge() {
  const managed = useManaged();
  const device = managed?.applianceId ?? null;
  const session = managed?.session ?? null;
  useEffect(() => {
    if (!device || !session) return;
    const stops: (() => void)[] = [];
    const pending = takeConnectReturn(device);
    if (pending) stops.push(finish(session, pending));
    const off = onConnectReturn((item) => {
      if (item.device !== device) return false;
      stops.push(finish(session, item));
      return true;
    });
    return () => {
      off();
      for (const stop of stops) stop();
    };
  }, [device, session]);
  return null;
}
