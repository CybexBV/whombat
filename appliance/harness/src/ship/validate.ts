/**
 * `release/ship validate <prod id>` (UP-C1, UP-C2; IN-96, IN-116): from the commit that was built, everything that
 * proves the candidate. Side by side under one hold of the heavy lock (`--serial`: one after the other, each taking
 * it): harness/validate → demo in the caller's environment, the live-agent scenarios in their own, and the VM upgrade
 * gates (`--no-lock`). publish-dev doesn't wait for any of it (IN-115). No skew check: clients and the box share one
 * contracts major (Whombat HE-52, IN-413).
 *
 *   gates.json          `harness/validate` with the candidate's pins in the caller's (scripted) environment (every
 *                       repository's gates, the harness's own check, every scenario but the live-agent ones), the
 *                       live-agent scenarios in a fresh environment of their own (live.ts, IN-108), and `harness/demo`;
 *   upgrade-gates.json  `release/upgrade-gates` (agent G, NX-110…): the candidate installed as an update of the two
 *                       newest PROD releases from the migration baseline on that boxes run, in VMs, through the real
 *                       manager, helper and TUF.
 *
 * What is skipped is recorded (`chain.complete: false`): DEV takes it, `promote-prod` doesn't.
 *
 * A machine that must not run VMs names a command in `WB_UPGRADE_GATES_RUN`: it is called instead of
 * `release/upgrade-gates`, with the same arguments, and runs the gates on a machine that may (`upgradeGatesCommand`).
 *
 * The pins say which commit of which component is validated. A release of the one repository is one commit: its pins
 * are the component list (`manifest/components.json`) with that commit filled in, and control and the relay at the
 * whombat-cloud commits the release records name (`--cloud <commit>` names another). A release from before it has the
 * candidate manifest its own commit holds. Either way they are the pins of the build, never of a later commit.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { HARNESS_DIR } from '../lib/paths.ts';
import { run } from '../lib/proc.ts';
import { type FindOptions, findSource, showAt } from '../lib/source.ts';
import { writePinsAt } from '../manifest/components.ts';
import { findBuild } from './build.ts';
import {
  channelReleaseIds,
  git,
  heavy,
  holdHeavy,
  labelled,
  prodOp,
  type ShipContext,
  say,
  together,
} from './context.ts';
import { BASELINE_RELEASE, compareIds, fromBaseline, parseReleaseId, prodId, type ReleaseId } from './ids.ts';
import { LIVE_SCENARIOS, runLive, selectsLive } from './live.ts';
import type { FleetDevice } from './promote.ts';
import { type ChainedRecord, nextChain, readRecord, sha256Hex, verifyChain, writeRecord } from './records.ts';

export interface ValidateArgs {
  prodId: string;
  /** harness/validate options passed through. */
  skipGates: boolean;
  scenarios: string | null;
  jobs: number;
  demo: boolean;
  upgradeGates: boolean;
  /** Run harness/validate, the live scenarios and the demo even when a passing gates.json of this build exists. */
  rerunGates: boolean;
  /** Run the upgrade gates even when a passing run of this build exists. */
  rerunUpgradeGates: boolean;
  /** One part after the other, each taking the heavy lock itself (before IN-116), instead of side by side. */
  serial: boolean;
  previous: string[] | null;
  /** `--cloud`: the whombat-cloud commit control and the relay run at (a release of the one repository). */
  cloud?: string | null;
}

/**
 * The pins a build is validated with, as `WB_MGD_PINS` takes them (a path seen from the appliance's folder, or an
 * absolute one), and why.
 *
 * - A build of the one repository (it names no candidate file): the component list at the build's commit, written to
 *   `<release folder>/validation/<candidate>.json`.
 * - A build from before it: the candidate manifest its commit holds. While this checkout still has that file it must
 *   be the same and is used where it is; once the manifests have left the repository, the commit's own is written to
 *   the release folder.
 */
export function pinsOfBuild(o: {
  repo: string;
  /** The release's folder. */
  dir: string;
  build: { source: { rev: string }; ship: { candidate: { file: string; name: string } } };
  cloud?: string | null;
  /** Where commits are looked for (default: the checkout, then the archives). */
  find?: FindOptions;
  env?: NodeJS.ProcessEnv;
}): { file: string; from: string } {
  const { rev } = o.build.source;
  const { file, name } = o.build.ship.candidate;
  const find = o.find ?? { checkout: o.repo };
  if (!file) {
    const out = join(o.dir, 'validation', `${name}.json`);
    const r = writePinsAt({
      rev,
      name,
      cloud: o.cloud ?? null,
      out,
      find,
      ...(o.env ? { env: o.env } : {}),
    });
    return {
      file: out,
      from: `the component list at ${rev.slice(0, 12)}, control ${r.cloud.control.slice(0, 12)}, the relay ${r.cloud.relay.slice(0, 12)}`,
    };
  }
  // The build's commit may be this checkout's or an archive's.
  const atBuild = showAt(findSource(rev, find), file).trim();
  if (existsSync(join(o.repo, file))) {
    if (atBuild !== readFileSync(join(o.repo, file), 'utf8').trim())
      throw new Error(
        `${file} differs from the one ${rev.slice(0, 12)} was built with: validate the pins you built`,
      );
    return { file, from: `${file}, as ${rev.slice(0, 12)} has it` };
  }
  const out = join(o.dir, 'validation', basename(file));
  mkdirSync(join(o.dir, 'validation'), { recursive: true });
  writeFileSync(out, `${atBuild}\n`);
  return { file: out, from: `${file} of ${rev.slice(0, 12)} (it is no longer in this checkout)` };
}

/**
 * `vm-tests/upgrade-gates/previous.json` (NX-110): N−1 and N−2 when neither control nor the update repository says
 * what boxes run. Production-family releases from the migration baseline on (IN-415); it may be empty (the gates
 * that update from a previous release are then not applicable). Nothing moves it: it is edited by hand.
 */
export function previousFromFile(repo: string): string[] {
  const file = join(repo, 'vm-tests', 'upgrade-gates', 'previous.json');
  const ids = (JSON.parse(readFileSync(file, 'utf8')) as { previous?: unknown }).previous;
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string' && prodIdOrNull(x)))
    throw new Error(
      `${file}: "previous" isn’t a list of production release ids from the migration baseline on (${BASELINE_RELEASE})`,
    );
  return ids as string[];
}

/** A production release id from the migration baseline on, else null. */
const prodIdOrNull = (id: string) => {
  const r = parseReleaseId(id);
  return r && fromBaseline(r) ? r : null;
};

/**
 * The PROD releases claimed boxes run, newest first. Only claimed boxes count: an unclaimed box nobody set up (a
 * stale test install still reporting an old release) isn’t a customer’s Whombat to upgrade; retired ones neither. A
 * release from before the migration baseline doesn’t count either: nothing updates from it (IN-415).
 */
export function claimedReleases(devices: FleetDevice[]): string[] {
  const ids = new Map<string, ReleaseId>();
  for (const d of devices) {
    const r = d.state === 'claimed' && d.status?.release ? prodIdOrNull(d.status.release) : null;
    if (r) ids.set(r.id, r);
  }
  return [...ids.values()].sort((a, b) => compareIds(b, a)).map((r) => r.id);
}

/**
 * The newest release each channel lists, newest first: what a Beta box and what a Production box run within the hour
 * of a publish. Null when no channel could be read; a channel that lists nothing from the migration baseline on adds
 * nothing.
 */
export function channelNewest(beta: string[] | null, production: string[] | null): string[] | null {
  if (!beta && !production) return null;
  const newest = (ids: string[] | null) =>
    (ids ?? [])
      .map(prodIdOrNull)
      .filter((r): r is ReleaseId => r !== null)
      .sort((a, b) => compareIds(b, a))[0];
  const out = new Map<string, ReleaseId>();
  for (const r of [newest(beta), newest(production)]) if (r) out.set(r.id, r);
  return [...out.values()].sort((a, b) => compareIds(b, a)).map((r) => r.id);
}

/**
 * The two releases the candidate is installed as an update of (UP-C2; N−1, N−2), from what boxes run:
 *
 * - the two newest releases claimed boxes report to control;
 * - with one release there, or none, the newest release each channel of the update repository lists (Beta's and
 *   Production's: a box on a channel takes its newest within the hour, whether or not it reports to control);
 * - previous.json only when the update repository can't be read either.
 */
export function pickPrevious(
  claimed: string[] | null,
  listed: string[] | null,
  file: string[],
): { ids: string[]; from: string } {
  const rest = listed?.length ? listed : file;
  const restFrom = listed?.length
    ? 'the newest release Beta and Production list'
    : 'vm-tests/upgrade-gates/previous.json';
  if (!claimed?.length) return { ids: rest.slice(0, 2), from: restFrom };
  const ids = claimed.slice(0, 2);
  if (ids.length === 1) {
    const newest = prodId(ids[0] as string);
    const older = rest.find((x) => {
      const r = prodIdOrNull(x);
      return r !== null && compareIds(r, newest) < 0;
    });
    if (older)
      return { ids: [...ids, older], from: `the release claimed boxes run (control), then ${restFrom}` };
  }
  return { ids, from: 'the releases claimed boxes run (control)' };
}

export async function previousReleases(
  ctx: ShipContext,
  given: string[] | null,
): Promise<{ ids: string[]; from: string }> {
  if (given?.length) return { ids: given, from: '--previous' };
  const file = previousFromFile(ctx.repo);
  const listed = channelNewest(
    await channelReleaseIds(ctx.prod.releasesUrl, 'development'),
    await channelReleaseIds(ctx.prod.releasesUrl, 'production'),
  );
  if (!listed) say(`${ctx.prod.releasesUrl}'s channels are unreadable: previous.json stands in for them`);
  let claimed: string[] | null = null;
  let why = 'control’s device list unavailable';
  try {
    const fleet = await prodOp<{ devices: FleetDevice[] }>(ctx, 'GET', '/v1/operator/devices');
    claimed = claimedReleases(fleet?.devices ?? []);
    if (fleet) why = 'no claimed box reports a production release';
  } catch (err) {
    why = `control’s device list: ${(err as Error).message.split('\n')[0]}`;
  }
  const picked = pickPrevious(claimed, listed, file);
  if (!claimed?.length) say(`${why}; using ${picked.from} (${picked.ids.join(', ')})`);
  return picked;
}

interface ValidationReportLite {
  ok: boolean;
  totals: Record<string, number>;
  manifest: { ok: boolean; problems: string[] };
  harness?: { outcome: string } | null;
  gates?: { outcome: string }[];
  soak?: { ok?: boolean } | null;
  scenarios?: { file: string; name: string; outcome: string; blocked?: string; error?: string }[];
  records?: { kind?: string; test?: string; gap?: string; detail?: string }[];
}

const isFile = (file: string, names: string[]) => names.some((n) => file.endsWith(n));

/**
 * A harness/validate report that passed in everything but the given scenario files (IN-108: the live-agent scenarios,
 * blocked in the scripted environment, run in their own).
 */
export function okApartFrom(report: ValidationReportLite | null, files: string[]): boolean {
  if (!report?.manifest.ok) return false;
  if (report.harness && report.harness.outcome !== 'passed') return false;
  if ((report.gates ?? []).some((g) => g.outcome !== 'passed')) return false;
  if (report.soak && report.soak.ok === false) return false;
  return (report.scenarios ?? []).every((sc) => sc.outcome === 'passed' || isFile(sc.file, files));
}

/** Only the given scenario files count: at least one test of them ran, and every one passed. */
export function passedOnly(report: ValidationReportLite | null, files: string[]): boolean {
  const mine = (report?.scenarios ?? []).filter((sc) => isFile(sc.file, files));
  return mine.length > 0 && mine.every((sc) => sc.outcome === 'passed');
}

function readReport(output: string): { file: string | null; report: ValidationReportLite | null } {
  const md = /report: (\S+report\.md)/.exec(output)?.[1] ?? null;
  const file = md?.replace(/\.md$/, '.json') ?? null;
  return {
    file,
    report:
      file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ValidationReportLite) : null,
  };
}

/**
 * The scenarios that didn't pass, by file, with why (a blocked scenario's recorded reason; a failed one's error): what
 * gates.json's summary names. A skipped or blocked scenario isn't passing (production needs every one to run).
 */
export function scenariosNotPassed(
  report: ValidationReportLite | null,
  exclude: string[] = [],
): { file: string; outcome: string; count: number; why: string }[] {
  const byKey = new Map<string, { file: string; outcome: string; count: number; why: string }>();
  for (const sc of report?.scenarios ?? []) {
    if (sc.outcome === 'passed' || isFile(sc.file, exclude)) continue;
    const rec = report?.records?.find((r) => r.kind === 'blocked' && r.test === sc.name);
    const why =
      rec?.detail ??
      rec?.gap ??
      sc.blocked ??
      sc.error ??
      (sc.outcome === 'skipped' ? 'skipped by the scenario' : '');
    const key = `${sc.file}\u0000${sc.outcome}\u0000${why}`;
    const cur = byKey.get(key);
    if (cur) cur.count++;
    else byKey.set(key, { file: sc.file.replace(/^scenarios\//, ''), outcome: sc.outcome, count: 1, why });
  }
  return [...byKey.values()];
}

/**
 * The runner's record of a passing run for exactly this candidate build (`buildSha256`) and these previous releases, or
 * null. A broken-candidate self-test (`breakCandidate`) never counts.
 */
export function reusableUpgradeGates(
  file: string,
  buildSha256: string,
  previous: string[],
): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  let r: {
    ok?: boolean;
    buildSha256?: string;
    breakCandidate?: unknown;
    previous?: { releaseId?: string }[];
    gates?: { ok?: boolean }[];
  };
  try {
    r = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const prev = (r.previous ?? []).map((p) => p.releaseId);
  if (r.ok !== true || r.breakCandidate || r.buildSha256 !== buildSha256) return null;
  if (prev.join() !== previous.join() || !r.gates?.length || !r.gates.every((g) => g.ok === true))
    return null;
  return r as Record<string, unknown>;
}

/**
 * The command that runs the VM upgrade gates, and its arguments.
 *
 * It is `release/upgrade-gates` of this tree, here. A machine that must not run VMs (a development machine that
 * shares its memory) names another command in `WB_UPGRADE_GATES_RUN`: its words, then the runner's own arguments
 * (`--candidate <build.json>`, a `--previous <build.json>` each, `--out <file>`). That command runs the same runner
 * on a machine that may, from the commit checked out here (it is started in the appliance's folder), and leaves the
 * runner's record at `--out`, unchanged apart from where its logs are. It never gets `--no-lock`: the heavy lock this
 * run holds is this machine's, and the other machine's runner takes its own.
 */
export function upgradeGatesCommand(
  runner: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[]; elsewhere: boolean } {
  const [cmd, ...first] = (env.WB_UPGRADE_GATES_RUN ?? '').trim().split(/\s+/).filter(Boolean);
  if (!cmd) return { cmd: runner, args, elsewhere: false };
  return { cmd, args: [...first, ...args.filter((a) => a !== '--no-lock')], elsewhere: true };
}

/** What a validate run leaves out, worded as gates.json's notes word it (so a record's skips can be compared). */
export function skipNotes(a: Pick<ValidateArgs, 'skipGates' | 'scenarios' | 'demo'>): string[] {
  return [
    ...(a.skipGates ? ['repository gates skipped (--skip-gates)'] : []),
    ...(a.scenarios ? [`scenarios limited to ${a.scenarios}`] : []),
    ...(a.demo ? [] : ['demo skipped (--no-demo)']),
  ];
}

/**
 * Whether a gates.json can stand for this validate run (a rerun after an upgrade gate failed shouldn’t repeat hours
 * of scenarios and the demo): it passed, it follows exactly this build.json (`buildSha256`), the harness ran the same
 * pins (the file, and its sha256 when recorded; the build fixes the file's content, validate checks that), and it
 * skipped nothing this run wants.
 */
export function reusableGates(
  rec: { record: ChainedRecord & Record<string, unknown>; sha256: string } | null,
  want: { buildSha256: string; pins: string; pinsSha256: string; skips: string[] },
): { reuse: true } | { reuse: false; why: string } {
  if (!rec) return { reuse: false, why: 'no gates.json' };
  const r = rec.record;
  const c = r.chain;
  if (c?.stage !== 'gates' || c.ok !== true) return { reuse: false, why: 'it did not pass' };
  if (c.after?.stage !== 'build' || c.after.sha256 !== want.buildSha256)
    return { reuse: false, why: 'it follows another build.json' };
  if (r.pins !== want.pins) return { reuse: false, why: `it ran ${String(r.pins)}, not ${want.pins}` };
  if (typeof r.pinsSha256 === 'string' && r.pinsSha256 !== want.pinsSha256)
    return { reuse: false, why: `${want.pins} changed since` };
  const missing = c.notes.filter((n) => !want.skips.includes(n));
  if (missing.length) return { reuse: false, why: `it left out what this run wants: ${missing.join('; ')}` };
  return { reuse: true };
}

type UgPlan =
  | { kind: 'skip' }
  | { kind: 'reuse'; reusable: Record<string, unknown>; out: string; uLog: string }
  | { kind: 'run'; runner: string; candidate: string; prevBuilds: string[]; out: string; uLog: string };

export async function validate(ctx: ShipContext, a: ValidateArgs): Promise<{ ok: boolean; detail: string }> {
  const prod = prodId(a.prodId);
  const dir = join(ctx.root, prod.id);
  const chain = verifyChain(dir, prod.id, 'build');
  const buildRec = chain[0]?.record as ChainedRecord & {
    source: { rev: string };
    ship: { candidate: { file: string; name: string }; twin: { releaseId: string; dir: string } };
  };
  const twin = buildRec.chain.twin;
  // The product is the build's pins (the gates and scenarios build their commits) and, for the VM gates, the build's
  // own source: HEAD may be a later harness, but not other pins.
  const rev = await git(ctx.repo, ['rev-parse', 'HEAD']);
  const pinned = pinsOfBuild({ repo: ctx.repo, dir, build: buildRec, cloud: a.cloud ?? null });
  say(`pins: ${pinned.from}`);
  if (rev !== buildRec.source.rev)
    say(
      `the harness is ${rev.slice(0, 12)}, the build ${buildRec.source.rev.slice(0, 12)}: the pins are the build's`,
    );
  const logDir = join(ctx.logDir, prod.id);
  mkdirSync(logDir, { recursive: true });
  const env = { WB_MGD_PINS: pinned.file };
  // `join` leaves an absolute path as it is only when it comes first: the pins may be in the release's folder.
  const pinsSha256 = sha256Hex(
    readFileSync(pinned.file.startsWith('/') ? pinned.file : join(ctx.repo, pinned.file)),
  );
  const previous = await previousReleases(ctx, a.previous);

  // 1–3 run again only when no passing gates.json stands for this build (a rerun after an upgrade gate failed).
  type GatesRecord = { record: ChainedRecord & Record<string, unknown>; sha256: string };
  let existing: GatesRecord | null = null;
  try {
    existing = readRecord(dir, 'gates') as GatesRecord | null;
  } catch {
    existing = null; // unreadable: run the gates again
  }
  const reuse = a.rerunGates
    ? ({ reuse: false, why: '--rerun-gates' } as const)
    : reusableGates(existing, {
        buildSha256: chain[0]?.sha256 ?? '',
        pins: env.WB_MGD_PINS,
        pinsSha256,
        skips: skipNotes(a),
      });
  let gatesFailure = '';
  const needGates = !(reuse.reuse && existing);
  if (!needGates && existing)
    say(
      `gates: reusing the passing run of ${existing.record.chain.at} for this build (gates.json ${existing.sha256.slice(0, 12)}); --rerun-gates runs them again`,
    );
  else if (existing && !reuse.reuse)
    say(`gates: not reusing gates.json ${existing.sha256.slice(0, 12)} (${reuse.why})`);
  const ugPlan = planUpgradeGates();

  // Side by side unless --serial (IN-116): the VM upgrade gates next to the scenarios, and the live-agent environment
  // next to the scripted one's harness/validate → demo, all under one hold of the heavy lock (the runner gets
  // --no-lock). --serial runs them one after the other, each taking the lock itself.
  const parallel = !a.serial && (needGates || ugPlan.kind === 'run');
  if (parallel)
    say(
      `running side by side: ${[needGates ? ['harness/validate', a.demo ? 'demo' : null].filter(Boolean).join(' → ') : null, needGates && selectsLive(a.scenarios) ? 'the live-agent environment' : null, ugPlan.kind === 'run' ? 'the VM upgrade gates' : null].filter(Boolean).join(' ∥ ')} (--serial runs them one after the other)`,
    );
  const held = parallel ? await holdHeavy(ctx) : null;
  let gatesOk = true;
  let ugResult: { ok: boolean; ug: Record<string, unknown>; notes: string[] };
  try {
    const g = held?.ctx ?? ctx;
    if (parallel)
      [gatesOk, ugResult] = await together(
        () => (needGates ? runGates(g, true) : Promise.resolve(true)),
        () => labelled('vm gates', () => runUpgradeGates(g, ugPlan, true)),
      );
    else {
      if (needGates) gatesOk = await runGates(g, false);
      ugResult = await runUpgradeGates(g, ugPlan, false);
    }
  } finally {
    await held?.release();
  }

  async function runGates(g: ShipContext, side: boolean): Promise<boolean> {
    const notes = skipNotes(a);
    // 1. harness/validate with the candidate's pins, in the caller's (scripted) environment.
    const stepValidate = async () => {
      const vArgs = ['--jobs', String(a.jobs)];
      if (a.serial) vArgs.push('--scenario-jobs', '1');
      if (a.rerunGates) vArgs.push('--no-gate-cache');
      if (a.skipGates) vArgs.push('--skip-gates');
      if (a.scenarios) vArgs.push('--scenarios', a.scenarios);
      const vLog = join(logDir, 'harness-validate.log');
      say(`harness/validate ${vArgs.join(' ')} (WB_MGD_PINS=${env.WB_MGD_PINS}); log ${vLog}`);
      const v = await heavy(g, join(HARNESS_DIR, 'validate'), vArgs, {
        cwd: ctx.repo,
        env,
        logFile: vLog,
        timeoutMs: 8 * 3_600_000,
      });
      // The caller's environment runs the scripted Hermes: the live-agent scenarios are blocked there by design and
      // run in an environment of their own (IN-108).
      const { file: reportJson, report } = readReport(`${v.stderr}\n${v.stdout}`);
      const validation = {
        ok: okApartFrom(report, LIVE_SCENARIOS),
        exitCode: v.code,
        report: reportJson ? relative(ctx.repo, reportJson) : null,
        reportSha256: reportJson && existsSync(reportJson) ? sha256Hex(readFileSync(reportJson)) : null,
        totals: report?.totals ?? {},
        manifest: report?.manifest ?? null,
        notPassed: scenariosNotPassed(report, LIVE_SCENARIOS),
        liveScenariosHere: 'run in the live environment',
        log: vLog,
      };
      say(`harness/validate: ${validation.ok ? 'ok' : 'FAILED'} ${JSON.stringify(validation.totals)}`);
      for (const n of validation.notPassed) say(`  ${n.count} ${n.outcome} in ${n.file}: ${n.why}`);
      return validation;
    };

    // 1b. The live-agent scenarios, alone, in a fresh environment with WB_MGD_AGENTS=live (ports +400).
    const stepLive = async (): Promise<Record<string, unknown> & { ok?: boolean }> => {
      if (!selectsLive(a.scenarios)) return { skipped: `--scenarios ${a.scenarios ?? ''}` };
      const r = await runLive(g, { pinsFile: env.WB_MGD_PINS, logDir });
      const { file, report: lr } = readReport(r.output);
      const live = {
        ok: passedOnly(lr, LIVE_SCENARIOS),
        exitCode: r.exitCode,
        report: file ? relative(ctx.repo, file) : null,
        reportSha256: file && existsSync(file) ? sha256Hex(readFileSync(file)) : null,
        totals: lr?.totals ?? {},
        notPassed: scenariosNotPassed(lr),
        env: r.env,
        log: r.log,
      };
      say(`live agents: ${live.ok ? 'ok' : 'FAILED'} ${JSON.stringify(live.totals)}`);
      for (const n of live.notPassed) say(`  ${n.count} ${n.outcome} in ${n.file}: ${n.why}`);
      return live;
    };

    // 2. The acceptance demo (the scripted environment, after harness/validate).
    const stepDemo = async (): Promise<Record<string, unknown>> => {
      if (!a.demo) return { skipped: '--no-demo' };
      const dLog = join(logDir, 'harness-demo.log');
      say(`harness/demo; log ${dLog}`);
      const d = await heavy(g, join(HARNESS_DIR, 'demo'), [], {
        cwd: ctx.repo,
        env,
        logFile: dLog,
        timeoutMs: 3 * 3_600_000,
      });
      const latest = join(HARNESS_DIR, 'reports', 'latest-demo.json');
      const fresh = existsSync(latest) && statSync(latest).mtimeMs > Date.now() - 3 * 3_600_000;
      say(`harness/demo: ${d.code === 0 ? 'ok' : 'FAILED'}`);
      return {
        ok: d.code === 0,
        exitCode: d.code,
        report: fresh ? relative(ctx.repo, latest) : null,
        reportSha256: fresh ? sha256Hex(readFileSync(latest)) : null,
        log: dLog,
      };
    };

    let validation: Awaited<ReturnType<typeof stepValidate>>;
    let live: Awaited<ReturnType<typeof stepLive>>;
    let demo: Awaited<ReturnType<typeof stepDemo>>;
    if (side) {
      let scripted: { validation: typeof validation; demo: typeof demo };
      [scripted, live] = await together(
        () =>
          labelled('scenarios', async () => {
            const v = await stepValidate();
            return { validation: v, demo: await stepDemo() };
          }),
        () => labelled('live', stepLive),
      );
      ({ validation, demo } = scripted);
    } else {
      validation = await stepValidate();
      live = await stepLive();
      demo = await stepDemo();
    }

    const liveOk = !('ok' in live) || live.ok === true;
    const ok = validation.ok && liveOk && (!('ok' in demo) || demo.ok === true);
    const livePassed = (live.notPassed ?? []) as ReturnType<typeof scenariosNotPassed>;
    const failed = [
      ...(validation.ok
        ? []
        : [
            `harness/validate failed${validation.notPassed.length ? ` (${validation.notPassed.map((n) => `${n.count} ${n.outcome} in ${n.file}: ${n.why}`).join('; ')})` : ''}`,
          ]),
      ...(liveOk
        ? []
        : [
            `the live-agent scenarios failed${livePassed.length ? ` (${livePassed.map((n) => `${n.count} ${n.outcome} in ${n.file}: ${n.why}`).join('; ')})` : ''}`,
          ]),
      ...('ok' in demo && demo.ok !== true ? ['the demo failed'] : []),
    ];
    const gates: ChainedRecord = {
      chain: nextChain(dir, prod.id, 'gates', {
        twin,
        ok,
        complete: notes.length === 0,
        notes: [...failed, ...notes],
      }),
      v: 1,
      commit: rev,
      pins: env.WB_MGD_PINS,
      pinsSha256,
      validate: validation,
      live,
      demo,
    };
    const gatesSha = writeRecord(dir, 'gates', gates);
    say(`gates.json ${gatesSha.slice(0, 12)}: ${ok ? 'ok' : `FAILED (${failed.join('; ')})`}`);
    gatesFailure = failed.join('; ');
    if (!ok) process.exitCode = 1;
    return ok;
  }

  // 4. The upgrade gates in VMs (agent G's runner), N−1 and N−2 → the candidate: what to do, checked before anything
  // runs (a missing runner or previous build refuses at once, not after the scenarios).
  function planUpgradeGates(): UgPlan {
    if (!a.upgradeGates) return { kind: 'skip' };
    const runner = join(ctx.repo, 'release', 'upgrade-gates');
    if (!existsSync(runner))
      throw new Error(
        'release/upgrade-gates is not in this tree (UP-C2, agent G): merge it, or --skip-upgrade-gates for a DEV-only run',
      );
    const prevBuilds = previous.ids.map((id) => {
      const b = findBuild(ctx, id);
      if (!b)
        throw new Error(
          `${id}: no build.json in ${ctx.searchRoots.join(', ')} (the upgrade gates build it from its source)`,
        );
      return join(b.dir, 'build.json');
    });
    const candidate =
      buildRec.ship && !('devOnly' in buildRec && buildRec.devOnly)
        ? join(dir, 'build.json')
        : join(buildRec.ship.twin.dir, 'build.json');
    const out = join(logDir, 'upgrade-gates.runner.json');
    const uLog = join(logDir, 'upgrade-gates.log');
    // A validate run again (e.g. after a demo fix) keeps a passing run of the same build and previous releases: the
    // VMs take most of an hour, and nothing they test changed (`--rerun-upgrade-gates` runs them anyway).
    const reusable = a.rerunUpgradeGates
      ? null
      : reusableUpgradeGates(out, sha256Hex(readFileSync(candidate)), previous.ids);
    if (reusable) return { kind: 'reuse', reusable, out, uLog };
    return { kind: 'run', runner, candidate, prevBuilds, out, uLog };
  }

  async function runUpgradeGates(
    g: ShipContext,
    plan: UgPlan,
    lockHeld: boolean,
  ): Promise<{ ok: boolean; ug: Record<string, unknown>; notes: string[] }> {
    if (plan.kind === 'skip')
      return {
        ok: true,
        ug: { skipped: '--skip-upgrade-gates' },
        notes: ['upgrade gates skipped (--skip-upgrade-gates)'],
      };
    if (plan.kind === 'reuse') {
      say(
        `upgrade gates: reusing the passing run of ${String(plan.reusable.at)} for this build (${plan.out}); --rerun-upgrade-gates runs them again`,
      );
      return {
        ok: true,
        ug: { runner: plan.reusable, reused: true, exitCode: 0, log: plan.uLog, previousFrom: previous.from },
        notes: [],
      };
    }
    // Alone (--serial), not under `heavy()`: the runner takes the heavy lock for its builds and each batch of gates and
    // gives it back in between (NX-110). Side by side, this process holds the lock for everything: --no-lock.
    const gates = upgradeGatesCommand(plan.runner, [
      '--candidate',
      plan.candidate,
      ...plan.prevBuilds.flatMap((p) => ['--previous', p]),
      '--out',
      plan.out,
      ...(lockHeld && g.heavyHeld ? ['--no-lock'] : []),
    ]);
    say(
      `release/upgrade-gates${gates.elsewhere ? ` through ${gates.cmd} (WB_UPGRADE_GATES_RUN)` : ''} (previous ${previous.ids.join(', ')} from ${previous.from}); log ${plan.uLog}`,
    );
    // A record left by an earlier run must not stand for this one when the command dies before it writes its own.
    rmSync(plan.out, { force: true });
    const u = await run(gates.cmd, gates.args, {
      cwd: ctx.repo,
      env: { WB_HEAVY_LOCK: ctx.heavyLock },
      logFile: plan.uLog,
      timeoutMs: 8 * 3_600_000,
    });
    const res = existsSync(plan.out)
      ? (JSON.parse(readFileSync(plan.out, 'utf8')) as Record<string, unknown>)
      : null;
    // The record must be of this very build, wherever the gates ran.
    const ofThisBuild = res?.buildSha256 === sha256Hex(readFileSync(plan.candidate));
    const ok = u.code === 0 && res?.ok === true && ofThisBuild;
    say(`upgrade gates: ${ok ? 'ok' : 'FAILED'}`);
    return {
      ok,
      ug: { runner: res, exitCode: u.code, log: plan.uLog, previousFrom: previous.from },
      notes: ok
        ? []
        : [
            `the upgrade gates failed (exit ${u.code}${res ? (ofThisBuild ? '' : ', a record of another build') : ', no record'})`,
          ],
    };
  }

  if (!gatesOk) {
    say(
      `upgrade-gates.json not written: gates.json failed${ugResult.ok && ugPlan.kind === 'run' ? ' (the upgrade gates passed; a rerun of this build reuses them)' : ''}`,
    );
    return { ok: false, detail: `gates.json failed: ${gatesFailure || 'see the record'}` };
  }
  const record: ChainedRecord = {
    chain: nextChain(dir, prod.id, 'upgrade-gates', {
      twin,
      ok: ugResult.ok,
      complete: a.upgradeGates,
      notes: ugResult.notes,
    }),
    v: 1,
    previous: previous.ids,
    ...ugResult.ug,
  };
  const sha = writeRecord(dir, 'upgrade-gates', record);
  say(`upgrade-gates.json ${sha.slice(0, 12)}: ${ugResult.ok ? 'ok' : 'FAILED'}`);
  if (!ugResult.ok) process.exitCode = 1;
  return {
    ok: ugResult.ok,
    detail: ugResult.ok
      ? `upgrade-gates.json ${sha.slice(0, 12)}`
      : `upgrade-gates.json failed: ${ugResult.notes.join('; ')}`,
  };
}
