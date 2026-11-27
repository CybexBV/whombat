import { ApiError, InvalidRequestError, problemText, withBurrow } from '@whombat/client';
import { holdGoogleConnect, licenceRefusalText } from '@whombat/client/managed';
import { useConnectors, useStartGoogleConnection } from '@whombat/client/react';
import type { ConnectorService, ConnectorsStatus } from '@whombat/core/domain';
import { useState } from 'react';
import { useManaged } from '../../app/providers';
import { useWebI18n } from '../../i18n/provider';

/** Where Google sends the browser back to: this burrow's Settings → Connections → Google (naming the burrow, AP-365). */
export function connectionsPath(burrow: string): string {
  return withBurrow('/settings?tab=connections&connection=google', burrow);
}

/** Google can be connected here: the app is set up (or the fake Google needs none) and Google isn't off. */
export function googleConnectable(status: ConnectorsStatus | undefined): boolean {
  if (!status || status.mode === 'off') return false;
  return status.mode === 'fake' || status.google.app.configured;
}

const COULD_NOT_START = 'Couldn’t start connecting Google. Try again in a moment.';

export interface ConnectGoogleOptions {
  /**
   * Where Google sends the browser back to (a path on this Whombat). Default: Settings → Connections. A guide's
   * connect card passes its server-made `returnTo` unchanged (the DM with the guide marker, AG-08).
   */
  returnTo?: string;
  /** This tab's storage for the managed return (tests). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

/**
 * Starts connecting Google for the ticked services: asks the server for the consent URL and leaves for it
 * (a full-page navigation). `problem` is the server's refusal (Google not set up, turned off).
 *
 * On a managed Whombat Google returns to the hosted UI's `/connect/google` (AG-14): which Whombat started the
 * connect, and where it comes back to, is held in this tab's `sessionStorage` first, so that route can reopen it.
 */
export function useConnectGoogle(
  burrow: string,
  navigate?: (url: string) => void,
  options: ConnectGoogleOptions = {},
) {
  const { tag: uiLocale } = useWebI18n();
  const start = useStartGoogleConnection(navigate);
  const [problem, setProblem] = useState<string | null>(null);
  const managed = useManaged();
  const returnTo = options.returnTo ?? connectionsPath(burrow);
  async function connect(services: readonly ConnectorService[]) {
    setProblem(null);
    // Google's answer goes only to the Whombat that started the connect (AG-14): when this tab can't hold which one
    // that is (its storage full or off), the connect doesn't start (AP-592).
    const held =
      !managed ||
      holdGoogleConnect(options.storage ?? (() => sessionStorage), { device: managed.applianceId, returnTo });
    if (!held) {
      setProblem(COULD_NOT_START);
      return;
    }
    try {
      await start.mutateAsync({ body: { services: [...services], returnTo } });
    } catch (err) {
      const licence = licenceRefusalText(err, uiLocale);
      if (licence) setProblem(licence);
      else if (err instanceof ApiError || err instanceof InvalidRequestError)
        setProblem(problemText(err, undefined, uiLocale));
      else setProblem(COULD_NOT_START);
    }
  }
  // Stays busy after success: the page is about to leave for Google.
  return { connect, busy: start.isPending || start.isSuccess, problem };
}

/** The connectors status, shared by the tab and the callout. */
export function useConnectorsStatus() {
  return useConnectors({}, { retry: false });
}
