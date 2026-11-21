/**
 * A skill's files (SST-01, SST-04, CT-804; CT-1213; since 2.0 without Whombat's import checks, CT-1403): the limits a
 * skill keeps within (Hermes's), safe paths, files no skill holds, its text, and a version's content hash. Pure.
 *
 * Whombat's own check of a skill folder (`validateSkill`: its front-matter rule, literal secrets and its content scan)
 * went with imports (HSK-07, HSK-08): Hermes's guard checks what is installed or edited.
 */
import { sha256Hex } from '../audit/crypto.js';
import { decodeUtf8OrNull } from '../text/utf8.js';

/** The instructions file at the top of a skill's folder. */
export const SKILL_MD = 'SKILL.md';

/**
 * What one skill may hold (SST-01, CT-417; since 0.125 within Hermes's limits, CT-1213): its `SKILL.md` up to 100,000
 * bytes, front matter included (Hermes's `MAX_SKILL_CONTENT_CHARS` is 100,000 characters), up to 49 other files (50 with
 * `SKILL.md`, Hermes's skills guard's `MAX_FILE_COUNT`) of at most 256 KB each (`MAX_SINGLE_FILE_KB`) and 2 MiB together,
 * and paths at most six folders deep inside the skill.
 */
export interface SkillLimits {
  bodyBytes: number;
  files: number;
  fileBytes: number;
  filesBytes: number;
  depth: number;
}

export const SKILL_LIMITS: SkillLimits = {
  bodyBytes: 100_000,
  files: 49,
  fileBytes: 256 * 1024,
  filesBytes: 2 * 1024 * 1024,
  depth: 6,
};

/** A file of a skill: its path, size and sha-256 (`skillContentHash`). */
export interface SkillFileInfo {
  path: string;
  size: number;
  sha256: string;
}

/** Why a path inside a skill is not acceptable, or null. Paths use `/`, relative to the skill's folder. */
export function skillPathProblem(path: string, maxDepth = SKILL_LIMITS.depth): string | null {
  if (!path) return 'An empty path.';
  if (path.length > 200) return 'The path is longer than 200 characters.';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'The path is absolute.';
  if (path.includes('\\')) return 'The path uses a backslash.';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'The path holds control characters.';
  const segments = path.split('/');
  if (segments.some((s) => s === '..')) return 'The path climbs out of the skill (..).';
  if (segments.some((s) => s === '' || s === '.')) return 'The path has an empty or “.” segment.';
  if (segments.length > maxDepth) return `The path is deeper than ${maxDepth} folders.`;
  return null;
}

/**
 * The text of a file when it is well-formed UTF-8 without NUL bytes, else null, without a leading byte order mark.
 * (Core has no TextDecoder: it runs where no DOM or Node types exist.) Overlong forms, surrogates and code points past
 * U+10FFFF are refused.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return decodeUtf8OrNull(bom ? bytes.subarray(3) : bytes);
}

/**
 * A skill version's identity (SST-04, CT-804): sha-256 (hex) over its files sorted by path, each as `path`, NUL, the
 * file's sha-256, newline.
 */
export function skillContentHash(files: readonly Pick<SkillFileInfo, 'path' | 'sha256'>[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\u0000${f.sha256}\n`)
    .join('');
  return sha256Hex(lines);
}

/**
 * Files a provider would act on by themselves (BP-D02), at any depth: hooks (`hooks`, `hooks.json`, `hooks/…`), MCP
 * configs, plugin folders (`.claude-plugin/`, `.codex-plugin/`), provider settings folders (`.claude/`, `.codex/`) and
 * Codex skill metadata (`agents/*.yaml`). Never in a skill.
 */
export const SKILL_PROVIDER_FILE =
  /(^|\/)hooks[^/]*(\/|$)|(^|\/)\.mcp\.json$|(^|\/)\.(claude|codex)(-plugin)?(\/|$)|(^|\/)agents\/[^/]+\.ya?ml$/i;
