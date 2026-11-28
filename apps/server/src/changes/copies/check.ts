/**
 * Which services Whombat keeps a settings copy of, and its one check (docs/decisions/outside-changes.md), without the
 * readers: What Whombat watches lists the check for those services.
 */
import type { KindCheck } from '../../things/quiet/types';

/** The catalog ids of the services with a settings copy. */
export const COPY_CATALOG_IDS: readonly string[] = ['opnsense', 'pihole', 'nginx_proxy_manager'];

export const keepsSettingsCopy = (catalogId: string): boolean => COPY_CATALOG_IDS.includes(catalogId);

/**
 * “Settings copy failing”: on from the start, as a backup that stopped happening is (watch-defaults.md); its line only
 * comes once a copy worked before and none has for two days.
 */
export const SETTINGS_COPY_CHECK: KindCheck = {
  check: 'settings.copy',
  name: 'Settings copy failing',
  nature: 'problem',
  perItem: false,
  startsOn: true,
};
