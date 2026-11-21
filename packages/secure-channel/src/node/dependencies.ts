import { readFileSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PINNED_DEPENDENCIES } from '../pins.js';

export interface DependencyMismatch {
  name: string;
  expected: string;
  /** Installed version, or `missing`. */
  actual: string;
  /** The package it was resolved from. */
  from: string;
}

/** Packages whose dependencies we resolve (the channel's runtime closure is reached through these). */
const PARENTS: readonly string[] = [
  '@libp2p/noise',
  '@libp2p/crypto',
  '@libp2p/utils',
  '@libp2p/peer-id',
  '@libp2p/interface',
  '@libp2p/logger',
  'weald',
];

function version(pkgJson: string): string {
  return (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string }).version;
}

/** The packages a package.json declares it imports. */
function declared(pkgJson: string): Set<string> {
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as Record<string, Record<string, string> | undefined>;
  return new Set(
    ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {})),
  );
}

function locate(name: string, base: string): string | undefined {
  try {
    const found = findPackageJSON(name, base);
    return found ? realpathSync(found) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check that the installed runtime closure of `@whombat/secure-channel` is exactly the reviewed set
 * (`PINNED_DEPENDENCIES`, ADR SC-01), as resolved from this package and from each library that imports it.
 * Consumers run it in CI after `pnpm install` (see the ADR's `pnpm.overrides` snippet); an empty result means
 * every resolution matches.
 */
export function verifyInstalledDependencies(): DependencyMismatch[] {
  const self = pathToFileURL(import.meta.filename ?? '').href;
  const bases = new Map<string, string>([['@whombat/secure-channel', self]]);
  for (const parent of PARENTS) {
    for (const base of [...bases.values()]) {
      const pkg = locate(parent, base);
      if (pkg) {
        bases.set(parent, pathToFileURL(pkg).href);
        break;
      }
    }
  }
  // A library that doesn't declare a package never imports it: what Node would find from there is only pnpm's
  // hoisting, which in a workspace with other versions of the same package proves nothing about the closure.
  const imports = new Map(
    [...bases]
      .filter(([from]) => from !== '@whombat/secure-channel')
      .map(([from, base]) => [from, declared(fileURLToPath(base))]),
  );
  const mismatches: DependencyMismatch[] = [];
  for (const [name, expected] of Object.entries(PINNED_DEPENDENCIES)) {
    let seen = false;
    for (const [from, base] of bases) {
      if (imports.get(from)?.has(name) === false) continue;
      const pkg = locate(name, base);
      if (!pkg || dirname(pkg) === dirname(base)) continue;
      seen = true;
      const actual = version(pkg);
      if (actual !== expected) mismatches.push({ name, expected, actual, from });
    }
    if (!seen) mismatches.push({ name, expected, actual: 'missing', from: '@whombat/secure-channel' });
  }
  return mismatches;
}
