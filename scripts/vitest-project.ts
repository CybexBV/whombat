/**
 * What every Vitest config here shares: on a developer's machine Vitest keeps the modules it transformed between runs
 * (`fsModuleCache`, in `node_modules/.vitest-cache`), so a run transforms only what changed. CI (`CI=true`) transforms
 * everything afresh: its machines start empty, and a check there must not depend on an earlier run. A `fast-test` run
 * on the build server is told a folder that stays between its runs (`FAST_TEST_CACHE_DIR`) and keeps them there: its checkout
 * is new every time, and transforming was up to a third of the suite's time.
 *
 * Under `fast-test` (`FAST_TEST=1`) a failing test runs once more by itself before it counts as failing, so the step
 * around it doesn't run the whole suite twice.
 *
 * Vitest's own key is a module's path and content, `NODE_ENV`, the config files and the plugin names, and a change to
 * the installed lockfile clears the whole cache. It misses where an import resolves to (a workspace package's `exports`
 * naming another file: the importer's cached code keeps the old path) and files a config loads itself (the mobile
 * config's SVG helper), so the key below adds those, with the TypeScript settings the transform reads.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitest/config';

/** A developer's machine: CI's machines set `CI=true`. */
export const LOCAL_RUN = process.env.CI !== 'true';

/** A folder that outlives the run on a machine whose checkout doesn't (fast-test's runs on the build server). */
const KEPT_CACHE = process.env.FAST_TEST_CACHE_DIR;

/** fast-test's steps: a failing test runs once more by itself. */
const UNDER_FAST_TEST = process.env.FAST_TEST === '1';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Files a config reads itself, outside Vite's module graph. */
const LOADED_BY_CONFIGS = ['apps/mobile/svg-markup.cjs'];

/** The package.json fields that decide which file an import of the package resolves to (not its version). */
const RESOLVE_FIELDS = ['exports', 'imports', 'main', 'module', 'browser', 'type'] as const;

const read = (file: string) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : '');

/** The root and the workspace's package directories, as `pnpm-workspace.yaml` lists them. */
function workspaceDirs(): string[] {
  const block = /^packages:\n((?:[ \t]+-.*\n)+)/m.exec(read('pnpm-workspace.yaml'))?.[1] ?? '';
  const patterns = [...block.matchAll(/^[ \t]+-[ \t]*['"]?([^'"\s#]+)/gm)].map((m) => m[1] ?? '');
  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });
  return ['.', ...dirs.sort()].filter((dir) => existsSync(join(ROOT, dir, 'package.json')));
}

function resolveKey(): string {
  const hash = createHash('sha1');
  for (const dir of workspaceDirs()) {
    const pkg = JSON.parse(read(`${dir}/package.json`)) as Record<string, unknown>;
    hash.update(`${dir}\0${JSON.stringify(RESOLVE_FIELDS.map((field) => pkg[field] ?? null))}\0`);
    hash.update(`${read(`${dir}/tsconfig.json`)}\0`);
  }
  for (const file of ['tsconfig.base.json', ...LOADED_BY_CONFIGS]) hash.update(`${file}\0${read(file)}\0`);
  return hash.digest('hex');
}

// Every project's config adds the plugin, and each config file is bundled with its own copy of this module, but the
// key generators belong to the whole run: the first project registers one, through a registry all copies share.
const REGISTRY = Symbol.for('whombat.vitest.moduleCacheKey');
const shared = globalThis as { [REGISTRY]?: WeakSet<object> };
shared[REGISTRY] ??= new WeakSet();
const registered = shared[REGISTRY];

const moduleCacheKey: Plugin = {
  name: 'whombat-module-cache-key',
  configureVitest({ vitest, defineCacheKeyGenerator }) {
    if (registered.has(vitest)) return;
    registered.add(vitest);
    let key: string | undefined;
    // Read once per run, when Vitest first looks a module up.
    defineCacheKeyGenerator(() => {
      key ??= resolveKey();
      return key;
    });
  },
};

/** `config`, keeping its transformed modules between runs, and retrying a failing test once under fast-test. */
export function withModuleCache<T extends { plugins?: unknown[]; test?: object }>(config: T): T {
  const retry = UNDER_FAST_TEST ? { retry: 1 } : {};
  if (!LOCAL_RUN && !KEPT_CACHE) return { ...config, test: { ...config.test, ...retry } };
  return {
    ...config,
    plugins: [...(config.plugins ?? []), moduleCacheKey],
    test: {
      ...config.test,
      ...retry,
      fsModuleCache: true,
      ...(KEPT_CACHE ? { fsModuleCachePath: join(KEPT_CACHE, 'vitest') } : {}),
    },
  };
}
