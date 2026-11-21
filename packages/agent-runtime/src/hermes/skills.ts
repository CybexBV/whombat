/**
 * Skills on Hermes, in Hermes's own layout (one-person.md OP-08; hermes-skills.md HSK-01…HSK-05): the person's profile
 * keeps them in its `skills/` — Hermes's built-in skills, kept there by Hermes's own sync, what the person installed
 * from Hermes's hub, and what the agent learned. One folder, one list; the runner keeps it
 * (`apps/runner/src/hermes-home/skills*.ts`, Hermes's own code through the plugin's skills steps).
 *
 * Whombat's bookkeeping sits in the folder (`.whombat/skills.json`, so its archive carries it in backups): the names
 * switched off (every turn's `skills.disabled`, HSK-05), the default-off names already applied once (HSK-04), and who
 * installed or changed which skill.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** A skill's own file. */
export const HERMES_SKILL_MD = 'SKILL.md';
/** Whombat's folder in the skills folder, and its bookkeeping there. */
export const SKILLS_STATE_DIR = '.whombat';
export const SKILLS_STATE_FILE = 'skills.json';

/** A profile's skills: its `skills/`, where Hermes keeps them. */
export function hermesSkillsDir(profile: string): string {
  return join(profile, 'skills');
}

/**
 * `config.yaml`'s `skills` section (pure): the names switched off (HSK-05); no repository's own skills
 * (`project_discovery`: a checkout's `.agents/skills` would be instructions from whoever wrote the repository); no
 * `!cmd` in a skill run at load; Hermes's scan on what the agent writes. Hermes's skill hub has no agent tool.
 */
export function hermesSkillsConfig(disabled: readonly string[] = []): Record<string, unknown> {
  return {
    ...(disabled.length ? { disabled: [...disabled] } : {}),
    project_discovery: false,
    inline_shell: false,
    guard_agent_created: true,
  };
}

/** Who did something to a skill, and when (`by` null: Whombat itself). */
export interface SkillChange {
  by: string | null;
  at: string;
}

/** What Whombat knows of one skill beyond Hermes's own records (by path). */
export interface SkillRecord {
  /** Who installed it from the hub. */
  added: SkillChange | null;
  /** Who last changed it in Settings. */
  changed: SkillChange | null;
}

/** The skills folder's bookkeeping (`.whombat/skills.json`, version 2). */
export interface SkillsState {
  v: 2;
  /** Names switched off: every turn's `skills.disabled` (HSK-05). Sorted. */
  off: string[];
  /** HSK-04's default-off names already applied once, so the person's later choice sticks. Sorted. */
  defaults: string[];
  /** By path in the skills folder. */
  skills: Record<string, SkillRecord>;
}

export const emptySkillsState = (): SkillsState => ({ v: 2, off: [], defaults: [], skills: {} });

const names = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x))].sort() : [];

const change = (v: unknown): SkillChange | null => {
  const c = v as { by?: unknown; at?: unknown } | null;
  if (!c || typeof c !== 'object' || typeof c.at !== 'string') return null;
  return { by: typeof c.by === 'string' ? c.by : null, at: c.at };
};

/**
 * The skills folder's bookkeeping as it is now (pure on the parsed file): version 2, or empty for none or any other
 * version (Whombat's earlier one goes with its skills, the runner's cleanup).
 */
export function parseSkillsState(raw: unknown): SkillsState {
  const r = raw as Partial<Record<keyof SkillsState, unknown>> | null;
  if (!r || typeof r !== 'object' || r.v !== 2) return emptySkillsState();
  const skills: Record<string, SkillRecord> = {};
  if (r.skills && typeof r.skills === 'object')
    for (const [path, rec] of Object.entries(r.skills as Record<string, unknown>)) {
      const x = rec as { added?: unknown; changed?: unknown } | null;
      if (x && typeof x === 'object') skills[path] = { added: change(x.added), changed: change(x.changed) };
    }
  return { v: 2, off: names(r.off), defaults: names(r.defaults), skills };
}

/** Reads the skills folder's bookkeeping (empty when there is none). */
export async function readSkillsState(dir: string): Promise<SkillsState> {
  try {
    const text = await readFile(join(dir, SKILLS_STATE_DIR, SKILLS_STATE_FILE), 'utf8');
    return parseSkillsState(JSON.parse(text));
  } catch {
    return emptySkillsState();
  }
}

const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * The name Hermes knows a skill by (pure, as Hermes's `read_skill_name`): its front matter's `name:`, quotes taken off,
 * else its folder's.
 */
export function skillNameOf(text: string, folder: string): string {
  const m = FRONT_MATTER.exec(text.slice(0, 4_000));
  for (const raw of (m?.[1] ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('name:')) continue;
    const v = line
      .slice(5)
      .trim()
      .replace(/^["']+|["']+$/g, '');
    if (v) return v;
  }
  return folder;
}

/** The skills switched off (HSK-05): every turn's `skills.disabled`. Sorted. */
export async function disabledSkills(dir: string): Promise<string[]> {
  return (await readSkillsState(dir)).off;
}

/** Directories no skill is read from: every dot folder (Hermes's and Whombat's bookkeeping) and caches. */
const SKIPPED = new Set(['node_modules', '__pycache__']);

/** Every skill folder under `root` (a folder with a `SKILL.md`), relative, sorted; not below another skill's folder. */
export async function skillFolders(root: string, maxDepth = 4): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== root && entries.some((e) => e.isFile() && e.name === HERMES_SKILL_MD)) {
      out.push(relative(root, dir));
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1)))
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIPPED.has(e.name))
        await walk(join(dir, e.name), depth + 1);
  };
  await walk(root, 0);
  return out;
}
