/**
 * What a built web page makes the browser fetch before its first screen: the module scripts and stylesheets
 * `index.html` loads itself, and the chunks and styles it preloads. Prints raw, gzip (level 9) and Brotli (quality 11)
 * sizes per set as JSON, so two builds (a baseline checkout's and this one's) can be compared.
 *
 *   node --import tsx scripts/benchmarks/web-initial-size.ts apps/web/dist
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dist = process.argv[2];
if (!dist) throw new Error('usage: web-initial-size.ts <dist directory>');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const attribute = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

const sets: Record<'initialJs' | 'initialCss' | 'preloadJs' | 'preloadCss', string[]> = {
  initialJs: [],
  initialCss: [],
  preloadJs: [],
  preloadCss: [],
};
for (const tag of html.match(/<(script|link)\b[^>]*>/g) ?? []) {
  const src = attribute(tag, 'src');
  const href = attribute(tag, 'href');
  const rel = attribute(tag, 'rel');
  if (tag.startsWith('<script') && attribute(tag, 'type') === 'module' && src) sets.initialJs.push(src);
  else if (!tag.startsWith('<link') || !href) continue;
  else if (rel === 'stylesheet') sets.initialCss.push(href);
  else if (rel === 'modulepreload') sets.preloadJs.push(href);
  else if (rel === 'preload' && attribute(tag, 'as') === 'style') sets.preloadCss.push(href);
}

const kB = (bytes: number) => Number((bytes / 1000).toFixed(1));
const sizes = Object.fromEntries(
  Object.entries(sets).map(([set, files]) => {
    let raw = 0;
    let gzip = 0;
    let brotli = 0;
    for (const file of files) {
      const bytes = readFileSync(join(dist, file.replace(/^\//, '')));
      raw += bytes.length;
      gzip += gzipSync(bytes, { level: 9 }).length;
      brotli += brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    }
    return [set, { files: files.length, rawKB: kB(raw), gzipKB: kB(gzip), brotliKB: kB(brotli) }];
  }),
);
console.log(JSON.stringify(sizes, null, 2));
