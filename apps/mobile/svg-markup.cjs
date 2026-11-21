// What Metro (metro-svg-transformer.cjs) and the unit tests (vitest.config.ts) make of an `.svg` file (AP-903).

/**
 * The markup the app draws (AP-903): the file without its `<metadata>` (each avatar carries a C2PA manifest, ~7.7 kB of
 * its ~21 kB, a third of the bundle's avatars), without namespace declarations nothing uses any more, and with empty
 * elements written `<stop …/>` instead of `<stop …></stop>`. Drawing data (shapes, paths, gradients, numbers) is left
 * exactly as it is, so the avatars look the same.
 */
function slimSvg(src) {
  let out = src.replace(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/g, '').replace(/<metadata\b[^>]*\/>/g, '');
  for (const [declaration, prefix] of out.matchAll(/\sxmlns:([\w.-]+)="[^"]*"/g)) {
    const rest = out.replace(declaration, '');
    if (!new RegExp(`[<\\s]${prefix.replace(/[.-]/g, '\\$&')}:`).test(rest)) out = rest;
  }
  return out.replace(/<([A-Za-z][\w:.-]*)(\s[^<>]*?)?><\/\1>/g, (_, tag, attrs = '') => `<${tag}${attrs}/>`);
}

module.exports = { slimSvg };
