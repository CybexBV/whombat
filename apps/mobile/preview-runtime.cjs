// Browser runtimes kept as bytes: they execute only inside the confined preview (Mermaid's diagrams, the page set
// viewer's script), never in React Native. Metro (metro-svg-transformer.cjs) and the unit tests (vitest.config.ts) both
// turn these files into a module whose default export is a `data:` URL of the file.

/** The files that become data-URL modules, by where they end. */
const RUNTIME_FILES = ['/mermaid/dist/mermaid.min.js', '/packages/client/src/pages/pages-runtime.js'];

/** Whether a source file is one of the browser runtimes. */
function isRuntimeFile(filename) {
  const file = String(filename).split('?')[0].replaceAll('\\', '/');
  return RUNTIME_FILES.some((end) => file.endsWith(end));
}

/** The file as a `data:application/javascript;base64,…` URL. */
function runtimeDataUrl(src) {
  return `data:application/javascript;base64,${Buffer.from(src).toString('base64')}`;
}

/** The CommonJS module Metro bundles for a runtime. */
function runtimeModuleSource(src) {
  return `module.exports = { __esModule: true, default: ${JSON.stringify(runtimeDataUrl(src))} };`;
}

module.exports = { isRuntimeFile, runtimeDataUrl, runtimeModuleSource };
