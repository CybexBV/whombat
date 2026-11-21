/**
 * Skills on Hermes, in Hermes's own layout (one-person.md OP-08; hermes-skills.md HSK-01…HSK-10), through the
 * Hermes-home service (`SKILLS_METHODS` in `@whombat/core`): one folder, the person's profile's `skills/`
 * (`ctx.skillsDir`, `$WHOMBAT_HERMES_ROOT/skills`), with Hermes's built-ins (its bundled sync and its
 * `.bundled_manifest`), what the person installed from Hermes's hub (its `.hub/lock.json`) and what the agent learned
 * (Hermes's `skill_manage`, in a turn). Hermes's own code keeps the built-ins and the hub skills (`skills-plugin.ts`:
 * sync, diff, reset, the hub, the scan); listing, reading, editing and on/off are this file's. A skill switched off
 * stays where it is: its name is in the bookkeeping's `off` list, which every turn's `config.yaml` names in
 * `skills.disabled` (HSK-05). Changes hold the folder's lock (`withSkills`, a host lock), which its archive takes too,
 * not the profile's: as Hermes's own CLI, a change doesn't wait for a turn. No two skills there answer to one name.
 *
 * Skills Hermes doesn't offer here (another platform's, one whose toolset a turn never has; HSK-04) aren't listed, nor
 * Hermes's own manual (`hermes-agent`, never seeded). Dot entries are bookkeeping, never skills. Who may do what is the
 * server's to check; the runner does what it is asked.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { hostLock, LockBusyError, type SkillRecord, skillFolders, skillNameOf } from '@whombat/agent-runtime';
import {
  HERMES_SKILL_FILE_MAX_BYTES,
  HERMES_SKILL_FILES_MAX,
  HERMES_SKILL_MAX_BYTES,
  HERMES_SKILL_MD_MAX_BYTES,
  HERMES_SKILLS_MAX,
  type HermesHomeArgs,
  type HermesHomeMethod,
  type HermesHomeResult,
  type HermesHubEntry,
  type HermesHubResult,
  HermesHubUpdateStatus,
  type HermesSkillCategory,
  type HermesSkillChange,
  HermesSkillFilePath,
  type HermesSkillOrigin,
  HermesSkillPath,
  type HermesSkillRead,
  type HermesSkillScan,
  type HermesSkillState,
  type HermesSkillSummary,
  redactSecrets,
  SCAN_FINDINGS_MAX,
  SCAN_MATCH_MAX,
  ScanCategory,
  type ScanFinding,
  ScanSeverity,
  ScanTrust,
  ScanVerdict,
  SKILL_CATEGORY_DESCRIPTION_MAX,
  SkillCategory,
  SkillHubIdentifier,
  SkillHubSource,
  SkillTrust,
} from '@whombat/core';
import { type HermesHomeContext, HermesHomeError } from './context';
import type { AreaHandlers } from './handlers';
import {
  type FolderFile,
  folderFiles,
  folderHash,
  isSkillFolder,
  makeWritable,
  type NewFile,
  readFolder,
  removeFolder,
} from './skills-folder';
import { skillFront } from './skills-front';
import { type HermesSkillsStep, type HermesSkillsSteps, pluginSteps } from './skills-plugin';
import {
  applyDefaultsOff,
  type HubLockEntry,
  hubSourceOf,
  readBundledManifest,
  readHubLock,
  readSkillsStateOf,
  stagingDir,
  writeSkillsState,
} from './skills-state';

/** How long a change waits for another change of the skills folder before it answers `busy`. */
const SKILLS_LOCK_WAIT_MS = 10_000;
/** A built-in list (`builtins`, 0.9 s) is kept while nothing changed the directory, at most this long. */
const BUILTINS_TTL_MS = 10 * 60_000;
/** Hermes's manual: never seeded, never listed (HE-S127). */
const HERMES_MANUAL = 'hermes-agent';

/** Bumped after every change of the skills folder: what is kept about it (`builtinsOf`) is from before. */
const generations = new WeakMap<HermesHomeContext, number>();
const generation = (ctx: HermesHomeContext) => generations.get(ctx) ?? 0;
/** The directory changed: what is kept about it is from before. */
const changedNow = (ctx: HermesHomeContext) => generations.set(ctx, generation(ctx) + 1);

/** Runs `fn` holding the skills folder's lock (`busy` when another change holds it too long). */
export async function withSkills<T>(
  ctx: HermesHomeContext,
  fn: (dir: string) => Promise<T>,
  options: { holder?: string; waitMs?: number } = {},
): Promise<T> {
  let lock: Awaited<ReturnType<typeof hostLock>>;
  try {
    lock = await hostLock(`hermes-skills:${ctx.skillsDir}`, {
      dir: join(ctx.root, 'locks'),
      holder: options.holder ?? 'hermes-home',
      waitMs: options.waitMs ?? SKILLS_LOCK_WAIT_MS,
      pollMs: 100,
    });
  } catch (err) {
    if (err instanceof LockBusyError)
      throw new HermesHomeError('busy', 'The skills are being changed right now.');
    throw err;
  }
  try {
    return await fn(ctx.skillsDir);
  } finally {
    changedNow(ctx);
    await lock.release();
  }
}

/* Hermes's steps --------------------------------------------------------------------------------------------------- */

const stepsCache = new WeakMap<HermesHomeContext, HermesSkillsSteps>();

/** One of the plugin's skills steps (or the test's stand-in for it). */
function step<T>(ctx: HermesHomeContext, name: HermesSkillsStep, input: Record<string, unknown>): Promise<T> {
  let steps = stepsCache.get(ctx);
  if (!steps) {
    steps =
      ctx.skillsSteps ??
      pluginSteps({ python: ctx.python, state: ctx.skillsState, env: ctx.env, log: ctx.log });
    stepsCache.set(ctx, steps);
  }
  return steps(name, input) as Promise<T>;
}

/** The plugin's `builtins` row (HSK-S05). */
interface BuiltinRow {
  name: string;
  path: string;
  present: boolean;
  tracked: boolean;
  removed: boolean;
  changed: boolean;
  original_changed: boolean;
  offered: boolean;
}

/** Hermes's built-ins as they are in the skills folder now, and Hermes's categories. */
interface Builtins {
  byPath: Map<string, BuiltinRow>;
  byName: Map<string, BuiltinRow>;
  /** Category (one folder) → Hermes's description of it. */
  categories: Map<string, string | null>;
  /** A removed built-in's `SKILL.md` as Hermes ships it (`diff`), once asked. */
  shipped: Map<string, Promise<string | null>>;
}

const builtinsCache = new WeakMap<
  HermesHomeContext,
  { key: string; at: number; value: Promise<Builtins | null> }
>();

/** Hermes's built-ins (the plugin's `builtins`, kept while nothing changed); null without a real Hermes or on failure. */
async function builtinsOf(ctx: HermesHomeContext): Promise<Builtins | null> {
  const manifest = await stat(join(ctx.skillsDir, '.bundled_manifest')).catch(() => null);
  const key = `${generation(ctx)}:${manifest?.mtimeMs ?? 0}:${manifest?.size ?? 0}`;
  const hit = builtinsCache.get(ctx);
  if (hit && hit.key === key && Date.now() - hit.at < BUILTINS_TTL_MS) return hit.value;
  const value = step<{
    builtins: BuiltinRow[];
    categories: Record<string, { description: string | null }>;
  }>(ctx, 'builtins', { dir: ctx.skillsDir })
    .then((a) => {
      const rows = (a.builtins ?? []).filter((r) => r.name !== HERMES_MANUAL);
      const categories = new Map<string, string | null>();
      for (const [category, info] of Object.entries(a.categories ?? {}))
        if (SkillCategory.safeParse(category).success)
          categories.set(
            category,
            info?.description?.trim().slice(0, SKILL_CATEGORY_DESCRIPTION_MAX) || null,
          );
      return {
        byPath: new Map(rows.map((r) => [r.path, r])),
        byName: new Map(rows.map((r) => [r.name, r])),
        categories,
        shipped: new Map(),
      };
    })
    .catch((err: unknown) => {
      // The list still works without it (HSK-S16); a step that failed is asked again next time.
      if (!(err instanceof HermesHomeError && err.code === 'unavailable')) {
        ctx.log('warn', `skills · Hermes's built-in list failed: ${(err as Error).message}`);
        builtinsCache.delete(ctx);
      }
      return null;
    });
  builtinsCache.set(ctx, { key, at: Date.now(), value });
  return value;
}

/** The plugin's `diff` (HSK-S06). */
interface DiffAnswer {
  present: boolean;
  diffs: { path: string; status: 'modified' | 'added' | 'removed' | 'binary' }[];
  skill_md: string;
}

const diffOf = (ctx: HermesHomeContext, name: string) =>
  step<DiffAnswer>(ctx, 'diff', { dir: ctx.skillsDir, name });

/** A removed built-in's `SKILL.md` as Hermes ships it (kept with the built-in list). */
function shippedText(ctx: HermesHomeContext, b: Builtins, name: string): Promise<string | null> {
  let hit = b.shipped.get(name);
  if (!hit) {
    hit = diffOf(ctx, name)
      .then((d) => d.skill_md || null)
      .catch(() => null);
    b.shipped.set(name, hit);
  }
  return hit;
}

/* Reading a folder ------------------------------------------------------------------------------------------------ */

const notFound = () => new HermesHomeError('not_found', 'That skill isn’t there.');
const iso = (ms: number) => new Date(ms || 0).toISOString();
const short = (hash: string) => hash.slice(0, 16);
const now = () => new Date().toISOString();

/** A `SKILL.md` as text (`failed` when it isn't UTF-8 or is too large to be one). */
async function skillMd(dir: string): Promise<string> {
  const raw = await readFile(join(dir, 'SKILL.md')).catch(() => null);
  if (!raw) throw notFound();
  if (raw.length > HERMES_SKILL_MD_MAX_BYTES)
    throw new HermesHomeError('failed', 'Its SKILL.md is too large.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new HermesHomeError('failed', 'Its SKILL.md isn’t UTF-8 text.');
  }
}

/** The name Hermes knows a skill at `path` by. */
const nameAt = (path: string, text: string) => skillNameOf(text, basename(path));

/** Everything a skill's summary is made from besides its folder. */
interface SkillFacts {
  off: ReadonlySet<string>;
  records: Readonly<Record<string, SkillRecord>>;
  builtins: Builtins | null;
  manifest: ReadonlyMap<string, string>;
  hubByPath: ReadonlyMap<string, HubLockEntry>;
}

async function skillFacts(ctx: HermesHomeContext, withBuiltins = true): Promise<SkillFacts> {
  const shared = ctx.skillsDir;
  const [state, builtins, manifest, lock] = await Promise.all([
    readSkillsStateOf(shared),
    withBuiltins ? builtinsOf(ctx) : Promise.resolve(null),
    readBundledManifest(shared),
    readHubLock(shared),
  ]);
  return {
    off: new Set(state.off),
    records: state.skills,
    builtins,
    manifest,
    hubByPath: new Map([...lock.values()].map((e) => [e.installPath, e])),
  };
}

/**
 * Where a skill comes from (HSK-01): Hermes's hub lock has it at this path; Hermes's sync placed it (tracked at a
 * built-in's path, or without a real Hermes to ask, a name its manifest tracks); else the agent learned it.
 */
function originOf(path: string, name: string, f: SkillFacts): HermesSkillOrigin {
  if (f.hubByPath.has(path)) return 'hub';
  if (f.builtins) {
    const row = f.builtins.byPath.get(path);
    return row?.tracked && row.name === name ? 'builtin' : 'learned';
  }
  return f.manifest.get(name) ? 'builtin' : 'learned';
}

/** Facts beyond the folder itself, for its summary. */
interface SummaryExtra {
  state: HermesSkillState;
  origin: HermesSkillOrigin;
  added: HermesSkillChange | null;
  hub: HermesHubEntry | null;
  changed: HermesSkillChange | null;
  originalChanged: boolean;
}

function summaryFrom(
  path: string,
  text: string,
  files: readonly FolderFile[] | readonly NewFile[],
  version: string,
  updatedMs: number,
  extra: SummaryExtra,
): HermesSkillSummary {
  const front = skillFront(text, basename(path));
  const bytes = files.reduce((n, f) => n + ('bytes' in f ? f.bytes : f.data.length), 0);
  return {
    path,
    name: front.name.slice(0, 64),
    description: front.description.slice(0, 1_024),
    version: short(version),
    updatedAt: iso(updatedMs),
    files: files.length,
    bytes,
    state: extra.state,
    origin: extra.origin,
    added: extra.added,
    hub: extra.hub,
    changed: extra.changed,
    originalChanged: extra.originalChanged,
    needs: front.needs,
  };
}

/** What a skill's summary says beyond its folder, from the facts. */
function skillExtra(path: string, name: string, f: SkillFacts, updatedMs: number): SummaryExtra {
  const origin = originOf(path, name, f);
  const rec = f.records[path];
  const row = origin === 'builtin' ? f.builtins?.byPath.get(path) : undefined;
  const builtinChanged = origin === 'builtin' && !!row?.changed;
  return {
    state: f.off.has(name) ? 'off' : 'on',
    origin,
    added: origin === 'builtin' ? null : (rec?.added ?? null),
    hub: origin === 'hub' ? (f.hubByPath.get(path)?.hub ?? null) : null,
    // A built-in is changed when Hermes says so (an edit undone by hand isn't); who changed it is Whombat's.
    changed:
      origin === 'builtin'
        ? builtinChanged
          ? (rec?.changed ?? { by: null, at: iso(updatedMs) })
          : null
        : (rec?.changed ?? null),
    originalChanged: builtinChanged && !!row?.original_changed,
  };
}

async function summaryOfDir(
  path: string,
  dir: string,
  extra: (name: string, updatedMs: number) => SummaryExtra,
): Promise<HermesSkillSummary> {
  const files = await folderFiles(dir);
  const text = await skillMd(dir);
  const updated = files.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
  return summaryFrom(
    path,
    text,
    files,
    await folderHash(dir, files),
    updated,
    extra(nameAt(path, text), updated),
  );
}

/** A skill's summary as it is now. */
async function skillSummary(
  ctx: HermesHomeContext,
  path: string,
  f?: SkillFacts,
): Promise<HermesSkillSummary> {
  const facts = f ?? (await skillFacts(ctx));
  return summaryOfDir(path, join(ctx.skillsDir, path), (name, updated) =>
    skillExtra(path, name, facts, updated),
  );
}

/** A built-in the person removed: Hermes's `SKILL.md` stands for it. */
function summaryOfRemoved(row: BuiltinRow, text: string, f: SkillFacts): HermesSkillSummary {
  const md = text || `---\nname: ${row.name}\ndescription: ""\n---\n`;
  const data = Buffer.from(md);
  return summaryFrom(
    row.path,
    md,
    [{ path: 'SKILL.md', data, exec: false }],
    createHash('sha256').update(data).digest('hex'),
    0,
    {
      state: 'removed',
      origin: 'builtin',
      added: null,
      hub: null,
      changed: f.records[row.path]?.changed ?? null,
      originalChanged: false,
    },
  );
}

/** Skill folders a path can name (dot folders are bookkeeping; others on disk are left alone). */
async function addressable(root: string): Promise<string[]> {
  return (await skillFolders(root)).filter(
    (p) => HermesSkillPath.safeParse(p).success && !p.split('/').some((s) => s.startsWith('.')),
  );
}

/** Every skill by the name Hermes knows it by. */
async function skillNames(shared: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of await addressable(shared)) {
    const text = await readFile(join(shared, path, 'SKILL.md'), 'utf8').catch(() => '');
    const name = nameAt(path, text);
    if (!out.has(name)) out.set(name, path);
  }
  return out;
}

/** `conflict` when a skill other than the one at `path` answers to `name`. */
async function assertUnique(shared: string, path: string, name: string): Promise<void> {
  const at = (await skillNames(shared)).get(name);
  if (at !== undefined && at !== path)
    throw new HermesHomeError('conflict', `Another skill is called “${name}” (${at}).`);
}

/** The skill at `path`; `not_found` for none. */
async function locate(shared: string, ref: { path: string }): Promise<string> {
  const dir = join(shared, ref.path);
  if (!(await isSkillFolder(dir))) throw notFound();
  return dir;
}

/** A file a path can name (one the agent's CLI wrote under another name stays on disk, unlisted). */
const addressableFile = (path: string) => HermesSkillFilePath.safeParse(path).success;

/* Steps ------------------------------------------------------------------------------------------------------------ */

type SkillsMethod = Extract<HermesHomeMethod, `skills.${string}`>;
type Args<M extends SkillsMethod> = HermesHomeArgs<M>;
type Result<M extends SkillsMethod> = HermesHomeResult<M>;

/** A category in the list: Hermes's words, else its `DESCRIPTION.md` in the skills folder. */
async function categoryOf(
  shared: string,
  category: string,
  b: Builtins | null,
): Promise<HermesSkillCategory> {
  if (b?.categories.has(category)) return { category, description: b.categories.get(category) ?? null };
  const text = await readFile(join(shared, category, 'DESCRIPTION.md'), 'utf8').catch(() => null);
  const description = text ? skillFront(text, category).description.trim() : '';
  return { category, description: description.slice(0, SKILL_CATEGORY_DESCRIPTION_MAX) || null };
}

const categoryOfPath = (path: string) => (path.includes('/') ? (path.split('/')[0] as string) : null);

async function list(ctx: HermesHomeContext): Promise<Result<'skills.list'>> {
  const shared = ctx.skillsDir;
  const facts = await skillFacts(ctx);
  const b = facts.builtins;
  const out: Result<'skills.list'> = { skills: [], categories: [] };
  const names = new Map<string, string>();
  for (const path of await addressable(shared)) {
    const row = b?.byPath.get(path);
    if (row?.tracked && !row.offered) continue;
    const s = await skillSummary(ctx, path, facts).catch(() => null);
    if (!s || s.name === HERMES_MANUAL) continue;
    out.skills.push(s);
    if (!names.has(s.name)) names.set(s.name, path);
  }
  for (const row of b?.byName.values() ?? []) {
    if (!row.removed || !row.offered || names.has(row.name)) continue;
    out.skills.push(summaryOfRemoved(row, (await shippedText(ctx, b as Builtins, row.name)) ?? '', facts));
  }
  out.skills = out.skills.slice(0, HERMES_SKILLS_MAX);
  const categories = new Set(out.skills.map((s) => categoryOfPath(s.path)).filter((c) => c !== null));
  for (const category of [...categories].sort())
    if (SkillCategory.safeParse(category).success) out.categories.push(await categoryOf(shared, category, b));
  out.categories = out.categories.slice(0, HERMES_SKILLS_MAX);
  return out;
}

type Ref = { path: string };

/** The folder a ref names (null for a removed built-in), its summary, and what it is compared with. */
async function resolveRef(
  ctx: HermesHomeContext,
  ref: Ref,
): Promise<{
  dir: string | null;
  summary: HermesSkillSummary;
  text: string;
  original: HermesSkillRead['original'];
}> {
  const shared = ctx.skillsDir;
  const facts = await skillFacts(ctx);
  const dir = join(shared, ref.path);
  if (!(await isSkillFolder(dir))) {
    const row = facts.builtins?.byPath.get(ref.path);
    if (!facts.builtins || !row?.removed || !row.offered) throw notFound();
    const text = (await shippedText(ctx, facts.builtins, row.name)) ?? '';
    return { dir: null, summary: summaryOfRemoved(row, text, facts), text, original: { text, changes: [] } };
  }
  const summary = await skillSummary(ctx, ref.path, facts);
  const text = await skillMd(dir);
  let original: HermesSkillRead['original'] = null;
  if (summary.origin === 'builtin' && summary.changed) {
    const d = await diffOf(ctx, summary.name).catch(() => null);
    if (d)
      original = {
        text: d.skill_md.slice(0, HERMES_SKILL_MD_MAX_BYTES),
        changes: d.diffs
          .filter((c) => addressableFile(c.path))
          .slice(0, HERMES_SKILL_FILES_MAX)
          .map((c) => ({ path: c.path, status: c.status })),
      };
  }
  return { dir, summary, text, original };
}

async function read(ctx: HermesHomeContext, p: Args<'skills.read'>): Promise<HermesSkillRead> {
  const r = await resolveRef(ctx, p);
  const files = r.dir
    ? (await folderFiles(r.dir))
        .filter((f) => f.path !== 'SKILL.md' && addressableFile(f.path))
        .slice(0, HERMES_SKILL_FILES_MAX)
        .map((f) => ({ path: f.path, bytes: f.bytes }))
    : [];
  return { skill: r.summary, text: r.text, files, original: r.original };
}

async function filesOfRef(ctx: HermesHomeContext, ref: Ref): Promise<NewFile[]> {
  const r = await resolveRef(ctx, ref);
  if (!r.dir) return [{ path: 'SKILL.md', data: Buffer.from(r.text), exec: false }];
  const listed = await folderFiles(r.dir);
  if (listed.length > HERMES_SKILL_FILES_MAX)
    throw new HermesHomeError('failed', 'The skill has too many files.');
  if (listed.reduce((n, f) => n + f.bytes, 0) > HERMES_SKILL_MAX_BYTES)
    throw new HermesHomeError('failed', 'The skill is too large.');
  return (await readFolder(r.dir)).filter((f) => addressableFile(f.path));
}

async function readOneFile(
  ctx: HermesHomeContext,
  p: Args<'skills.readFile'>,
): Promise<Result<'skills.readFile'>> {
  const r = await resolveRef(ctx, p);
  if (!r.dir) {
    if (p.file !== 'SKILL.md') throw notFound();
    return { data: Buffer.from(r.text).toString('base64') };
  }
  const target = join(r.dir, p.file);
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile()) throw notFound();
  if (info.size > HERMES_SKILL_FILE_MAX_BYTES)
    throw new HermesHomeError('invalid', 'That file is too large.');
  return { data: (await readFile(target)).toString('base64') };
}

async function exportSkill(
  ctx: HermesHomeContext,
  p: Args<'skills.export'>,
): Promise<Result<'skills.export'>> {
  const files = await filesOfRef(ctx, p);
  return { files: files.map((f) => ({ path: f.path, data: f.data.toString('base64'), exec: f.exec })) };
}

/* The scan (HSK-07) ------------------------------------------------------------------------------------------------ */

/** The plugin's scan answer (HSK-S12; a hub preview's carries the same findings, HSK-S09). */
interface ScanAnswer {
  verdict: string;
  findings: Record<string, unknown>[];
  decision: string;
}

/** Hermes's findings in the contract's shape: secrets redacted, cut as Hermes cuts them, at most 50 (pure). */
export function findingsOf(raw: readonly Record<string, unknown>[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const f of raw) {
    const severity = ScanSeverity.safeParse(f.severity);
    if (!severity.success) continue;
    const category = ScanCategory.safeParse(f.category);
    const line = Number(f.line);
    out.push({
      patternId: String(f.pattern_id || f.category || 'finding').slice(0, 80),
      severity: severity.data,
      category: category.success ? category.data : 'other',
      file: String(f.file ?? '').slice(0, 200),
      line: Number.isInteger(line) && line > 0 ? line : 0,
      match: redactSecrets(String(f.match ?? '')).slice(0, SCAN_MATCH_MAX),
      description: String(f.description ?? '').slice(0, 300),
    });
  }
  return out;
}

/** A scan answer as the contract's (`agent-created` for a share or an edit, else the trust it was scanned with). */
export function scanOf(a: ScanAnswer, trust: string): HermesSkillScan {
  const findings = findingsOf(a.findings ?? []);
  const verdict = ScanVerdict.safeParse(a.verdict);
  const t = ScanTrust.safeParse(trust);
  return {
    trust: t.success ? t.data : 'community',
    // A verdict Whombat doesn't know is taken as the worst.
    verdict: verdict.success ? verdict.data : 'dangerous',
    findings: findings.slice(0, SCAN_FINDINGS_MAX),
    findingsTotal: findings.length,
    decision: a.decision === 'allow' ? 'allow' : a.decision === 'ask' ? 'ask' : 'block',
  };
}

async function scan(ctx: HermesHomeContext, p: Args<'skills.scan'>): Promise<Result<'skills.scan'>> {
  const dir = await locate(ctx.skillsDir, p);
  if (p.text === undefined)
    return scanOf(await step<ScanAnswer>(ctx, 'scan', { path: dir }), 'agent-created');
  // An edit: the folder as it would be, with the new SKILL.md, in the runner's own state.
  const work = join(ctx.skillsState, 'scan', randomBytes(6).toString('hex'));
  const copy = join(work, basename(p.path));
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    await cp(dir, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
    await makeWritable(copy);
    await writeFile(join(copy, 'SKILL.md'), p.text);
    return scanOf(await step<ScanAnswer>(ctx, 'scan', { path: copy }), 'agent-created');
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/* Changes ---------------------------------------------------------------------------------------------------------- */

/** Replaces a folder's `SKILL.md` the way Hermes does (a temporary file beside it, renamed over it). */
async function replaceSkillMd(dir: string, text: string): Promise<void> {
  await makeWritable(dir, false);
  await makeWritable(join(dir, 'SKILL.md'), false);
  const tmp = join(dir, `.SKILL.md.whombat-${process.pid}`);
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, join(dir, 'SKILL.md'));
}

async function write(ctx: HermesHomeContext, p: Args<'skills.write'>): Promise<Result<'skills.write'>> {
  if (Buffer.byteLength(p.text) > HERMES_SKILL_MD_MAX_BYTES)
    throw new HermesHomeError('invalid', 'That SKILL.md is too large.');
  return withSkills(ctx, async (shared) => {
    const dir = await locate(shared, p);
    if (p.ifVersion !== undefined && short(await folderHash(dir)) !== p.ifVersion)
      throw new HermesHomeError('conflict', 'The skill changed since it was read.');
    const before = nameAt(p.path, await skillMd(dir));
    const after = nameAt(p.path, p.text);
    await assertUnique(shared, p.path, after);
    await replaceSkillMd(dir, p.text);
    const state = await readSkillsStateOf(shared);
    state.skills[p.path] = { added: state.skills[p.path]?.added ?? null, changed: { by: p.by, at: now() } };
    if (after !== before && state.off.includes(before))
      state.off = [...state.off.filter((n) => n !== before), after];
    await writeSkillsState(shared, state);
    changedNow(ctx);
    return skillSummary(ctx, p.path);
  });
}

async function setOff(ctx: HermesHomeContext, p: Args<'skills.setOff'>): Promise<Result<'skills.setOff'>> {
  return withSkills(ctx, async (shared) => {
    const dir = await locate(shared, p);
    const name = nameAt(p.path, await skillMd(dir));
    const state = await readSkillsStateOf(shared);
    state.off = p.off ? [...state.off, name] : state.off.filter((n) => n !== name);
    await writeSkillsState(shared, state);
    return skillSummary(ctx, p.path);
  });
}

/** Forgets what the bookkeeping says of a skill that went. */
async function forget(shared: string, path: string, name: string | null): Promise<void> {
  const state = await readSkillsStateOf(shared);
  delete state.skills[path];
  if (name) state.off = state.off.filter((n) => n !== name);
  await writeSkillsState(shared, state);
}

async function remove(ctx: HermesHomeContext, p: Args<'skills.remove'>): Promise<null> {
  await withSkills(ctx, async (shared) => {
    const dir = await locate(shared, p);
    if ([...(await readHubLock(shared)).values()].some((e) => e.installPath === p.path))
      throw new HermesHomeError('invalid', 'A hub skill is uninstalled (skills.hubUninstall).');
    const name = nameAt(p.path, await skillMd(dir));
    // A built-in stays removed: Hermes's manifest still tracks it, so its sync never brings it back (HSK-02).
    await removeFolder(dir, shared);
    await forget(shared, p.path, name);
  });
  return null;
}

async function restore(ctx: HermesHomeContext, p: Args<'skills.restore'>): Promise<Result<'skills.restore'>> {
  return withSkills(ctx, async (shared) => {
    const b = await builtinsOf(ctx);
    if (!b) throw new HermesHomeError('unavailable', 'Hermes’s skills code isn’t here (no real Hermes).');
    const row = b.byPath.get(p.path);
    if (!row?.tracked) throw notFound();
    const done = await step<{ path: string }>(ctx, 'reset', { dir: shared, name: row.name });
    const path = HermesSkillPath.safeParse(done.path).success ? done.path : p.path;
    const state = await readSkillsStateOf(shared);
    delete state.skills[path];
    state.off = state.off.filter((n) => n !== row.name);
    await writeSkillsState(shared, state);
    changedNow(ctx);
    return skillSummary(ctx, path);
  });
}

/** The plugin's `sync` answer (HSK-S04). */
interface SyncAnswer {
  added: string[];
  updated: string[];
  kept: string[];
  removed: string[];
  not_placed?: string[];
  duplicates?: { name: string; paths: string[] }[];
}

const names64 = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((n): n is string => typeof n === 'string')
        .map((n) => n.slice(0, 64))
        .slice(0, HERMES_SKILLS_MAX)
    : [];

/**
 * The skills folder on Hermes's skills (the runner's start; `skills.sync` after a restore, HSK-02): Hermes's bundled
 * sync, then HSK-04's default-off names applied once each. Without a real Hermes the sync is skipped and answers no
 * names. Hermes's gateway runs the same sync at each start (OP-08), on the same manifest.
 */
export function syncSkills(ctx: HermesHomeContext): Promise<Result<'skills.sync'>> {
  return withSkills(
    ctx,
    async (shared) => {
      await mkdir(shared, { recursive: true, mode: 0o755 });
      let answer: SyncAnswer = { added: [], updated: [], kept: [], removed: [] };
      try {
        answer = await step<SyncAnswer>(ctx, 'sync', { dir: shared });
        changedNow(ctx);
      } catch (err) {
        if (!(err instanceof HermesHomeError && err.code === 'unavailable')) throw err;
        ctx.log('info', `skills · Hermes's sync skipped: ${err.message}`);
      }
      if (answer.not_placed?.length)
        ctx.log('warn', `skills · not Hermes's, at a built-in's place: ${answer.not_placed.join(', ')}`);
      if (answer.duplicates?.length)
        ctx.log(
          'warn',
          `skills · more than one skill named ${answer.duplicates.map((d) => d.name).join(', ')}`,
        );
      await applyDefaults(shared);
      await rm(stagingDir(shared), { recursive: true, force: true }).catch(() => {});
      return {
        added: names64(answer.added),
        updated: names64(answer.updated),
        kept: names64(answer.kept),
        removed: names64(answer.removed),
      };
    },
    { holder: 'skills-sync', waitMs: 60_000 },
  );
}

/**
 * HSK-04 on what the skills folder has now, once per name: Hermes's built-ins (its manifest tracks them) and hub skills
 * (its lock), never a skill the agent learned.
 */
async function applyDefaults(shared: string): Promise<void> {
  const state = await readSkillsStateOf(shared);
  const [manifest, lock] = await Promise.all([readBundledManifest(shared), readHubLock(shared)]);
  const present = new Set(
    [...(await skillNames(shared)).keys()].filter((n) => !!manifest.get(n) || lock.has(n)),
  );
  if (applyDefaultsOff(state, present)) await writeSkillsState(shared, state);
}

/* Hermes's hub (HSK-06…HSK-09) -------------------------------------------------------------------------------------- */

/** One row of the plugin's hub search or preview (HSK-S08, HSK-S09). */
interface HubRow {
  source: unknown;
  identifier: unknown;
  name: unknown;
  description: unknown;
  trust: unknown;
  repo?: unknown;
  path?: unknown;
  installs?: unknown;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const textOrNull = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);

/** A hub row in the contract's shape, or null for one outside the three sources (pure). */
export function hubResultOf(r: HubRow, installed: ReadonlySet<string>): HermesHubResult | null {
  const source = SkillHubSource.safeParse(hubSourceOf(r.source));
  const identifier = SkillHubIdentifier.safeParse(r.identifier);
  const trust = SkillTrust.safeParse(r.trust);
  const name = text(r.name, 120);
  if (!source.success || !identifier.success || !trust.success || !name) return null;
  const installs = Number(r.installs);
  return {
    source: source.data,
    identifier: identifier.data,
    name,
    description: text(r.description, 1_024),
    trust: trust.data,
    repo: textOrNull(r.repo, 200),
    path: textOrNull(r.path, 300),
    installs: r.installs !== null && Number.isInteger(installs) && installs >= 0 ? installs : null,
    installed: installed.has(identifier.data),
  };
}

const installedIds = async (shared: string) =>
  new Set([...(await readHubLock(shared)).values()].flatMap((e) => (e.hub ? [e.hub.identifier] : [])));

async function hubSearch(
  ctx: HermesHomeContext,
  p: Args<'skills.hubSearch'>,
): Promise<Result<'skills.hubSearch'>> {
  const a = await step<{ results: HubRow[]; unanswered: unknown[] }>(ctx, 'hub-search', {
    query: p.query,
    source: p.source ?? 'all',
    limit: p.limit,
  });
  const installed = await installedIds(ctx.skillsDir);
  return {
    results: (a.results ?? [])
      .map((r) => hubResultOf(r, installed))
      .filter((r) => r !== null)
      .slice(0, 50),
    unreachable: [
      ...new Set((a.unanswered ?? []).map(hubSourceOf).filter((s): s is NonNullable<typeof s> => s !== null)),
    ],
  };
}

async function hubInspect(
  ctx: HermesHomeContext,
  p: Args<'skills.hubInspect'>,
): Promise<Result<'skills.hubInspect'>> {
  const a = await step<
    HubRow & { skill_md: string; files: { path: string; size: number }[] } & ScanAnswer & { trust: string }
  >(ctx, 'hub-inspect', { identifier: p.identifier });
  const shared = ctx.skillsDir;
  const result = hubResultOf(a, await installedIds(shared));
  if (!result) throw new HermesHomeError('invalid', 'That skill isn’t from one of the hub’s sources.');
  const md = typeof a.skill_md === 'string' ? a.skill_md : '';
  const front = skillFront(md, result.name);
  return {
    result,
    text: md.slice(0, HERMES_SKILL_MD_MAX_BYTES),
    files: (a.files ?? [])
      .filter((f) => addressableFile(f.path))
      .slice(0, HERMES_SKILL_FILES_MAX)
      .map((f) => ({ path: f.path, bytes: Math.max(0, Math.floor(Number(f.size) || 0)) })),
    needs: front.needs,
    platforms: front.platforms,
    scan: scanOf(a, String(a.trust)),
    taken: (await skillNames(shared)).has(result.name),
  };
}

async function hubInstall(
  ctx: HermesHomeContext,
  p: Args<'skills.hubInstall'>,
): Promise<Result<'skills.hubInstall'>> {
  return withSkills(
    ctx,
    async (shared) => {
      const done = await step<{ name: string; path: string }>(ctx, 'hub-install', {
        dir: shared,
        identifier: p.identifier,
      });
      if (!HermesSkillPath.safeParse(done.path).success)
        throw new HermesHomeError(
          'failed',
          `Hermes installed it where Whombat can’t name it (${done.path}).`,
        );
      const state = await readSkillsStateOf(shared);
      state.skills[done.path] = { added: { by: p.by, at: now() }, changed: null };
      applyDefaultsOff(state, new Set([done.name]));
      await writeSkillsState(shared, state);
      return skillSummary(ctx, done.path, await skillFacts(ctx, false));
    },
    { holder: 'skills-hub' },
  );
}

/** The hub skill at `path` (its lock entry), else `not_found`. */
async function hubEntryAt(shared: string, path: string): Promise<HubLockEntry> {
  const entry = [...(await readHubLock(shared)).values()].find((e) => e.installPath === path);
  if (!entry) throw new HermesHomeError('not_found', 'That isn’t a skill installed from the hub.');
  return entry;
}

async function hubUninstall(ctx: HermesHomeContext, p: Args<'skills.hubUninstall'>): Promise<null> {
  await withSkills(ctx, async (shared) => {
    const entry = await hubEntryAt(shared, p.path);
    await makeWritable(join(shared, p.path));
    await step(ctx, 'hub-uninstall', { dir: shared, name: entry.name });
    await forget(shared, p.path, entry.name);
  });
  return null;
}

async function hubCheck(ctx: HermesHomeContext): Promise<Result<'skills.hubCheck'>> {
  const shared = ctx.skillsDir;
  const a = await step<{ skills: { name: string; status: string }[] }>(ctx, 'hub-check', { dir: shared });
  const lock = await readHubLock(shared);
  const skills: Result<'skills.hubCheck'>['skills'] = [];
  for (const row of a.skills ?? []) {
    const path = lock.get(row.name)?.installPath;
    const status = HermesHubUpdateStatus.safeParse(row.status);
    if (!path || !HermesSkillPath.safeParse(path).success) continue;
    skills.push({ path, name: row.name.slice(0, 64), status: status.success ? status.data : 'unavailable' });
  }
  return { checkedAt: now(), skills: skills.slice(0, HERMES_SKILLS_MAX) };
}

async function hubUpdate(
  ctx: HermesHomeContext,
  p: Args<'skills.hubUpdate'>,
): Promise<Result<'skills.hubUpdate'>> {
  return withSkills(
    ctx,
    async (shared) => {
      const entry = await hubEntryAt(shared, p.path);
      await makeWritable(join(shared, p.path));
      const done = await step<{ updated: boolean; path?: string }>(ctx, 'hub-update', {
        dir: shared,
        name: entry.name,
      });
      const path = done.path && HermesSkillPath.safeParse(done.path).success ? done.path : p.path;
      if (done.updated) {
        const state = await readSkillsStateOf(shared);
        state.skills[path] = { added: state.skills[p.path]?.added ?? null, changed: null };
        if (path !== p.path) delete state.skills[p.path];
        await writeSkillsState(shared, state);
      }
      return skillSummary(ctx, path, await skillFacts(ctx, false));
    },
    { holder: 'skills-hub' },
  );
}

export const skillsHandlers: AreaHandlers<SkillsMethod> = {
  'skills.list': list,
  'skills.read': read,
  'skills.readFile': readOneFile,
  'skills.export': exportSkill,
  'skills.scan': scan,
  'skills.write': write,
  'skills.setOff': setOff,
  'skills.remove': remove,
  'skills.restore': restore,
  'skills.sync': (ctx) => syncSkills(ctx),
  'skills.hubSearch': hubSearch,
  'skills.hubInspect': hubInspect,
  'skills.hubInstall': hubInstall,
  'skills.hubUninstall': hubUninstall,
  'skills.hubCheck': (ctx) => hubCheck(ctx),
  'skills.hubUpdate': hubUpdate,
};
