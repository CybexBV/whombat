/** The workspace services' kinds: Notion, Airtable and Dropbox (docs/decisions/connection-dashboards.md). */
import type { KindModule } from '../registry';
import { AIRTABLE_KIND } from './airtable';
import { DROPBOX_KIND } from './dropbox';
import { NOTION_KIND } from './notion';

export const WORKSPACE_KINDS: Record<string, KindModule> = {
  notion: NOTION_KIND,
  airtable: AIRTABLE_KIND,
  dropbox: DROPBOX_KIND,
};
