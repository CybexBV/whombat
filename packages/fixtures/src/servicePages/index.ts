/**
 * Every group's fixture pages (`types.ts` says the shape), in one list for `createServicePages`. A group edits only its
 * own file.
 */
import { APPS_PAGES } from './apps.js';
import { ARR_PAGES } from './arr.js';
import { BIZ_DEV_PAGES } from './biz-dev.js';
import { BIZ_MONEY_PAGES } from './biz-money.js';
import { CUSTOM_PAGES } from './custom.js';
import { FIRST_PAGES } from './first.js';
import { HOME_PAGES } from './home.js';
import { INFRA_APPS_PAGES } from './infra-apps.js';
import { INFRA_NET_PAGES } from './infra-net.js';
import { PS5_PAGES } from './ps5.js';
import { STORAGE_PAGES } from './storage.js';
import type { FixtureServicePage } from './types.js';

export type { FixtureService, FixtureServiceCtx, FixtureServicePage } from './types.js';

export const GROUP_SERVICE_PAGES: readonly FixtureServicePage[] = [
  ...FIRST_PAGES,
  ...HOME_PAGES,
  ...ARR_PAGES,
  ...APPS_PAGES,
  ...STORAGE_PAGES,
  ...INFRA_NET_PAGES,
  ...INFRA_APPS_PAGES,
  ...BIZ_MONEY_PAGES,
  ...BIZ_DEV_PAGES,
  ...CUSTOM_PAGES,
  ...PS5_PAGES,
];
