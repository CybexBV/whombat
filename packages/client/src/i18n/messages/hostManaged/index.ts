import type { MessageCatalog } from '@whombat/core/i18n';
import { BACKUP_FILE_WORDS } from './backupFile';
import { BACKUP_PASSKEY_WORDS } from './backupPasskey';
import { BLUETOOTH_WORDS } from './bluetooth';
import { COMMUNITY_WORDS } from './community';
import { DIAGNOSTICS_WORDS } from './diagnostics';
import { HARDWARE_WORDS } from './hardware';
import { HOME_WORDS } from './home';
import { HOST_CHART_WORDS_TREE } from './hostCharts';
import { MAIL_WORDS } from './mail';
import { MANAGED_COPY_WORDS } from './managedCopy';
import { NETWORK_WORDS } from './network';
import { OWN_ADDRESS_WORDS } from './ownAddress';
import { PASSKEY_WORDS } from './passkeys';
import { SWITCHER_WORDS } from './switcher';
import { TAILSCALE_WORDS } from './tailscale';
import { WHOMBAT_LINK_WORDS } from './whombatLink';

export type MessageArea = {
  readonly en: MessageCatalog;
  readonly nl: MessageCatalog;
  readonly prefix: string;
};

/** This Whombat's host sections, the backup file and the managed journeys' words, as catalog areas. */
export const HOST_MANAGED_AREAS: readonly MessageArea[] = [
  BACKUP_FILE_WORDS,
  BACKUP_PASSKEY_WORDS,
  BLUETOOTH_WORDS,
  COMMUNITY_WORDS,
  DIAGNOSTICS_WORDS,
  HARDWARE_WORDS,
  HOME_WORDS,
  HOST_CHART_WORDS_TREE,
  MAIL_WORDS,
  MANAGED_COPY_WORDS,
  NETWORK_WORDS,
  OWN_ADDRESS_WORDS,
  PASSKEY_WORDS,
  SWITCHER_WORDS,
  TAILSCALE_WORDS,
  WHOMBAT_LINK_WORDS,
];
