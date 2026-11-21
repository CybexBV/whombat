/**
 * The `tufrepo` that signs the dev instance's TUF repository (`$WB_MGD_HOME/env/manager/tuf`, development keys in its
 * `keys/`): `dev/publish-release` publishes releases with it and the dev stack's refresher re-signs the timestamp with
 * it (`tuf-refresh.ts`, IN-224). `$WB_TUFREPO`, else this checkout's `whombat-release-tools` (nix build; quick while
 * the build is in the store, so it is resolved again for each use rather than kept).
 */
import { join } from 'node:path';
import { REPO_DIR } from '../lib/paths.ts';
import { must } from '../lib/proc.ts';
import { treeFlake } from '../lib/source.ts';

export async function tufrepoBin(log?: string, timeoutMs?: number): Promise<string> {
  if (process.env.WB_TUFREPO) return process.env.WB_TUFREPO;
  const r = await must(
    'nix',
    [
      '--extra-experimental-features',
      'nix-command flakes',
      'build',
      '--no-link',
      '--print-out-paths',
      `${treeFlake(REPO_DIR)}#whombat-release-tools`,
    ],
    { cwd: REPO_DIR, ...(log ? { logFile: log } : {}), ...(timeoutMs ? { timeoutMs } : {}) },
  );
  return join(r.stdout.trim(), 'bin', 'tufrepo');
}
