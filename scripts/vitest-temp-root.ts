import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Every test run gets one temporary folder of its own, and it is removed when the run ends.
//
// Many tests make scratch folders with mkdtemp(tmpdir()) and leave them behind. Pointing TMPDIR at a folder per
// run before the workers start puts all of them in one place that teardown can delete, so a forgotten cleanup in
// a test can no longer fill the disk of a machine that runs the suites all day.
//
// The root config and every project config list this file, so a run from the root and a run inside one package
// are both covered. The first setup in a process owns the folder; the ones after it (the projects of a root run, or
// a suite started from inside a test) reuse it.

const PREFIX = 'wbt-';
// A run that was killed never reaches its teardown. Its folder is swept by a later run once it is this old, far
// longer than any run takes.
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

// What Vitest hands a global setup; only the part used here.
type Project = { vitest?: { _tmpDir?: unknown } };

export default function setup(project?: Project): (() => void) | undefined {
  if (process.env.WHOMBAT_TEST_TMP_ROOT) return undefined;
  const parent = tmpdir();
  // A run started inside one package keeps its compiled modules in a folder Vitest picks before this setup runs and
  // never removes. Teardown removes it too, as long as it is where Vitest puts it.
  const vitestTmp = project?.vitest?._tmpDir;
  const leftover = typeof vitestTmp === 'string' && dirname(vitestTmp) === parent ? vitestTmp : undefined;
  sweepStale(parent);
  const root = mkdtempSync(join(parent, PREFIX));
  const previous = process.env.TMPDIR;
  process.env.WHOMBAT_TEST_TMP_ROOT = root;
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    delete process.env.WHOMBAT_TEST_TMP_ROOT;
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    if (leftover) rmSync(leftover, { recursive: true, force: true, maxRetries: 3 });
  };
}

function sweepStale(parent: string, now = Date.now()): void {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(parent, name);
    try {
      const info = statSync(path);
      if (info.isDirectory() && now - info.mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run removed it first.
    }
  }
}
