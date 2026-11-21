// Shared helpers for the release scripts (Node only; never imported by package sources).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// contracts/scripts/lib → the repository root, whose packages/ holds the contracts packages.
export const repoRoot = join(import.meta.dirname, '..', '..', '..');

export type PackageInfo = {
  dir: string;
  name: string;
  version: string;
  /** Subpath export keys (`.`, `./domain`, …) as published. */
  subpaths: string[];
  /** `pnpm pack` file name: `@whombat/core@0.1.0` → `whombat-core-0.1.0.tgz`. */
  tarball: string;
  /** Peer dependencies, and their `@types/*`, at the versions this repository develops against (`@whombat/brand/react` needs react). */
  peers: Record<string, string>;
};

type Manifest = {
  name: string;
  version: string;
  publishConfig?: { exports?: Record<string, unknown> };
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** Every workspace package that declares `publishConfig.exports` is published (the contracts; apps and runtime packages never do). */
export function publishablePackages(): PackageInfo[] {
  const base = join(repoRoot, 'packages');
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const dir = join(base, d.name);
      let manifest: Manifest;
      try {
        manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
      } catch {
        return [];
      }
      const exportsMap = manifest.publishConfig?.exports;
      if (!exportsMap) return [];
      return [
        {
          dir,
          name: manifest.name,
          version: manifest.version,
          subpaths: Object.keys(exportsMap),
          tarball: `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`,
          peers: Object.fromEntries(
            Object.entries(manifest.peerDependencies ?? {}).flatMap(([name, range]) => {
              const types = `@types/${name}`;
              const typesVersion = manifest.devDependencies?.[types];
              return [
                [name, manifest.devDependencies?.[name] ?? range] as const,
                ...(typesVersion ? [[types, typesVersion] as const] : []),
              ];
            }),
          ),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Import specifiers for every published JavaScript subpath of a package (a stylesheet such as `./tokens.css` is a file, not a module). */
export function specifiers(pkg: Pick<PackageInfo, 'name' | 'subpaths'>): string[] {
  return pkg.subpaths
    .filter((s) => !s.endsWith('.css'))
    .map((s) => (s === '.' ? pkg.name : `${pkg.name}/${s.replace(/^\.\//, '')}`));
}
