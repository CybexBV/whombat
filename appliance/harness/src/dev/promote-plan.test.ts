import { describe, expect, it } from 'vitest';
import {
  isTransientGitHubPushError,
  PROMOTE_PUSH_ATTEMPTS,
  PROMOTE_PUSH_BACKOFF_MS,
  type PromoteFacts,
  parsePromoteArgs,
  planWords,
  promotePlan,
  promotionSection,
  retryTransientPush,
  uploadOutcome,
  withPromotion,
} from './promote-plan.ts';

const ID = 'whombat-20261120.2';
const facts = (o: Partial<PromoteFacts> = {}): PromoteFacts => ({
  id: ID,
  beta: ['whombat-dev-20261119.9', 'whombat-20261120.1', ID],
  production: [],
  built: true,
  host: { id: 'whombat-20261120.1', dir: '/r/whombat-20261120.1', iso: true },
  site: { bucket: 'whombat-downloads', baseUrl: 'https://downloads.example.com' },
  noIso: false,
  ...o,
});

describe('promote: a Beta release to Production on John’s word (ONE-19)', () => {
  it('takes one release id of the image, and --yes', () => {
    expect(parsePromoteArgs([ID])).toEqual({ id: ID, yes: false, noIso: false });
    expect(parsePromoteArgs([ID, '--yes', '--no-iso'])).toEqual({ id: ID, yes: true, noIso: true });
    expect(() => parsePromoteArgs([])).toThrow(/usage: promote/);
    expect(() => parsePromoteArgs(['whombat-dev-20261119.9', '--yes'])).toThrow(
      /not a release id of the Whombat image/,
    );
    expect(() => parsePromoteArgs([ID, 'whombat-20261120.3'])).toThrow(/one release id/);
    expect(() => parsePromoteArgs([ID, '--force'])).toThrow(/unknown option --force/);
  });

  it('says what it will do: promote, wait for the site, the installer, the notes', () => {
    const steps = promotePlan(facts());
    expect(steps.map((s) => s.kind)).toEqual(['promote', 'wait', 'iso-upload', 'notes']);
    const words = planWords(ID, steps);
    expect(words).toContain('gh-promote');
    expect(words).toContain("whombat-20261120.1's installer");
    expect(words).toContain('whombat-installer-vX.Y.iso');
    expect(words).toContain('installer/latest.json');
    expect(words).toContain('remove every older installer');
  });

  it('builds the host’s ISO first when it has none, and leaves the installer alone with --no-iso', () => {
    expect(promotePlan(facts({ host: { id: ID, dir: `/r/${ID}`, iso: false } })).map((s) => s.kind)).toEqual([
      'promote',
      'wait',
      'iso-build',
      'iso-upload',
      'notes',
    ]);
    expect(
      promotePlan(facts({ noIso: true, built: false, host: null, site: null })).map((s) => s.kind),
    ).toEqual(['promote', 'wait', 'notes']);
  });

  it('tags the commit of a release of the one repository, and none for a release the old flow built', () => {
    const rev = 'a'.repeat(40);
    const steps = promotePlan(facts({ source: { rev, here: true } }));
    expect(steps.map((s) => s.kind)).toEqual(['promote', 'wait', 'tag', 'iso-upload', 'notes']);
    expect(steps[2]).toMatchObject({ kind: 'tag', tag: ID, rev });
    expect(planWords(ID, steps)).toContain(`as ${ID} and push the tag`);
    // The appliance's old repository holds the commit: nothing here to tag.
    expect(promotePlan(facts({ source: { rev, here: false } })).map((s) => s.kind)).not.toContain('tag');
    // The tag doesn't wait for the installer.
    expect(
      promotePlan(facts({ noIso: true, host: null, site: null, source: { rev, here: true } })).map(
        (s) => s.kind,
      ),
    ).toEqual(['promote', 'wait', 'tag', 'notes']);
    expect(promotionSection({ id: ID, day: '2026-11-20', installer: null, tagged: rev })).toContain(
      `\`${rev.slice(0, 12)}\` is tagged \`${ID}\``,
    );
  });

  it('runs gh-promote again after a stop, even when the clone lists the release in Production (R2 A10)', () => {
    // A push that failed leaves the role signed in the clone: only the idempotent publisher pushes it.
    const steps = promotePlan(facts({ production: [ID] }));
    expect(steps.map((s) => s.kind)).toEqual(['promote', 'wait', 'iso-upload', 'notes']);
    expect(steps[0]?.words).toContain('pushes what isn');
  });

  it('refuses before anything: not in Beta, no build here, no download site', () => {
    expect(() => promotePlan(facts({ beta: ['whombat-20261120.1'] }))).toThrow(/is not in Beta/);
    expect(() => promotePlan(facts({ built: false, host: null }))).toThrow(/has no build here.*--no-iso/);
    expect(() => promotePlan(facts({ site: null }))).toThrow(/WHOMBAT_INSTALLER_BUCKET/);
  });

  it('writes the releases runbook’s section', () => {
    const s = promotionSection({
      id: ID,
      day: '2026-11-20',
      installer: {
        host: 'whombat-20261120.1',
        url: 'https://downloads.example.com/whombat-installer-v0.3.iso',
        version: 'v0.3',
      },
    });
    expect(s.startsWith(`### ${ID} in Production (2026-11-20)`)).toBe(true);
    expect(s).toContain(`promote ${ID} --yes`);
    expect(s).toContain('v0.3');
    expect(s).toContain('https://downloads.example.com/whombat-installer-v0.3.iso');
    expect(promotionSection({ id: ID, day: '2026-11-20', installer: null })).toContain('--no-iso');
    const kept = promotionSection({
      id: ID,
      day: '2026-11-20',
      installer: {
        host: 'whombat-20261120.1',
        url: 'https://downloads.example.com/whombat-installer-v0.4.iso',
        version: 'v0.4',
        kept: 'whombat-20261121.1',
      },
    });
    expect(kept).toContain('whombat-20261121.1');
    expect(kept).toContain('newer');
  });

  it('adds its section to the runbook once, however often it runs', () => {
    const section = promotionSection({ id: ID, day: '2026-11-20', installer: null });
    const once = withPromotion('# Releases\n\n### something earlier\n', ID, section);
    expect(once.endsWith(`${section}\n`)).toBe(true);
    expect(once).toContain('### something earlier');
    expect(withPromotion(once, ID, section)).toBe(once);
    expect(withPromotion('', ID, section)).toBe(`# Releases\n\n${section}\n`);
    // Another release's section is no reason to leave this one out.
    expect(withPromotion(once, 'whombat-20261120.3', 'x')).not.toBe(once);
  });

  it('takes the installer kept at a newer release as done, and anything else but up as a failure (R2 B2)', () => {
    const up =
      '{"releaseId":"whombat-20261120.1","version":"v0.2","url":"https://d.example.com/whombat-installer-v0.2.iso","removed":[]}';
    expect(uploadOutcome(0, `x\n${up}`)).toMatchObject({
      kind: 'up',
      host: 'whombat-20261120.1',
      version: 'v0.2',
    });
    const kept =
      '{"releaseId":"whombat-20261120.1","latest":false,"latestKept":"whombat-20261121.1","keptVersion":"v0.3","keptUrl":"https://d.example.com/whombat-installer-v0.3.iso"}';
    expect(uploadOutcome(3, kept)).toMatchObject({
      kind: 'kept',
      kept: 'whombat-20261121.1',
      version: 'v0.3',
      url: 'https://d.example.com/whombat-installer-v0.3.iso',
    });
    // As release/upload-iso prints it: jq spreads the object over several lines.
    const spread = JSON.stringify(JSON.parse(up), null, 2);
    expect(uploadOutcome(0, `upload-iso: served\n${spread}\n`)).toMatchObject({
      kind: 'up',
      host: 'whombat-20261120.1',
      url: 'https://d.example.com/whombat-installer-v0.2.iso',
    });
    expect(uploadOutcome(3, JSON.stringify(JSON.parse(kept), null, 2))).toMatchObject({
      kind: 'kept',
      kept: 'whombat-20261121.1',
    });
    expect(uploadOutcome(1, up)).toEqual({ kind: 'failed' });
    expect(uploadOutcome(0, 'not json')).toEqual({ kind: 'failed' });
  });

  it('recognises transient GitHub push faults and leaves auth, rule and ref errors alone', () => {
    expect(
      isTransientGitHubPushError(
        'remote: fatal error in commit_refs_rules\n! [remote rejected] main -> main (pre-receive hook declined)',
      ),
    ).toBe(true);
    expect(
      isTransientGitHubPushError('error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502'),
    ).toBe(true);
    expect(isTransientGitHubPushError('fatal: the remote end hung up unexpectedly')).toBe(true);
    expect(
      isTransientGitHubPushError('fatal: unable to access https://github.com/o/r.git/: Connection timed out'),
    ).toBe(true);
    expect(isTransientGitHubPushError('error: remote unpack failed: index-pack failed')).toBe(true);
    // Permanent refusals must not be retried.
    expect(isTransientGitHubPushError('fatal: Authentication failed for https://github.com/o/r.git/')).toBe(
      false,
    );
    expect(
      isTransientGitHubPushError('remote: Permission to o/r.git denied to user.\nfatal: returned error: 403'),
    ).toBe(false);
    expect(isTransientGitHubPushError('! [rejected] main -> main (non-fast-forward)')).toBe(false);
    expect(isTransientGitHubPushError('! [rejected] v1 -> v1 (already exists)')).toBe(false);
    expect(
      isTransientGitHubPushError(
        'remote: error: GH013: Repository rule violations found for refs/heads/main.',
      ),
    ).toBe(false);
    expect(isTransientGitHubPushError('')).toBe(false);
  });

  it('retries transient GitHub push faults with backoff and stops immediately on permanent ones', async () => {
    const waits: number[] = [];
    const notices: number[] = [];
    let calls = 0;
    const ok = await retryTransientPush(
      async () => {
        calls++;
        return calls < 3
          ? { code: 1, stdout: '', stderr: 'remote: fatal error in commit_refs_rules\n' }
          : { code: 0, stdout: 'ok\n', stderr: '' };
      },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
        onRetry: ({ attempt }) => notices.push(attempt),
      },
    );
    expect(ok.code).toBe(0);
    expect(calls).toBe(3);
    expect(waits).toEqual([...PROMOTE_PUSH_BACKOFF_MS]);
    expect(notices).toEqual([1, 2]);

    // Exhausting attempts returns the last failure after PROMOTE_PUSH_ATTEMPTS tries.
    let failCalls = 0;
    const exhausted = await retryTransientPush(
      async () => {
        failCalls++;
        return { code: 1, stdout: '', stderr: 'fatal: HTTP 503 Service Unavailable' };
      },
      { sleep: async () => {} },
    );
    expect(exhausted.code).toBe(1);
    expect(failCalls).toBe(PROMOTE_PUSH_ATTEMPTS);

    // Permanent errors return on attempt 1 without waiting.
    let permCalls = 0;
    const permWaits: number[] = [];
    const perm = await retryTransientPush(
      async () => {
        permCalls++;
        return { code: 1, stdout: '', stderr: '! [rejected] main -> main (non-fast-forward)' };
      },
      { sleep: async (ms) => void permWaits.push(ms) },
    );
    expect(perm.code).toBe(1);
    expect(permCalls).toBe(1);
    expect(permWaits).toEqual([]);
  });
});
