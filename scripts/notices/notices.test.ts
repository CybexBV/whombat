import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNotices, goRequires, type LicensedPackage, type Tree } from './notices';

const ROOT = resolve(import.meta.dirname, '../..');
const LICENCES: Record<string, LicensedPackage[]> = {
  MIT: [{ name: 'left-pad', versions: ['1.3.0'], license: 'MIT' }],
};

/** This checkout's tracked files, less those `leave` drops; files read from disk. */
function checkout(leave: (path: string) => boolean = () => false): Tree {
  const files = execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => f && !leave(f));
  return { files, read: (path) => readFileSync(join(ROOT, path), 'utf8') };
}

/** A small tree: files with their contents. */
function tree(files: Record<string, string>): Tree {
  return {
    files: Object.keys(files),
    read: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`${path} isn't in the tree`);
      return text;
    },
  };
}

const MARKS = 'packages/brand/assets/marks/';
const FONTS = 'apps/web/src/app/fonts/';
const describedTree = {
  [`${FONTS}dmmono-a.woff2`]: '',
  [`${FONTS}OFL.txt`]: '',
  [`${FONTS}OFL-DMMono.txt`]: '',
  [`${MARKS}SOURCES.md`]: '| `adguard.svg` | AdGuard | Simple Icons `adguard` | CC0-1.0 |\n',
  [`${MARKS}adguard.svg`]: '',
  'patches/postgres@3.4.9.patch': '',
};

describe('third-party notices', () => {
  it('say the same, and need nothing more, without the folders the public copy leaves out', () => {
    const full = buildNotices(checkout(), LICENCES);
    const publicCopy = buildNotices(
      checkout((f) => f.startsWith('docs/') || f.startsWith('vendor/')),
      LICENCES,
    );
    expect(full.problems).toEqual([]);
    expect(publicCopy.problems).toEqual([]);
    expect(publicCopy.text).toBe(full.text);
    expect(full.text).not.toContain('docs/design-handoff');
  });

  it('name a third-party thing in the tree that is not described', () => {
    const { problems } = buildNotices(
      tree({
        ...describedTree,
        'patches/left-pad@1.3.0.patch': '',
        'packages/x/vendor/thing/a.py': '',
        'docs/design-handoff/fonts/dmmono-a.woff2': '',
        'docs/design-handoff/fonts/OFL.txt': '',
        [`${FONTS}comicsans-a.woff2`]: '',
        [`${MARKS}radarr.svg`]: '',
        [`${MARKS}SOURCES.md`]: `${describedTree[`${MARKS}SOURCES.md`]}| \`plex.svg\` | Plex | somewhere | WTFPL |\n`,
        [`${MARKS}plex.svg`]: '',
        'packages/x/package.json': JSON.stringify({ optionalDependencies: { fsevents: '2.3.3' } }),
      }),
      { ...LICENCES, 'GPL-2.0-only': [{ name: 'gpl-thing', versions: ['1.0.0'], license: 'GPL-2.0-only' }] },
    );
    for (const what of [
      'patches/left-pad@1.3.0.patch',
      'packages/x/vendor/thing',
      'docs/design-handoff/fonts/OFL-DMMono.txt',
      `${FONTS}comicsans-a.woff2`,
      `${MARKS}radarr.svg`,
      'plex.svg',
      'fsevents',
      'gpl-thing',
    ])
      expect(problems.join('\n')).toContain(what);
  });

  it('list the Go modules each go.mod requires, and name one without a licence', () => {
    const goMod = [
      'module example.com/appliance',
      'go 1.26.0',
      'require (',
      '\tgolang.org/x/sys v0.48.0',
      '\texample.com/ours/contracts v0.0.0-00010101000000-000000000000',
      '\texample.com/unknown/thing v1.2.3 // indirect',
      ')',
      'require rsc.io/qr v0.2.0',
      'replace example.com/ours/contracts => ../contracts/go',
    ].join('\n');
    expect(goRequires(goMod).map((r) => `${r.module}@${r.version}`)).toEqual([
      'example.com/unknown/thing@v1.2.3',
      'golang.org/x/sys@v0.48.0',
      'rsc.io/qr@v0.2.0',
    ]);
    const { text, problems } = buildNotices(tree({ ...describedTree, 'appliance/go.mod': goMod }), LICENCES);
    expect(text).toContain('`appliance/go.mod`');
    expect(text).toContain('| golang.org/x/sys | v0.48.0 | BSD-3-Clause |');
    expect(text).not.toContain('hosts/go.mod');
    expect(text).not.toContain('example.com/ours/contracts');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('example.com/unknown/thing');
  });

  it('take a font whose own file holds the whole licence without OFL.txt beside it', () => {
    const fonts = 'hosts/web/public/fonts/';
    const geist = {
      [`${fonts}geist-mono-latin-400-normal.woff2`]: '',
      [`${fonts}geist-latin-400-normal.woff2`]: '',
    };
    const complete = buildNotices(
      tree({
        ...describedTree,
        ...geist,
        [`${fonts}LICENSE-Geist.txt`]: '',
        [`${fonts}LICENSE-Geist-Mono.txt`]: '',
      }),
      LICENCES,
    );
    expect(complete.problems).toEqual([]);
    expect(complete.text).toContain('| Geist Mono |');
    expect(complete.text).toContain(fonts);
    const missing = buildNotices(
      tree({ ...describedTree, ...geist, [`${fonts}LICENSE-Geist.txt`]: '' }),
      LICENCES,
    );
    expect(missing.problems).toEqual([
      `${fonts.slice(0, -1)}/LICENSE-Geist-Mono.txt: missing beside Geist Mono`,
    ]);
  });

  it('leave out, and don’t require, what they describe but the tree doesn’t have', () => {
    const { text, problems } = buildNotices(tree(describedTree), LICENCES);
    expect(problems).toEqual([]);
    expect(text).toContain('patches/postgres@3.4.9.patch');
    expect(text).not.toContain('xterm');
    expect(text).not.toContain('Vendored code');
    expect(text).not.toContain('apps/admin/src/fonts');
    expect(text).toContain('apps/web/src/app/fonts');
    expect(text).not.toContain('Bricolage Grotesque');
  });
});
