/**
 * Tests: the plugin's skills steps (hermes-skills.md HSK-S04…HSK-S12) without Python — the same inputs and answers on
 * the shared directory, with a few built-ins and hub skills of the test's own. It keeps Hermes's records the way Hermes
 * does (`.bundled_manifest` `name:hash` lines, `.hub/lock.json`), so the runner reads them as it reads Hermes's; the
 * scan calls a skill holding `DANGEROUS` dangerous and one holding `CAUTION` worth a look. Not a model of Hermes's
 * scanner or hub: the real plugin's own tests are its pytest, and the runner's against it
 * (`skills.plugin.test.ts`, with `WHOMBAT_HERMES_PYTHON`).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { skillNameOf } from '@whombat/agent-runtime';
import { HermesHomeError } from './context';
import { folderFiles, folderHash, makeWritable } from './skills-folder';
import type { HermesSkillsStep, HermesSkillsSteps } from './skills-plugin';

/** One of the fake's built-ins: its path in the shared directory and its files (`SKILL.md` first). */
export interface FakeBuiltin {
  path: string;
  files: Record<string, string>;
  /** Hermes doesn't offer it here (another platform's). */
  offered?: boolean;
}

/** One skill of the fake's hub. */
export interface FakeHubSkill {
  identifier: string;
  source: 'official' | 'github' | 'skills-sh';
  trust: 'builtin' | 'trusted' | 'community';
  name: string;
  description: string;
  /** Where Hermes would install it (an official skill keeps its catalog folder); default the top. */
  category?: string;
  files: Record<string, string>;
  /** A newer version at its source (`hub-check` says `update_available`, `hub-update` installs it). */
  newer?: Record<string, string>;
}

export interface FakeHermesSkills extends HermesSkillsSteps {
  builtins: FakeBuiltin[];
  hub: FakeHubSkill[];
  /** Every step asked, in order. */
  calls: { step: HermesSkillsStep; input: Record<string, unknown> }[];
  /** Steps that answer `unavailable` (a hub that doesn't answer). */
  down: Set<HermesSkillsStep>;
}

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function filesHash(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${p}\u0000${sha(files[p] as string)}\n`);
  return sha(lines.join(''));
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  if (existsSync(dir)) {
    await makeWritable(dir);
    await rm(dir, { recursive: true, force: true });
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

async function readManifest(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const raw = await readFile(join(dir, '.bundled_manifest'), 'utf8').catch(() => '');
  for (const line of raw.split('\n').filter(Boolean)) {
    const [name, hash = ''] = line.split(':');
    if (name) out.set(name, hash);
  }
  return out;
}

async function writeManifest(dir: string, m: Map<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  const lines = [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, h]) => `${n}:${h}\n`);
  await writeFile(join(dir, '.bundled_manifest'), lines.join(''));
}

type Lock = { version: 1; installed: Record<string, Record<string, unknown>> };

async function readLock(dir: string): Promise<Lock> {
  try {
    return JSON.parse(await readFile(join(dir, '.hub', 'lock.json'), 'utf8')) as Lock;
  } catch {
    return { version: 1, installed: {} };
  }
}

async function writeLock(dir: string, lock: Lock): Promise<void> {
  await mkdir(join(dir, '.hub'), { recursive: true });
  await writeFile(join(dir, '.hub', 'lock.json'), JSON.stringify(lock, null, 2));
}

async function namesIn(dir: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const walk = async (d: string, rel: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    if (rel && entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const text = await readFile(join(d, 'SKILL.md'), 'utf8');
      const name = skillNameOf(text, rel.split('/').at(-1) as string);
      out.set(name, [...(out.get(name) ?? []), rel]);
      return;
    }
    for (const e of entries)
      if (e.isDirectory() && !e.name.startsWith('.'))
        await walk(join(d, e.name), rel ? `${rel}/${e.name}` : e.name);
  };
  await walk(dir, '');
  return out;
}

const nameOfBuiltin = (b: FakeBuiltin) =>
  skillNameOf(b.files['SKILL.md'] ?? '', b.path.split('/').at(-1) as string);

function scanText(texts: string[]) {
  const all = texts.join('\n');
  const findings: Record<string, unknown>[] = [];
  if (all.includes('DANGEROUS'))
    findings.push({
      pattern_id: 'fake_dangerous',
      severity: 'critical',
      category: 'destructive',
      file: 'SKILL.md',
      line: 1,
      match: 'DANGEROUS',
      description: 'A dangerous thing',
    });
  if (all.includes('CAUTION'))
    findings.push({
      pattern_id: 'fake_caution',
      severity: 'high',
      category: 'network',
      file: 'SKILL.md',
      line: 1,
      match: 'CAUTION',
      description: 'Something to look at',
    });
  const verdict = all.includes('DANGEROUS') ? 'dangerous' : all.includes('CAUTION') ? 'caution' : 'safe';
  return { verdict, findings };
}

/** Hermes's install policy (`INSTALL_POLICY`). */
function policy(trust: string, verdict: string): 'allow' | 'block' {
  const table: Record<string, string[]> = {
    builtin: ['allow', 'allow', 'allow'],
    trusted: ['allow', 'allow', 'block'],
    community: ['allow', 'block', 'block'],
    'agent-created': ['allow', 'allow', 'block'],
  };
  return (table[trust] ?? (table.community as string[]))[
    ['safe', 'caution', 'dangerous'].indexOf(verdict)
  ] === 'allow'
    ? 'allow'
    : 'block';
}

const dirOf = (input: Record<string, unknown>) => String(input.dir ?? '');

/** The fake plugin (see the file comment). */
export function fakeHermesSkills(
  options: { builtins?: FakeBuiltin[]; hub?: FakeHubSkill[] } = {},
): FakeHermesSkills {
  const builtins = options.builtins ?? [];
  const hub = options.hub ?? [];
  const calls: FakeHermesSkills['calls'] = [];
  const down = new Set<HermesSkillsStep>();
  const byName = () => new Map(builtins.map((b) => [nameOfBuiltin(b), b]));
  const hubSkill = (identifier: string) => {
    const s = hub.find((h) => h.identifier === identifier);
    if (!s) throw new HermesHomeError('not_found', `${identifier} couldn't be found or fetched.`);
    return s;
  };
  const install = async (dir: string, s: FakeHubSkill, files: Record<string, string>, at?: string) => {
    const scan = scanText(Object.values(files));
    if (policy(s.trust, scan.verdict) !== 'allow') throw new HermesHomeError('blocked', 'Blocked by policy.');
    const path = at ?? (s.category ? `${s.category}/${s.name}` : s.name);
    await writeFiles(join(dir, path), files);
    const lock = await readLock(dir);
    const now = new Date().toISOString();
    lock.installed[s.name] = {
      source: s.source,
      identifier: s.identifier,
      trust_level: s.trust,
      scan_verdict: scan.verdict,
      content_hash: filesHash(files),
      install_path: path,
      files: Object.keys(files),
      installed_at: (lock.installed[s.name]?.installed_at as string | undefined) ?? now,
      updated_at: now,
    };
    await writeLock(dir, lock);
    return {
      name: s.name,
      identifier: s.identifier,
      source: s.source,
      trust: s.trust,
      verdict: scan.verdict,
      path,
      files: Object.keys(files).sort(),
    };
  };

  const steps: Record<HermesSkillsStep, (input: Record<string, unknown>) => Promise<unknown>> = {
    async sync(input) {
      const dir = dirOf(input);
      await mkdir(dir, { recursive: true });
      const manifest = await readManifest(dir);
      const out = {
        added: [] as string[],
        updated: [] as string[],
        kept: [] as string[],
        removed: [] as string[],
      };
      for (const b of builtins) {
        const name = nameOfBuiltin(b);
        const dest = join(dir, b.path);
        const hash = filesHash(b.files);
        if (!manifest.has(name)) {
          if (existsSync(dest)) continue; // not placed: something else is there
          await writeFiles(dest, b.files);
          manifest.set(name, hash);
          out.added.push(name);
        } else if (existsSync(dest)) {
          const current = await folderHash(dest);
          if (current === manifest.get(name)) {
            if (current !== hash) {
              await writeFiles(dest, b.files);
              manifest.set(name, hash);
              out.updated.push(name);
            }
          } else out.kept.push(name);
        }
      }
      await writeManifest(dir, manifest);
      for (const list of Object.values(out)) list.sort();
      return { ...out, relocated: [], not_placed: [], duplicates: [], total: builtins.length };
    },
    async builtins(input) {
      const dir = dirOf(input);
      const manifest = await readManifest(dir);
      const categories: Record<string, { description: string | null; text: string | null }> = {};
      const rows = [];
      for (const b of builtins) {
        const name = nameOfBuiltin(b);
        const dest = join(dir, b.path);
        const present = existsSync(join(dest, 'SKILL.md'));
        const tracked = manifest.has(name);
        const origin = manifest.get(name) ?? '';
        const changed = present && tracked && !!origin && (await folderHash(dest)) !== origin;
        const category = b.path.includes('/') ? (b.path.split('/')[0] as string) : 'general';
        categories[category] = { description: `Skills for ${category}.`, text: null };
        rows.push({
          name,
          path: b.path,
          category,
          present,
          tracked,
          removed: tracked && !present,
          changed,
          original_changed: changed && filesHash(b.files) !== origin,
          offered: b.offered !== false,
        });
      }
      for (const paths of (await namesIn(dir)).values())
        for (const p of paths)
          if (p.includes('/')) categories[p.split('/')[0] as string] ??= { description: null, text: null };
      return { builtins: rows, categories, toolsets: [] };
    },
    async diff(input) {
      const dir = dirOf(input);
      const b = byName().get(String(input.name));
      if (!b)
        throw new HermesHomeError(
          'not_found',
          `${String(input.name)} isn't one of Hermes's built-in skills.`,
        );
      const dest = join(dir, b.path);
      const present = existsSync(dest);
      const diffs = [];
      if (present) {
        const mine = new Set((await folderFiles(dest)).map((f) => f.path));
        for (const path of [...new Set([...mine, ...Object.keys(b.files)])].sort()) {
          if (!(path in b.files)) diffs.push({ path, status: 'added', diff: '' });
          else if (!mine.has(path)) diffs.push({ path, status: 'removed', diff: '' });
          else if ((await readFile(join(dest, path), 'utf8')) !== b.files[path])
            diffs.push({ path, status: 'modified', diff: '' });
        }
      }
      return {
        name: input.name,
        present,
        modified: diffs.length > 0,
        diffs,
        skill_md: b.files['SKILL.md'] ?? '',
      };
    },
    async reset(input) {
      const dir = dirOf(input);
      const name = String(input.name);
      const b = byName().get(name);
      if (!b) throw new HermesHomeError('not_found', `${name} isn't one of Hermes's built-in skills.`);
      await writeFiles(join(dir, b.path), b.files);
      const manifest = await readManifest(dir);
      manifest.set(name, filesHash(b.files));
      await writeManifest(dir, manifest);
      return { name, path: b.path, restored: true };
    },
    async 'hub-search'(input) {
      const q = String(input.query ?? '').toLowerCase();
      const source = String(input.source ?? 'all');
      const results = hub
        .filter(
          (h) =>
            (source === 'all' || h.source === source) && (!q || `${h.name} ${h.description}`.includes(q)),
        )
        .slice(0, Number(input.limit ?? 20))
        .map((h) => ({
          source: h.source,
          identifier: h.identifier,
          name: h.name,
          description: h.description,
          trust: h.trust,
          repo: h.source === 'official' ? null : h.identifier.split('/').slice(0, 2).join('/'),
          path: null,
          installs: h.source === 'skills-sh' ? 12 : null,
        }));
      return { results, unanswered: [] };
    },
    async 'hub-inspect'(input) {
      const s = hubSkill(String(input.identifier));
      const scan = scanText(Object.values(s.files));
      return {
        identifier: s.identifier,
        name: s.name,
        description: s.description,
        source: s.source,
        trust: s.trust,
        repo: null,
        path: null,
        category: s.category ?? '',
        skill_md: s.files['SKILL.md'] ?? '',
        files: Object.entries(s.files).map(([path, text]) => ({ path, size: Buffer.byteLength(text) })),
        verdict: scan.verdict,
        findings: scan.findings,
        decision: policy(s.trust, scan.verdict),
        reason: 'fake',
      };
    },
    async 'hub-install'(input) {
      const dir = dirOf(input);
      const s = hubSkill(String(input.identifier));
      if ((await readLock(dir)).installed[s.name])
        throw new HermesHomeError('conflict', `${s.name} is installed.`);
      if ((await namesIn(dir)).has(s.name))
        throw new HermesHomeError('conflict', `A skill named ${s.name} is here.`);
      return install(dir, s, s.files);
    },
    async 'hub-uninstall'(input) {
      const dir = dirOf(input);
      const name = String(input.name);
      const lock = await readLock(dir);
      const entry = lock.installed[name];
      if (!entry) throw new HermesHomeError('not_found', `${name} isn't a skill installed from the hub.`);
      const at = join(dir, String(entry.install_path));
      await makeWritable(at);
      await rm(at, { recursive: true, force: true });
      delete lock.installed[name];
      await writeLock(dir, lock);
      return { name, path: entry.install_path, removed: true };
    },
    async 'hub-check'(input) {
      const lock = await readLock(dirOf(input));
      return {
        skills: Object.entries(lock.installed).map(([name, e]) => {
          const s = hub.find((h) => h.identifier === e.identifier);
          const status = !s
            ? 'unavailable'
            : s.newer && filesHash(s.newer) !== e.content_hash
              ? 'update_available'
              : 'up_to_date';
          return {
            name,
            identifier: e.identifier,
            source: e.source,
            status,
            update_available: status === 'update_available',
          };
        }),
      };
    },
    async 'hub-update'(input) {
      const dir = dirOf(input);
      const name = String(input.name);
      const e = (await readLock(dir)).installed[name];
      if (!e) throw new HermesHomeError('not_found', `${name} isn't a skill installed from the hub.`);
      const s = hub.find((h) => h.identifier === e.identifier);
      if (!s) throw new HermesHomeError('unavailable', `${name}'s source didn't answer.`);
      if (!s.newer || filesHash(s.newer) === e.content_hash) return { name, updated: false };
      if (
        input.overwrite !== true &&
        (await folderHash(join(dir, String(e.install_path)))) !== e.content_hash
      )
        throw new HermesHomeError('conflict', `${name} was changed here.`);
      return { ...(await install(dir, s, s.newer, String(e.install_path))), updated: true };
    },
    async scan(input) {
      const path = String(input.path ?? '');
      if (!existsSync(path)) throw new HermesHomeError('not_found', `${path} doesn't exist.`);
      const texts = [];
      for (const f of await folderFiles(path)) texts.push(await readFile(join(path, f.path), 'utf8'));
      const scan = scanText(texts);
      return { ...scan, decision: policy('agent-created', scan.verdict), reason: 'fake' };
    },
  };

  const fake = (async (step: HermesSkillsStep, input: Record<string, unknown>) => {
    calls.push({ step, input });
    if (down.has(step)) throw new HermesHomeError('unavailable', `${step} didn't answer in time.`);
    return steps[step](input);
  }) as FakeHermesSkills;
  fake.builtins = builtins;
  fake.hub = hub;
  fake.calls = calls;
  fake.down = down;
  return fake;
}
