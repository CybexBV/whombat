/**
 * THIRD-PARTY-NOTICES.txt: every npm package whose code is inside the bundles or shipped in node_modules,
 * with its license and license text. esbuild's metafile says which files went into the bundles.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The package directory (relative) of a bundled input like `node_modules/.pnpm/x@1/node_modules/x/lib/a.js`. */
export function packageDirOf(input: string): string | null {
  const i = input.lastIndexOf('node_modules/');
  if (i < 0) return null;
  const rest = input.slice(i + 'node_modules/'.length).split('/');
  const depth = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= depth) return null;
  return `${input.slice(0, i)}node_modules/${rest.slice(0, depth).join('/')}`;
}

interface Notice {
  name: string;
  version: string;
  license: string;
  text: string | null;
}

function readNotice(dir: string): Notice | null {
  let pkg: { name?: string; version?: string; license?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!pkg.name) return null;
  const file = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(n))
        .sort()[0]
    : undefined;
  return {
    name: pkg.name,
    version: pkg.version ?? '?',
    license: typeof pkg.license === 'string' ? pkg.license : 'see the package',
    text: file ? readFileSync(join(dir, file), 'utf8').trim() : null,
  };
}

/** The notices text for these package directories (absolute), sorted by name. */
export function noticesText(dirs: Iterable<string>): string {
  const seen = new Map<string, Notice>();
  for (const d of dirs) {
    const n = readNotice(d);
    if (n) seen.set(`${n.name}@${n.version}`, n);
  }
  const parts = [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, n]) =>
        `${key} (${n.license})\n${'-'.repeat(Math.min(key.length + n.license.length + 3, 100))}\n${n.text ?? 'No license file in the package; see its package.json and repository.'}\n`,
    );
  return `Third-party software in this Whombat release\n\n${parts.join('\n')}`;
}
