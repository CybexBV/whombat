/**
 * An `app_oauth` entry's app (Dropbox; connections-catalog.md CX-14; app AP-762; phone-connect.md PC-07, AP-2912): the
 * provider's words for its client id and secret, the status line, what the form refuses before saving and every word of
 * the setup the web's `AppOAuthSetup` and the phone's app form share. Pure.
 */
import type { CatalogAppStatus, CatalogEntry, CatalogSignIn } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { CONN_APP_WORDS } from '../i18n/messages/connectionsHosts/connections';

export type AppMethod = Extract<CatalogSignIn, { kind: 'app_oauth' }>;

/** The provider's words for the client id and secret: Dropbox says app key and app secret. */
export function appWords(entry: CatalogEntry, locale?: string | null) {
  const w = clientTree(locale, CONN_APP_WORDS);
  return entry.id === 'dropbox'
    ? { ...w.dropbox }
    : { ...w.other, console: interpolate(w.other.console, { name: entry.name }) };
}

/** The app's status line: set in the config, set up (with its key's hint), or what to do. */
export function appSummary(entry: CatalogEntry, app: CatalogAppStatus, locale?: string | null): string {
  const words = appWords(entry, locale);
  const w = clientTree(locale, CONN_APP_WORDS).summary;
  const hint = app.clientIdHint ?? '';
  if (app.source === 'config') return interpolate(w.config, { id: words.id, hint });
  if (app.configured) return interpolate(w.configured, { id: words.id, hint });
  return interpolate(w.todo, { name: entry.name });
}

/** The setup's words (the web's, its bold parts as plain text). */
export function appSetupText(locale?: string | null) {
  const w = clientTree(locale, CONN_APP_WORDS).setup;
  return {
    ...w,
    section: (name: string) => interpolate(w.section, { NAME: name.toUpperCase() }),
    createDropbox: (consoleName: string) => interpolate(w.createDropbox, { console: consoleName }),
    createOther: (consoleName: string) => interpolate(w.createOther, { console: consoleName }),
    openConsole: (consoleName: string) => interpolate(w.openConsole, { console: consoleName }),
    stepPaste: (idLabel: string) => interpolate(w.stepPaste, { id: idLabel.toLowerCase() }),
    optionalSecret: (secretLabel: string) =>
      interpolate(w.optionalSecret, { secret: secretLabel.toLowerCase() }),
    saved: (name: string) => interpolate(w.saved, { name }),
    removed: (name: string) => interpolate(w.removed, { name }),
    confirmRemove: (name: string) => interpolate(w.confirmRemove, { name }),
  };
}

export const APP_SETUP_TEXT = appSetupText('en');

/** “Saved · App key abc… · app secret saved · 2 days ago” without the time (each form adds its own). */
export function appSavedLine(entry: CatalogEntry, app: CatalogAppStatus, locale?: string | null): string {
  const words = appWords(entry, locale);
  const w = clientTree(locale, CONN_APP_WORDS);
  const secret = app.secretSet ? interpolate(w.secretSaved, { secret: words.secret.toLowerCase() }) : '';
  return `${interpolate(w.savedLine, { id: words.id, hint: app.clientIdHint ?? '' })}${secret}`;
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
  locale?: string | null,
): string | 'unchanged' | null {
  const words = appWords(entry, locale);
  const w = clientTree(locale, CONN_APP_WORDS).problem;
  const id = typed.clientId.trim();
  const key = typed.secret.trim();
  if (!id && !app.configured)
    return interpolate(w.pasteId, { id: words.id.toLowerCase(), console: words.console });
  if (!key && !method.clientSecretOptional && !app.secretSet)
    return interpolate(w.pasteSecret, { secret: words.secret.toLowerCase() });
  if (!id && !key) return 'unchanged';
  return null;
}
