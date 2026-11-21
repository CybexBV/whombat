/**
 * `node harness/src/dev/twin-record.ts <prod id> [--out FILE]` — writes `<twin dir>/record.json` for a PROD build the
 * way `release/ship publish-dev` does (ship/publish-dev.ts), without publish-dev's DEV box checks: John's box
 * (IN-398) is in his own org, where the devbox tool's owner gets no tickets, so publish-dev's smoke
 * can't reach it. `dev/publish-release --record`
 * takes the file. Was `~/.cache/wb-tmp/ship/twin-record.mts` (IN-288…IN-295); in the repo since IN-296 (dev/candidate).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { say, shipContext } from '../ship/context.ts';
import { prodId } from '../ship/ids.ts';
import { recordChain } from '../ship/publish-dev.ts';
import { builtFromOf, releaseRecord } from '../ship/record.ts';
import { verifyChain } from '../ship/records.ts';

interface BuildRecord {
  source: { rev: string };
  runtime: { whombatRev: string };
  ship: {
    twin: { releaseId: string; dir: string; devAllowDowngradeFrom?: string[] };
    candidate: { file: string };
    contracts?: string;
  };
}

export async function writeTwinRecord(id: string, out?: string): Promise<string> {
  const ctx = shipContext(null);
  const prod = prodId(id);
  const dir = join(ctx.root, prod.id);
  verifyChain(dir, prod.id, 'build');
  const chain = recordChain(dir, prod.id);
  const build = chain[0]?.record as unknown as BuildRecord;
  const twinDir = build.ship.twin.dir;
  const record: Record<string, unknown> = releaseRecord({
    env: 'dev',
    twin: prod.id,
    notesDir: twinDir,
    chain,
    builtFrom: await builtFromOf(ctx.repo, build),
  }) as unknown as Record<string, unknown>;
  const allowDown = build.ship.twin.devAllowDowngradeFrom ?? [];
  if (allowDown.length) record.allowDowngradeFrom = allowDown;
  const file = out ?? join(twinDir, 'record.json');
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  say(`${build.ship.twin.releaseId} (twin of ${prod.id}): record written to ${file}`);
  return file;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const id = argv[0];
  if (!id) {
    process.stderr.write('usage: node harness/src/dev/twin-record.ts <prod id> [--out FILE]\n');
    process.exit(2);
  }
  const at = argv.indexOf('--out');
  await writeTwinRecord(id, at >= 0 ? argv[at + 1] : undefined);
}
