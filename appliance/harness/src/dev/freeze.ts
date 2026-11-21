/**
 * `dev/freeze` — the candidate freeze's second half (the move to GitHub, Whombat LNK-50; the maintainers'
 * dev-instance runbook “The move to GitHub”). whombat-ops `bin/candidate --freeze "<why>"` waits for a candidate that
 * is running (the candidates' lock), writes the freeze file, and runs this while it still holds the lock:
 *
 * 1. every open DEV rollout is stopped (reason `dev_move_freeze`): one that completed would offer its release to every
 *    box, and a stop never interrupts an installation (CT-140);
 * 2. it waits until every claimed DEV box is settled (dev/move.ts `settle`): steady, heard from within the hour, and not
 *    behind the release DEV control offers every box (it would take that at its next check);
 * 3. each box's release goes into the freeze file (`release <device> <id>` lines under its first line): what
 *    `tufrepo gh-continue --carry` takes, checked again before each box is offered the bridge.
 *
 *   dev/freeze [--wait 30m] [--ignore <device>,…]
 *
 * Run again (through `bin/candidate --freeze`) it does the same: nothing is lifted, a box that settled since is
 * recorded. Exit 1 when the boxes didn't settle in time: the freeze stays, the move waits.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateDuration } from '../ship/args.ts';
import { devControl, devOp, shipContext } from '../ship/context.ts';
import { freezeFile } from './candidate-plan.ts';
import { boxLines, freezeRecord, type MoveDevice, type MoveRollout, openRollouts, settle } from './move.ts';

const say = (s: string) => process.stderr.write(`freeze: ${s}\n`);

function arg(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const waitMs = validateDuration(arg(argv, '--wait') ?? '30m');
  const ignore = (arg(argv, '--ignore') ?? '').split(',').filter(Boolean);
  const file = freezeFile(process.env, homedir());
  if (!existsSync(file))
    throw new Error(`no freeze file at ${file}: bin/candidate --freeze "<why>" writes it, then runs this`);
  const firstLine = readFileSync(file, 'utf8').split('\n')[0] ?? '';
  const c = devControl(shipContext());

  const { rollouts } = await devOp<{ rollouts: MoveRollout[] }>(c, 'GET', '/rollouts');
  for (const r of openRollouts(rollouts)) {
    await devOp(c, 'POST', `/rollouts/${r.rollout}/stop`, { reason: 'dev_move_freeze' });
    say(`rollout ${r.rollout} (${r.release}, ${r.state}) stopped`);
  }

  const until = Date.now() + waitMs;
  let last = '';
  for (;;) {
    const [{ devices }, { rollouts: now }] = await Promise.all([
      devOp<{ devices: MoveDevice[] }>(c, 'GET', '/devices'),
      devOp<{ rollouts: MoveRollout[] }>(c, 'GET', '/rollouts'),
    ]);
    const s = settle(devices, now, Date.now(), ignore);
    const lines = [
      ...(s.open.length ? [`open rollouts: ${s.open.join(', ')}`] : []),
      `offered to every box: ${s.offered ?? 'nothing'}`,
      ...boxLines(s.boxes),
    ];
    if (lines.join('\n') !== last) {
      for (const l of lines) say(l);
      last = lines.join('\n');
    }
    if (s.settled) {
      writeFileSync(file, freezeRecord(firstLine, s.boxes));
      say(`settled; each box's release is in ${file} (the list gh-continue --carry takes)`);
      for (const l of boxLines(s.boxes)) process.stdout.write(`${l}\n`);
      return;
    }
    if (Date.now() > until) {
      say(
        `not settled within ${Math.round(waitMs / 60_000)} min: the freeze stays and the move waits; run bin/candidate --freeze again (--ignore <device> for one that never reports)`,
      );
      process.exitCode = 1;
      return;
    }
    await sleep(20_000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`freeze: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
