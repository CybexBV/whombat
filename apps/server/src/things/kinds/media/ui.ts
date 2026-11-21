/**
 * The media pages' buttons, galleries and the 0.121 parts of lines and cells (service-dashboards.md SD-07, SD-11;
 * contracts 0.121.0 CT-1001…CT-1004, CT-1012, CT-1013): whether a button may be pressed and why not (SD-07,
 * `pageButton`: refused on Look only with a plain reason).
 */
import type {
  ThingGalleryItem,
  ThingPageButton,
  ThingPageItem,
  ThingPageNotice,
  ThingPagePanel,
  ThingPageRow,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { KindNotice } from '../../quiet/types';
import { pageButton } from '../buttons';

export type Button = ThingPageButton;
export type GalleryItem = ThingGalleryItem;
export type GalleryPanel = Extract<ThingPagePanel, { kind: 'gallery' }>;
export type Row = ThingPageRow;
export type Item = ThingPageItem;
export type Notice = ThingPageNotice;
export type Panel = ThingPagePanel;

/** The panels as `KindView` takes them. */
export const asPanels = (panels: Panel[]): ThingPagePanel[] => panels;
/** Worth a look as `KindView` takes it, with each line's nature, check and item (quiet-notices.md QN-01). */
export const asNotices = (notices: KindNotice[]): KindNotice[] => notices;

/** The connection, for a page's buttons: whether it is Look only. */
export interface ButtonCtx {
  row: CatalogConnectionRow;
}

/** A button as the person may press it (`pageButton`): disabled with the reason on Look only. */
export function button(who: ButtonCtx, spec: Omit<Button, 'allowed' | 'reason'>): Button {
  return pageButton(who, spec) as Button;
}
