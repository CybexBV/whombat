import type { MessageCatalog } from '@whombat/core/i18n';
import { HOSTS_ACTIONS_WORDS } from './actions';
import { HOSTS_APP_UPDATES_WORDS } from './appUpdates';
import { CONN_DRAFT_WORDS, CONN_FORM_WORDS, CONN_SETUP_WORDS } from './connectForm';
import {
  CONN_ACCOUNT_KEYS_WORDS,
  CONN_ACCOUNTS_WORDS,
  CONN_APP_WORDS,
  CONN_PARTS_WORDS,
  CONN_REASON_WORDS,
  CONN_SETTINGS_WORDS,
  CONN_SIGN_IN_AGAIN_WORDS,
  GUIDES_WORDS,
} from './connections';
import { HOSTS_DASHBOARD_MORE_WORDS } from './dashboardMore';
import { HOSTS_FIND_MY_TIMELINE_WORDS, HOSTS_FIND_MY_WORDS } from './findMy';
import { HOSTS_GUEST_WORDS } from './guestMobile';
import {
  HOSTS_DASHBOARD_RANGE_WORDS,
  HOSTS_REPOINT_WORDS,
  HOSTS_TEMPORARY_WORDS,
  HOSTS_UPDATES_WORDS,
} from './hostsBasics';
import { HOSTS_INCUS_WORDS } from './incus';
import { HOSTS_INSTALL_WORDS } from './install';
import { HOSTS_LIBVIRT_WORDS } from './libvirt';
import { HOSTS_MAC_WORDS } from './mac';
import { HOSTS_MODEL_WORDS } from './servers';
import { HOSTS_UNRAID_WORDS } from './unraid';
import { HOSTS_WINDOWS_WORDS } from './windows';

export type MessageArea = {
  readonly en: MessageCatalog;
  readonly nl: MessageCatalog;
  readonly prefix: string;
};

/** The word trees of `@whombat/client/connections` and `@whombat/client/hosts`, in English and Dutch. */
export const CONNECTIONS_HOSTS_AREAS: readonly MessageArea[] = [
  CONN_ACCOUNT_KEYS_WORDS,
  CONN_ACCOUNTS_WORDS,
  CONN_APP_WORDS,
  CONN_REASON_WORDS,
  CONN_PARTS_WORDS,
  CONN_SETTINGS_WORDS,
  CONN_SIGN_IN_AGAIN_WORDS,
  CONN_DRAFT_WORDS,
  CONN_FORM_WORDS,
  CONN_SETUP_WORDS,
  GUIDES_WORDS,
  HOSTS_TEMPORARY_WORDS,
  HOSTS_REPOINT_WORDS,
  HOSTS_UPDATES_WORDS,
  HOSTS_APP_UPDATES_WORDS,
  HOSTS_DASHBOARD_RANGE_WORDS,
  HOSTS_FIND_MY_WORDS,
  HOSTS_FIND_MY_TIMELINE_WORDS,
  HOSTS_MAC_WORDS,
  HOSTS_WINDOWS_WORDS,
  HOSTS_INSTALL_WORDS,
  HOSTS_MODEL_WORDS,
  HOSTS_GUEST_WORDS,
  HOSTS_INCUS_WORDS,
  HOSTS_UNRAID_WORDS,
  HOSTS_LIBVIRT_WORDS,
  HOSTS_ACTIONS_WORDS,
  HOSTS_DASHBOARD_MORE_WORDS,
];
