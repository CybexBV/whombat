/**
 * A GitHub repository renamed or moved to another owner keeps its id, and GitHub sends its old name on to the new one.
 * Whombat follows it (docs/decisions/agent-repos.md): what names the repository by its old name names the new one.
 */

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The repository `from` as a whole name, in any case: not part of a longer owner (`xacme/app`) or name (`acme/app-2`,
 * `acme/app.js`). A `.git` after it, a slash (a URL's path) or a sentence's full stop still end it.
 */
function wholeName(from: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_.-])${escapeRegExp(from)}(?![A-Za-z0-9_-]|\\.(?!git\\b)[A-Za-z0-9_-])`,
    'gi',
  );
}

/** `text` with every mention of the repository `from` (a whole `owner/name`) as `to`. */
export function renameRepoInText(text: string, from: string, to: string): string {
  if (!from || from.toLowerCase() === to.toLowerCase() || !text.toLowerCase().includes(from.toLowerCase()))
    return text;
  return text.replace(wholeName(from), to);
}

/**
 * A JSON value with every string (keys stay) renamed by `renameRepoInText`. Returns the same value when nothing named the
 * repository, so a caller can tell by identity whether there is anything to save.
 */
export function renameRepoInJson<T>(value: T, from: string, to: string): T {
  if (typeof value === 'string') return renameRepoInText(value, from, to) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const next = renameRepoInJson(v, from, to);
      if (next !== v) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const next = renameRepoInJson(v, from, to);
      if (next !== v) changed = true;
      out[k] = next;
    }
    return (changed ? out : value) as T;
  }
  return value;
}
