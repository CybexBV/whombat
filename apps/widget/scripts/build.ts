/**
 * Builds Whombat Feedback (docs/decisions/feedback.md FB-26) into `dist/v1/`:
 *
 * ```
 * widget.js                 the loader (IIFE, minified; cached 5 minutes, so not hashed)
 * assets/frame.<hash>.js    the frame UI
 * assets/frame.<hash>.css   its styles, @whombat/tokens included
 * manifest.json             {version, loader, frame: {js, css}, files: {name: {bytes, sha256}}}
 * ```
 *
 * The same sources give the same bytes (no timestamps or paths; hashes are of the content). `--out <dir>` writes
 * elsewhere (release packaging), `--watch` rebuilds on changes (pnpm dev).
 *
 * `--embed` (alias `--hosted`) builds the **embed tree** of a managed Whombat's widget instead (Whombat
 * `docs/decisions/feedback-drop.md` FD-29, FD-31; whombat-app AP-107), a static site of its own for the embed origin
 * (`embed.whombat.com`), default `dist-embed/`:
 *
 * ```
 * _headers                          the static host's headers (CSP with connect-src = control, frame-ancestors *, …)
 * embed/v1/widget.js                the same loader bytes as dist/v1
 * embed/v1/assets/frame.<hash>.*    the same frame bytes as dist/v1
 * embed/v1/frame.html               static: the frame document with control's origin in a meta and a meta CSP
 * embed/v1/manifest.json            as in dist/v1
 * ```
 *
 * It needs control's URL: `--control-url <url>`, else `WHOMBAT_CONTROL_URL`, else `VITE_WHOMBAT_CONTROL_URL` (what
 * the hosted web build reads).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { normalizeOrigin } from '@whombat/core/feedback/sanitize';
import * as esbuild from 'esbuild';
import { CONTROL_META } from '../src/frame/drop';
import { WIDGET_VERSION } from '../src/version';

export const WIDGET_ROOT = resolve(import.meta.dirname, '..');
const BROWSERS = ['chrome80', 'firefox78', 'safari15'];
/** The host page may be old, so the loader is plain ES2019. */
const LOADER_TARGET = ['es2019', ...BROWSERS];
/** The loader must stay small (it runs on every page of the website). */
export const LOADER_GZIP_BUDGET = 8 * 1024;

export interface WidgetManifest {
  version: string;
  loader: string;
  frame: { js: string; css: string };
  files: Record<string, { bytes: number; sha256: string }>;
}

export interface BuiltFile {
  name: string;
  bytes: number;
  gzip: number;
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The bundle's bytes and the source files it was made of (paths relative to the widget package). */
async function bundleWithInputs(
  entry: string,
  options: esbuild.BuildOptions,
): Promise<{ contents: Uint8Array; inputs: string[] }> {
  const result = await esbuild.build({
    absWorkingDir: WIDGET_ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
    outdir: 'out',
    metafile: true,
    ...options,
  });
  const outputs = result.outputFiles ?? [];
  const file = outputs[0];
  if (!file || outputs.length !== 1) throw new Error(`${entry}: expected exactly one output file`);
  return { contents: file.contents, inputs: Object.keys(result.metafile?.inputs ?? {}) };
}

async function bundle(entry: string, options: esbuild.BuildOptions): Promise<Uint8Array> {
  return (await bundleWithInputs(entry, options)).contents;
}

/** Resolve the loader's stylesheet and fallback styles at build time so unused tokens stay out of the bundle. */
const inlineLoaderStyles: esbuild.Plugin = {
  name: 'inline-loader-styles',
  setup({ onLoad }) {
    onLoad({ filter: /[/\\]loader[/\\]styles\.ts$/ }, async () => {
      const source = await bundle('src/loader/styles.ts', { format: 'esm', platform: 'node' });
      const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
      const { loaderCss, FALLBACK_STYLES }: typeof import('../src/loader/styles') = await import(
        /* @vite-ignore */ url
      );
      return {
        contents: `export const loaderCss = () => ${JSON.stringify(loaderCss())};
export const FALLBACK_STYLES = ${JSON.stringify(FALLBACK_STYLES)};`,
      };
    });
  },
};

/**
 * What the frame bundle must never contain (FD-28 (7), FD-30): storage of any kind and HTML parsing. The frame is
 * framed by any website on an origin of its own; it keeps nothing and writes only DOM text. The one exception is the
 * reporter session in `localStorage` (AP-429), allowed in `FRAME_STORAGE_MODULE` only (`frameSourceViolations`).
 */
export const FRAME_BANNED: readonly { name: string; pattern: RegExp }[] = [
  { name: 'cookies', pattern: /\.cookie\b|cookieStore/ },
  { name: 'sessionStorage', pattern: /sessionStorage/ },
  { name: 'IndexedDB', pattern: /indexedDB|IDBFactory/ },
  { name: 'the Cache API', pattern: /\bcaches\b/ },
  { name: 'service workers', pattern: /serviceWorker/ },
  { name: 'Web SQL', pattern: /openDatabase/ },
  { name: 'innerHTML', pattern: /innerHTML|outerHTML|insertAdjacentHTML|document\.write/ },
  { name: 'eval', pattern: /\beval\(|new Function/ },
];

/** The frame bundle's violations of `FRAME_BANNED`, by name. */
export function frameViolations(frameJs: string): string[] {
  return FRAME_BANNED.filter((b) => b.pattern.test(frameJs)).map((b) => b.name);
}

/** The only frame module that may use `localStorage`: the reporter session's single key (AP-429). */
export const FRAME_STORAGE_MODULE = 'src/frame/reporter-store.ts';

/**
 * The source files of the frame bundle (its own modules and every dependency) that name `localStorage` although they
 * aren't `FRAME_STORAGE_MODULE`.
 */
export function frameSourceViolations(inputs: readonly { path: string; text: string }[]): string[] {
  return inputs
    .filter((input) => input.path !== FRAME_STORAGE_MODULE && /localStorage/.test(input.text))
    .map((input) => input.path);
}

export const EMBED_LOADER_CACHE = 'public, max-age=300';
export const EMBED_ASSET_CACHE = 'public, max-age=31536000, immutable';

/**
 * The frame's Content-Security-Policy on the embed origin (FD-29): its own assets, control for the card and the drop,
 * any website may frame it (the frame checks the card's origins and the bridge itself, FD-28). The meta form can't
 * carry `frame-ancestors`.
 */
export function embedCsp(control: string, forHeader: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    `connect-src ${control}`,
    "form-action 'none'",
    "base-uri 'none'",
    ...(forHeader ? ['frame-ancestors *'] : []),
  ].join('; ');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The static frame document of the embed tree: the same for every website, an empty `#wb-root` that the frame's script
 * fills once it has read its site, parent and theme from the URL and checked the parent (`src/frame/bridge.ts`), plus
 * the meta CSP and control's origin (`<meta name="whombat-control">`, which drop mode reads). Nothing inline.
 */
export function embedFrameHtml(manifest: WidgetManifest, control: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(embedCsp(control, false))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="${CONTROL_META}" content="${escapeAttr(control)}">
<title>Feedback</title>
<link rel="stylesheet" href="${escapeAttr(manifest.frame.css)}">
<script src="${escapeAttr(manifest.frame.js)}" defer></script>
</head>
<body>
<div id="wb-root"></div>
</body>
</html>
`;
}

/**
 * `_headers` of the embed tree (FD-29, FD-31): this origin serves nothing but the widget, so every response gets the
 * frame's policy; `widget.js` and `frame.html` are revalidated after 5 minutes, the hashed assets are immutable. No
 * `X-Frame-Options` (any website frames the frame). The static host applies every block that matches a path.
 */
export function embedHeaders(control: string): string {
  return [
    '/*',
    `  Content-Security-Policy: ${embedCsp(control, true)}`,
    '  Cross-Origin-Resource-Policy: cross-origin',
    '  Referrer-Policy: no-referrer',
    '  X-Content-Type-Options: nosniff',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
    '  Strict-Transport-Security: max-age=63072000; includeSubDomains',
    '/embed/v1/widget.js',
    `  Cache-Control: ${EMBED_LOADER_CACHE}`,
    '/embed/v1/frame.html',
    `  Cache-Control: ${EMBED_LOADER_CACHE}`,
    '/embed/v1/assets/*',
    `  Cache-Control: ${EMBED_ASSET_CACHE}`,
    '',
  ].join('\n');
}

/** Control's origin from a URL (`https://api.whombat.com`, or http on loopback), or an error. */
export function controlOriginOf(url: string | undefined): string {
  let origin: string | null = null;
  try {
    origin = url ? normalizeOrigin(new URL(url).origin) : null;
  } catch {
    origin = null;
  }
  if (!origin)
    throw new Error(
      'the embed build needs control’s URL: --control-url https://… (or WHOMBAT_CONTROL_URL / VITE_WHOMBAT_CONTROL_URL)',
    );
  return origin;
}

export interface EmbedOptions {
  /** Control's origin (`controlOriginOf`). */
  control: string;
}

/**
 * Builds into `<outDir>/v1` (replacing it) and returns the manifest and sizes. With `embed`, into
 * `<outDir>/embed/v1` with the static `frame.html`, and `<outDir>/_headers` (both replaced).
 */
export async function buildWidget(
  outDir = join(WIDGET_ROOT, 'dist'),
  embed?: EmbedOptions,
): Promise<{
  manifest: WidgetManifest;
  sizes: BuiltFile[];
}> {
  const js = { format: 'iife', platform: 'browser' } as const;
  const loader = await bundle('src/loader/index.ts', {
    ...js,
    target: LOADER_TARGET,
    plugins: [inlineLoaderStyles],
  });
  const frame = await bundleWithInputs('src/frame/index.ts', { ...js, target: BROWSERS });
  const frameJs = frame.contents;
  const frameCss = await bundle('src/frame/frame.css', { target: BROWSERS });

  const loaderText = new TextDecoder().decode(loader);
  for (const banned of ['eval(', 'new Function', 'innerHTML', 'document.write'])
    if (loaderText.includes(banned)) throw new Error(`widget.js must not use ${banned}`);
  const violations = frameViolations(new TextDecoder().decode(frameJs));
  if (violations.length > 0) throw new Error(`the frame must not use ${violations.join(', ')}`);
  const storageUsers = frameSourceViolations(
    frame.inputs.map((path) => ({ path, text: readFileSync(resolve(WIDGET_ROOT, path), 'utf8') })),
  );
  if (storageUsers.length > 0)
    throw new Error(`only ${FRAME_STORAGE_MODULE} may use localStorage, not ${storageUsers.join(', ')}`);

  const files = new Map<string, Uint8Array>([
    ['widget.js', loader],
    [`assets/frame.${sha256(frameJs).slice(0, 12)}.js`, frameJs],
    [`assets/frame.${sha256(frameCss).slice(0, 12)}.css`, frameCss],
  ]);
  const names = [...files.keys()];
  const manifest: WidgetManifest = {
    version: WIDGET_VERSION,
    loader: 'widget.js',
    frame: { js: names[1] as string, css: names[2] as string },
    files: Object.fromEntries(
      [...files].map(([name, data]) => [name, { bytes: data.byteLength, sha256: sha256(data) }]),
    ),
  };

  const v1 = embed ? join(outDir, 'embed', 'v1') : join(outDir, 'v1');
  rmSync(v1, { recursive: true, force: true });
  for (const [name, data] of files) {
    mkdirSync(dirname(join(v1, name)), { recursive: true });
    writeFileSync(join(v1, name), data);
  }
  writeFileSync(join(v1, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (embed) {
    writeFileSync(join(v1, 'frame.html'), embedFrameHtml(manifest, embed.control));
    writeFileSync(join(outDir, '_headers'), embedHeaders(embed.control));
  }
  const sizes = [...files].map(([name, data]) => ({
    name,
    bytes: data.byteLength,
    gzip: gzipSync(data, { level: 9 }).byteLength,
  }));
  const loaderSize = sizes[0];
  if (loaderSize && loaderSize.gzip > LOADER_GZIP_BUDGET)
    throw new Error(
      `widget.js is ${loaderSize.gzip} bytes gzipped, over the ${LOADER_GZIP_BUDGET} byte budget`,
    );
  return { manifest, sizes };
}

function report(sizes: BuiltFile[], outDir: string, embed?: EmbedOptions): void {
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  process.stdout.write(
    embed
      ? `[widget] built the embed tree ${join(outDir, 'embed', 'v1')} (control ${embed.control})\n`
      : `[widget] built ${join(outDir, 'v1')}\n`,
  );
  for (const s of sizes)
    process.stdout.write(
      `[widget]   ${s.name.padEnd(32)} ${kb(s.bytes).padStart(9)} raw ${kb(s.gzip).padStart(9)} gzip\n`,
    );
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      watch: { type: 'boolean' },
      embed: { type: 'boolean' },
      hosted: { type: 'boolean' },
      'control-url': { type: 'string' },
    },
  });
  const embed =
    values.embed || values.hosted
      ? {
          control: controlOriginOf(
            values['control-url'] ||
              process.env.WHOMBAT_CONTROL_URL ||
              process.env.VITE_WHOMBAT_CONTROL_URL ||
              undefined,
          ),
        }
      : undefined;
  const outDir = resolve(
    process.env.INIT_CWD ?? process.cwd(),
    values.out ?? join(WIDGET_ROOT, embed ? 'dist-embed' : 'dist'),
  );
  const once = async () => {
    const { sizes } = await buildWidget(outDir, embed);
    report(sizes, outDir, embed);
  };
  if (!values.watch) return once();
  // Watching (pnpm dev): a broken build is reported and waits for the next change instead of stopping dev.
  await once().catch((err: unknown) =>
    process.stderr.write(`[widget] ${err instanceof Error ? err.message : String(err)}\n`),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      once().catch((err: unknown) =>
        process.stderr.write(`[widget] ${err instanceof Error ? err.message : err}\n`),
      );
    }, 100);
  };
  watch(join(WIDGET_ROOT, 'src'), { recursive: true }, rebuild);
  process.stdout.write('[widget] watching for changes…\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`[widget] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
