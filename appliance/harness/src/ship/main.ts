/**
 * `release/ship` — the release pipeline of one environment (UP-C1; ONE-01, ONE-19; the maintainers' shipping
 * runbook; IN-94…IN-101). One command per stage, each writing a chained record next to the release (records.ts):
 *
 *   build      the release of the one Whombat image, notes, build.json          (build.ts)
 *   validate   gates, scenarios, demo → gates.json; VM upgrade gates             (validate.ts)
 *   status     one screen: hosted components, fleet, rollouts, alerts, records  (status.ts)
 *   iso        the installer ISO of a build (its host's), on demand (UP-X15)    (iso.ts)
 *
 * Publishing is whombat-ops `candidate` (Beta) and `promote` (Production): `tufrepo gh-publish` and `gh-promote`.
 * Arguments: args.ts.
 */
import { parseShipArgs } from './args.ts';
import { build } from './build.ts';
import { shipContext } from './context.ts';
import { shipIso } from './iso.ts';
import { status } from './status.ts';
import { validate } from './validate.ts';

async function main(): Promise<void> {
  // A release is Cybex's: what it builds is scanned against the maintainers' guard list, which it refuses to go without.
  process.env.WHOMBAT_GUARDS_REQUIRED ??= '1';
  const a = parseShipArgs(process.argv.slice(2));
  const ctx = shipContext(a.outRoot);
  const id = a.id ?? '';
  switch (a.command) {
    case 'build':
      return build(ctx, { prodId: id, ...a.build });
    case 'validate':
      await validate(ctx, { prodId: id, ...a.validate });
      return;
    case 'status':
      return status(ctx, a.status);
    case 'iso':
      await shipIso(ctx, { prodId: id });
      return;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`ship: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
