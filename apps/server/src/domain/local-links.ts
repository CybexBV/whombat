/**
 * An agent's links to its own machine (docs/decisions/messaging.md MS-L01, MS-L02): a Markdown link whose target is a
 * path on the runner or of the agent's commands — a skill's `SKILL.md` under the runner's temporary directory, a file in
 * its working directory, `file://…` — leads nowhere for the people reading it. Stored as its label instead, so the
 * words stay and nothing looks clickable. Whombat's own links (`/c/general`, `/agents/…`) and web addresses stay;
 * inline code and fenced blocks are left as written.
 */

/** Top-level directories of a Linux machine: a link under one of them is a path, not a page of the app. */
const ROOTS = [
  'bin',
  'boot',
  'dev',
  'etc',
  'home',
  'lib',
  'mnt',
  'nix',
  'opt',
  'persist',
  'proc',
  'root',
  'run',
  'sbin',
  'srv',
  'sys',
  'tmp',
  'usr',
  'var',
  'work',
  'workspace',
];

const LINK = new RegExp(
  String.raw`\[([^\]\n]*)\]\(\s*<?((?:file:\/\/)?\/(?:${ROOTS.join('|')})(?:\/[^\s)>]*)?|file:\/\/[^\s)>]*)>?(?:\s+"[^"\n]*")?\s*\)`,
  'g',
);

/** Fenced blocks and inline code: kept as written. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

export function unlinkLocalPaths(text: string): string {
  if (!text.includes('](')) return text;
  return text
    .split(CODE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(LINK, (_all, label: string, target: string) => label.trim() || `\`${target}\``),
    )
    .join('');
}
