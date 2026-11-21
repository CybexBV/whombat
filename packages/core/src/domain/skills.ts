/**
 * A skill's text and files as you edit them (contracts 0.125, CT-1210…CT-1213; since 2.0 without imports or links,
 * CT-1403; Whombat hermes-engine.md HE-19, HE-41, hermes-skills.md HSK-08): Hermes keeps the skills, Whombat shows and
 * edits them. Pure.
 */
import { z } from 'zod';
import { SKILL_LIMITS, SKILL_PROVIDER_FILE, skillPathProblem } from '../skills/files.js';
import { SKILL_MD_DESCRIPTION_MAX } from '../skills/front-matter.js';
import { utf8ByteLength } from './signins.js';

/**
 * Where a skill's files sit (RA-25; Hermes's `ALLOWED_SUBDIRS`, CT-1213): next to `SKILL.md`, or in `references/`,
 * `templates/`, `scripts/` or `assets/` (any depth below them, within a skill's depth).
 */
export const SKILL_FILE_DIRS = ['references', 'templates', 'scripts', 'assets'] as const;

/** A skill's description as people write it: at most 1,024 characters (Hermes's `MAX_DESCRIPTION_LENGTH`). */
export const SkillDescription = z.string().trim().min(1).max(SKILL_MD_DESCRIPTION_MAX);

/** A `SKILL.md` body as an edit takes it: at most `SKILL_LIMITS.bodyBytes` UTF-8 bytes. */
export const LibrarySkillBody = z
  .string()
  .max(SKILL_LIMITS.bodyBytes)
  .refine((body) => body.trim().length > 0, 'Write the skill.')
  .refine(
    (body) => utf8ByteLength(body) <= SKILL_LIMITS.bodyBytes,
    `The skill is longer than ${Math.round(SKILL_LIMITS.bodyBytes / 1000)} KB.`,
  );

/**
 * A file's path relative to the skill's folder (`skillPathProblem`'s rules), no `SKILL.md` at any depth (the body is the
 * skill's one; a nested one would load as another skill with front matter nobody checked, CT-131), no hook, plugin or
 * provider files (`SKILL_PROVIDER_FILE`), and only next to `SKILL.md` or in `SKILL_FILE_DIRS`.
 */
export const SkillFilePath = z
  .string()
  .min(1)
  .max(200)
  .superRefine((path, ctx) => {
    const problem = skillPathProblem(path);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
    else if (/^skill\.md$/i.test(path)) ctx.addIssue({ code: 'custom', message: 'SKILL.md is the body.' });
    else if (/(^|\/)skill\.md$/i.test(path))
      ctx.addIssue({ code: 'custom', message: 'A skill holds one SKILL.md: the body.' });
    else if (SKILL_PROVIDER_FILE.test(path))
      ctx.addIssue({ code: 'custom', message: 'Hook and plugin files aren’t allowed in a skill.' });
    else if (skillFileDirProblem(path))
      ctx.addIssue({ code: 'custom', message: skillFileDirProblem(path) as string });
  });

/** Why a skill file's folder isn't allowed (RA-25), or null: files sit next to SKILL.md or in `SKILL_FILE_DIRS`. */
export function skillFileDirProblem(path: string): string | null {
  const slash = path.indexOf('/');
  if (slash === -1) return null;
  return (SKILL_FILE_DIRS as readonly string[]).includes(path.slice(0, slash))
    ? null
    : 'Put files next to SKILL.md or in references/, templates/, scripts/ or assets/.';
}
