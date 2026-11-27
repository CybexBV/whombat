/**
 * Google's, Microsoft 365's and the other builtin connections' words (docs/decisions/connectors.md CN-03…CN-06; app
 * phone-connect.md PC-02, AP-2909): why an account needs connecting again, what a sign-in's `connect_error=` means, a
 * service's check, the list of services, and the account card's words the web's pages and the phone's account screens
 * share. Pure.
 */
import {
  type ConnectErrorCode,
  type ConnectionCheck,
  type ConnectorProvider,
  type ConnectorService,
  providerServiceLabels,
  type ReauthReason,
} from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { CONN_ACCOUNTS_WORDS } from '../i18n/messages/connectionsHosts/connections';

/** The line under a connection that needs connecting again, by why. */
export function reauthReasonText(locale?: string | null): Record<ReauthReason, string> {
  return { ...clientTree(locale, CONN_ACCOUNTS_WORDS).reauth };
}

export const REAUTH_TEXT: Record<ReauthReason, string> = reauthReasonText('en');

/** What the callback's `connect_error=` means, and what to do. */
export function connectErrorTexts(locale?: string | null): Record<ConnectErrorCode, string> {
  return { ...clientTree(locale, CONN_ACCOUNTS_WORDS).connectError };
}

export const CONNECT_ERROR_TEXT: Record<ConnectErrorCode, string> = connectErrorTexts('en');

/** `connect_error=` for Google or Microsoft: a code of theirs, or the closest one for anything else. */
export function connectErrorText(code: string, locale?: string | null): string {
  const texts = connectErrorTexts(locale);
  return texts[code as ConnectErrorCode] ?? texts.exchange_failed;
}

/** The state part of one service's line (“Working”, “API turned off in your Google project”…). */
export function checkText(check: ConnectionCheck, locale?: string | null): string {
  const w = clientTree(locale, CONN_ACCOUNTS_WORDS).check;
  switch (check.state) {
    case 'ok':
      return w.ok;
    case 'api_disabled':
      return w.api_disabled;
    case 'no_scope':
      return w.no_scope;
    default:
      return check.message ? interpolate(w.failedWhy, { message: check.message }) : w.failed;
  }
}

/** “Gmail, Google Calendar and Google Drive”; Microsoft's by their names there (“Outlook Mail and OneDrive”). */
export function serviceList(
  services: readonly ConnectorService[],
  provider: ConnectorProvider = 'google',
  locale?: string | null,
): string {
  const labels = providerServiceLabels(locale)[provider];
  const names = services.map((s) => labels[s]);
  if (names.length <= 1) return names.join('');
  return interpolate(clientTree(locale, CONN_ACCOUNTS_WORDS).list, {
    items: names.slice(0, -1).join(', '),
    last: names.at(-1) ?? '',
  });
}

/** The account card's words (the web's Google and Microsoft 365 pages). */
export function accountText(locale?: string | null) {
  const w = clientTree(locale, CONN_ACCOUNTS_WORDS).account;
  return {
    ...w,
    setUpFirst: (name: string) => interpolate(w.setUpFirst, { name }),
    connect: (name: string) => interpolate(w.connect, { name }),
    continueTo: (name: string) => interpolate(w.continueTo, { name }),
    disconnectNamed: (name: string) => interpolate(w.disconnectNamed, { name }),
    disconnected: (name: string) => interpolate(w.disconnected, { name }),
    connectedAs: (name: string, email: string) => interpolate(w.connectedAs, { name, email }),
    couldNotStart: (name: string) => interpolate(w.couldNotStart, { name }),
  };
}

export const ACCOUNT_TEXT = accountText('en');
