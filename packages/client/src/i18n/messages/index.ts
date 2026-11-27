/**
 * The client's word trees (`../tree.ts`): each screen's table in English and Dutch, side by side in its own file, merged
 * here into the flat catalogs `../catalog.ts` spreads in.
 */
import type { MessageCatalog } from '@whombat/core/i18n';
import { BACKUP_LOOK_WORDS } from './backupLook';
import { BACKUP_OPTIONS_WORDS } from './backupOptions';
import { BACKUP_PLACES_WORDS } from './backupPlaces';
import { BACKUP_SETUP_WORDS } from './backupSetup';
import { CHAT_WORK_AREAS } from './chatWork';
import { CONNECTIONS_HOSTS_AREAS } from './connectionsHosts';
import { DESK_WORDS } from './desk';
import { DESK_SCREENS_WORDS } from './deskScreens';
import { HOST_MANAGED_AREAS } from './hostManaged';
import { ACCOUNTS_WORDS, MANAGED_STATUS_WORDS } from './managedStatus';
import { ONE_PASSKEY_WORDS } from './onePasskey';
import { OWN_NAME_WORDS } from './ownName';
import { PASSKEY_SETUP_WORDS } from './passkeySetup';
import { KIT_BACKUP_WORDS } from './recovery';
import { REMOTE_HELP_CLIENT_WORDS } from './remoteHelp';
import { HERMES_WORDS_TREE, THIS_WHOMBAT_WORDS } from './thisWhombat';

const AREAS = [
  DESK_WORDS,
  DESK_SCREENS_WORDS,
  THIS_WHOMBAT_WORDS,
  HERMES_WORDS_TREE,
  PASSKEY_SETUP_WORDS,
  KIT_BACKUP_WORDS,
  BACKUP_LOOK_WORDS,
  BACKUP_OPTIONS_WORDS,
  BACKUP_PLACES_WORDS,
  BACKUP_SETUP_WORDS,
  MANAGED_STATUS_WORDS,
  ACCOUNTS_WORDS,
  REMOTE_HELP_CLIENT_WORDS,
  ONE_PASSKEY_WORDS,
  OWN_NAME_WORDS,
  ...CHAT_WORK_AREAS,
  ...CONNECTIONS_HOSTS_AREAS,
  ...HOST_MANAGED_AREAS,
] as const;

function merged(lang: 'en' | 'nl'): MessageCatalog {
  const out: Record<string, MessageCatalog[string]> = {};
  for (const area of AREAS) Object.assign(out, area[lang]);
  return out;
}

/** Every tree's messages, flat: `{ en, nl }`. */
export const WORD_TREES = {
  en: merged('en'),
  nl: merged('nl'),
  prefixes: AREAS.map((a) => a.prefix),
} as const;
