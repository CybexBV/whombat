/**
 * The repositories the demo world's software work is in, for their threads' rows (`ChatThread.repo`): Acme's shop with
 * its own icon (an attachment URL the app shows from a bundled picture, `data/demoImages.ts`) and Acme's help desk
 * without one, which shows its letter. Made-up names only.
 */
import type { ChatThreadRepo } from '@whombat/core';

/** The shop's icon, as a Whombat would hand it out. */
export const DEMO_REPO_ICON_URL = '/api/v1/burrows/demo/attachments/att_demo-acme-shop-icon';

export const DEMO_REPOS = {
  shop: { fullName: 'acme/shop', name: 'shop', iconUrl: DEMO_REPO_ICON_URL },
  desk: { fullName: 'acme/desk', name: 'desk', iconUrl: null },
} as const satisfies Record<string, ChatThreadRepo>;
