// Metro for a pnpm workspace: watch the repo, resolve workspace packages (TypeScript source through their
// package `exports`) and keep one copy of every library that must be a singleton. Workspace packages have
// their own devDependencies (React 19.3 for the web tests, TanStack Query), so without the redirect below a
// hook imported from `@whombat/client/react` would load a second React.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
// The avatars' SVG files are source, imported as markup (metro-svg-transformer.cjs, FA-09), not image assets.
config.transformer.babelTransformerPath = require.resolve('./metro-svg-transformer.cjs');
config.resolver.assetExts = config.resolver.assetExts.filter((ext) => ext !== 'svg');
config.resolver.sourceExts = [...config.resolver.sourceExts, 'svg'];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.unstable_enablePackageExports = true;
// The app's own modules run when first used instead of all at start (android-slim.md AP-888): Metro doesn't tree-shake,
// so the bundle holds every screen, and evaluating them all held the first frame back. Expo turns inline requires off by
// default; React Native's own template turns them on. Not for node_modules: inlined requires in the transport libraries
// (Noise, uint8arraylist, cborg, …) halved upload and download speed in the device harness. Metro asks `file in
// blockList` in its main process, so a proxy answers for every package file.
const NODE_MODULES = `${path.sep}node_modules${path.sep}`;
const packageFiles = new Proxy(
  {},
  { has: (_, file) => typeof file === 'string' && file.includes(NODE_MODULES) },
);
config.transformer.getTransformOptions = async () => ({
  transform: { experimentalImportSupport: true, inlineRequires: { blockList: packageFiles } },
});

/** Always resolved from the app, whoever imports them. */
const SINGLETONS = [
  'react',
  'react-native',
  'react-native-svg',
  'react-native-safe-area-context',
  '@tanstack/react-query',
  '@tanstack/query-core',
  'zod',
];
const fromApp = path.join(projectRoot, 'index.ts');
const upstream = config.resolver.resolveRequest;

/**
 * `@libp2p/utils`' react-native field maps a helper to its Node file, which imports `node:os`; the secure channel
 * never uses it (secure-channel ADR SC-05 item 3). An empty module keeps Metro resolving.
 */
const SHIMS = {
  'node:os': path.join(projectRoot, 'shims/node-os.js'),
  // Its `browser` field maps crypto/index.js → index.browser.js, but Metro doesn't apply it to the `./crypto`
  // export (the pure-JS primitives the native AEAD builds on, AP-26).
  '@libp2p/noise/crypto': path.join(
    require('node:fs').realpathSync(path.join(projectRoot, 'node_modules/@libp2p/noise')),
    'dist/src/crypto/index.browser.js',
  ),
};

/**
 * zod's entry re-exports all of its ~45 locales (`z.locales`); without tree shaking that is ~250 kB of messages the app
 * never shows (zod imports its English default itself). The shim keeps the namespace with English only (AP-889).
 */
const ZOD_LOCALES = /[\\/]zod[\\/]v4[\\/](classic|core)[\\/][^\\/]+$/;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (SHIMS[moduleName]) return { type: 'sourceFile', filePath: SHIMS[moduleName] };
  if (moduleName === '../locales/index.js' && ZOD_LOCALES.test(context.originModulePath))
    return { type: 'sourceFile', filePath: path.join(projectRoot, 'shims/zod-locales.js') };
  const resolve = upstream ?? context.resolveRequest;
  const singleton = SINGLETONS.some((name) => moduleName === name || moduleName.startsWith(`${name}/`));
  const from = singleton ? { ...context, originModulePath: fromApp } : context;
  try {
    return resolve(from, moduleName, platform);
  } catch (error) {
    // The contracts' sources name the file tsc emits (`./edition.js` is edition.ts, contracts CT-01); Metro only
    // looks for the .js file.
    if (!/^\.\.?\/.*\.js$/.test(moduleName)) throw error;
    return resolve(from, moduleName.replace(/\.js$/, '.ts'), platform);
  }
};

module.exports = config;
