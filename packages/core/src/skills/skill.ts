/**
 * A skill (contracts 0.113, CT-800; since 2.0 Hermes's own, CT-1400…CT-1404; since 3.0 one list, CT-1570; Whombat
 * hermes-skills.md HSK-01, HSK-10, HSK-13, one-person.md OP-08): a folder with `SKILL.md` and its files, as Hermes Agent
 * lays them out. Its name, where it comes from, the category Hermes files it under, and what its own front matter says
 * it needs. Pure.
 *
 * Whombat's own `whombat:` front-matter line, its keys (`requires`), and its connection and server needs went with
 * Whombat's skills (HSK-01, HSK-10): a skill says what it needs the way Hermes's skills do (`SkillNeeds`).
 */
import { z } from 'zod';

/**
 * A skill's name, as Hermes names a skill's folder (since 0.125, CT-1213; Hermes's `VALID_NAME_RE`, `MAX_NAME_LENGTH`):
 * lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit, at most 64. It keys a skill
 * in the list (SST-02, SST-06; one name, one skill, as Hermes refuses an ambiguous one).
 */
export const SkillName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'Use lowercase letters, digits, dots, dashes and underscores (at most 64), starting with a letter or digit.',
  )
  .refine((name) => !name.includes('..'), 'A name can’t hold “..”.');
export type SkillName = z.infer<typeof SkillName>;

/* Where a skill comes from (CT-1400, CT-1570) ------------------------------------------------------------------- */

/**
 * Where a skill comes from (HSK-01, HSK-06; since 3.0 one list in the person's Hermes profile, CT-1570, OP-08):
 * `builtin` — one of Hermes's own skills, synced in with Hermes (HSK-02); `hub` — you installed it from Hermes's hub;
 * `learned` — the agent wrote it while working with you (Hermes's agent-created skills).
 */
export const SKILL_ORIGINS = ['builtin', 'hub', 'learned'] as const;
export const SkillOrigin = z.enum(SKILL_ORIGINS);
export type SkillOrigin = z.infer<typeof SkillOrigin>;

/* Categories (HSK-13) -------------------------------------------------------------------------------------------- */

/**
 * The category Hermes files a skill under (HSK-13, CT-1401): the first folder of its path in its directory
 * (`productivity/notion` → `productivity`; Hermes's `_get_category_from_path`), the folder Hermes's own skills and its
 * optional ones come in, or the one Hermes installs a hub skill into. One path segment as Hermes names folders.
 */
export const SkillCategory = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'A category is one folder name.')
  .refine((c) => !c.includes('..'), 'A category can’t hold “..”.');
export type SkillCategory = z.infer<typeof SkillCategory>;

/** The longest description a category has (Hermes's `DESCRIPTION.md`, its front matter's `description`). */
export const SKILL_CATEGORY_DESCRIPTION_MAX = 1_000;

/**
 * A category as Settings → Skills titles and describes its group (HSK-13): its title from the folder's name
 * (`skillCategoryTitle`) and Hermes's own words for it (`<category>/DESCRIPTION.md`), null when it has none.
 */
export const SkillCategoryInfo = z.object({
  category: SkillCategory,
  title: z.string().min(1).max(80),
  description: z.string().max(SKILL_CATEGORY_DESCRIPTION_MAX).nullable(),
});
export type SkillCategoryInfo = z.infer<typeof SkillCategoryInfo>;

/** Words a category's title keeps as Hermes writes them, by their lowercase folder spelling. */
const TITLE_WORDS: Readonly<Record<string, string>> = {
  ai: 'AI',
  mcp: 'MCP',
  mlops: 'MLOps',
  devops: 'DevOps',
  github: 'GitHub',
  api: 'API',
  llm: 'LLM',
};

/**
 * A category's title from its folder name (HSK-13): dashes and underscores become spaces, the first word gets a
 * capital, a few names keep their own spelling (`autonomous-ai-agents` → “Autonomous AI agents”, `mlops` → “MLOps”).
 */
export function skillCategoryTitle(category: string): string {
  const words = category
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w, i) => {
      const known = TITLE_WORDS[w.toLowerCase()];
      if (known) return known;
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    });
  return words.length ? words.join(' ').slice(0, 80) : category.slice(0, 80);
}

/* What a skill needs (HSK-10) ------------------------------------------------------------------------------------ */

/** Most environment variables, commands and files one skill's needs list each (CT-1402). */
export const SKILL_NEEDS_MAX = 16;

/** An environment variable's name as a skill names it (`NOTION_API_KEY`). */
export const SkillEnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/);
/** A command a skill runs (`curl`, `himalaya`, `gws`). */
export const SkillCommandName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);
/** A credential file a skill reads, relative to the Hermes home (`google_token.json`). */
export const SkillCredentialFile = z
  .string()
  .regex(/^[A-Za-z0-9_.][A-Za-z0-9._ /-]{0,199}$/)
  .refine((p) => !p.split('/').includes('..'), 'A file inside the Hermes home.');

/**
 * An environment variable a skill reads: from `prerequisites.env_vars` or `required_environment_variables` (whose
 * `optional: true` makes it `optional`: the skill works without it, with less).
 */
export const SkillEnvNeed = z.object({ name: SkillEnvName, optional: z.boolean().default(false) });
export type SkillEnvNeed = z.infer<typeof SkillEnvNeed>;

/**
 * What a skill's own front matter says it needs (HSK-10, CT-1402), as Hermes reads it: environment variables
 * (`prerequisites.env_vars`, `required_environment_variables`), commands (`prerequisites.commands`) and credential files
 * (`required_credential_files`, their `path`). Each list in the front matter's order, each entry once. Whether a need is
 * met shows when the skill runs, not here: a skill with needs is still on.
 */
export const SkillNeeds = z.object({
  env: z.array(SkillEnvNeed).max(SKILL_NEEDS_MAX).default([]),
  commands: z.array(SkillCommandName).max(SKILL_NEEDS_MAX).default([]),
  files: z.array(SkillCredentialFile).max(SKILL_NEEDS_MAX).default([]),
});
export type SkillNeeds = z.infer<typeof SkillNeeds>;
export type SkillNeedsInput = z.input<typeof SkillNeeds>;

/** “a”, “a and b”, “a, b and c”. */
function and(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * What a skill needs, in words for its row (HSK-10): one line per kind, required variables first (“Needs
 * NOTION_API_KEY”), then commands (“Needs the curl and jq commands”), files (“Needs google_token.json”) and the variables
 * it can do without (“Can use USDA_API_KEY”). Empty when it needs nothing.
 */
export function skillNeedsText(needs: SkillNeedsInput | undefined): string[] {
  if (!needs) return [];
  const n = SkillNeeds.parse(needs);
  const required = n.env.filter((e) => !e.optional).map((e) => e.name);
  const optional = n.env.filter((e) => e.optional).map((e) => e.name);
  const lines: string[] = [];
  if (required.length) lines.push(`Needs ${and(required)}`);
  if (n.commands.length)
    lines.push(`Needs the ${and(n.commands)} command${n.commands.length === 1 ? '' : 's'}`);
  if (n.files.length) lines.push(`Needs ${and(n.files)}`);
  if (optional.length) lines.push(`Can use ${and(optional)}`);
  return lines;
}
