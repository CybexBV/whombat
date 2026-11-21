/**
 * Every runner test file gets its own temporary directory (docs/decisions/archive/delegation.md DG-49). A turn's scratch
 * directory is `<tmp>/whombat-runner-<uid>/scratch/<dispatch id>` (`runnerTmpRoot`, BP-C38), and every test context has
 * the dispatch id `dsp_turn`: test files that ran turns without a `host.runnerTmp` of their own shared that one
 * directory with each other (vitest runs files in parallel) and with every other test run on the machine, so one turn's
 * cleanup removed it while another created it (`ENOENT: mkdir …/scratch/dsp_turn`, a turn that “failed” under load).
 * `os.tmpdir()` reads `TMPDIR` at each call, so pointing it at a directory of this file's own isolates them all.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const outer = tmpdir();
// A short name: pod tests open Unix sockets deep below it, and a socket's path may have 107 characters at most.
const own = mkdtempSync(join(outer, 'r-'));
process.env.TMPDIR = own;

/** Opens what a test made unreadable (scratch folders, SL-D21) so the directory can go. */
function openUp(dir: string): void {
  try {
    chmodSync(dir, 0o700);
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory() && !e.isSymbolicLink()) openUp(join(dir, e.name));
  } catch {
    // gone already, or not ours to open
  }
}

afterAll(() => {
  process.env.TMPDIR = outer;
  openUp(own);
  rmSync(own, { recursive: true, force: true });
});
