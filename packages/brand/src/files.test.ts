import { readdirSync, readFileSync } from 'node:fs';
import { brandColors, themeColors } from '@whombat/tokens';
import { describe, expect, it } from 'vitest';
import {
  androidLauncherForegroundXml,
  androidLauncherMonochromeXml,
  androidSmallIconXml,
  brandMarkSvg,
  faviconSvg,
  webManifest,
} from './files.js';
import { BRAND_MARKS } from './marks.js';

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const STALE = 'stale: run `pnpm --filter @whombat/brand export-icons`';

describe('generated files', () => {
  it('are committed up to date', () => {
    expect(repoFile('apps/web/public/favicon.svg'), STALE).toBe(faviconSvg(brandColors));
    expect(repoFile('apps/web/public/manifest.webmanifest'), STALE).toBe(
      webManifest({ background: themeColors.light.bg }),
    );
    expect(
      repoFile('apps/mobile/modules/whombat-live/android/src/main/res/drawable/whombat_live_small.xml'),
      STALE,
    ).toBe(androidSmallIconXml());
    expect(repoFile('apps/mobile/assets/android/whombat_launcher_foreground.xml'), STALE).toBe(
      androidLauncherForegroundXml(brandColors),
    );
    expect(repoFile('apps/mobile/assets/android/whombat_launcher_monochrome.xml'), STALE).toBe(
      androidLauncherMonochromeXml(),
    );
  });

  it('store every mark as a file (MK-03)', () => {
    const MARKS_STALE = 'stale: run `pnpm --filter @whombat/brand export-marks`';
    const dir = new URL('../assets/marks/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.svg'));
    expect(files.sort(), MARKS_STALE).toEqual(BRAND_MARKS.map((m) => `${m}.svg`).sort());
    for (const mark of BRAND_MARKS)
      expect(readFileSync(new URL(`${mark}.svg`, dir), 'utf8'), `${mark}: ${MARKS_STALE}`).toBe(
        brandMarkSvg(mark),
      );
  });
});
