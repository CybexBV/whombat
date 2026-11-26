/**
 * whombat-ops `promote <release-id> --yes` — a Beta release to Production, on John's word (ONE-03, ONE-15, ONE-19;
 * whombat-ops runbooks/appliance/shipping.md). It says what it will do first; without `--yes` that is all it does.
 *
 *   1. `tufrepo gh-promote --dir $WHOMBAT_RELEASES_DIR --release <id>`: the release listed in Production unchanged
 *      (the online production key, ONE-05) and pushed; the whombat-releases workflow signs snapshot and timestamp on
 *      that push;
 *   2. it waits until releases.whombat.com lists the release in Production (at most 20 minutes);
 *   3. the tag `<id>` on the commit the release was built from, pushed (a release of the one repository; one the old
 *      flow built is a commit of the appliance's old repository and gets none);
 *   4. the installer of its host (itself for a host release; `release/build iso <dir>` first when it has none yet) on
 *      the download site with `release/upload-iso <dir> --production` (ENV-22): `whombat-installer-vX.Y.iso` and its
 *      `.sha256` at the root, the next version unless the site has this one, then `installer/latest.json`, then every
 *      older installer removed;
 *   5. its section in whombat-ops runbooks/appliance/releases.md, committed there.
 *
 *   promote <release-id> [--yes] [--no-iso]
 *
 * Run again after a stop, it carries on: a release already in Production goes straight to its tag and its installer;
 * a tag that is there stays, and an installer already on the site isn't sent again. Settings: WHOMBAT_RELEASES_DIR and WHOMBAT_RELEASES_TOKEN (whombat-ops
 * bin/promote reads them from ~/.config/whombat/releases.env), WHOMBAT_INSTALLER_BUCKET and WHOMBAT_INSTALLER_BASE_URL
 * (the download site), WB_RELEASES_URL (default https://releases.whombat.com). Logs: ~/.cache/wb-tmp/promote-<id>/.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { opsDir } from '../lib/guards.ts';
import { REPO_DIR, TMP_DIR } from '../lib/paths.ts';
import { must, run } from '../lib/proc.ts';
import { topOf, whereIs } from '../lib/source.ts';
import { findBuild } from '../ship/build.ts';
import { channelReleaseIds, cloneChannelIds, shipContext } from '../ship/context.ts';
import { ensureIso, hostBuildOf, isoInfo } from '../ship/iso.ts';
import { releasesTarget } from './candidate-plan.ts';
import * as plan from './promote-plan.ts';
import { commitRunbook } from './runbook.ts';
import { tufrepoBin } from './tufrepo.ts';

const say = (s: string) => process.stderr.write(`promote: ${s}\n`);
const WAIT_MS = 20 * 60_000;

async function main(): Promise<number> {
  const a = plan.parsePromoteArgs(process.argv.slice(2));
  const github = releasesTarget(process.env);
  const ctx = shipContext();
  const beta = cloneChannelIds(github.dir, 'development');
  if (!beta)
    throw new Error(`${github.dir} has no Beta channel: is it the publisher's clone of whombat-releases?`);
  const production = cloneChannelIds(github.dir, 'production') ?? [];
  const b = findBuild(ctx, a.id);
  const host = b && !a.noIso ? hostBuildOf(ctx, b) : null;
  // The commit the release was built from: this repository's for a release of the one repository.
  const rev = (b?.build.source as { rev?: string } | undefined)?.rev ?? null;
  const top = topOf(REPO_DIR);
  const source = rev ? { rev, here: whereIs(rev, { checkout: REPO_DIR, archives: [] }) !== null } : null;
  const bucket = process.env.WHOMBAT_INSTALLER_BUCKET ?? '';
  const baseUrl = process.env.WHOMBAT_INSTALLER_BASE_URL ?? '';
  const steps = plan.promotePlan({
    id: a.id,
    beta,
    production,
    built: b !== null,
    host: host ? { ...host, iso: isoInfo(host.dir) !== null } : null,
    site: bucket && baseUrl ? { bucket, baseUrl } : null,
    noIso: a.noIso,
    source,
  });
  process.stdout.write(`${plan.planWords(a.id, steps)}\n`);
  if (!a.yes) {
    say(`nothing done: promote ${a.id} --yes does it, on John's word (ONE-19)`);
    return 2;
  }
  const logDir = join(TMP_DIR, `promote-${a.id}`);
  mkdirSync(logDir, { recursive: true });
  let installer: plan.PromotedInstaller | null = null;
  let tagged: string | null = null;
  for (const step of steps) {
    say(`${step.words}…`);
    switch (step.kind) {
      case 'promote': {
        const bin = await tufrepoBin();
        const r = await plan.retryTransientPush(
          () =>
            run(bin, ['gh-promote', '--dir', github.dir, '--release', a.id], {
              cwd: REPO_DIR,
              logFile: join(logDir, 'gh-promote.log'),
              timeoutMs: 30 * 60_000,
            }),
          {
            sleep: (ms) => sleep(ms),
            onRetry: ({ attempt, maxAttempts, waitMs }) =>
              say(
                `tufrepo gh-promote hit a transient GitHub push error (attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(waitMs / 1000)}s…`,
              ),
          },
        );
        if (r.code !== 0)
          throw new Error(
            `tufrepo gh-promote failed (${r.code}; ${join(logDir, 'gh-promote.log')}): ${r.stderr.trim().split('\n').slice(-3).join(' ')}`,
          );
        break;
      }
      case 'wait': {
        const until = Date.now() + WAIT_MS;
        for (;;) {
          const ids = await channelReleaseIds(ctx.prod.releasesUrl, 'production');
          if (ids?.includes(a.id)) break;
          if (Date.now() > until)
            throw new Error(
              `${ctx.prod.releasesUrl} doesn't list ${a.id} in Production after 20 minutes: look at the whombat-releases workflow's run, then promote again (it carries on)`,
            );
          await sleep(20_000);
        }
        say(`${ctx.prod.releasesUrl} lists ${a.id} in Production`);
        break;
      }
      case 'tag': {
        const git = async (...args: string[]) =>
          (
            await must('git', ['-C', top, ...args], { cwd: top, logFile: join(logDir, 'tag.log') })
          ).stdout.trim();
        const at = (
          await run('git', ['-C', top, 'rev-parse', '-q', '--verify', `refs/tags/${step.tag}^{commit}`], {
            cwd: top,
          })
        ).stdout.trim();
        if (at && at !== step.rev)
          throw new Error(
            `the tag ${step.tag} is on ${at.slice(0, 12)}, not on ${step.rev.slice(0, 12)}, the commit the release was built from: someone must look before anything is moved`,
          );
        if (!at) await git('tag', '-a', step.tag, '-m', `${step.tag} in Production`, step.rev);
        const push = await plan.retryTransientPush(
          () =>
            run('git', ['-C', top, 'push', 'origin', `refs/tags/${step.tag}`], {
              cwd: top,
              logFile: join(logDir, 'tag.log'),
            }),
          {
            sleep: (ms) => sleep(ms),
            onRetry: ({ attempt, maxAttempts, waitMs }) =>
              say(
                `pushing tag ${step.tag} hit a transient GitHub push error (attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(waitMs / 1000)}s…`,
              ),
          },
        );
        if (push.code !== 0)
          throw new Error(
            `git push refs/tags/${step.tag} failed (${push.code}; ${join(logDir, 'tag.log')}): ${push.stderr.trim().split('\n').slice(-3).join(' ')}`,
          );
        say(`${step.tag} is a tag on ${step.rev.slice(0, 12)}`);
        tagged = step.rev;
        break;
      }
      case 'iso-build':
        await ensureIso(ctx, step.dir, join(logDir, 'iso.log'));
        break;
      case 'iso-upload': {
        const r = await run(join(REPO_DIR, 'release', 'upload-iso'), [step.dir, '--production'], {
          cwd: REPO_DIR,
          logFile: join(logDir, 'upload-iso.log'),
          timeoutMs: 3 * 3_600_000,
        });
        const outcome = plan.uploadOutcome(r.code ?? -1, r.stdout);
        if (outcome.kind === 'failed')
          throw new Error(
            `release/upload-iso failed (${r.code}; ${join(logDir, 'upload-iso.log')}): ${r.stderr.trim().split('\n').slice(-2).join(' ')}; run promote again, it carries on`,
          );
        if (outcome.kind === 'kept') {
          say(
            `the site keeps ${outcome.kept}'s installer, newer than ${outcome.host}'s: the installer only moves forward`,
          );
          installer = { host: outcome.host, url: outcome.url, version: outcome.version, kept: outcome.kept };
        } else installer = { host: outcome.host, url: outcome.url, version: outcome.version };
        break;
      }
      case 'notes': {
        const ops = opsDir(REPO_DIR);
        if (!ops) {
          say('no whombat-ops on this machine: the releases runbook gets no section');
          break;
        }
        const section = plan.promotionSection({
          id: a.id,
          day: new Date().toISOString().slice(0, 10),
          installer,
          tagged,
        });
        // Claude Code runs it most of the time; its commits carry the trailer the repository's others do.
        const trailer =
          process.env.CLAUDECODE === '1' ? '\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' : '';
        // In the copy itself, or on origin's main when whombat-ops is the ops/ folder of whombat-cloud.
        await commitRunbook({
          ops,
          message: `runbooks: ${a.id} in Production${trailer}`,
          change: (text) => plan.withPromotion(text, a.id, section),
          say,
        });
        break;
      }
    }
  }
  process.stdout.write(
    `${a.id} is in Production${installer ? `; its installer: ${installer.url}` : ''}. Production boxes take it at their next check.\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.slice(2).some((o) => o === '-h' || o === '--help')) {
    process.stdout.write(`${plan.PROMOTE_USAGE}\n`);
    process.exit(0);
  }
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      say(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
