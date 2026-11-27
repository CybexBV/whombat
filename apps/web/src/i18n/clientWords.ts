/**
 * The words `@whombat/client` builds per language (`managedText(locale)`, `deskText(locale)`, …) under the names of
 * its English constants (`MANAGED_TEXT`, `DESK_TEXT`, …), read in the page's language when used. A screen switches by
 * importing them from here instead of the package. A module-level alias (`const T = BACKUP_OPTIONS_TEXT.detail`) stays
 * live too: every object inside reads the page's language at the moment it is read. A language change draws the app's
 * screens again (`LanguageBoundary`), so each read picks the new one.
 */
import { deskScreensText, deskText } from '@whombat/client/desk';
import {
  accountsText,
  backupLookText,
  backupOptionsText,
  backupPlacesText,
  backupSetupText,
  hermesWords,
  kitBackupText,
  managedText,
  onePasskeyText,
  ownNameText,
  passkeySetupText,
  remoteHelpText,
  remoteHelpWords,
  thisWhombatText,
} from '@whombat/client/managed';
import { currentLocale } from './provider';

type Path = readonly PropertyKey[];

function isTree(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(root: unknown, path: Path): unknown {
  let value = root;
  for (const key of path) value = isTree(value) ? Reflect.get(value, key) : undefined;
  return value;
}

/** The package's words under one name, read in the page's language at every use. */
export function liveText<T extends object>(make: (locale?: string) => T): T {
  const english = make();
  let cache: { tag: string | undefined; words: T } = { tag: undefined, words: english };
  const now = (): T => {
    const tag = currentLocale();
    if (cache.tag !== tag) cache = { tag, words: tag ? make(tag) : english };
    return cache.words;
  };
  const branches = new Map<string, object>();
  const branch = (path: Path): object => {
    const id = path.map(String).join('\u0000');
    const known = branches.get(id);
    if (known) return known;
    const target = at(english, path);
    const made = new Proxy(isTree(target) ? target : {}, {
      get(_target, key) {
        const value = at(now(), [...path, key]);
        return isTree(value) ? branch([...path, key]) : value;
      },
    });
    branches.set(id, made);
    return made;
  };
  return branch([]) as T;
}

export const MANAGED_TEXT = liveText(managedText);
export const ACCOUNTS_TEXT = liveText(accountsText);
export const BACKUP_SETUP_TEXT = liveText(backupSetupText);
export const BACKUP_LOOK_TEXT = liveText(backupLookText);
export const BACKUP_OPTIONS_TEXT = liveText(backupOptionsText);
export const BACKUP_PLACES_TEXT = liveText(backupPlacesText);
export const THIS_WHOMBAT_TEXT = liveText(thisWhombatText);
export const HERMES_WORDS = liveText(hermesWords);
export const PASSKEY_SETUP_TEXT = liveText(passkeySetupText);
export const ONE_PASSKEY_TEXT = liveText(onePasskeyText);
export const REMOTE_HELP_TEXT = liveText(remoteHelpText);
export const REMOTE_HELP_WORDS = liveText(remoteHelpWords);
export const OWN_NAME_TEXT = liveText(ownNameText);
export const DESK_TEXT = liveText(deskText);
export const DESK_SCREENS_TEXT = liveText(deskScreensText);
/** Why the kit left its backup section out, on the screen (the kit itself stays English). */
export const KIT_GAP_TEXT = liveText(kitBackupText);
