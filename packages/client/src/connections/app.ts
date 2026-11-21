/**
 * An `app_oauth` entry's app (Dropbox; connections-catalog.md CX-14; app AP-762; phone-connect.md PC-07, AP-2912): the
 * provider's words for its client id and secret, the status line, what the form refuses before saving and every word of
 * the setup the web's `AppOAuthSetup` and the phone's app form share. Pure.
 */
import type { CatalogAppStatus, CatalogEntry, CatalogSignIn } from '@whombat/core/domain';

export type AppMethod = Extract<CatalogSignIn, { kind: 'app_oauth' }>;

/** The provider's words for the client id and secret: Dropbox says app key and app secret. */
export function appWords(entry: CatalogEntry) {
  return entry.id === 'dropbox'
    ? { id: 'App key', secret: 'App secret', console: 'the Dropbox App Console' }
    : { id: 'Client ID', secret: 'Client secret', console: `${entry.name}’s developer console` };
}

/** The app's status line: set in the config, set up (with its key's hint), or what to do. */
export function appSummary(entry: CatalogEntry, app: CatalogAppStatus): string {
  const words = appWords(entry);
  if (app.source === 'config') return `Set in this Whombat’s config · ${words.id} ${app.clientIdHint ?? ''}`;
  if (app.configured) return `Set up · ${words.id} ${app.clientIdHint ?? ''}`;
  return `Set up ${entry.name} once, then you can connect. Four steps, about five minutes.`;
}

/** The setup's words (the web's, its bold parts as plain text). */
export const APP_SETUP_TEXT = {
  section: (name: string) => `${name.toUpperCase()} APP`,
  forThisWhombat: 'For this Whombat',
  setUp: 'Set up',
  notSetUp: 'Not set up',
  showSteps: 'Show setup steps',
  hideSteps: 'Hide setup steps',
  stepCreate: 'Create the app',
  createDropbox: (consoleName: string) =>
    `In ${consoleName}, create an app with Scoped access and Full Dropbox (or App folder, to keep your agent to one folder). Name it after this Whombat.`,
  createOther: (consoleName: string) =>
    `In ${consoleName}, create an OAuth app for this Whombat. Name it after this Whombat.`,
  openConsole: (consoleName: string) => `Open ${consoleName}`,
  stepPermissions: 'Give it permissions',
  /** Before signing in: a permission added later needs signing in again (SG-22, AP-3909). */
  permissions: 'On the app’s Permissions tab, tick these and click Submit before you sign in:',
  stepRedirect: 'Add the redirect URI',
  redirect: 'On the Settings tab, under OAuth 2 → Redirect URIs, add this URI exactly:',
  /** Dropbox's Settings tab, after the redirect URI (SG-22): Whombat signs in with PKCE, without the secret. */
  dropboxPublicClients: 'Leave Allow public clients (Implicit Grant & PKCE) on Allow.',
  /** A new Dropbox app links only its owner until this (SG-22). */
  dropboxMoreUsers:
    'Under Development users, click Enable additional users, so people other than you can connect.',
  redirectLabel: 'Redirect URI',
  redirectCopied: 'Redirect URI copied.',
  stepPaste: (idLabel: string) => `Paste the ${idLabel.toLowerCase()}`,
  copyThem: 'Copy them from the app’s Settings tab.',
  optionalSecret: (secretLabel: string) =>
    ` The ${secretLabel.toLowerCase()} is optional: Whombat signs in with PKCE without it.`,
  optional: ' · OPTIONAL',
  keepId: 'Leave empty to keep the saved one',
  keepSecret: 'Leave empty to keep the saved secret',
  save: 'Save',
  cancel: 'Cancel',
  replace: 'Replace',
  remove: 'Remove',
  removeApp: 'Remove the app',
  saved: (name: string) => `${name} app saved. Connect below to test it.`,
  removed: (name: string) => `${name} app removed. Your ${name} connections need you to sign in again.`,
  confirmRemove: (name: string) =>
    `Remove the ${name} app? Your ${name} connections stop working until it’s set up again.`,
} as const;

/** “Saved · App key abc… · app secret saved · 2 days ago” without the time (each form adds its own). */
export function appSavedLine(entry: CatalogEntry, app: CatalogAppStatus): string {
  const words = appWords(entry);
  return `Saved · ${words.id} ${app.clientIdHint ?? ''}${app.secretSet ? ` · ${words.secret.toLowerCase()} saved` : ''}`;
}

/**
 * What the form refuses before saving: no id the first time, no secret where one is needed and none is saved. Null
 * when it may save; `'unchanged'` when nothing was typed over a saved app (the form just closes).
 */
export function appSaveProblem(
  entry: CatalogEntry,
  method: AppMethod,
  app: Pick<CatalogAppStatus, 'configured' | 'secretSet'>,
  typed: { clientId: string; secret: string },
): string | 'unchanged' | null {
  const words = appWords(entry);
  const id = typed.clientId.trim();
  const key = typed.secret.trim();
  if (!id && !app.configured) return `Paste the ${words.id.toLowerCase()} from ${words.console}.`;
  if (!key && !method.clientSecretOptional && !app.secretSet)
    return `Paste the ${words.secret.toLowerCase()} too.`;
  if (!id && !key) return 'unchanged';
  return null;
}
