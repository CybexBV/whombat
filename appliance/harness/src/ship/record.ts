/**
 * The release record control keeps next to a tuple (UP-X02, contracts 0.22.0 `ReleaseRecord`, CT-139): the notes,
 * the migrations, the gates' records by digest, what it was built from — always with the contracts release the runtime
 * vendors (`builtFrom.contracts`: control lets a hosted web or embed build out only with the contracts major of every
 * live box's release, IN-420); no API level or features (IN-413). Not signed (the tuple is); control serves it to the
 * admin panel, the fleet check and the owner's “what changed”.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeUpdateFailure } from '@whombat/release';
import { expandHome } from '../lib/paths.ts';
import { run } from '../lib/proc.ts';
import type { ReleaseNotes } from './notes.ts';
import type { ChainedRecord, Stage } from './records.ts';

export interface GateSummary {
  ok: boolean;
  at: number;
  sha256: string;
  summary: string;
}

export interface ReleaseRecord {
  notes?: { summary: string; markdown: string };
  migrations?: { tag: string; class: string; readers: number; writers: number; version: number }[];
  twin?: string;
  env?: 'dev' | 'prod';
  gates?: Partial<Record<'build' | 'validate' | 'upgradeGates' | 'devSoak', GateSummary>>;
  builtFrom: BuiltFrom;
  knownIssues?: string[];
}

const GATE_KEY: Partial<Record<Stage, keyof NonNullable<ReleaseRecord['gates']>>> = {
  build: 'build',
  gates: 'validate',
  'upgrade-gates': 'upgradeGates',
  'dev-soak': 'devSoak',
};

export function gateSummary(stage: Stage, record: ChainedRecord, sha256: string): GateSummary {
  const c = record.chain;
  const what = c.ok ? (c.complete ? 'passed' : 'passed, partly skipped') : 'failed';
  const summary = `${stage}: ${what}${c.notes.length ? ` (${c.notes.join('; ')})` : ''}`;
  return {
    ok: c.ok,
    at: Math.floor(Date.parse(c.at) / 1000),
    sha256,
    summary: summary.length > 500 ? `${summary.slice(0, 497)}…` : summary,
  };
}

/** What a release was built from; `contracts` is the contracts release its runtime vendors, never left out (IN-420). */
export interface BuiltFrom {
  appliance: string;
  whombat?: string;
  app?: string;
  contracts: string;
}

/**
 * The contracts a Whombat commit is built with: its own packages/core's version, or before the contracts moved into
 * Whombat the `@whombat/core` tarball its root `package.json` depends on
 * (`file:vendor/whombat-contracts/<v>/whombat-core-<v>.tgz`), read from the Whombat checkout. Throws when it can't be
 * read: a release record names its contracts or isn't written.
 */
export async function runtimeContractsAt(whombatSrc: string, rev: string): Promise<string> {
  const fail = (why: string) =>
    new Error(
      `can't read the contracts the runtime ${rev.slice(0, 12)} vendors (${why}); a release record must name them (IN-420)`,
    );
  if (!existsSync(whombatSrc)) throw fail(`no Whombat checkout at ${whombatSrc}`);
  const r = await run('git', ['-C', whombatSrc, 'show', `${rev}:package.json`], { cwd: whombatSrc });
  if (r.code !== 0) throw fail(`${rev.slice(0, 12)}:package.json is not in ${whombatSrc}`);
  let spec = '';
  try {
    spec =
      (JSON.parse(r.stdout) as { dependencies?: Record<string, string> }).dependencies?.['@whombat/core'] ??
      '';
  } catch {
    throw fail('its package.json is not JSON');
  }
  const v = /whombat-core-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(spec)?.[1];
  if (v) return v;
  // Whombat holds the contracts since whombat-contracts moved into it: the runtime is built with its own packages/core.
  const core = await run('git', ['-C', whombatSrc, 'show', `${rev}:packages/core/package.json`], {
    cwd: whombatSrc,
  });
  const own =
    core.code === 0
      ? /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
          (JSON.parse(core.stdout) as { version?: string }).version ?? '',
        )?.[1]
      : undefined;
  if (own) return own;
  throw fail(
    `its package.json's @whombat/core is ${spec ? `“${spec}”` : 'missing'}, not a vendored tarball, and it has no packages/core`,
  );
}

/** The Whombat checkout a candidate pins file names for the runtime (`whombat-runtime`'s `source`). */
export function whombatSourceOf(pinsFile: string): string {
  const pins = JSON.parse(readFileSync(pinsFile, 'utf8')) as {
    components: { id: string; source?: string }[];
  };
  return expandHome(pins.components.find((x) => x.id === 'whombat-runtime')?.source ?? '~/Code/Whombat');
}

/**
 * `builtFrom` of a ship build: the appliance and Whombat commits, the app the candidate pins and the contracts the
 * runtime vendors (`ship.contracts`, recorded by `release/ship build`; read from the Whombat checkout the pins name for
 * builds from before it).
 */
export async function builtFromOf(
  repo: string,
  build: {
    source: { rev: string };
    runtime: { whombatRev: string };
    ship: { candidate: { file: string }; contracts?: string; app?: string };
  },
): Promise<BuiltFrom> {
  // A build from the one repository names no pins file: the release is its commit, the runtime the commit of its
  // stamp, and the build recorded the app's and the contracts' versions itself.
  if (!build.ship.candidate.file) {
    if (!build.ship.contracts)
      throw new Error('the build records no contracts version (ship.contracts, IN-420)');
    return {
      appliance: build.source.rev,
      whombat: build.runtime.whombatRev,
      ...(build.ship.app ? { app: build.ship.app } : {}),
      contracts: build.ship.contracts,
    };
  }
  const pinsFile = join(repo, build.ship.candidate.file);
  const pins = JSON.parse(readFileSync(pinsFile, 'utf8')) as {
    components: { id: string; tag?: string; version?: string }[];
  };
  const app = pins.components.find((x) => x.id === 'whombat-app');
  const label = app ? (app.tag ?? app.version) : undefined;
  return {
    appliance: build.source.rev,
    whombat: build.runtime.whombatRev,
    ...(label ? { app: label } : {}),
    contracts:
      build.ship.contracts ?? (await runtimeContractsAt(whombatSourceOf(pinsFile), build.runtime.whombatRev)),
  };
}

export function releaseRecord(o: {
  env: 'dev' | 'prod';
  twin: string | null;
  notesDir: string;
  chain: { stage: Stage; record: ChainedRecord; sha256: string }[];
  builtFrom: BuiltFrom;
  /** Extra known issues (a promotion without validation names itself here, IN-158). */
  knownIssues?: string[];
}): ReleaseRecord {
  const notes = JSON.parse(readFileSync(join(o.notesDir, 'notes.json'), 'utf8')) as ReleaseNotes;
  const markdown = readFileSync(join(o.notesDir, 'notes.md'), 'utf8');
  const gates: NonNullable<ReleaseRecord['gates']> = {};
  for (const c of o.chain) {
    const key = GATE_KEY[c.stage];
    if (key) gates[key] = gateSummary(c.stage, c.record, c.sha256);
  }
  return {
    notes: {
      summary: notes.summary,
      markdown: markdown.length > 20_000 ? `${markdown.slice(0, 19_990)}\n…\n` : markdown,
    },
    migrations: notes.migrations.slice(0, 1000).map((m) => ({
      tag: m.tag.slice(0, 80),
      class: m.class.slice(0, 16),
      readers: m.readers,
      writers: m.writers,
      version: m.version,
    })),
    ...(o.twin ? { twin: o.twin } : {}),
    env: o.env,
    gates,
    builtFrom: o.builtFrom,
    knownIssues: [...(o.knownIssues ?? []), ...notes.knownIssues].slice(0, 20).map((k) => k.slice(0, 300)),
  };
}

/**
 * What a device's failure says: the contracts' rendering of the structured detail (`describeUpdateFailure`, CT-137),
 * the sentence the admin panel and the owner see; the fields themselves when it can't render them; the bare code when
 * control or the manager is older than the detail.
 */
export function describeFailure(d: {
  failure?: string | null;
  failureDetail?: Record<string, unknown> | null;
}): string {
  const fd = d.failureDetail;
  if (!fd) return d.failure ? `failure ${d.failure}` : 'no failure reported';
  try {
    return describeUpdateFailure(fd as unknown as Parameters<typeof describeUpdateFailure>[0]);
  } catch {
    // not the shape this contracts release renders: list the fields
  }
  const parts = [`${String(fd.code ?? d.failure ?? 'failure')} at ${String(fd.stage ?? '?')}`];
  if (Array.isArray(fd.reasons) && fd.reasons.length) parts.push(`reasons ${fd.reasons.join(', ')}`);
  const schema = fd.schema as
    | { database?: number; target?: number | null; candidateWrites?: number }
    | undefined;
  if (schema)
    parts.push(
      `database ${schema.database}, candidate writes ${schema.candidateWrites}, target ${schema.target ?? '—'}`,
    );
  if (Array.isArray(fd.failedChecks) && fd.failedChecks.length)
    parts.push(`failed checks ${fd.failedChecks.join(', ')}`);
  if (fd.rollbackAccess) parts.push(`rollback ${String(fd.rollbackAccess)}`);
  return parts.join('; ');
}

/** A paused rollout's detail in words: the device and its rendered failure. */
export function describePause(r: {
  pauseReason?: string | null;
  pauseDetail?: {
    device?: string | null;
    reason?: string;
    failureDetail?: Record<string, unknown> | null;
  } | null;
}): string {
  const d = r.pauseDetail;
  const what = r.pauseReason ?? d?.reason ?? 'no reason';
  if (!d?.device) return what;
  return `${what}: ${d.device}${d.failureDetail ? ` — ${describeFailure({ failureDetail: d.failureDetail })}` : ''}`;
}
