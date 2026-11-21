/**
 * A skill's `SKILL.md` front matter, read flat (SST-01, CT-801; since 2.0 without Whombat's `whombat:` line, CT-1403).
 * Hermes reads the front matter itself (YAML, `hermes_yaml`); Whombat only takes the body apart from it and reads a
 * top-level value. Pure.
 */

/** Longest description a `SKILL.md` may give (Hermes's `MAX_DESCRIPTION_LENGTH`). */
export const SKILL_MD_DESCRIPTION_MAX = 1024;

const FRONT_MATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** A front-matter value: a double-quoted one is a JSON string, a single-quoted one YAML's. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not JSON: the quotes are taken off as they are.
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * Front matter of a `SKILL.md` (`---` block of `key: value` lines), flat: a nested YAML value reads as its first line
 * only, and other lines are skipped. Null without a front-matter block.
 */
export function skillFrontMatter(text: string): Record<string, string> | null {
  const m = FRONT_MATTER.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of (m[1] as string).split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    out[kv[1] as string] = unquote((kv[2] as string).trim());
  }
  return out;
}

/** The text after the front matter (all of it when there is none). */
export function skillBody(text: string): string {
  const m = FRONT_MATTER.exec(text);
  return m ? text.slice(m[0].length) : text;
}
