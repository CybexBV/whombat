import { describe, expect, it } from 'vitest';
import { solidPng } from './fake';
import { iconCandidates, iconImage, REPO_ICON_MAX_BYTES } from './repo-icons';

const file = (path: string, size = 2000) => ({ path, size, sha: `${path.length}`.padEnd(40, '0') });
const best = (paths: string[]) => iconCandidates(paths.map((p) => file(p)))[0]?.path;

describe('iconCandidates', () => {
  it('finds a web app’s home-screen icon, the shorter path first', () => {
    expect(
      best([
        'marketing/public/apple-touch-icon.png',
        'web/public/apple-touch-icon.png',
        'web/public/favicon.ico',
        'web/public/favicon.png',
        'README.md',
      ]),
    ).toBe('web/public/apple-touch-icon.png');
  });

  it('finds an icon kept with a brand package', () => {
    expect(
      best([
        'packages/brand/assets/app-icon/android-chrome-192.png',
        'packages/brand/assets/app-icon/apple-touch-icon-180.png',
        'packages/brand/assets/logo.svg',
      ]),
    ).toBe('packages/brand/assets/app-icon/apple-touch-icon-180.png');
  });

  it('ranks by name: home-screen icons, then app icons, then a favicon', () => {
    expect(best(['favicon.png', 'assets/logo.png'])).toBe('assets/logo.png');
    expect(best(['icon.png', 'public/icon-192.png'])).toBe('public/icon-192.png');
    expect(best(['favicon.png'])).toBe('favicon.png');
  });

  it('leaves out other projects’ pictures, built ones, SVG and ICO, and files over the limit', () => {
    expect(
      best(['node_modules/x/apple-touch-icon.png', 'dist/icon.png', 'logo.svg', 'favicon.ico']),
    ).toBeUndefined();
    expect(iconCandidates([file('apple-touch-icon.png', REPO_ICON_MAX_BYTES + 1)])).toEqual([]);
  });
});

describe('iconImage', () => {
  it('takes PNG by its bytes, with its size', () => {
    expect(iconImage(solidPng(32, [1, 2, 3]))).toEqual({ contentType: 'image/png', width: 32, height: 32 });
  });

  it('refuses SVG, ICO, GIF, empty and too large files whatever they are called', () => {
    expect(iconImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(iconImage(new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]))).toBeNull();
    expect(iconImage(new TextEncoder().encode('GIF89a\u0001\u0000\u0001\u0000'))).toBeNull();
    expect(iconImage(new Uint8Array())).toBeNull();
    expect(iconImage(new Uint8Array(REPO_ICON_MAX_BYTES + 1))).toBeNull();
  });
});
