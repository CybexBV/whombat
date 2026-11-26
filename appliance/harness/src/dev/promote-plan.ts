/**
 * The pure parts of whombat-ops `promote <release-id> --yes` (ONE-03, ONE-15, ONE-19): its arguments, what it will do
 * (said first, and the whole answer without `--yes`), and the releases runbook's line. promote.ts does the work.
 */
import { parseReleaseId } from '../ship/ids.ts';

export interface PromoteArgs {
  id: string;
  /** John's word, on the command line: without it nothing is done (the plan is printed). */
  yes: boolean;
  /** Leave the installer on the download site as it is (a release whose ISO someone else puts up). */
  noIso: boolean;
}

export const PROMOTE_USAGE =
  'usage: promote <release-id> [--yes] [--no-iso]   (moves a Beta release to Production on John’s word; without --yes it only says what it would do)';

/** How many times a GitHub push step tries before giving up on a transient server or transport fault. */
export const PROMOTE_PUSH_ATTEMPTS = 3;
/** Delay between retries of a transient GitHub push fault, in milliseconds. */
export const PROMOTE_PUSH_BACKOFF_MS: readonly number[] = [10_000, 30_000];

const PERMANENT_PUSH_ERROR = [
  /\b(?:non-fast-forward|already exists|fetch first|cannot lock ref)\b/i,
  /\b(?:authentication failed|permission denied|could not read username|invalid username or token|access denied|repository not found)\b/i,
  /\b(?:secret scanning|push declined due to repository rule violations|gh006|gh009|gh013)\b/i,
  /\b(?:returned error|http|status)\s*[:=]?\s*40[134]\b/i,
];

const TRANSIENT_PUSH_ERROR = [
  /fatal error in commit_refs_rules/i,
  /\b(?:returned error|http|status)\s*[:=]?\s*5\d\d\b/i,
  /\brpc failed\b/i,
  /\b(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/i,
  /\b(?:remote unpack failed|the remote end hung up unexpectedly|early eof)\b/i,
  /\b(?:connection reset|connection timed out|operation timed out|timed out|broken pipe|tls handshake timeout|could not resolve host|temporary failure in name resolution|network is unreachable)\b/i,
  /\btry again later\b/i,
];

/**
 * Whether a failed GitHub push (tufrepo gh-promote or git push) looks like a transient server or network fault that
 * is safe to retry, as opposed to an auth, permission, rule, or ref-conflict refusal.
 */
export function isTransientGitHubPushError(output: string): boolean {
  if (!output.trim()) return false;
  if (PERMANENT_PUSH_ERROR.some((re) => re.test(output))) return false;
  return TRANSIENT_PUSH_ERROR.some((re) => re.test(output));
}

/**
 * Runs an idempotent GitHub push command, retrying up to `PROMOTE_PUSH_ATTEMPTS` times with backoff when the output
 * matches a transient GitHub push fault. Non-transient failures return immediately without retrying.
 */
export async function retryTransientPush<T extends { code: number | null; stdout: string; stderr: string }>(
  op: (attempt: number) => Promise<T>,
  o: {
    attempts?: number;
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; maxAttempts: number; waitMs: number; output: string }) => void;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, o.attempts ?? PROMOTE_PUSH_ATTEMPTS);
  const backoff = o.backoffMs ?? PROMOTE_PUSH_BACKOFF_MS;
  const wait = o.sleep ?? (async () => {});
  let last!: T;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await op(attempt);
    if (last.code === 0) return last;
    const output = `${last.stderr}\n${last.stdout}`;
    if (attempt >= maxAttempts || !isTransientGitHubPushError(output)) return last;
    const waitMs = backoff[attempt - 1] ?? backoff.at(-1) ?? 0;
    o.onRetry?.({ attempt, maxAttempts, waitMs, output });
    if (waitMs > 0) await wait(waitMs);
  }
  return last;
}

export function parsePromoteArgs(argv: readonly string[]): PromoteArgs {
  let id: string | null = null;
  let yes = false;
  let noIso = false;
  for (const a of argv) {
    if (a === '--yes') yes = true;
    else if (a === '--no-iso') noIso = true;
    else if (a === '-h' || a === '--help') throw new Error(PROMOTE_USAGE);
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}\n${PROMOTE_USAGE}`);
    else if (id) throw new Error(`one release id only\n${PROMOTE_USAGE}`);
    else id = a;
  }
  if (!id) throw new Error(PROMOTE_USAGE);
  // Production lists the one image's releases only (ONE-02, ONE-04): a DEV twin never goes there.
  if (parseReleaseId(id)?.env !== 'prod' || !id.startsWith('whombat-'))
    throw new Error(`${id} is not a release id of the Whombat image (whombat-YYYYMMDD.N)`);
  return { id, yes, noIso };
}

/** Where the release stands: Beta and Production as the publisher's clone has them, and its build here. */
export interface PromoteFacts {
  id: string;
  beta: readonly string[];
  production: readonly string[];
  /** Its build.json here (~/.cache/whombat-releases/<id>), or null. */
  built: boolean;
  /** The host build whose ISO installs it (itself for a host release), and whether that ISO is built yet. */
  host: { id: string; dir: string; iso: boolean } | null;
  /** The download site's settings (WHOMBAT_INSTALLER_BUCKET, WHOMBAT_INSTALLER_BASE_URL). */
  site: { bucket: string; baseUrl: string } | null;
  noIso: boolean;
  /**
   * The commit the release was built from, when its build is here: `here` when it is a commit of this repository
   * (a release of the one repository), false for one the appliance's old repository holds.
   */
  source?: { rev: string; here: boolean } | null;
}

export type PromoteStep =
  | { kind: 'promote'; words: string }
  | { kind: 'wait'; words: string }
  | { kind: 'tag'; words: string; tag: string; rev: string }
  | { kind: 'iso-build'; words: string; dir: string }
  | { kind: 'iso-upload'; words: string; dir: string }
  | { kind: 'notes'; words: string };

/**
 * What promote does, in order, or why it refuses before anything: a release that isn't in Beta, one without its build
 * here (the ISO comes from it), or the download site's settings missing. A run again does every step again: each is
 * idempotent (the promotion, the wait, the installer's upload).
 */
export function promotePlan(f: PromoteFacts): PromoteStep[] {
  if (!f.beta.includes(f.id))
    throw new Error(
      `${f.id} is not in Beta (the publisher's clone lists ${f.beta.length} Beta releases): only a Beta release goes to Production (ONE-03)`,
    );
  // gh-promote always runs (R2 A10): it is idempotent (a release Production lists already is left as it is) and it
  // pushes what a stopped run signed but didn't push, so the clone saying Production lists the release proves nothing.
  const steps: PromoteStep[] = [
    {
      kind: 'promote',
      words: f.production.includes(f.id)
        ? `push ${f.id}'s promotion (the clone lists it in Production already; tufrepo gh-promote pushes what isn't pushed and changes nothing else)`
        : `list ${f.id} in Production, unchanged (tufrepo gh-promote with the online production key, ONE-05), and push it`,
    },
    {
      kind: 'wait',
      words:
        "wait until releases.whombat.com lists it in Production (the repository's workflow signs snapshot and timestamp on the push)",
    },
  ];
  // A Production release is a tag on its commit (a release is one commit of main): what Production runs can be
  // checked out by its id. A release the old flow built is a commit of the appliance's old repository, which gets none.
  if (f.source?.here)
    steps.push({
      kind: 'tag',
      words: `tag the commit it was built from, ${f.source.rev.slice(0, 12)}, as ${f.id} and push the tag`,
      tag: f.id,
      rev: f.source.rev,
    });
  if (!f.noIso) {
    if (!f.built || !f.host)
      throw new Error(
        `${f.id} has no build here (~/.cache/whombat-releases/${f.id}), and its installer comes from it: promote it where it was built, or with --no-iso`,
      );
    if (!f.site)
      throw new Error(
        'the download site needs WHOMBAT_INSTALLER_BUCKET and WHOMBAT_INSTALLER_BASE_URL (release/upload-iso; ONE-15), or --no-iso',
      );
    if (!f.host.iso)
      steps.push({
        kind: 'iso-build',
        words: `build the installer ISO of ${f.host.id} (release/build iso ${f.host.dir})`,
        dir: f.host.dir,
      });
    steps.push({
      kind: 'iso-upload',
      words: `put ${f.host.id}'s installer on ${f.site.baseUrl} under its version (whombat-installer-vX.Y.iso and its .sha256, the next version unless the site has this one), then installer/latest.json, then remove every older installer from the bucket (release/upload-iso --production; ENV-22)`,
      dir: f.host.dir,
    });
  }
  steps.push({ kind: 'notes', words: 'its line in whombat-ops runbooks/appliance/releases.md' });
  return steps;
}

/** The plan in words, numbered. */
export function planWords(id: string, steps: readonly PromoteStep[]): string {
  return [`promote ${id}:`, ...steps.map((s, i) => `  ${i + 1}. ${s.words}`)].join('\n');
}

/** What the download site has after a promotion: its installer, or the newer one it kept. */
export interface PromotedInstaller {
  /** The release whose ISO went up (the promoted release's host). */
  host: string;
  /** The installer's link: this one's, or the newer one's the site kept. */
  url: string;
  /** Its version (`v0.12`), when the site says one. */
  version?: string | null;
  /** The newer release whose installer the site kept, when it did. */
  kept?: string | null;
}

/** The releases runbook's section for a promotion. */
export function promotionSection(o: {
  id: string;
  day: string;
  installer: PromotedInstaller | null;
  /** The commit that was tagged with the release's id, when it was. */
  tagged?: string | null;
}): string {
  return [
    `### ${o.id} in Production (${o.day})`,
    '',
    `Promoted on John's word with whombat-ops \`promote ${o.id} --yes\` (\`tufrepo gh-promote\`, ONE-19).${
      o.tagged ? ` Whombat \`${o.tagged.slice(0, 12)}\` is tagged \`${o.id}\`.` : ''
    }${installerWords(o.installer)}`,
  ].join('\n');
}

function installerWords(i: PromotedInstaller | null): string {
  if (!i) return ' The installer was left as it was (`--no-iso`).';
  const v = i.version ? ` ${i.version}` : '';
  if (i.kept) return ` The download site keeps ${i.kept}'s installer${v}, which is newer: ${i.url}.`;
  return ` The installer is${v}, ${i.host}'s: ${i.url} (\`installer/latest.json\` names it; older installers removed).`;
}

/**
 * The releases runbook with a promotion's section: added at the end, once. A promotion run again after it finished
 * finds its section and leaves the runbook as it is.
 */
export function withPromotion(md: string, id: string, section: string): string {
  if (md.split('\n').some((line) => line.startsWith(`### ${id} in Production`))) return md;
  return `${(md || '# Releases\n').replace(/\n*$/, '\n')}\n${section}\n`;
}

/**
 * What `release/upload-iso --production` said: up (exit 0), nothing sent because the site has a newer release's
 * installer (exit 3, R2 B2: it only moves forward), or failed.
 */
export function uploadOutcome(
  code: number,
  stdout: string,
):
  | { kind: 'up'; host: string; url: string; version: string | null }
  | { kind: 'kept'; host: string; url: string; version: string | null; kept: string }
  | { kind: 'failed' } {
  if (code !== 0 && code !== 3) return { kind: 'failed' };
  // Its answer is the last thing it prints: one JSON object, on one line or spread over several as jq writes it.
  const lines = stdout.trimEnd().split('\n');
  const start = lines.findLastIndex((l) => l.startsWith('{'));
  let out: {
    releaseId?: string;
    url?: string;
    version?: string | null;
    latestKept?: string;
    keptUrl?: string | null;
    keptVersion?: string | null;
  } = {};
  try {
    out = JSON.parse(start < 0 ? '' : lines.slice(start).join('\n'));
  } catch {
    return { kind: 'failed' };
  }
  const host = out.releaseId ?? '?';
  if (code === 3)
    return {
      kind: 'kept',
      host,
      url: out.keptUrl ?? '?',
      version: out.keptVersion ?? null,
      kept: out.latestKept ?? '?',
    };
  return { kind: 'up', host, url: out.url ?? '?', version: out.version ?? null };
}
