/**
 * The page shapes of contracts 0.121.0 the home pages draw (CT-1000…CT-1005, CT-1012…CT-1014: pictures, buttons,
 * gallery, controls), and a button as `pageButton` words it (never on Look only).
 */
import type {
  ThingControl,
  ThingControlIcon,
  ThingGalleryItem,
  ThingImage,
  ThingPageButton,
  ThingPagePanel,
} from '@whombat/core';
import { pageButton } from '../buttons';
import type { KindCtx } from '../types';

export type { ThingControl, ThingControlIcon, ThingGalleryItem, ThingImage, ThingPageButton };

export type ThingControlsPanel = Extract<ThingPagePanel, { kind: 'controls' }>;
export type ThingGalleryPanel = Extract<ThingPagePanel, { kind: 'gallery' }>;

/** What a pure builder needs to word its buttons: the connection (Look only). */
export type ButtonCtx = Pick<KindCtx, 'row'>;

/** A button: allowed when Whombat may change things there, else with the reason. */
export function button(ctx: ButtonCtx, spec: Omit<ThingPageButton, 'allowed' | 'reason'>): ThingPageButton {
  return pageButton(ctx, spec) as ThingPageButton;
}
