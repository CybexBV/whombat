/**
 * The logo package's files (`packages/brand/assets`) as URLs Vite serves and bundles, for the `/brand`
 * page's previews and downloads. Every file of the package is listed; `brandAsset` throws on a typo.
 */
const FILES = import.meta.glob('../../../../../../packages/brand/assets/**/*.{svg,png,ico}', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const PREFIX = '../../../../../../packages/brand/assets/';

/** Package path (`svg/whombat-symbol-ink.svg`) → URL. */
export const BRAND_ASSETS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [path.slice(PREFIX.length), url]),
);

export function brandAsset(path: string): string {
  const url = BRAND_ASSETS[path];
  if (!url) throw new Error(`no brand asset ${path}`);
  return url;
}

/** File name of a package path, for the `download` attribute. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
