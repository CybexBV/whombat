/**
 * Hermes's skill hub and its guard (contracts 2.0, CT-1405…CT-1409; Whombat hermes-skills.md HSK-06, HSK-07, HSK-09):
 * where Add skills looks, how far Hermes trusts what it finds, what Hermes's scan (`tools/skills_guard.py`) reports, and
 * what its install policy decides. Hermes decides; these are the words and shapes Whombat carries them in. Pure.
 */
import { z } from 'zod';

/* Sources (HSK-06) ----------------------------------------------------------------------------------------------- */

/**
 * The hub's sources Whombat asks (HSK-06), by Hermes's source ids: `official` (Hermes's optional skills, part of the
 * Hermes package, no network), `github` (Hermes's default taps, `SKILL_HUB_GITHUB_REPOS`) and `skills-sh` (skills.sh's
 * index). Never ClawHub, LobeHub, browse.sh, well-known endpoints or links; Hermes's own index only for what it resolves
 * into these three.
 */
export const SKILL_HUB_SOURCES = ['official', 'github', 'skills-sh'] as const;
export const SkillHubSource = z.enum(SKILL_HUB_SOURCES);
export type SkillHubSource = z.infer<typeof SkillHubSource>;

/** The `github` source's repositories: Hermes's default taps (`GitHubSource.DEFAULT_TAPS`), all of them `trusted`. */
export const SKILL_HUB_GITHUB_REPOS = [
  'openai/skills',
  'anthropics/skills',
  'huggingface/skills',
  'NVIDIA/skills',
] as const;

/**
 * A hub skill's identifier as Hermes's hub names it (`SkillMeta.identifier`): `official/<category>/<name>` (an optional
 * skill may sit one folder deeper), `<owner>/<repo>/<path>` on GitHub (`openai/skills/skills/.curated/pdf`), or
 * `skills-sh/<owner>/<repo>/<skill>`. Path segments of letters, digits, dots, dashes and underscores, none `.` or `..`.
 */
export const SkillHubIdentifier = z
  .string()
  .min(3)
  .max(300)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/, 'A hub skill’s identifier.')
  .refine((id) => id.split('/').every((s) => s !== '.' && s !== '..'), 'A hub skill’s identifier.');
export type SkillHubIdentifier = z.infer<typeof SkillHubIdentifier>;

/**
 * Which of the three sources an identifier is from (HSK-06): `official/…` and `skills-sh/…` by their prefix, a GitHub
 * one only inside `SKILL_HUB_GITHUB_REPOS` (owner and repository in any case, as GitHub matches them). Null for anything
 * else (ClawHub, LobeHub, a link, another repository): Whombat never asks for it.
 */
export function skillHubSourceOf(identifier: string): SkillHubSource | null {
  if (!SkillHubIdentifier.safeParse(identifier).success) return null;
  const parts = identifier.split('/');
  if (parts[0] === 'official') return parts.length >= 3 ? 'official' : null;
  if (parts[0] === 'skills-sh') return parts.length >= 4 ? 'skills-sh' : null;
  if (parts.length < 3) return null;
  const repo = `${parts[0]}/${parts[1]}`.toLowerCase();
  return SKILL_HUB_GITHUB_REPOS.some((r) => r.toLowerCase() === repo) ? 'github' : null;
}

/* Trust (HSK-07) ------------------------------------------------------------------------------------------------- */

/**
 * How far Hermes trusts a hub skill (`trust_level`, `skills_guard._resolve_trust_level`): `builtin` (Hermes's own
 * optional skills), `trusted` (Hermes's `TRUSTED_REPOS`, also when skills.sh lists one of theirs, and an official skill
 * whose files live in another repository) or `community`.
 */
export const SKILL_TRUST_LEVELS = ['builtin', 'trusted', 'community'] as const;
export const SkillTrust = z.enum(SKILL_TRUST_LEVELS);
export type SkillTrust = z.infer<typeof SkillTrust>;

/** A skill's trust in words, beside its name. */
export const SKILL_TRUST_TEXT: Readonly<Record<SkillTrust, string>> = {
  builtin: 'From Hermes',
  trusted: 'Trusted',
  community: 'Community',
};

/**
 * The trust Hermes's guard scans with (`ScanResult.trust_level`): a hub skill's (`SkillTrust`), or `agent-created` for a
 * skill written here: one the agent learned, or your edit (HSK-07).
 */
export const SCAN_TRUST_LEVELS = [...SKILL_TRUST_LEVELS, 'agent-created'] as const;
export const ScanTrust = z.enum(SCAN_TRUST_LEVELS);
export type ScanTrust = z.infer<typeof ScanTrust>;

/* The scan (HSK-07) ---------------------------------------------------------------------------------------------- */

/** Hermes's verdict (`_determine_verdict`): a critical finding is `dangerous`, a high one `caution`, else `safe`. */
export const SCAN_VERDICTS = ['safe', 'caution', 'dangerous'] as const;
export const ScanVerdict = z.enum(SCAN_VERDICTS);
export type ScanVerdict = z.infer<typeof ScanVerdict>;

/** A verdict in words. */
export const SCAN_VERDICT_TEXT: Readonly<Record<ScanVerdict, string>> = {
  safe: 'Nothing risky found',
  caution: 'Worth a look',
  dangerous: 'Dangerous',
};

/** A finding's severity, as Hermes rates it. */
export const SCAN_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const ScanSeverity = z.enum(SCAN_SEVERITIES);
export type ScanSeverity = z.infer<typeof ScanSeverity>;

/**
 * A finding's category (`Finding.category`): any slug, since a newer Hermes may add one; the ones Hermes 0.22.5 knows
 * have words (`SCAN_CATEGORY_TEXT`).
 */
export const ScanCategory = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export type ScanCategory = z.infer<typeof ScanCategory>;

/** Hermes 0.22.5's categories in words; another category reads as “Something else”. */
export const SCAN_CATEGORY_TEXT: Readonly<Record<string, string>> = {
  exfiltration: 'Sends data out',
  injection: 'Tries to change the agent’s instructions',
  destructive: 'Deletes or overwrites things',
  persistence: 'Keeps itself running',
  network: 'Opens network connections',
  obfuscation: 'Hides what it does',
  execution: 'Runs code',
  traversal: 'Reaches outside its folder',
  mining: 'Mines cryptocurrency',
  supply_chain: 'Installs software from outside',
  privilege_escalation: 'Asks for more rights',
  credential_exposure: 'Exposes passwords or keys',
  structural: 'Unusual files',
};

/** A finding's category in words. */
export function scanCategoryText(category: string): string {
  return Object.hasOwn(SCAN_CATEGORY_TEXT, category)
    ? (SCAN_CATEGORY_TEXT[category] as string)
    : 'Something else';
}

/** Most findings one scan carries (the verdict counts them all: `findingsTotal`). */
export const SCAN_FINDINGS_MAX = 50;
/** The longest text a finding quotes (Hermes cuts a line at 120 characters). */
export const SCAN_MATCH_MAX = 120;

/**
 * One thing Hermes's scan found (`Finding`): its pattern, severity and category, the file and line (0 for the folder as a
 * whole, `(directory)`), the text it matched — secrets redacted (`redactSecrets`), at most `SCAN_MATCH_MAX` characters —
 * and Hermes's own description of it.
 */
export const ScanFinding = z.object({
  patternId: z.string().min(1).max(80),
  severity: ScanSeverity,
  category: ScanCategory,
  file: z.string().max(200),
  line: z.number().int().min(0),
  match: z.string().max(SCAN_MATCH_MAX),
  description: z.string().max(300),
});
export type ScanFinding = z.infer<typeof ScanFinding>;

/* The install policy (HSK-07) ------------------------------------------------------------------------------------ */

/**
 * What Hermes's install policy decided (`should_allow_install` without `force`): `allow` or `block`. Hermes's `ask` (an
 * agent-created skill with a dangerous verdict) is a `block` in Whombat: dangerous is refused, and there is no force.
 */
export const SKILL_INSTALL_DECISIONS = ['allow', 'block'] as const;
export const SkillInstallDecision = z.enum(SKILL_INSTALL_DECISIONS);
export type SkillInstallDecision = z.infer<typeof SkillInstallDecision>;

/** The policy's decision and why, in plain words (`skillPolicyReasonText`). */
export const SkillPolicy = z.object({
  decision: SkillInstallDecision,
  reason: z.string().min(1).max(300),
});
export type SkillPolicy = z.infer<typeof SkillPolicy>;

/**
 * Why Hermes's policy allowed or blocked a skill (HSK-07), in words a person reads before Install, from what decided it:
 * the verdict, the trust it was scanned with, and the decision.
 */
export function skillPolicyReasonText(scan: {
  verdict: ScanVerdict;
  trust: ScanTrust;
  decision: SkillInstallDecision;
}): string {
  if (scan.decision === 'block') {
    if (scan.verdict === 'dangerous') return 'Hermes found something dangerous in it, so it can’t be added.';
    return 'Hermes found something risky in it. Skills from the community are only added when nothing is.';
  }
  if (scan.verdict === 'safe') return 'Hermes checked it and found nothing risky.';
  if (scan.trust === 'builtin') return 'Hermes found something to look at, but it comes with Hermes itself.';
  return 'Hermes found something to look at, but it comes from a source Hermes trusts.';
}

/* Updates (HSK-09) ----------------------------------------------------------------------------------------------- */

/** How often Settings asks Hermes whether installed hub skills changed (HSK-09): at most once an hour. */
export const SKILL_UPDATE_CHECK_MS = 60 * 60 * 1000;
