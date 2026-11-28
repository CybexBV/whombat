/** The services Whombat keeps a settings copy of, by catalog id (docs/decisions/outside-changes.md). */
import { COPY_CATALOG_IDS } from './check';
import { NPM_COPY } from './npm';
import { OPNSENSE_COPY } from './opnsense';
import { PIHOLE_COPY } from './pihole';
import type { CopyService } from './types';

export { COPY_CATALOG_IDS, keepsSettingsCopy, SETTINGS_COPY_CHECK } from './check';

export const COPY_SERVICES: Readonly<Record<string, CopyService>> = {
  opnsense: OPNSENSE_COPY,
  pihole: PIHOLE_COPY,
  nginx_proxy_manager: NPM_COPY,
};
export const COPY_IDS = COPY_CATALOG_IDS;

export const copyServiceOf = (catalogId: string): CopyService | null => COPY_SERVICES[catalogId] ?? null;
