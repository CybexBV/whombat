/**
 * The kinds registry (service-dashboards.md SD-S01): every kind of connection with a page of its own, by catalog id.
 * The four first kinds (Home Assistant, UniFi Network, Hetzner, Fusebox) come from `first.ts`; each group file belongs to
 * one stream. A group may extend a first kind under the same id: its entry, spread later, wins.
 */

import type { CatalogConnectionRow } from '../../connections/types';
import { registerChecks } from '../quiet/defaults';
import { recipeKind } from '../recipe/kind';
import { BUSINESS_KINDS } from './business/index';
import { FIND_MY_KIND } from './findmy';
import { FIRST_KINDS } from './first';
import { HOME_KINDS } from './home/index';
import { INFRA_KINDS } from './infra/index';
import { MEDIA_KINDS } from './media/index';
import { OWN_KINDS } from './own/index';
import { PS5_KIND } from './ps5';
import type { KindModule } from './registry';
import { SERVER_KINDS } from './servers/index';
import { STORAGE_KINDS } from './storage/index';
import { WORKSPACE_KINDS } from './workspace/index';

export const KIND_MODULES: Record<string, KindModule> = {
  ...FIRST_KINDS,
  ...MEDIA_KINDS,
  ...HOME_KINDS,
  ...INFRA_KINDS,
  ...STORAGE_KINDS,
  ...BUSINESS_KINDS,
  ...OWN_KINDS,
  ...WORKSPACE_KINDS,
  ...SERVER_KINDS,
  ps5: PS5_KIND,
  findmy: FIND_MY_KIND,
};

// Which of their checks Whombat watches from the start (watch-defaults.md).
for (const kind of Object.values(KIND_MODULES)) registerChecks(kind.checks ?? []);

/** The kind of a catalog id, when it has a page of its own. */
export function kindOf(catalogId: string): KindModule | undefined {
  return Object.hasOwn(KIND_MODULES, catalogId) ? KIND_MODULES[catalogId] : undefined;
}

/**
 * The kind of a connection: its recipe's when the assistant gave a Custom connection a page (connection-looks.md),
 * else its catalog id's.
 */
export function kindFor(row: Pick<CatalogConnectionRow, 'catalogId' | 'page'>): KindModule | undefined {
  return recipeKind(row) ?? kindOf(row.catalogId);
}
