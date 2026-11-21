// Metro: `.svg` files become modules whose default export is the file's markup (Whombat five-agents.md FA-09), less what
// doesn't draw (AP-903). The five agents' avatars (`@whombat/avatars/svg/*`) are drawn with react-native-svg from the
// JS bundle inside the APK: no asset server, no network, the same files the web serves. Everything else goes to Expo's
// Babel transformer.
// The transformer `expo/metro-config` sets by default (metro.config.cjs replaces it with this file).
const upstream = require(
  require.resolve('@expo/metro-config/babel-transformer', { paths: [require.resolve('expo/package.json')] }),
);
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { slimSvg } = require('./svg-markup.cjs');
const { isRuntimeFile, runtimeModuleSource } = require('./preview-runtime.cjs');

// Metro keys its cache by this file's contents and the upstream key, not by what it requires: svg-markup.cjs joins in.
const markupKey = createHash('sha1')
  .update(readFileSync(require.resolve('./svg-markup.cjs')))
  .update(readFileSync(require.resolve('./preview-runtime.cjs')))
  .digest('hex');

/** The module source for an SVG file: its slimmed markup as the default export. */
function svgModuleSource(src) {
  return `module.exports = { __esModule: true, default: ${JSON.stringify(slimSvg(src))} };`;
}

module.exports = {
  ...upstream,
  slimSvg,
  svgModuleSource,
  getCacheKey(...args) {
    return `${upstream.getCacheKey ? upstream.getCacheKey(...args) : ''}$svg-markup:${markupKey}`;
  },
  transform(params) {
    if (isRuntimeFile(params.filename))
      return upstream.transform({ ...params, src: runtimeModuleSource(params.src) });
    if (params.filename.endsWith('.svg'))
      return upstream.transform({ ...params, src: svgModuleSource(params.src) });
    return upstream.transform(params);
  },
};
