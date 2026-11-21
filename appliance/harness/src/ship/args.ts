/**
 * `release/ship` arguments (the maintainers' shipping runbook; one environment since ONE-01):
 *
 *   release/ship build <id> [--reuse-host <id> | --host] [--known-issue "…"]… [--previous <id>] [--no-newer-check]
 *                      [--out-root DIR]
 *   release/ship iso <id> [--out-root DIR]: the installer ISO of the build (its host's; UP-X15)
 *   release/ship validate <id> [--skip-gates] [--scenarios <pattern>] [--jobs N] [--no-demo]
 *                      [--skip-upgrade-gates] [--rerun-gates] [--rerun-upgrade-gates] [--serial] [--previous <id>,<id>]
 *                      [--cloud <whombat-cloud commit>] [--out-root DIR]
 *   release/ship status [--dev] [--out-root DIR]
 *
 * `publish-dev`, `promote-prod` and `all` went with DEV and the Hetzner update repository (ONE-01, ONE-19): a release
 * goes to Beta with whombat-ops `candidate` and to Production with whombat-ops `promote <id> --yes`. So did build's
 * DEV twin and its options (`--dev-only`, `--twin`, `--reuse-host-twin`, `--dev-allow-downgrade-from`,
 * `--ahead-of-line`, `--override-input`) and `iso --dev|--both`.
 */
export type Command = 'build' | 'validate' | 'status' | 'iso';

export interface Parsed {
  command: Command;
  id: string | null;
  outRoot: string | null;
  build: {
    reuseHost: string | null;
    /** `--host`: a host release even when only the runtime changed (UP-X16). */
    forceHost: boolean;
    knownIssues: string[];
    newerCheck: boolean;
    previous: string | null;
    /** `<rev>:<time>:<date>`: the commit the runtime says it is. */
    runtimeStamp: string | null;
    /** The candidate's number, for the records. */
    candidate: string | null;
  };
  validate: {
    skipGates: boolean;
    scenarios: string | null;
    jobs: number;
    demo: boolean;
    upgradeGates: boolean;
    rerunGates: boolean;
    rerunUpgradeGates: boolean;
    serial: boolean;
    previous: string[] | null;
    /** `--cloud`: the whombat-cloud commit control and the relay run at, instead of what the release records say. */
    cloud: string | null;
  };
  status: { dev: boolean };
}

/** `90s`, `10m`, `2h` → milliseconds (a bare number is minutes). */
export function validateDuration(s: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(s.trim());
  if (!m?.[1]) throw new Error(`bad duration ${s} (e.g. 10m, 2h)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 'm') as 's' | 'm' | 'h'];
}

const COMMANDS: Command[] = ['build', 'validate', 'status', 'iso'];

/** The stages that went with DEV (ONE-01, ONE-19), and what replaced them. */
const RETIRED: Record<string, string> = {
  'publish-dev':
    'release/ship publish-dev went with DEV (ONE-01): whombat-ops candidate publishes a release to Beta',
  'promote-prod':
    'release/ship promote-prod went with the Hetzner update repository (ONE-01): whombat-ops promote <id> --yes moves a Beta release to Production, on John’s word (ONE-19)',
  all: 'release/ship all went with DEV (ONE-01): whombat-ops candidate builds and publishes to Beta, whombat-ops promote <id> --yes moves it to Production',
};

/** Build's options for the DEV twin, gone with it (ONE-01). */
const GONE_OPTIONS = [
  '--dev-only',
  '--twin',
  '--reuse-host-twin',
  '--dev-allow-downgrade-from',
  '--ahead-of-line',
  '--override-input',
  '--dev',
  '--both',
];

/** Which options each command takes (a value follows the ones listed in `valued`). */
const OPTIONS: Record<Command, { flags: string[]; valued: string[]; repeat?: string[] }> = {
  build: {
    flags: ['--no-newer-check', '--host'],
    valued: ['--reuse-host', '--known-issue', '--previous', '--out-root', '--runtime-stamp', '--candidate'],
    repeat: ['--known-issue'],
  },
  validate: {
    flags: [
      '--skip-gates',
      '--no-demo',
      '--skip-upgrade-gates',
      '--rerun-gates',
      '--rerun-upgrade-gates',
      '--serial',
    ],
    valued: ['--scenarios', '--jobs', '--previous', '--cloud', '--out-root'],
  },
  status: { flags: ['--dev'], valued: ['--out-root'] },
  iso: { flags: [], valued: ['--out-root'] },
};

export function parseShipArgs(argv: readonly string[]): Parsed {
  const [cmd, ...rest] = argv;
  if (cmd && RETIRED[cmd]) throw new Error(RETIRED[cmd]);
  if (!cmd || !COMMANDS.includes(cmd as Command))
    throw new Error(`usage: release/ship ${COMMANDS.join('|')} … (the maintainers' shipping runbook)`);
  const command = cmd as Command;
  const spec = OPTIONS[command];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  let id: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (spec.flags.includes(a)) flags.add(a);
    else if (spec.valued.includes(a)) {
      const v = rest[++i];
      if (v === undefined || (v.startsWith('--') && a !== '--known-issue'))
        throw new Error(`${a} needs a value`);
      if (values.has(a) && !spec.repeat?.includes(a)) throw new Error(`${a} given twice`);
      values.set(a, [...(values.get(a) ?? []), v]);
    } else if (GONE_OPTIONS.includes(a) && command !== 'status')
      throw new Error(
        `release/ship ${command} ${a}: the DEV twin went with DEV (ONE-01); there is one release`,
      );
    else if (a.startsWith('-')) throw new Error(`release/ship ${command}: unknown option ${a}`);
    else if (id === null && command !== 'status') id = a;
    else throw new Error(`release/ship ${command}: unexpected argument ${a}`);
  }
  if (command !== 'status' && !id) throw new Error(`release/ship ${command} <prod id> (whombat-YYYYMMDD.N)`);
  const one = (k: string) => values.get(k)?.[0] ?? null;
  const jobs = Number(one('--jobs') ?? 2);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) throw new Error('--jobs takes 1…16');
  if (flags.has('--host') && values.has('--reuse-host'))
    throw new Error('--host and --reuse-host: a host release or a runtime-only one, not both');
  return {
    command,
    id,
    outRoot: one('--out-root'),
    build: {
      reuseHost: one('--reuse-host'),
      forceHost: flags.has('--host'),
      knownIssues: (values.get('--known-issue') ?? []).map((k) => {
        if (!k.trim() || k.length > 300)
          throw new Error('--known-issue takes one line of at most 300 characters');
        return k.trim();
      }),
      newerCheck: !flags.has('--no-newer-check'),
      previous: one('--previous'),
      runtimeStamp: one('--runtime-stamp'),
      candidate: one('--candidate'),
    },
    validate: {
      skipGates: flags.has('--skip-gates'),
      scenarios: one('--scenarios'),
      jobs,
      demo: !flags.has('--no-demo'),
      upgradeGates: !flags.has('--skip-upgrade-gates'),
      rerunGates: flags.has('--rerun-gates'),
      rerunUpgradeGates: flags.has('--rerun-upgrade-gates'),
      serial: flags.has('--serial'),
      previous: one('--previous')?.split(',').filter(Boolean) ?? null,
      cloud: one('--cloud'),
    },
    status: { dev: flags.has('--dev') },
  };
}
