/**
 * What the runner reads of the person's skills folder besides the skills (hermes-skills.md HSK-02…HSK-06, HSK-S03;
 * one-person.md OP-08): Whombat's bookkeeping (`.whombat/skills.json`, agent-runtime's `SkillsState`), Hermes's own
 * records — its bundled sync's `.bundled_manifest` and its hub lock `.hub/lock.json` — and HSK-04's skills that start
 * off.
 *
 * Every dot entry of the folder is bookkeeping (Hermes's or Whombat's): never listed as a skill, always carried by the
 * folder's archive (HSK-S14).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  readSkillsState,
  SKILLS_STATE_DIR,
  SKILLS_STATE_FILE,
  type SkillsState,
} from '@whombat/agent-runtime';
import {
  type HermesHubEntry,
  ScanVerdict,
  SkillHubIdentifier,
  type SkillHubSource,
  SkillTrust,
} from '@whombat/core';

export { readSkillsState as readSkillsStateOf };

/** Writes the bookkeeping the way Hermes writes its own (a temporary file beside it, renamed over it). */
export async function writeSkillsState(shared: string, state: SkillsState): Promise<void> {
  const dir = join(shared, SKILLS_STATE_DIR);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `${SKILLS_STATE_FILE}.${randomBytes(4).toString('hex')}`);
  const out: SkillsState = {
    v: 2,
    off: [...new Set(state.off)].sort(),
    defaults: [...new Set(state.defaults)].sort(),
    skills: state.skills,
  };
  await writeFile(tmp, `${JSON.stringify(out, null, 1)}\n`, { mode: 0o644 });
  await rename(tmp, join(dir, SKILLS_STATE_FILE));
}

/**
 * Where folders are written before they are moved into place: beside the skills folder (the same file system), never
 * in it, where Hermes would see a half-written skill; one of the root's folders the person's Hermes never sees
 * (`HERMES_PRIVATE_DIRS`).
 */
export const stagingDir = (shared: string) => join(dirname(shared), `.${basename(shared)}-staging`);

/**
 * HSK-04: what can't work on a Whombat starts off — another agent's command line (`claude-code`, `codex`, `opencode`),
 * a desktop or Hermes's desktop app (`computer-use`, `inspecting-hermes-desktop-dom`), Hermes's Teams platform
 * (`teams-meeting-pipeline`), Hermes's own Google sign-in (`google-workspace`).
 */
export const DEFAULT_OFF: readonly string[] = [
  'claude-code',
  'codex',
  'opencode',
  'computer-use',
  'inspecting-hermes-desktop-dom',
  'teams-meeting-pipeline',
  'google-workspace',
];

/**
 * HSK-04 applied once per name (pure on `state`, changed in place): a default-off name that is in the shared directory
 * now and was never applied is switched off and remembered, so the person, who switches it on later, keeps it on. Whether
 * anything changed.
 */
export function applyDefaultsOff(state: SkillsState, present: ReadonlySet<string>): boolean {
  let changed = false;
  for (const name of DEFAULT_OFF) {
    if (!present.has(name) || state.defaults.includes(name)) continue;
    state.defaults.push(name);
    if (!state.off.includes(name)) state.off.push(name);
    changed = true;
  }
  return changed;
}

/** Hermes's bundled sync's manifest (`name:origin-hash` lines; an empty hash is a name Hermes never seeds). */
export async function readBundledManifest(shared: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const raw = await readFile(join(shared, '.bundled_manifest'), 'utf8').catch(() => '');
  for (const line of raw.split('\n')) {
    const at = line.indexOf(':');
    const name = (at < 0 ? line : line.slice(0, at)).trim();
    if (name) out.set(name, at < 0 ? '' : line.slice(at + 1).trim());
  }
  return out;
}

/** One entry of Hermes's hub lock, as the runner reads it. */
export interface HubLockEntry {
  name: string;
  /** Where Hermes installed it, relative to the shared directory. */
  installPath: string;
  /** In Whombat's shape; null when the entry isn't one of the three sources or can't be read. */
  hub: HermesHubEntry | null;
}

/** skills.sh's id as Hermes writes it in a result (`skills.sh`) or a lock (`skills-sh`). */
export function hubSourceOf(source: unknown): SkillHubSource | null {
  if (source === 'skills.sh' || source === 'skills-sh') return 'skills-sh';
  return source === 'official' || source === 'github' ? source : null;
}

const isoOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** Hermes's hub lock (`.hub/lock.json`, `HubLockFile`): the installed hub skills by name. */
export async function readHubLock(shared: string): Promise<Map<string, HubLockEntry>> {
  const out = new Map<string, HubLockEntry>();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(shared, '.hub', 'lock.json'), 'utf8'));
  } catch {
    return out;
  }
  const installed = (raw as { installed?: unknown } | null)?.installed;
  if (!installed || typeof installed !== 'object') return out;
  for (const [name, value] of Object.entries(installed as Record<string, unknown>)) {
    const e = value as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || typeof e.install_path !== 'string') continue;
    const source = hubSourceOf(e.source);
    const identifier = SkillHubIdentifier.safeParse(e.identifier);
    const trust = SkillTrust.safeParse(e.trust_level);
    const verdict = ScanVerdict.safeParse(e.scan_verdict);
    const installedAt = isoOf(e.installed_at);
    const updatedAt = isoOf(e.updated_at) ?? installedAt;
    out.set(name, {
      name,
      installPath: e.install_path,
      hub:
        source && identifier.success && trust.success && verdict.success && installedAt && updatedAt
          ? {
              source,
              identifier: identifier.data,
              trust: trust.data,
              verdict: verdict.data,
              installedAt,
              updatedAt,
            }
          : null,
    });
  }
  return out;
}
