/**
 * The installer ISO on demand (UP-X15). `release/ship build` builds none; the ISO of a host build is made by
 * `release/build iso <dir>` (from the build's source rev, its system checked to be the build's host) when
 * something needs it: whombat-ops `promote` before it puts the installer on the download site (ONE-15),
 * `release/ship iso <id>` by hand.
 *
 * Where a release's ISO is: `iso.json` (UP-X15), else `build.json`'s `iso` (builds before it); the file in `iso/`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBuild } from './build.ts';
import { buildScript, heavy, type ShipContext, say } from './context.ts';
import { prodId } from './ids.ts';

export interface IsoInfo {
  file: string;
  /** The ISO file. */
  path: string;
  sha256: string;
  size: number;
  storePath: string;
  from: 'iso.json' | 'build.json';
}

type IsoFields = { file?: string; sha256?: string; size?: number; storePath?: string } | null | undefined;

/** A release directory's ISO: iso.json first, then build.json's `iso` (older builds); null without one. */
export function isoInfo(dir: string): IsoInfo | null {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
  const of = (x: IsoFields, from: IsoInfo['from']): IsoInfo | null =>
    x?.file
      ? {
          file: x.file,
          path: join(dir, 'iso', x.file),
          sha256: x.sha256 ?? '',
          size: x.size ?? 0,
          storePath: x.storePath ?? '',
          from,
        }
      : null;
  if (existsSync(join(dir, 'iso.json'))) return of(read('iso.json') as IsoFields, 'iso.json');
  if (existsSync(join(dir, 'build.json'))) return of(read('build.json').iso as IsoFields, 'build.json');
  return null;
}

/** The ISO of the host build in `dir`, built under the heavy lock when it has none yet. */
export async function ensureIso(ctx: ShipContext, dir: string, log: string): Promise<IsoInfo> {
  const have = isoInfo(dir);
  if (have) return have;
  say(`building the installer ISO of ${dir} under ${ctx.heavyLock}; log ${log}`);
  const r = await heavy(ctx, buildScript(ctx.repo), ['iso', dir], {
    cwd: ctx.repo,
    logFile: log,
    timeoutMs: 4 * 3_600_000,
  });
  if (r.code !== 0) throw new Error(`release/build iso ${dir} failed (${r.code}); see ${log}`);
  const got = isoInfo(dir);
  if (!got) throw new Error(`release/build iso ${dir} wrote no iso.json`);
  return got;
}

/** The build whose host a release runs: itself for a host release, else its host's build (runtime-only). */
export function hostBuildOf(
  ctx: ShipContext,
  b: { dir: string; build: Record<string, unknown> },
): { dir: string; id: string } {
  const id = b.build.releaseId as string;
  if (b.build.class === 'host') return { dir: b.dir, id };
  const host = (b.build.tuple as { host?: { version?: string } } | undefined)?.host?.version;
  if (!host) throw new Error(`${id} names no host release`);
  const h = findBuild(ctx, host);
  if (!h) throw new Error(`${id} runs the host of ${host}, which has no build.json here`);
  say(`${id} is runtime-only: the ISO is its host's, ${host}`);
  return { dir: h.dir, id: host };
}

/** `release/ship iso <id>`: the ISO of the build (its host's, for a runtime-only release). */
export async function shipIso(ctx: ShipContext, a: { prodId: string }): Promise<IsoInfo> {
  const prod = prodId(a.prodId);
  const b = findBuild(ctx, prod.id);
  if (!b) throw new Error(`${prod.id}: no build.json in ${ctx.searchRoots.join(', ')}`);
  if (b.build.devOnly || !b.build.tuple)
    throw new Error(`${prod.id} was built DEV-only: it has no release build`);
  const t = hostBuildOf(ctx, b);
  const iso = await ensureIso(ctx, t.dir, join(ctx.logDir, prod.id, `iso-${t.id}.log`));
  say(`${t.id}: ${iso.path} (sha256 ${iso.sha256.slice(0, 12)})`);
  process.stdout.write(
    `${JSON.stringify({ releaseId: t.id, iso: iso.path, sha256: iso.sha256, size: iso.size })}\n`,
  );
  return iso;
}
