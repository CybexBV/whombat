import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { buildNumberOfVersion } from '../../packages/client/src/managed/build';
import { bootPreload } from './boot-preload';
import { fixtureChunks } from './fixture-chunks';
import { hostedHardening, sandboxHeaders } from './hosted';
import { precompress } from './precompress';
import { NO_FLASH_SCRIPT } from './src/app/theme/noFlash';
import { contractsVersion, versionFile } from './version-file';

/** Sets `data-theme` before first paint (stored choice, else `prefers-color-scheme`). */
export function themeNoFlash(): Plugin {
  return {
    name: 'whombat-theme-no-flash',
    transformIndexHtml: () => [{ tag: 'script', children: NO_FLASH_SCRIPT, injectTo: 'head-prepend' }],
  };
}

const NODE_MODULES = (names: string) => new RegExp(`[\\\\/]node_modules[\\\\/](?:${names})[\\\\/]`);

/**
 * Chunks (docs/decisions/web-efficiency.md WE-01). The libraries change only when a dependency or the contracts move, so
 * each is a chunk of its own the browser keeps across app releases: React, the router, the query cache, zod, the
 * contracts (`@whombat/core`, `@whombat/protocol`) and the canvas editor's (canvases only). Everything else the first
 * page needs is one `app` chunk; the screens are lazy routes, and what several of them share is merged into chunks of
 * at least 20 kB.
 */
export const CODE_SPLITTING = {
  groups: [
    { name: 'react', test: NODE_MODULES('react|react-dom|scheduler'), priority: 40 },
    {
      name: 'router',
      test: NODE_MODULES('@tanstack[\\\\/](?:react-router|router-core|history|react-store|store)'),
      priority: 40,
    },
    { name: 'query', test: NODE_MODULES('@tanstack[\\\\/](?:query-core|react-query)'), priority: 40 },
    { name: 'zod', test: NODE_MODULES('zod'), priority: 40 },
    // The contracts are workspace packages: their sources under packages/.
    { name: 'contracts', test: /[\\/]packages[\\/](?:core|protocol)[\\/]src[\\/]/, priority: 30 },
    // The canvas editor's libraries (Tiptap, ProseMirror, Yjs, Hocuspocus): only canvases load them.
    {
      name: 'editor',
      test: NODE_MODULES('@tiptap|prosemirror-[a-z-]+|yjs|y-protocols|lib0'),
      priority: 30,
    },
    { name: 'app', tags: ['$initial' as const], priority: 20 },
    {
      name: 'shared',
      minShareCount: 2,
      entriesAware: true,
      entriesAwareMergeThreshold: 20_000,
      priority: 10,
    },
  ],
};

const sharedName = (name: string | undefined) => (name?.startsWith('shared~') ? 'shared' : null);

const APP_PACKAGE = fileURLToPath(new URL('./package.json', import.meta.url));
const FIXTURE_MODE = fileURLToPath(new URL('./src/app/fixtureMode.ts', import.meta.url));
const FIXTURES_PACKAGE = fileURLToPath(new URL('../../packages/fixtures/', import.meta.url));
const source = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

/** What `src/main.tsx` imports for each page once the page's scripts ran: preloaded by `bootPreload`. */
export const BOOT_MODULES = {
  box: [source('managed/BoxRoot.tsx'), source('managed/boxEnv.ts')],
  hosted: [source('managed/ManagedRoot.tsx'), source('managed/connect.ts')],
} as const;

/**
 * The fonts are this origin's own in every build (`src/app/fonts/fonts.css`, WE-05): no Google Fonts. The two files
 * the first screen always draws with are preloaded, so text doesn't wait for the stylesheet to find them: Bricolage
 * Grotesque latin (one variable file for 400–700) and DM Mono 400 latin. Build only (dev loads them through the CSS).
 */
export const PRELOADED_FONTS = [
  'bricolagegrotesque-3y9K6as8bTXq_nANBjzKo3IeZx8z6up5BeSl9D4dj_x9PpZBMlGIInE.woff2',
  'dmmono-aFTU7PB1QTsUX8KYthqQBA.woff2',
] as const;

export function preloadFonts(): Plugin {
  let base = '/';
  return {
    name: 'whombat-preload-fonts',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const assets = Object.values(ctx.bundle ?? {});
        return PRELOADED_FONTS.map((font) => {
          const asset = assets.find(
            (a) => a.type === 'asset' && a.originalFileNames.some((n) => n.endsWith(`/fonts/${font}`)),
          );
          if (!asset) throw new Error(`preloadFonts: ${font} isn't in the bundle (src/app/fonts/fonts.css)`);
          return {
            tag: 'link',
            attrs: {
              rel: 'preload',
              href: `${base}${asset.fileName}`,
              as: 'font',
              type: 'font/woff2',
              crossorigin: '',
            },
            injectTo: 'head' as const,
          };
        });
      },
    },
  };
}

/**
 * Production builds have no fixture mode (docs/decisions/web-efficiency.md WE-02): `src/app/fixtureMode.ts`, the door to
 * the mock world, loads as `null`, so `@whombat/fixtures`, the app's `*Fixtures.ts` and the fake AI aren't in what a page
 * loads. Development, tests, Storybook and the e2e builds keep it. The hosted app's “Look around without a Whombat”
 * (`lazyDemo`, docs/app/decisions/look-around.md) imports the world itself, on demand: there it may be only in chunks
 * that nothing the page loads imports statically. The box's page has none at all. A build that breaks this stops.
 */
export function noFixtureMode(options: { lazyDemo?: boolean } = {}): Plugin {
  return {
    name: 'whombat-no-fixture-mode',
    enforce: 'pre',
    apply: (_config, { command, mode }) => command === 'build' && mode === 'production',
    load(id) {
      if (id.split('?')[0] === FIXTURE_MODE) return 'export const fixtureMode = null;\n';
      return null;
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
      const leaked = fixtureChunks(chunks, options.lazyDemo ?? false).flatMap((c) =>
        c.moduleIds.filter((id) => id.startsWith(FIXTURES_PACKAGE)),
      );
      if (leaked.length)
        this.error(
          options.lazyDemo
            ? `the mock world loads with the page (${leaked.slice(0, 3).join(', ')}): only the demo may load it, on demand`
            : `the mock world is in a production build (${leaked.slice(0, 3).join(', ')}): import it through src/app/fixtureMode.ts`,
        );
    },
  };
}

/** The app's release version (this package's `package.json`, what `app-vX.Y.Z` tags). */
export function appVersion(): string {
  return (JSON.parse(readFileSync(APP_PACKAGE, 'utf8')) as { version: string }).version;
}

/**
 * The hosted UI's integer build number (CT-53: compared with the appliance's client security floor), AP-259: the
 * release version's (`buildNumberOfVersion`: 0.12.0 → 12000), so building a tag always gives the same number and
 * the deploy needs nothing else. `VITE_WHOMBAT_BUILD_NUMBER` overrides it (digits only). Never a guess: a version
 * that isn't `X.Y.Z` gives 0, which a floor refuses.
 */
export function webBuildNumber(env: Record<string, string | undefined>, version = appVersion()): number {
  const given = env.VITE_WHOMBAT_BUILD_NUMBER?.trim();
  if (given && /^\d+$/.test(given)) return Number(given);
  return buildNumberOfVersion(version);
}

/** The build id `hello.client.build` carries: `VITE_WHOMBAT_BUILD`, else the version and the commit (`0.12.0+1a2b3c4`). */
export function webBuildId(env: Record<string, string | undefined>, version = appVersion()): string {
  const given = env.VITE_WHOMBAT_BUILD?.trim();
  if (given) return given;
  try {
    const rev = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
    return rev ? `${version}+${rev}` : version;
  } catch {
    return version;
  }
}

export default defineConfig(({ mode, command }) => {
  const env = { ...loadEnv(mode, '../..', ''), ...process.env };
  // The production build talks to its own origin (the server serves it): never the fixtures.
  if (command === 'build' && mode === 'production' && ['1', 'true'].includes(env.VITE_FIXTURES ?? '')) {
    throw new Error('VITE_FIXTURES is set: a production build must talk to the server, not the mock world.');
  }
  // Which page (hermes-engine-app.md AP-5322): `box` — the page a box serves on its direct ways (HE-50), talking to its
  // own origin's direct socket with no control (the release artifact's `web/`; `pnpm dev`, which proxies that socket to
  // a local runtime); `hosted` — app.whombat.com: the cloud account, then the box directly on its Tailscale name or
  // through the relay. Fixture mode (`VITE_FIXTURES`) runs the burrow app on the in-memory box either way.
  const target = env.VITE_WHOMBAT_TARGET || 'box';
  if (target !== 'box' && target !== 'hosted')
    throw new Error(`VITE_WHOMBAT_TARGET must be box or hosted, not ${target}`);
  if (command === 'build' && mode === 'production' && env.VITE_WHOMBAT_FAKE === '1') {
    throw new Error(
      'VITE_WHOMBAT_FAKE is set: a production build must talk to control and the relay, not the fake world.',
    );
  }
  const version = appVersion();
  const build = { version, id: webBuildId(env, version), number: webBuildNumber(env, version) };
  // `pnpm dev` (HE-49): the page's own origin is Vite's, so its direct socket and the box's identity (`/v1/direct`) go
  // to a local runtime's direct listener (`WHOMBAT_DIRECT_PORT`, the runtime's `PORT + 80`), which takes loopback pages
  // in development (Whombat direct-connection.md DC-04, DC-17).
  const directTarget = `http://localhost:${env.WHOMBAT_DIRECT_PORT || Number(env.PORT || 4400) + 80}`;
  const directProxy = { '/v1/direct': { target: directTarget, changeOrigin: true, ws: true } };

  return {
    plugins: [
      noFixtureMode({ lazyDemo: target === 'hosted' }),
      react(),
      themeNoFlash(),
      preloadFonts(),
      // Fixture mode's burrow app is part of the page itself (`src/main.tsx`).
      bootPreload(env.VITE_FIXTURES ? null : BOOT_MODULES[target]),
      sandboxHeaders(),
      versionFile({ version, build: build.id, buildNumber: build.number }),
      // The box serves these (Whombat direct-connection.md DC-08); the hosted build's static host compresses itself.
      ...(target === 'box' ? [precompress()] : []),
      hostedHardening({
        controlUrl: env.VITE_WHOMBAT_CONTROL_URL || 'https://api.whombat.com',
        relayOrigins: (env.VITE_WHOMBAT_RELAY_ORIGINS || 'wss://relay.whombat.com wss://*.relay.whombat.com')
          .split(/\s+/)
          .filter(Boolean),
        noFlashScript: NO_FLASH_SCRIPT,
        box: target === 'box',
      }),
    ],
    define: {
      'import.meta.env.VITE_WHOMBAT_TARGET': JSON.stringify(target),
      'import.meta.env.VITE_WHOMBAT_FAKE': JSON.stringify(env.VITE_WHOMBAT_FAKE ?? ''),
      'import.meta.env.VITE_WHOMBAT_BUILD': JSON.stringify(build.id),
      'import.meta.env.VITE_WHOMBAT_BUILD_NUMBER': JSON.stringify(String(build.number)),
      // What Settings → This Whombat's VERSION and the account menu show (settings-simplify.md SS-06, SS-08).
      'import.meta.env.VITE_WHOMBAT_VERSION': JSON.stringify(version),
      'import.meta.env.VITE_WHOMBAT_CONTRACTS': JSON.stringify(contractsVersion()),
    },
    css: {
      modules: { localsConvention: 'camelCaseOnly' },
    },
    server: {
      port: Number(env.WEB_PORT || 5180),
      strictPort: true,
      proxy: target === 'box' ? directProxy : {},
    },
    preview: {
      port: Number(env.WEB_PORT || 5180),
    },
    build: {
      // Hashed files under /assets are cached for a year by the server; index.html never is.
      assetsDir: 'assets',
      // Voice typing's AudioWorklet stays a file of its own: the pages' CSP (`script-src 'self'`) refuses one inlined as
      // a `data:` URL (docs/decisions/dictation.md).
      assetsInlineLimit: (file: string) => (file.endsWith('captureWorklet.js') ? false : undefined),
      sourcemap: false,
      rolldownOptions: {
        output: {
          codeSplitting: CODE_SPLITTING,
          // Shared chunks are named after every screen that uses them; `shared-<hash>` is enough.
          chunkFileNames: (chunk) => `assets/${sharedName(chunk.name) ?? '[name]'}-[hash].js`,
          assetFileNames: (asset) => `assets/${sharedName(asset.names[0]) ?? '[name]'}-[hash][extname]`,
        },
      },
    },
  };
});
