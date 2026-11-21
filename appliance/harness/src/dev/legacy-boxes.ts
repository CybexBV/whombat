/**
 * whombat-ops `legacy-boxes` — which Whombats still need the old Hetzner update repository (updates.whombat.com),
 * read-only (R2 B1; ONE-01). Production control's directory (`deploy.sh op GET /v1/operator/devices`) says each box's
 * last reported release; a box is on the old repository's layout when that release is one updates.whombat.com lists
 * and neither GitHub channel does (Beta or Production, releases.whombat.com), and unknown when it reports none or a
 * release neither lists. Retired boxes don't count. Exit 0: control knows no box on it; 1: the boxes that are (or can't
 * be told) are listed: each needs a release through the old repository, with its own keys, that moves it to GitHub
 * first. A hint, not the answer (R3 B1): a release both repositories list says nothing about which one a box trusts,
 * and a box control never saw isn't here; the repository stays until the pilot inventory is reconciled and 30 days
 * pass without a request (docs/runbooks/updates.md, “Production repository”).
 *
 *   legacy-boxes [--json]
 *
 * WB_DEPLOY_SH names deploy.sh, WB_UPDATES_URL the old repository (https://updates.whombat.com), WB_RELEASES_URL the
 * GitHub one.
 */
import { channelReleaseIds, prodOp, publishedReleaseIds, shipContext } from '../ship/context.ts';

export interface LegacyDevice {
  device: string;
  state: string;
  name?: string | null;
  lastSeenAt?: number | null;
  status?: { release?: string; managerVersion?: string } | null;
}

export interface LegacyVerdict {
  /** On the old repository's layout: their release is only there. */
  legacy: { device: string; name: string | null; release: string; managerVersion: string | null }[];
  /** Can't be told: no report, or a release neither repository lists. */
  unknown: { device: string; name: string | null; release: string | null }[];
  /** On the GitHub channels. */
  github: number;
}

/** Each box that isn't retired, by where its last reported release is listed. */
export function legacyBoxes(
  devices: readonly LegacyDevice[],
  hetzner: readonly string[],
  github: readonly string[],
): LegacyVerdict {
  const old = new Set(hetzner);
  const gh = new Set(github);
  const out: LegacyVerdict = { legacy: [], unknown: [], github: 0 };
  for (const d of devices) {
    if (d.state === 'retired') continue;
    const release = d.status?.release ?? null;
    if (release && gh.has(release)) out.github++;
    else if (release && old.has(release))
      out.legacy.push({
        device: d.device,
        name: d.name ?? null,
        release,
        managerVersion: d.status?.managerVersion ?? null,
      });
    else out.unknown.push({ device: d.device, name: d.name ?? null, release });
  }
  return out;
}

async function main(): Promise<number> {
  const json = process.argv.includes('--json');
  const ctx = shipContext();
  const answer = await prodOp<{ devices: LegacyDevice[] }>(ctx, 'GET', '/v1/operator/devices');
  if (!answer) throw new Error('this deploy.sh has no `op` command');
  const hetzner = await publishedReleaseIds(ctx.prod.updatesUrl);
  if (!hetzner) throw new Error(`${ctx.prod.updatesUrl} lists no releases (unreadable): nothing can be told`);
  const beta = await channelReleaseIds(ctx.prod.releasesUrl, 'development');
  const production = await channelReleaseIds(ctx.prod.releasesUrl, 'production');
  if (!beta || !production)
    throw new Error(`${ctx.prod.releasesUrl}'s channels are unreadable: nothing can be told`);
  const v = legacyBoxes(answer.devices, hetzner, [...beta, ...production]);
  if (json) process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  else {
    process.stdout.write(`${v.github} Whombat(s) on the GitHub channels\n`);
    for (const b of v.legacy)
      process.stdout.write(
        `on the old repository: ${b.name ?? '(no name)'} ${b.device} ${b.release} manager ${b.managerVersion ?? '?'}\n`,
      );
    for (const b of v.unknown)
      process.stdout.write(
        `can't be told: ${b.name ?? '(no name)'} ${b.device} ${b.release ?? 'no report'}\n`,
      );
    process.stdout.write(
      v.legacy.length + v.unknown.length === 0
        ? 'Control knows no Whombat on updates.whombat.com. It stays until the pilot inventory is reconciled and 30 days pass without a request (docs/runbooks/updates.md).\n'
        : 'Keep updates.whombat.com: these Whombats need a release through it that moves them to GitHub first.\n',
    );
  }
  return v.legacy.length + v.unknown.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`legacy-boxes: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
