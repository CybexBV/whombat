/**
 * What this build is (docs/decisions/bp-distribution.md BP-F03): its version and git commit, and the schema it
 * expects. A packaged release has them compiled in (`__WHOMBAT_BUILD__`, defined by `pnpm package`); a checkout
 * reads the root package.json's version and asks git once.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { schemaVersion } from './db/migrate';

declare const __WHOMBAT_BUILD__:
  | { version: string; gitSha: string | null; buildTime: string | null }
  | undefined;

export interface BuildInfo {
  version: string;
  /** The commit it was built from (null: a checkout without git). */
  gitSha: string | null;
  /** When a release was built (SOURCE_DATE_EPOCH); null in a checkout. */
  buildTime: string | null;
  /** A release made by `pnpm package`, not a checkout. */
  packaged: boolean;
  /** The newest migration this build has (`0017_bp_automations`). */
  schema: string | null;
}

let cached: BuildInfo | null = null;

/** The checkout this module runs from (unused in a release). */
const CHECKOUT = resolve(import.meta.dirname, '../../..');

function checkoutInfo(): Pick<BuildInfo, 'version' | 'gitSha'> {
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(join(CHECKOUT, 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch {
    // not a checkout
  }
  let gitSha: string | null = null;
  try {
    gitSha =
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: CHECKOUT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim() || null;
  } catch {
    gitSha = null;
  }
  return { version, gitSha };
}

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const schema = schemaVersion();
  cached =
    typeof __WHOMBAT_BUILD__ !== 'undefined'
      ? { ...__WHOMBAT_BUILD__, packaged: true, schema }
      : { ...checkoutInfo(), buildTime: null, packaged: false, schema };
  return cached;
}

/** `0.1.0 (abc1234)` */
export function versionLine(info: BuildInfo = buildInfo()): string {
  return info.gitSha ? `${info.version} (${info.gitSha.slice(0, 7)})` : info.version;
}
