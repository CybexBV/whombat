/**
 * A `SKILL.md`'s front matter as Hermes reads it (hermes-skills.md HSK-10, contracts CT-1402): its name (Hermes's
 * `read_skill_name`: the `name:` line, else the folder's), its description (YAML, as Hermes's index reads it), what it
 * needs — environment variables (`required_environment_variables`, `setup.collect_secrets`, then the older
 * `prerequisites.env_vars`; the first entry of a name wins, as Hermes's `_get_required_environment_variables` merges
 * them), commands (`prerequisites.commands`) and credential files (`required_credential_files`) — and the platforms it
 * names. Pure.
 */
import { skillNameOf } from '@whombat/agent-runtime';
import {
  SKILL_NEEDS_MAX,
  SkillCommandName,
  SkillCredentialFile,
  SkillEnvName,
  type SkillNeeds,
} from '@whombat/core';
import { parse } from 'yaml';
import { skillHeader } from './skills-folder';

const FRONT_MATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** What the runner reads of a `SKILL.md`. */
export interface SkillFront {
  name: string;
  description: string;
  needs: SkillNeeds;
  platforms: string[];
}

/** The front matter as YAML, or null when there is none or it isn't a mapping. */
function frontMatter(text: string): Record<string, unknown> | null {
  const m = FRONT_MATTER.exec(text);
  if (!m) return null;
  try {
    const data = parse(m[1] ?? '', { maxAliasCount: 10 }) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Each value once, in order, those `ok` takes, at most `SKILL_NEEDS_MAX`. */
function firsts<T>(values: readonly T[], key: (v: T) => string, ok: (k: string) => boolean): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of values) {
    const k = key(v);
    if (!ok(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= SKILL_NEEDS_MAX) break;
  }
  return out;
}

/** What a front matter says the skill needs (HSK-10). */
export function needsOf(fm: Record<string, unknown> | null): SkillNeeds {
  if (!fm) return { env: [], commands: [], files: [] };
  const prereqs = asRecord(fm.prerequisites);
  const setup = asRecord(fm.setup);
  const env: { name: string; optional: boolean }[] = [];
  for (const e of asList(fm.required_environment_variables)) {
    if (typeof e === 'string') env.push({ name: e.trim(), optional: false });
    else {
      const r = asRecord(e);
      const name = String(r.name ?? r.env_var ?? '').trim();
      env.push({ name, optional: r.optional === true });
    }
  }
  for (const e of asList(setup.collect_secrets))
    env.push({ name: String(asRecord(e).env_var ?? '').trim(), optional: false });
  for (const e of asList(prereqs.env_vars))
    if (typeof e === 'string' || typeof e === 'number') env.push({ name: String(e).trim(), optional: false });
  const commands = asList(prereqs.commands)
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim());
  const files = asList(fm.required_credential_files)
    .map((f) => (typeof f === 'string' ? f : String(asRecord(f).path ?? '')).trim())
    .filter(Boolean);
  return {
    env: firsts(
      env,
      (e) => e.name,
      (n) => SkillEnvName.safeParse(n).success,
    ),
    commands: firsts(
      commands,
      (c) => c,
      (c) => SkillCommandName.safeParse(c).success,
    ),
    files: firsts(
      files,
      (f) => f,
      (f) => SkillCredentialFile.safeParse(f).success,
    ),
  };
}

/** The platforms a front matter names (`platforms`, Hermes's `skill_matches_platform`); empty: any. */
function platformsOf(fm: Record<string, unknown> | null): string[] {
  return [
    ...new Set(
      asList(fm?.platforms)
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim().slice(0, 40))
        .filter(Boolean),
    ),
  ].slice(0, 8);
}

/** A `SKILL.md` read: its name for `folder`, description, needs and platforms. */
export function skillFront(text: string, folder: string): SkillFront {
  const fm = frontMatter(text);
  const description =
    typeof fm?.description === 'string' ? fm.description.trim() : skillHeader(text).description;
  return {
    name: skillNameOf(text, folder),
    description,
    needs: needsOf(fm),
    platforms: platformsOf(fm),
  };
}
