/**
 * The words of the guides (docs/decisions/assistant-guides.md AG-04…AG-13), in one place. Verbatim from the spec
 * where it gives them; the Google setup steps and troubleshooting reuse the Settings panel's copy (CN-03, CN-06).
 * Plain text only (guide cards are never Markdown): curly quotes, no `@`.
 */
import type { ConnectErrorCode, ConnectionCheck, ConnectorService, ReauthReason } from '@whombat/core';

export type ConnectTopic = 'email' | 'calendar' | 'files';
/** Where a Google setup started: a connect topic, or nothing in particular (the setup on its own). */
export type Origin = ConnectTopic | 'none';

export const ORIGINS: readonly Origin[] = ['email', 'calendar', 'files', 'none'];

/** “A, B and C”. */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/* Welcome (AG-04; built from what the box found, first-day.md) ------------------------------------------- */

/** What the assistant can do, said once in the welcome when nothing was found to name yet. */
const CAN_DO = 'I can look after your servers, your network and your home, and help with your email.';

/** The welcome when the network scan found things: what, and the one question. */
export function welcomeFoundText(firstName: string, agentName: string, found: string, one: boolean): string {
  return `Hi ${firstName}, I’m ${agentName}. I found ${found} on your network. Want me to look after ${one ? 'it' : 'them'}?`;
}
/** The welcome while the first scan is still looking: what it can do, and that the finds come later. */
export function welcomeLookingText(firstName: string, agentName: string): string {
  return `Hi ${firstName}, I’m ${agentName}. ${CAN_DO} I’m looking around your network now and I’ll tell you what I find.`;
}
/** The welcome with nothing found and no scan coming (it was put away, or this Whombat doesn't scan by itself). */
export function welcomeQuietText(firstName: string, agentName: string): string {
  return `Hi ${firstName}, I’m ${agentName}. ${CAN_DO} Tell me what you’d like me to look after.`;
}
/** The scan's finds after the welcome went out without them: one message. */
export function foundLaterText(found: string, one: boolean): string {
  return `I looked around your network and found ${found}. Want me to look after ${one ? 'it' : 'them'}?`;
}
export const FOUND_TITLE = 'Found on your network';
export function foundBody(one: boolean): string {
  return one
    ? 'Connect it, and I’ll keep an eye on it.'
    : 'Connect the ones you want, and I’ll keep an eye on them.';
}
export function seeAllLabel(n: number): string {
  return `See all ${n}`;
}
/** Mail second: other email first, Google reachable (it needs the person's own Google app today). */
export const MAIL_TITLE = 'Your email';
export const MAIL_BODY = 'I can read, sort and draft replies. I always ask before I send anything.';
export const MAIL_OTHER = 'Other email (IMAP)';
export const MAIL_GOOGLE = 'Gmail or Google Workspace';
export const MAYBE_LATER = 'Maybe later';

/* Connect topics (AG-05) ----------------------------------------------------------------------- */

export const CONNECT_INTRO_TEXT =
  'I’ll guide you through it. You only do this once; after that it keeps working.';
export const CONNECT_TITLES: Record<ConnectTopic, string> = {
  email: 'Connect your email',
  calendar: 'Connect your calendar',
  files: 'Connect your files',
};
export const CONNECT_INTRO_BODY = 'Which one do you use?';
export const GOOGLE_OPTION_DESCRIPTION: Record<ConnectTopic, string> = {
  email: 'Gmail or Google Workspace. I can also use your calendar and files if you like.',
  calendar: 'Google Calendar or Google Workspace. I can also use your mail and files if you like.',
  files: 'Google Drive or Google Workspace. I can also use your mail and calendar if you like.',
};
export const COMING_SOON = 'Coming soon';
export const MICROSOFT_OPTION = { title: 'Microsoft 365', description: 'Outlook and Exchange' };
export const OTHER_EMAIL_OPTION = { title: 'Other email', description: 'Any provider with IMAP' };
/** “Other email” (CM-19): the mailbox is connected in Settings, where its password is typed, never in chat. */
export const OTHER_EMAIL_TEXT =
  'You can connect any other mailbox in Settings → Connections → Email (IMAP): your address and its password, or an app password if your provider has them. Once it’s connected I can read, sort and draft your email.';

export const GOOGLE_OFF_TEXT = 'Connecting accounts is turned off on this Whombat.';
export const NOT_NOW = 'Not now';

export const CONNECT_TITLE = 'Connect Google';
export const CONNECT_BODY =
  'Google asks you to sign in and to allow what’s ticked. I use it only for you, and I always ask before I send anything or change your calendar.';
export const RECONNECT_TITLE = 'Reconnect Google';

/* The Google app setup (AG-06, CN-03) ----------------------------------------------------------- */

export const APP_INTRO_TEXT =
  'First, Google needs to know about this Whombat. It’s a one-time setup and takes about ten minutes. I’ll give you every link and value you need.';
export const APP_AUDIENCE_TITLE = 'Who will connect their accounts?';
export const AUDIENCE_OPTIONS = {
  external: { title: 'A personal Gmail account', description: 'Anyone with a Google account can connect.' },
  internal: { title: 'A Google Workspace domain', description: 'Only people in your Workspace domain.' },
} as const;
export const APP_IN_CONFIG_TEXT =
  'Google is set in this Whombat’s config, so there’s nothing to set up here.';
export const APP_ALREADY_TEXT = 'Google is already set up on this Whombat.';

export const DONE_NEXT = 'Done, next step';
export const STUCK = 'I’m stuck';
export const SHOW_AGAIN = 'Show the step again';

export const STEP_TITLES = [
  'Create a project',
  'Turn on the APIs',
  'Configure the consent screen',
  'Create the OAuth client',
  'Paste the Client ID and secret',
  'Test it',
] as const;
export const STEP_BODIES = {
  project:
    'Create a Google Cloud project for this Whombat, or pick one you already use. It holds the app you see when you connect.',
  apis: 'One link turns on the Gmail, Calendar, Drive, Docs, Sheets and People APIs in that project.',
  consentExternal:
    'Fill in the app information with the values below and choose Audience External. Then open Audience and choose Publish app, so it says “In production”: in Testing, Google signs you out after 7 days. When you connect, Google shows “Google hasn’t verified this app”. That’s expected for your own app: choose Advanced, then Go to Whombat.',
  consentInternal:
    'Fill in the app information with the values below and choose Audience Internal. Only people in your Workspace domain can connect: there’s no warning screen and nothing to publish.',
  client: 'Create a client of type Web application. Under Authorized redirect URIs, add this URI exactly:',
  paste:
    'Paste them from the client’s page in Google Cloud, or drop the client_secret_….json you downloaded. They go straight to this Whombat and never into this chat.',
  test: 'Connect your own Google account. This step is done once a connection works.',
} as const;
export const STEP_LINKS = {
  createProject: 'Create a project',
  enableApis: 'Turn on the APIs',
  consentScreen: 'Open the consent screen',
  audience: 'Open Audience',
  createClient: 'Create the client',
} as const;
export const FORM_FIELDS = {
  clientId: { label: 'Client ID', placeholder: '1234567890-abc.apps.googleusercontent.com' },
  clientSecret: { label: 'Client secret', placeholder: 'GOCSPX-…' },
  clientJson: { label: 'Or the downloaded JSON file', placeholder: 'client_secret_….json' },
} as const;
export const FORM_SUBMIT = 'Save';
export const SAVED_TEXT = 'Saved. Now connect your own Google account to test it.';

/** The Settings panel's checks of a pasted client (CN-03 step 5, whombat-app `connectors/copy.ts`). */
export const DESKTOP_CLIENT_ERROR = 'This is a Desktop app client. Create one of type Web application.';
export const NOT_A_CLIENT_FILE = 'That isn’t the client_secret JSON file Google lets you download.';
export const CLIENT_ID_MISSING = 'Paste the Client ID from Google.';
export const CLIENT_SECRET_MISSING = 'Paste the client secret too.';
export function redirectMismatchText(redirectUri: string): string {
  return `This client doesn’t list ${redirectUri} as an authorized redirect URI. Add it in Google Cloud (step 4), or Google will answer redirect_uri_mismatch.`;
}
export function savedLabel(hint: string): string {
  return `Client ID ${hint} saved`;
}

/** TROUBLESHOOTING (CN-03) as status rows. */
export const TROUBLE_TITLE = 'Common problems and their fixes';
export const TROUBLE_BODY = 'These are the messages Google shows most often during the setup.';
export const TROUBLE_ROWS = [
  {
    label: 'redirect_uri_mismatch',
    detail:
      'Google shows this on its own page when the client doesn’t list this Whombat’s redirect URI. In the OAuth client, add exactly the URI below.',
  },
  {
    label: 'access_denied · “has not completed the Google verification process”',
    detail: 'The app is still in Testing. Publish it under Audience, or add yourself as a test user there.',
  },
  {
    label: '“API has not been used in project … or it is disabled”',
    detail: 'An API is turned off in your project. Turn them all on with the link below.',
  },
  {
    label: 'Signed out after 7 days',
    detail:
      'The app is still in Testing, so Google ends every sign-in after a week. Publish it under Audience so connections last.',
  },
] as const;
export function askAgentLabel(agentName: string): string {
  return `Ask ${agentName}`.slice(0, 40);
}

/* Coming back from Google (AG-08) ---------------------------------------------------------------- */

export function connectedTitle(email: string): string {
  return `Google connected · ${email}`.slice(0, 120);
}
const CAPABILITY: Partial<Record<ConnectorService, string>> = {
  mail: 'read your email and draft replies',
  calendar: 'check your calendar',
  files: 'work with your files',
  contacts: 'look up your contacts',
};
export function connectedText(services: readonly ConnectorService[]): string {
  const can = [
    ...new Set(services.map((s) => CAPABILITY[s === 'docs' || s === 'sheets' ? 'files' : s]).filter(Boolean)),
  ] as string[];
  const lead = can.length ? `Done. I can now ${andList(can)}.` : 'Done.';
  return `${lead} I’ll always ask before I send anything or change your calendar.`;
}
/** A service's line after connecting (the Settings panel's `checkText`, CN-06). */
export function checkDetail(check: ConnectionCheck | undefined): string {
  if (!check) return 'Not checked yet';
  switch (check.state) {
    case 'ok':
      return 'Working';
    case 'api_disabled':
      return 'API turned off in your Google project';
    case 'no_scope':
      return 'Not allowed when you connected · Reconnect and tick it';
    default:
      return 'Couldn’t check';
  }
}
/** What the callback's `connect_error=` means, and what to do (whombat-app `CONNECT_ERROR_TEXT`). */
export const CONNECT_ERROR_TEXT: Record<ConnectErrorCode, string> = {
  access_denied: 'Google didn’t connect: access wasn’t allowed. Try again and choose Allow.',
  invalid_state: 'That sign-in expired or was already used. Try connecting again.',
  exchange_failed:
    'Google didn’t finish the sign-in. Try again; if it keeps failing, check the Client ID and secret.',
  no_app: 'Google isn’t set up on this Whombat yet. Ask me and I’ll walk you through it.',
};
export const RETRY_TITLE = 'Try again';
export const CONNECT_ERROR_FIX: Record<ConnectErrorCode, string> = {
  access_denied:
    'If Google said the app “has not completed the Google verification process”, it is still in Testing: publish it under Audience, or add yourself as a test user there.',
  invalid_state: 'Google sign-ins last ten minutes and work once. Start again with the button below.',
  exchange_failed:
    'If Google showed redirect_uri_mismatch, add this Whombat’s redirect URI to the OAuth client exactly as Settings → Connections shows it.',
  no_app: 'Google is set up once on this Whombat.',
};

/* Suggestions (AG-11) --------------------------------------------------------------------------- */

export const SUGGESTION_TEXT = {
  email:
    'Quick idea: I could keep an eye on your inbox and draft replies for you. Want to connect your email? It takes about a minute.',
  calendar:
    'Quick idea: I could check your calendar, find free time and get you ready for meetings. Want to connect your calendar? It takes about a minute.',
  files:
    'Quick idea: I could find, read and write documents in your Google Drive for you. Want to connect your files? It takes about a minute.',
} as const;
export const SET_IT_UP = 'Set it up';
export const DONT_ASK_AGAIN = 'Don’t ask again';
export function dontAskText(topic: keyof typeof SUGGESTION_TEXT | 'skills'): string {
  if (topic === 'skills')
    return 'Okay, I won’t bring up skills again. You can always ask me, or use Settings → Skills.';
  return `Okay, I won’t bring up ${topic} again. You can always ask me, or use Settings → Connections.`;
}

/* Skills (AG-35…AG-39; skill-store.md SST-09) ------------------------------------------------------------- */

/** What an Add on a skills card from before says now: the assistant's skills are Hermes's, there already (HSK-01). */
export const SKILLS_ALL_TEXT =
  'I have my skills already. You can switch them on or off in Settings → Skills.';

/* Repair (AG-13) --------------------------------------------------------------------------------- */

const REAUTH_REASON: Record<ReauthReason, string> = {
  revoked: 'Google signed me out of your account',
  testing_expired: 'Google signs you out after 7 days while this Whombat’s Google app is in Testing',
  app_removed: 'this Whombat’s Google app was removed or replaced',
  scope_missing: 'Google didn’t allow everything I need',
  password_refused: 'your mail server refused the password',
};
const SERVICE_WORD: Record<ConnectorService, string> = {
  mail: 'email',
  calendar: 'calendar',
  files: 'files',
  docs: 'files',
  sheets: 'files',
  contacts: 'contacts',
};
export function repairText(reason: ReauthReason, services: readonly ConnectorService[]): string {
  const words = [...new Set(services.map((s) => SERVICE_WORD[s]))];
  const what = words.length ? andList(words) : 'email, calendar and files';
  return `Google stopped working for me: ${REAUTH_REASON[reason]}. Reconnect so I can keep helping with your ${what}.`;
}
/** An Email (IMAP) account whose server refused the password (CM-D03): no Google card, the way to a new one. */
export const IMAP_REPAIR_TEXT =
  'My email stopped working: your mail server refused the password. Enter a new one in Settings → Connections → Email (IMAP) so I can keep helping with your email.';
export const PUBLISH_APP_LINK = 'Publish the Google app to stop this';

/* A Vault card (connect-in-chat.md): its refusal without a value (the locked lines are core's `vaultAskLockedLabel`). */
export const VAULT_ASK_MISSING = 'Type it first.';
