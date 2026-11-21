/**
 * Pictures the demo world shows without a Whombat to fetch them from: an attachment URL its fixtures hand out, and the
 * bundled file that stands in for it. Every build has the demo world (look-around.md); the URL is the demo's own, on an
 * address no Whombat uses, so a real Whombat's URL is always fetched.
 */
import type { ImageSourcePropType } from 'react-native';
import { DEMO_REPO_ICON_URL } from '../fixtures/repos';

export const DEMO_IMAGES: Readonly<Record<string, ImageSourcePropType>> = {
  [DEMO_REPO_ICON_URL]: require('../fixtures/assets/acme-shop-icon.png') as ImageSourcePropType,
};
