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
  type ReauthReason,
  serviceLabel,
} from '@whombat/core/domain';

/** The line under a connection that needs connecting again, by why. */
export const REAUTH_TEXT: Record<ReauthReason, string> = {
  revoked: 'Google signed Whombat out of this account. Sign in again to keep using it.',
  testing_expired:
    'Google signed you out after 7 days because this Whombat’s Google app is still in Testing. Sign in again, and publish the app in Google Cloud.',
  app_removed: 'This Whombat’s Google app was removed or replaced. Sign in again.',
  scope_missing: 'Google didn’t allow everything Whombat needs. Sign in again and keep the services ticked.',
  // An IMAP account's servers refused the stored password (0.97, CM-D03); its page says it in its own words.
  password_refused: 'The mail server no longer accepts the password. Enter it again to keep using it.',
};

/** What the callback's `connect_error=` means, and what to do. */
export const CONNECT_ERROR_TEXT: Record<ConnectErrorCode, string> = {
  access_denied: 'Google didn’t connect: access wasn’t allowed. Try again and choose Allow.',
  invalid_state: 'That sign-in expired or was already used. Try signing in again.',
  exchange_failed:
    'Google didn’t finish the sign-in. Try again; if it keeps failing, check the Client ID and secret.',
  no_app: 'Google isn’t set up on this Whombat. Set it up in Settings → Connections first.',
};

/** `connect_error=` for Google or Microsoft: a code of theirs, or the closest one for anything else. */
export function connectErrorText(code: string): string {
  return CONNECT_ERROR_TEXT[code as ConnectErrorCode] ?? CONNECT_ERROR_TEXT.exchange_failed;
}

/** The state part of one service's line (“Working”, “API turned off in your Google project”…). */
export function checkText(check: ConnectionCheck): string {
  switch (check.state) {
    case 'ok':
      return 'Working';
    case 'api_disabled':
      return 'API turned off in your Google project';
    case 'no_scope':
      return 'Not allowed when you connected · Reconnect and tick it';
    default:
      return check.message ? `Couldn’t check: ${check.message}` : 'Couldn’t check';
  }
}

/** “Gmail, Google Calendar and Google Drive”; Microsoft's by their names there (“Outlook Mail and OneDrive”). */
export function serviceList(
  services: readonly ConnectorService[],
  provider: ConnectorProvider = 'google',
): string {
  const names = services.map((s) => serviceLabel(s, provider));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The account card's words (the web's Google and Microsoft 365 pages). */
export const ACCOUNT_TEXT = {
  yourAccount: 'YOUR ACCOUNT',
  notConnected: 'Not connected',
  connected: 'Connected',
  needsConnecting: 'Needs you to sign in again',
  pickServices: 'Your agent works with the services you tick, as you, when you ask. You can add more later.',
  keepServices: 'Services you connected stay connected. Disconnect removes them all.',
  tickOne: 'Tick at least one service.',
  off: 'Connecting accounts is turned off on this Whombat.',
  setUpFirst: (name: string) => `Set up ${name} first, in Settings → Connections.`,
  connect: (name: string) => `Connect ${name}`,
  reconnect: 'Reconnect',
  continueTo: (name: string) => `Continue to ${name}`,
  disconnect: 'Disconnect',
  disconnectNamed: (name: string) => `Disconnect ${name}`,
  disconnectGoogle:
    'Disconnect Google? Your agent can’t use your mail, calendar and files until you connect again.',
  disconnectMicrosoft:
    'Disconnecting removes access from this Whombat. To revoke consent at Microsoft too, remove Whombat in your Microsoft account’s application permissions. Word and Excel files can be downloaded; native editing is not available.',
  disconnected: (name: string) => `${name} disconnected.`,
  connectedAs: (name: string, email: string) => `${name} connected: ${email}.`,
  cancel: 'Cancel',
  checkAgain: 'Check again',
  checking: 'Checking…',
  notChecked: 'Not checked yet',
  microsoftUpdate: 'Update this Whombat to connect Microsoft 365.',
  couldNotStart: (name: string) => `Couldn’t start connecting ${name}. Try again in a moment.`,
} as const;
