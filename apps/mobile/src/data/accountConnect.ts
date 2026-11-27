/**
 * The builtin connections' screens on the phone (phone-connect.md PC-02, PC-05, PC-06; AP-2909, AP-2910): Google and
 * Microsoft 365 — the person's own account, connected here with the services they tick, the sign-in in the browser —
 * Email (IMAP), GitHub and Website feedback. What each says and whether it may connect, in the web's words
 * (`@whombat/client/connections` `ACCOUNT_TEXT`, `REAUTH_TEXT`, `serviceList`; `IMAP_COPY`). Pure.
 */
import {
  accountText,
  checkText,
  connectErrorText,
  reauthReasonText,
  serviceList,
} from '@whombat/client/connections';
import {
  CONNECTOR_SERVICES,
  type Connection,
  type ConnectionCheck,
  type ConnectorService,
  type ConnectorsStatus,
  catalogEntry,
  MICROSOFT_SERVICES,
  type Tone,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { AccountPage } from '../navigation/connectionLinks';

/** The two accounts connected through a sign-in elsewhere. */
export type AccountProvider = 'google' | 'microsoft';

export function isAccountProvider(page: string): page is AccountProvider {
  return page === 'google' || page === 'microsoft';
}

/** A page's name and line, from the catalog (“Google”, “Microsoft 365”, “Email (IMAP)”, “GitHub”, “Website feedback”). */
export function accountHead(page: AccountPage): { name: string; description: string } {
  const entry = catalogEntry(page);
  return { name: entry?.name ?? page, description: entry?.description ?? '' };
}

/** The services a provider offers, in its order. */
export function providerServices(provider: AccountProvider): readonly ConnectorService[] {
  return provider === 'google' ? CONNECTOR_SERVICES : MICROSOFT_SERVICES;
}

/**
 * Whether the person can connect it here: accounts aren't turned off, and the provider's app is set up (Google's fake
 * mode needs none); Microsoft 365 only on a Whombat that has it.
 */
export function providerConnectable(
  status: ConnectorsStatus | undefined,
  provider: AccountProvider,
): boolean {
  if (!status || status.mode === 'off') return false;
  if (provider === 'google') return status.mode === 'fake' || status.google.app.configured;
  return !!status.microsoft?.app.configured;
}

/** The person's account of a provider, if connected. */
export function providerConnection(
  status: ConnectorsStatus | undefined,
  provider: AccountProvider,
): Connection | null {
  return status?.connections.find((c) => c.provider === provider) ?? null;
}

/** “Connected as Mara Okafor · Gmail, Google Calendar and Google Drive”, or why it needs connecting again. */
export function accountLine(connection: Connection, provider: AccountProvider, locale?: string): string {
  const text = accountText(locale);
  if (connection.status !== 'active')
    return provider === 'google'
      ? reauthReasonText(locale)[connection.reauthReason ?? 'revoked']
      : text.needsConnecting;
  const services = serviceList(connection.services, provider, locale);
  return connection.name
    ? mobileTranslator(locale).t('data.accountConnect.connectedAs', {
        connected: text.connected,
        name: connection.name,
        services,
      })
    : `${text.connected} · ${services}`;
}

/** What a sign-in's `connect_error=` means on the provider's screen (Microsoft's says Microsoft, as the web's). */
export function accountErrorText(
  provider: AccountProvider,
  code: string | null | undefined,
  locale?: string,
): string | null {
  if (!code) return null;
  const text = connectErrorText(code, locale);
  return provider === 'microsoft' ? text.replaceAll('Google', 'Microsoft') : text;
}

/** What Disconnect asks first. */
export function disconnectAsk(provider: AccountProvider, locale?: string): string {
  const text = accountText(locale);
  return provider === 'google' ? text.disconnectGoogle : text.disconnectMicrosoft;
}

/** A service's check: its tone and words (Google's `checkText`; Microsoft's Ready or why). */
export function checkLine(
  check: ConnectionCheck,
  provider: AccountProvider,
  locale?: string,
): { tone: Tone; text: string } {
  const tone: Tone = check.state === 'ok' ? 'ok' : check.state === 'error' ? 'bad' : 'warn';
  if (provider === 'google') return { tone, text: checkText(check, locale) };
  const { t } = mobileTranslator(locale);
  return {
    tone,
    text:
      check.state === 'ok'
        ? t('data.accountConnect.ready')
        : (check.message ?? t('data.accountConnect.needsAttention')),
  };
}

/**
 * The services ticked when Reconnect opens: what is connected (it stays; more can be added), or all of them.
 */
export function reconnectServices(
  connection: Connection | null,
  provider: AccountProvider,
): ConnectorService[] {
  const all = providerServices(provider);
  return connection && connection.services.length > 0 ? [...connection.services] : [...all];
}

/** GitHub's and Website feedback's screens: set up in Whombat on a computer, said once (AP-2910). */
export function builtinText(locale?: string) {
  const { t, tp } = mobileTranslator(locale);
  return {
    github: {
      connected: (login: string | null, repos: number) =>
        [login ? `@${login}` : null, tp('data.accountConnect.repositories', repos)]
          .filter(Boolean)
          .join(' · '),
      notConnected: t('data.accountConnect.notConnected'),
      off: t('data.accountConnect.githubOff'),
      // Every repository the account owns comes with it, nothing to pick.
      elsewhere: t('data.accountConnect.githubElsewhere'),
    },
    feedback: {
      none: t('data.accountConnect.noWebsites'),
      elsewhere: t('data.accountConnect.websitesElsewhere'),
    },
  };
}

export const BUILTIN_TEXT = builtinText();
