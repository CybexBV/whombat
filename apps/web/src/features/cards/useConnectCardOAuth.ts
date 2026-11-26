import { CONNECT_FORM_TEXT, cardOAuthStartBody } from '@whombat/client/connections';
import { holdGoogleConnect, licenceRefusalText } from '@whombat/client/managed';
import { useConnectionWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import type { GuideConnectOAuth } from '@whombat/core/domain';
import { useState } from 'react';
import { useManaged } from '../../app/providers';
import { connectProblem } from '../connectors/catalog';

export interface UseConnectCardOAuth {
  start: () => Promise<void>;
  busy: boolean;
  problem: string | null;
}

/**
 * Starts an `add_connection` card's OAuth sign-in directly from the card (without detouring through Settings) and
 * returns to the card's `returnTo` thread on callback.
 */
export function useConnectCardOAuth(
  burrow: string,
  oauth: GuideConnectOAuth | undefined,
  leave: (url: string) => void = (url) => window.location.assign(url),
): UseConnectCardOAuth {
  const startOAuth = useConnectionWrite(api.connections.startOAuth, burrow);
  const managed = useManaged();
  const [problem, setProblem] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  async function start() {
    if (!oauth || startOAuth.isPending || leaving) return;
    setProblem(null);
    if (
      managed &&
      !holdGoogleConnect(() => sessionStorage, {
        device: managed.applianceId,
        returnTo: oauth.returnTo,
        flow: 'connection',
      })
    ) {
      setProblem(CONNECT_FORM_TEXT.cantStart);
      return;
    }
    try {
      const result = await startOAuth.mutateAsync({
        params: { burrow },
        body: cardOAuthStartBody(oauth),
      });
      if (result.status !== 'ok') {
        setProblem(CONNECT_FORM_TEXT.notThrough);
        return;
      }
      setLeaving(true);
      leave(result.data.authorizeUrl);
    } catch (err) {
      const licence = licenceRefusalText(err);
      if (licence) setProblem(licence);
      else setProblem(connectProblem(err).message ?? CONNECT_FORM_TEXT.cantStart);
    }
  }

  return { start, busy: startOAuth.isPending || leaving, problem };
}
