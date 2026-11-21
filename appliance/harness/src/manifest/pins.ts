/**
 * The pins (IN-02): the integration input — which commit of which repository, how to build it from a
 * clean checkout, which artifacts to digest and which gates to run. `manifest/build` turns it into the build
 * report and the strict `ProductManifest` (`@whombat/release`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { expandHome, HARNESS_DIR, MANIFEST_DIR, REPO_DIR, STATE_HOME } from '../lib/paths.ts';

export const Cmd = z.strictObject({
  /** argv; run without a shell unless `shell` is set. */
  run: z.array(z.string().min(1)).min(1),
  /** Relative to the checkout. */
  cwd: z.string().default('.'),
  env: z.record(z.string(), z.string()).default({}),
  timeoutS: z.number().int().positive().default(1800),
});
export type Cmd = z.infer<typeof Cmd>;

export const Artifact = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._/@:-]+$/),
  kind: z.enum(['nix-store-path', 'oci-image', 'tarball', 'web-bundle', 'apk', 'ipa', 'go-module']),
  /**
   * How to get the file whose sha256 is the digest:
   * - `file`: a file the build produced (`path`);
   * - `tar`: a deterministic tarball of `paths` (relative to `cwd`);
   * - `git-archive`: the source tree at the pinned commit (`prefix`);
   * - `sums`: every file listed in the SHA256SUMS at `path` (one artifact each, `name` is a prefix).
   */
  from: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('file'), path: z.string() }),
    z.strictObject({
      type: z.literal('tar'),
      cwd: z.string().default('.'),
      paths: z.array(z.string()).min(1),
    }),
    z.strictObject({ type: z.literal('git-archive'), prefix: z.string() }),
    z.strictObject({ type: z.literal('sums'), path: z.string(), compareWith: z.string().optional() }),
  ]),
  note: z.string().optional(),
});
export type Artifact = z.infer<typeof Artifact>;

export const Gate = Cmd.extend({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Needs the harness Postgres (`WB_MGD_PG_URL` is exported). */
  needsPostgres: z.boolean().default(false),
});
export type Gate = z.infer<typeof Gate>;

export const Component = z.strictObject({
  /** Unique id in this file (a repository can appear once per branch). */
  id: z.string().regex(/^[a-z0-9-]+$/),
  repository: z.enum([
    'whombat-contracts',
    'Whombat',
    'whombat-app',
    'whombat-api',
    'whombat-relay',
    'whombat-appliance',
    /** The hosts service (formerly Rackoon; Whombat ONE-11, NX-152): the flake input `whombat-hosts`. */
    'whombat-hosts',
  ]),
  /** Local repository to clone from (objects only; `~/` allowed). */
  source: z.string(),
  /**
   * The component's folder in its repository, for the commits that hold it in one: control and the relay are
   * `control/` and `relay/` of the private repository whombat-cloud. A commit from before a component moved there holds
   * it at its root ({@link rootIn}).
   */
  dir: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  /** Working tree `dev/up --live` runs (other agents' checkouts: never installed into or modified). */
  live: z.string().optional(),
  /** Remote, informational (private GitHub repositories; the harness never pushes or fetches). */
  remote: z.string().optional(),
  /** Branch or tag the pin follows (`manifest/pin --refresh` moves `commit` to its head). */
  ref: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  tag: z.string().optional(),
  /** Component version (package/binary), when it has one. */
  version: z.string(),
  /** Contracts release this commit consumes (vendored), detected by the build. */
  contracts: z.string().optional(),
  build: z.array(Cmd).default([]),
  artifacts: z.array(Artifact).default([]),
  gates: z.array(Gate).default([]),
  notes: z.array(z.string()).default([]),
});
export type Component = z.infer<typeof Component>;

export const Placeholder = z.strictObject({
  /** JSON path in the product manifest. */
  path: z.string(),
  reason: z.string(),
  /** Who replaces it with a real value. */
  owner: z.string(),
});

export const Pins = z.strictObject({
  $schema: z.literal('whombat.integration-pins/1'),
  productVersion: z.string(),
  /** Epoch seconds the pins last changed (the product manifest's `createdAt`; deterministic). */
  updatedAt: z.number().int(),
  contracts: z.strictObject({ version: z.string(), component: z.string() }),
  components: z.array(Component).min(1),
  /** Release tuple parts that don't exist yet (Nix closures, provider bundles), marked as placeholders. */
  tuple: z.strictObject({
    releaseId: z.string(),
    hostAbi: z.number().int(),
    runtimeHostAbi: z.strictObject({ min: z.number().int(), max: z.number().int() }),
    providers: z.array(
      z.strictObject({
        provider: z.string(),
        version: z.string(),
        placeholder: z.boolean(),
        note: z.string(),
      }),
    ),
  }),
  upgradePaths: z
    .array(
      z.strictObject({
        from: z.string(),
        to: z.string(),
        via: z.array(z.string()),
        requiresCheckpoint: z.boolean(),
      }),
    )
    .default([]),
  placeholders: z.array(Placeholder).default([]),
  evidence: z.array(z.string()).default([]),
});
export type Pins = z.infer<typeof Pins>;

/**
 * The pins in use (IN-20). `WB_MGD_PINS` names a set (the validation passes the pins of the release it checks).
 * Without it they are this checkout's own: the component list (`manifest/components.json`) at the commit that is
 * checked out, as `manifest/pins-at` writes them and as the full validation takes them, kept in
 * `<WB_MGD_HOME>/pins/<commit>.json`. That file is written the first time the pins are read (`loadPins`), and
 * `WB_MGD_PINS` is set to it then, so every process started from this one runs the same commit even when the checkout
 * moves on meanwhile. A set's build report and product manifest are written next to it (`<name>.build-report.json`,
 * `<name>.product-manifest.json`, `<name>.annotations.json`).
 *
 * `manifest/pins.json` is the last set the flow before the one repository validated; nothing reads it unless
 * `WB_MGD_PINS` names it.
 */
function pinsFile(): { file: string; own: string | null } {
  const p = process.env.WB_MGD_PINS;
  if (p) {
    if (isAbsolute(p) || existsSync(resolve(p))) return { file: resolve(p), own: null };
    // relative to the appliance's folder (the wrappers change directory)
    return { file: resolve(REPO_DIR, p), own: null };
  }
  let commit = '';
  try {
    commit = execFileSync('git', ['-C', REPO_DIR, 'rev-parse', 'HEAD^{commit}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // not a checkout: `ownPins` says so when the pins are read
  }
  return { file: join(STATE_HOME, 'pins', `${commit.slice(0, 12) || 'no-commit'}.json`), own: commit };
}
const chosen = pinsFile();
export const PINS_FILE = chosen.file;
const committed = join(MANIFEST_DIR, 'pins.json');
const candidate = PINS_FILE !== committed;
const stem = PINS_FILE.replace(/\.json$/, '');
export const MANIFEST_FILES = {
  buildReport: candidate ? `${stem}.build-report.json` : join(MANIFEST_DIR, 'build-report.json'),
  product: candidate ? `${stem}.product-manifest.json` : join(MANIFEST_DIR, 'product-manifest.json'),
  annotations: candidate
    ? `${stem}.annotations.json`
    : join(MANIFEST_DIR, 'product-manifest.annotations.json'),
  candidate,
};

let ownWritten = false;

/**
 * Writes this checkout's own pins (no `WB_MGD_PINS`), once per process: `manifest/pins-at <commit>` in a process of
 * its own (the component list reads these schemas), to a temporary file that is then renamed, so a reader never sees
 * half a file.
 */
function ownPins(): void {
  if (chosen.own === null || ownWritten) return;
  if (!chosen.own)
    throw new Error(
      `${REPO_DIR} is not a git checkout, so its pins can’t be made from the component list: name a pins file with WB_MGD_PINS`,
    );
  mkdirSync(dirname(PINS_FILE), { recursive: true });
  const tmp = `${PINS_FILE}.${process.pid}.tmp`;
  try {
    execFileSync(
      process.execPath,
      [join(HARNESS_DIR, 'src/manifest/components.ts'), chosen.own, '--out', tmp],
      { env: { ...process.env, WB_MGD_PINS: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const why = String((err as { stderr?: string }).stderr || err).trim();
    throw new Error(
      `the pins of ${chosen.own.slice(0, 12)} couldn’t be made from the component list (${why}); name a pins file with WB_MGD_PINS`,
    );
  }
  renameSync(tmp, PINS_FILE);
  ownWritten = true;
  process.env.WB_MGD_PINS = PINS_FILE;
}

export function loadPins(file = PINS_FILE): Pins {
  if (file === PINS_FILE) ownPins();
  return Pins.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function savePins(pins: Pins, file = PINS_FILE): void {
  writeFileSync(file, `${JSON.stringify(Pins.parse(pins), null, 2)}\n`);
}

export function sourceOf(c: Component): string {
  return expandHome(c.source);
}

/**
 * The component's root in a checkout of its repository at its pinned commit: its `dir` when that checkout has the
 * folder, the checkout itself otherwise (no `dir`, or a commit from before the component moved into its folder).
 */
export function rootIn(checkout: string, c: Pick<Component, 'dir'>): string {
  return c.dir && existsSync(join(checkout, c.dir)) ? join(checkout, c.dir) : checkout;
}

/** The pinned commit's tree the component is: `<commit>:<dir>` when `checkout` holds it in its folder, else the commit. */
export function treeIn(checkout: string, c: Pick<Component, 'dir' | 'commit'>): string {
  return rootIn(checkout, c) === checkout ? c.commit : `${c.commit}:${c.dir}`;
}

export function component(pins: Pins, id: string): Component {
  const c = pins.components.find((x) => x.id === id);
  if (!c) throw new Error(`no component ${id} in pins.json`);
  return c;
}
