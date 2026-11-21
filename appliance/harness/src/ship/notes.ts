/**
 * Release notes (UP-C3, IN-97): `notes.json` and `notes.md`, written by `release/ship build` next to the release and
 * its DEV twin. Per component the commits since the previous release of the environment (the appliance's `source.rev`,
 * the Whombat pin; contracts and app versions from the candidate pins), the migrations since the previous release's
 * schema with class and floors from the bundle's `migrations/compat.json`, and the known issues given at build time.
 * Nothing about clients: they share the box's contracts major (Whombat HE-52, IN-413).
 *
 * `summary` (≤ 500 characters) is what control keeps as `record.notes.summary` (UP-X02) and the owner sees under
 * “Updated to …”.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../lib/proc.ts';
import { fileAt, findSource, topOf, whereIs } from '../lib/source.ts';

export interface Commit {
  rev: string;
  subject: string;
}

export interface ComponentNotes {
  id: string;
  /** Commit or version before and now; null before: no previous release. */
  from: string | null;
  to: string;
  commits: Commit[];
  /** Commits left out of `commits` (the list keeps the newest 200). */
  more: number;
  /** Why the commit list is empty or partial (range unknown, repository not found). */
  note?: string;
}

export interface MigrationNote {
  tag: string;
  /** Journal position (the schema version it brings the database to). */
  version: number;
  class: string;
  readers: number;
  writers: number;
  note?: string;
}

export interface ReleaseNotes {
  v: 1;
  releaseId: string;
  twin: string | null;
  class: 'host' | 'runtime';
  previous: string | null;
  summary: string;
  versions: {
    runtime: { from: string | null; to: string };
    manager: { from: string | null; to: string };
    host: { from: string | null; to: string };
  };
  components: ComponentNotes[];
  schema: { from: number | null; to: number };
  migrations: MigrationNote[];
  knownIssues: string[];
  generatedAt: string;
  /**
   * How the release is delivered (UP-X16): host or runtime-only and why (with the store paths compared). Set by
   * `release/ship build`. Every release carries closure indexes only (IN-414).
   */
  delivery?: Delivery;
}

export interface Delivery {
  host: {
    class: 'host' | 'runtime';
    reason: string;
    reusedFrom: string | null;
    compared?: { release: string; hostRelease: string; expected: string; evaluated: string | null };
  };
}

/** The bundle's compat.json (`{runtime, migrations: {tag: {class, readers, writers, note}}}`). */
export interface Compat {
  /** The version before the chain's first migration (Whombat report-trackers.md; absent: 0). */
  schemaBase?: number;
  runtime: { readsFrom: string; writesFrom: string };
  /** `legacy` migrations (before MD-01's model) have no floors: they read and write only their own schema. */
  migrations: Record<string, { class: string; readers?: string; writers?: string; note?: string }>;
}

/**
 * Schema versions are journal positions after the chain's `schemaBase` (MD-01; Whombat report-trackers.md): the n-th
 * migration in tag order brings the schema to base + n.
 */
export function migrationsAfter(compat: Compat, fromSchema: number | null): MigrationNote[] {
  const tags = Object.keys(compat.migrations).sort();
  const base = compat.schemaBase ?? 0;
  const pos = (tag: string) => {
    const i = tags.indexOf(tag);
    if (i < 0) throw new Error(`compat.json names ${tag}, which is not one of its migrations`);
    return base + i + 1;
  };
  return tags
    .map((tag, i) => ({ tag, version: base + i + 1 }))
    .filter((m) => fromSchema === null || m.version > fromSchema)
    .map(({ tag, version }) => {
      const c = compat.migrations[tag] as Compat['migrations'][string];
      return {
        tag,
        version,
        class: c.class,
        readers: c.readers ? pos(c.readers) : version,
        writers: c.writers ? pos(c.writers) : version,
        ...(c.note ? { note: c.note } : {}),
      };
    });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One or two sentences, ≤ 500 characters: what an owner and an operator read first. */
export function summarize(n: Omit<ReleaseNotes, 'summary' | 'generatedAt'>): string {
  const parts: string[] = [];
  const rt = n.versions.runtime;
  if (rt.from && rt.from !== rt.to) parts.push(`Whombat ${rt.to} (was ${rt.from})`);
  else parts.push(`Whombat ${rt.to}`);
  if (n.class === 'host') parts.push('a new system image (the box restarts once)');
  else parts.push('the runtime only (no restart of the box)');
  const m = n.migrations;
  if (m.length) {
    const needsCheckpoint = m.some((x) => x.class !== 'expand');
    parts.push(
      `${plural(m.length, 'database change')} (${[...new Set(m.map((x) => x.class))].join(', ')}${needsCheckpoint ? '; a backup checkpoint first' : ''})`,
    );
  } else parts.push('no database change');
  const changes = n.components.reduce((a, c) => a + c.commits.length + c.more, 0);
  let s = `${n.releaseId}: ${parts.join(', ')}. ${plural(changes, 'change')} since ${n.previous ?? 'the first release'}.`;
  if (n.knownIssues.length) s += ` Known issues: ${n.knownIssues.join(' ')}`;
  return s.length > 500 ? `${s.slice(0, 497)}…` : s;
}

export function renderMarkdown(n: ReleaseNotes): string {
  const out: string[] = [];
  const v = (x: { from: string | null; to: string }) =>
    x.from && x.from !== x.to ? `${x.from} → ${x.to}` : x.to;
  out.push(`# ${n.releaseId}${n.twin ? ` (DEV twin ${n.twin})` : ''}`, '', n.summary, '');
  out.push(`Since: ${n.previous ?? 'none (first release)'} · class: ${n.class}`, '');
  out.push('| Component | Version |', '|---|---|');
  out.push(`| runtime | ${v(n.versions.runtime)} |`);
  out.push(`| host | ${v(n.versions.host)} |`);
  out.push(`| manager | ${v(n.versions.manager)} |`, '');
  out.push(
    '## Database',
    '',
    `Schema ${n.schema.from ?? '?'} → ${n.schema.to}.${n.migrations.length ? '' : ' No migration.'}`,
    '',
  );
  if (n.migrations.length) {
    out.push('| Migration | Schema | Class | Readers ≥ | Writers ≥ |', '|---|---|---|---|---|');
    for (const m of n.migrations)
      out.push(`| ${m.tag} | ${m.version} | ${m.class} | ${m.readers} | ${m.writers} |`);
    out.push('');
  }
  out.push('## Changes', '');
  for (const c of n.components) {
    out.push(`### ${c.id} ${c.from ? `${c.from} → ${c.to}` : c.to}`, '');
    if (c.note) out.push(`_${c.note}_`, '');
    for (const x of c.commits) out.push(`- \`${x.rev}\` ${x.subject}`);
    if (c.more) out.push(`- … and ${c.more} more`);
    if (c.commits.length || c.more) out.push('');
  }
  if (n.delivery) {
    const d = n.delivery;
    out.push('## Delivery', '');
    out.push(
      `- ${d.host.class === 'host' ? 'Host release' : `Runtime-only, on the host of ${d.host.reusedFrom}`}: ${d.host.reason}`,
    );
    if (d.host.compared)
      out.push(
        `- Compared with ${d.host.compared.release} (host ${d.host.compared.hostRelease}): \`${d.host.compared.expected}\` and this commit's \`${d.host.compared.evaluated ?? 'not evaluated'}\``,
      );
    out.push('');
  }
  out.push('## Known issues', '');
  if (n.knownIssues.length) for (const k of n.knownIssues) out.push(`- ${k}`);
  else out.push('None recorded.');
  out.push('');
  return `${out.join('\n')}\n`;
}

/* Gathering ------------------------------------------------------------------------------------------------- */

const MAX_COMMITS = 200;

/** `git log from..to` (first parent: merges read as one change each), newest first; bounded. */
export async function commitsBetween(
  repo: string,
  from: string | null,
  to: string,
): Promise<Pick<ComponentNotes, 'commits' | 'more' | 'note'>> {
  if (!existsSync(repo)) return { commits: [], more: 0, note: `repository ${repo} not found here` };
  const has = async (rev: string) =>
    (await run('git', ['-C', repo, 'cat-file', '-e', `${rev}^{commit}`], { cwd: repo })).code === 0;
  if (!(await has(to))) return { commits: [], more: 0, note: `${to.slice(0, 12)} is not in ${repo}` };
  if (from && !(await has(from)))
    return { commits: [], more: 0, note: `${from.slice(0, 12)} is not in ${repo}: range unknown` };
  if (from && from === to) return { commits: [], more: 0, note: 'unchanged' };
  const range = from ? `${from}..${to}` : to;
  const r = await run('git', ['-C', repo, 'log', '--first-parent', '--format=%h%x09%s', range], {
    cwd: repo,
  });
  if (r.code !== 0) return { commits: [], more: 0, note: `git log ${range} failed` };
  const all = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [rev = '', ...s] = l.split('\t');
      return { rev, subject: s.join('\t').slice(0, 200) };
    });
  const note = from
    ? (await run('git', ['-C', repo, 'merge-base', '--is-ancestor', from, to], { cwd: repo })).code === 0
      ? undefined
      : `${from.slice(0, 12)} is not an ancestor of ${to.slice(0, 12)}: the list is what ${to.slice(0, 7)} has and ${from.slice(0, 7)} hasn't`
    : 'no previous release: every commit';
  return {
    commits: all.slice(0, MAX_COMMITS),
    more: Math.max(0, all.length - MAX_COMMITS),
    ...(note ? { note } : {}),
  };
}

/** The candidate pins a commit of the appliance names (`candidate = "…"` in nix/packages/runtime), parsed. */
export async function candidateAt(
  repo: string,
  rev: string,
): Promise<{ name: string; pins: CandidatePins } | null> {
  // The commit may be this checkout's or an archive's, with the appliance at its top or in a folder.
  const show = async (p: string) => fileAt(rev, p, { checkout: repo });
  const nix = await show('nix/packages/runtime/default.nix');
  const name = nix ? /\bcandidate = "([^"]+)";/.exec(nix)?.[1] : undefined;
  if (!name) return null;
  const text = await show(`manifest/candidates/${name}.json`);
  return text ? { name, pins: JSON.parse(text) as CandidatePins } : null;
}

export interface CandidatePins {
  productVersion: string;
  contracts: { version: string };
  components: { id: string; commit: string; version: string; tag?: string; source: string }[];
}

export interface BuildRecord {
  releaseId: string;
  class: 'host' | 'runtime';
  source: { rev: string };
  runtime: { whombatRev: string };
  tuple: {
    runtime: { version: string; storePath: string; schemaWrites: number };
    host: { version: string };
    manager: { version: string; storePath: string };
  };
}

export interface GatherInput {
  applianceRepo: string;
  current: BuildRecord;
  previous: BuildRecord | null;
  twin: string | null;
  knownIssues: string[];
  expandHome: (p: string) => string;
}

/**
 * The components of a release built from the one repository: one line of commits, this repository's, since the
 * previous release (its own commit, or for a release from before the move the Whombat commit its runtime was built
 * from; the appliance's and the hosts service's earlier commits are in their old repositories), and the contracts'
 * and the app's versions as each commit has them.
 */
async function oneRepositoryComponents(
  i: GatherInput,
  top: string,
  prevCand: { pins: CandidatePins } | null,
): Promise<ComponentNotes[]> {
  const { current: cur, previous: prev } = i;
  const versionAt = (rev: string, path: string): string | null => {
    try {
      return (
        (
          JSON.parse(execFileSync('git', ['-C', top, 'show', `${rev}:${path}`], { encoding: 'utf8' })) as {
            version?: string;
          }
        ).version ?? null
      );
    } catch {
      return null;
    }
  };
  const here = (rev: string) => whereIs(rev, { checkout: top }) === top;
  const prevRev = prev ? (here(prev.source.rev) ? prev.source.rev : prev.runtime.whombatRev) : null;
  const components: ComponentNotes[] = [
    {
      id: 'whombat',
      from: prevRev?.slice(0, 12) ?? null,
      to: cur.source.rev.slice(0, 12),
      ...(await commitsBetween(top, prevRev, cur.source.rev)),
    },
  ];
  for (const [id, path] of [
    ['whombat-contracts', 'packages/core/package.json'],
    ['whombat-app', 'apps/web/package.json'],
  ] as const) {
    const to = versionAt(cur.source.rev, path);
    if (!to) continue;
    const was = prevCand?.pins.components.find((c) => c.id === id);
    const from =
      prev && here(prev.source.rev) ? versionAt(prev.source.rev, path) : (was?.tag ?? was?.version ?? null);
    components.push({ id, from, to, commits: [], more: 0 });
  }
  return components;
}

export async function gatherNotes(i: GatherInput): Promise<ReleaseNotes> {
  const { current: cur, previous: prev } = i;
  const bundle = cur.tuple.runtime.storePath;
  const compat = JSON.parse(readFileSync(join(bundle, 'migrations', 'compat.json'), 'utf8')) as Compat;
  const curCand = await candidateAt(i.applianceRepo, cur.source.rev);
  const prevCand = prev ? await candidateAt(i.applianceRepo, prev.source.rev) : null;
  const comp = (pins: CandidatePins | undefined, id: string) => pins?.components.find((c) => c.id === id);
  const whombatSrc = i.expandHome(comp(curCand?.pins, 'whombat-runtime')?.source ?? '~/Code/Whombat');

  // A release from the one repository names no candidate pins: its commit says everything.
  const oneRepository = !curCand && findSource(cur.source.rev, { checkout: i.applianceRepo }).dir !== '';
  const components: ComponentNotes[] = oneRepository
    ? await oneRepositoryComponents(i, topOf(i.applianceRepo), prevCand)
    : [];
  if (!oneRepository)
    components.push({
      id: 'whombat-appliance',
      from: prev?.source.rev.slice(0, 12) ?? null,
      to: cur.source.rev.slice(0, 12),
      ...(await commitsBetween(
        whereIs(cur.source.rev, { checkout: i.applianceRepo }) ?? i.applianceRepo,
        prev?.source.rev ?? null,
        cur.source.rev,
      )),
    });
  if (!oneRepository)
    components.push({
      id: 'whombat-runtime',
      from: prev?.runtime.whombatRev.slice(0, 12) ?? null,
      to: cur.runtime.whombatRev.slice(0, 12),
      ...(await commitsBetween(whombatSrc, prev?.runtime.whombatRev ?? null, cur.runtime.whombatRev)),
    });
  for (const id of oneRepository ? [] : (['whombat-contracts', 'whombat-app'] as const)) {
    const c = comp(curCand?.pins, id);
    const p = comp(prevCand?.pins, id);
    if (!c) continue;
    const label = (x: typeof c) => x.tag ?? x.version;
    const from = p ? label(p) : null;
    const src = i.expandHome(c.source);
    components.push({
      id,
      from,
      to: label(c),
      ...(p ? await commitsBetween(src, p.commit, c.commit) : { commits: [], more: 0 }),
    });
  }

  // The hosts service (NX-152): its commits since the previous release's pin; none before a release that had one.
  const hosts = comp(curCand?.pins, 'whombat-hosts');
  if (hosts) {
    const p = comp(prevCand?.pins, 'whombat-hosts');
    components.push({
      id: 'whombat-hosts',
      from: p?.commit.slice(0, 12) ?? null,
      to: hosts.commit.slice(0, 12),
      ...(p
        ? await commitsBetween(i.expandHome(hosts.source), p.commit, hosts.commit)
        : { commits: [], more: 0, note: 'new in this release' }),
    });
  }

  const base = {
    v: 1 as const,
    releaseId: cur.releaseId,
    twin: i.twin,
    class: cur.class,
    previous: prev?.releaseId ?? null,
    versions: {
      runtime: { from: prev?.tuple.runtime.version ?? null, to: cur.tuple.runtime.version },
      manager: { from: prev?.tuple.manager.version ?? null, to: cur.tuple.manager.version },
      host: { from: prev?.tuple.host.version ?? null, to: cur.tuple.host.version },
    },
    components,
    schema: { from: prev?.tuple.runtime.schemaWrites ?? null, to: cur.tuple.runtime.schemaWrites },
    migrations: migrationsAfter(compat, prev?.tuple.runtime.schemaWrites ?? null),
    knownIssues: i.knownIssues,
  };
  return { ...base, summary: summarize(base), generatedAt: new Date().toISOString() };
}
