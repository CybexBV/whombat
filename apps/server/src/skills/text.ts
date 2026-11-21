/**
 * A `SKILL.md` as Settings shows and edits it (pure): the body without the front matter, a new body (and description)
 * put into the front matter it had, and what Compare shows. Hermes's scan judges an edit (`skills.scan`, HSK-07).
 */
import type { HermesSkillRead } from '@whombat/core';

const FRONT_MATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** The text after the front matter (all of it when there is none). */
export function bodyOf(text: string): string {
  const m = FRONT_MATTER.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** The front matter's lines without `key` (and the indented lines of a block value under it). */
function withoutKey(lines: readonly string[], key: string): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping && /^(\s+\S|\s*$)/.test(line) && line !== '') continue;
    skipping = false;
    if (new RegExp(`^${key}:`).test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * `text` with `body` after its front matter and, when given, `description` in it (a JSON string, which YAML reads), every
 * other key as it was. A text without front matter gets one from `name`.
 */
export function withBody(text: string, name: string, body: string, description?: string): string {
  const m = FRONT_MATTER.exec(text);
  let lines = m ? (m[1] ?? '').split(/\r?\n/) : [`name: ${name}`];
  if (description !== undefined) {
    const at = lines.findIndex((l) => /^description:/.test(l));
    lines = withoutKey(lines, 'description');
    lines.splice(at < 0 ? Math.min(1, lines.length) : at, 0, `description: ${JSON.stringify(description)}`);
  }
  const b = body.replace(/^\s*\n/, '');
  return `---\n${lines.join('\n')}\n---\n${b.endsWith('\n') ? b : `${b}\n`}`;
}

/** What Compare shows (CT-1412): the original's body and how Hermes says each file differs. */
export function originalOf(read: Pick<HermesSkillRead, 'original'>) {
  return read.original === null
    ? null
    : { text: bodyOf(read.original.text), changes: read.original.changes.map((c) => ({ ...c })) };
}
