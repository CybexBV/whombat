#!/usr/bin/env node
/**
 * Moves a SCRATCH clone of Whombat to another Claude Code version so its provider tests can run against it (the
 * “latest tested” job, docs/runbooks/client-latest-tested.md). Never run it on a real checkout: the job only tests;
 * bumping Whombat's committed pins stays a person's change (docs/managed/provider-bundles.md “Bumping a pin”). Claude
 * Code only: Codex is no longer tested or published (IN-432; Whombat HN-04).
 *
 * It reads the current pin from packages/agent-runtime/src/providers/bundles.ts and replaces, in the agent-runtime
 * package and pnpm-workspace.yaml, the old version with the new one and every old digest with the new one from
 * `clientchannel fetch` (release asset sha256, npm integrity, executable sha256), then renames the fixture file when
 * the pin has one (a Whombat since hermes-native.md HN-K01 has none: `fixture: null`). A fixture's content is
 * regenerated afterwards by `provider:fixtures`.
 *
 * Usage: node bump-pins.mjs --whombat <scratch clone> --fetched <fetch JSON>
 * Prints JSON: {provider, from, to, files, fixture (null: none), adapter}
 */
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(n);
  if (i < 0 || !args[i + 1]) throw new Error(`${n} is required`);
  return args[i + 1];
};
const whombat = opt('--whombat');
const fetched = JSON.parse(readFileSync(opt('--fetched'), 'utf8'));
const pkg = join(whombat, 'packages', 'agent-runtime');
const bundlesTs = join(pkg, 'src', 'providers', 'bundles.ts');
const mod = await import(pathToFileURL(bundlesTs).href);
if (fetched.provider !== 'claude')
  throw new Error(`${fetched.provider} is no longer tested or published: Claude Code only (IN-432)`);
const old = mod.CLAUDE_BUNDLE;
if (!old) throw new Error('bundles.ts has no bundle for claude');
// The runtime's adapter level (RuntimeFacts.clientAdapters): CLIENT_ADAPTER_LEVELS in providers/clients.ts (SUB-25),
// read as text (that module imports others, which plain type stripping can't resolve).
const adapterLevel = () => {
  const f = join(pkg, 'src', 'providers', 'clients.ts');
  if (!existsSync(f)) return null;
  const m = /CLIENT_ADAPTER_LEVELS[^=]*=\s*\{([^}]*)\}/.exec(readFileSync(f, 'utf8'));
  const v = m && new RegExp(`\\b${fetched.provider}\\s*:\\s*(\\d+)`).exec(m[1]);
  return v ? Number(v[1]) : null;
};

const map = new Map();
const set = (from, to) => {
  if (!from || !to || from === to) return;
  if (map.has(from) && map.get(from) !== to) throw new Error(`conflicting replacements for ${from}`);
  map.set(from, to);
};
set(old.version, fetched.version);
for (const b of old.binaries) {
  const pin = fetched.pins?.[b.platform];
  if (!pin) throw new Error(`no ${b.platform} pin for ${fetched.provider} ${fetched.version}`);
  const [rel, npm] = b.artifacts;
  set(rel?.digest?.replace(/^sha256:/, ''), pin.sha256);
  if (npm?.digest?.startsWith('sha512-')) set(npm.digest, pin.npmIntegrity);
  if (b.binarySha256) set(b.binarySha256, pin.binarySha256 ?? null);
}

const exts = /\.(ts|mts|mjs|js|json|md|yaml)$/;
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (exts.test(e.name) && statSync(p).size < 8 << 20) files.push(p);
  }
};
walk(pkg);
files.push(join(whombat, 'pnpm-workspace.yaml'));
const keys = [...map.keys()].sort((a, b) => b.length - a.length);
const changed = [];
for (const f of files) {
  if (!existsSync(f)) continue;
  let s = readFileSync(f, 'utf8');
  const before = s;
  for (const k of keys) {
    const v = map.get(k);
    // A digest that is no longer known becomes null (quoted string → null), everything else is a plain replacement.
    s = v === null ? s.split(`'${k}'`).join('null') : s.split(k).join(v);
  }
  if (s !== before) {
    writeFileSync(f, s);
    changed.push(relative(whombat, f));
  }
}
if (old.fixture) {
  const oldFixture = join(pkg, 'src', 'providers', old.fixture);
  const newFixture = join(pkg, 'src', 'providers', old.fixture.split(old.version).join(fetched.version));
  if (oldFixture !== newFixture && existsSync(oldFixture)) renameSync(oldFixture, newFixture);
}
const after = await import(`${pathToFileURL(bundlesTs).href}?bumped=${Date.now()}`);
const now = after.CLAUDE_BUNDLE;
if (now.version !== fetched.version) throw new Error(`bundles.ts still pins ${now.version}`);
console.log(
  JSON.stringify({
    provider: fetched.provider,
    from: old.version,
    to: fetched.version,
    files: changed,
    fixture: now.fixture ? relative(whombat, join(pkg, 'src', 'providers', now.fixture)) : null,
    adapter: adapterLevel(),
  }),
);
