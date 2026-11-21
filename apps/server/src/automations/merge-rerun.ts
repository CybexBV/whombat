/**
 * Which failed GitHub Actions jobs a merge step runs once more, per repository (docs/decisions/automation-recipes.md,
 * “Failed checks run once more”). `once`, the default: every failed job of the repo's workflow runs, as a flaky test is
 * the common reason. `infrastructure`: only when every failed job failed for a reason that isn't the code — it timed
 * out, its runner was lost or shut down, or it failed while setting up —, for a repository whose CI already retries its
 * flaky tests and whose runs are long, so a blind re-run of a real failure only delays the person.
 *
 * The setting is `WHOMBAT_MERGE_RERUN`: `once` or `infrastructure` for every repository, or `owner/repo=<value>,…` with
 * an optional `*=<value>` for the rest. Pure: config.ts validates it with `mergeRerunProblem`.
 */

export const MERGE_RERUN_POLICIES = ['once', 'infrastructure'] as const;
export type MergeRerunPolicy = (typeof MERGE_RERUN_POLICIES)[number];

const isPolicy = (v: string): v is MergeRerunPolicy =>
  (MERGE_RERUN_POLICIES as readonly string[]).includes(v);

/** The setting as a table, lower-case `owner/repo` (or `*`) to its value; throws with what is wrong. */
export function parseMergeRerun(spec: string | null | undefined): Map<string, MergeRerunPolicy> {
  const table = new Map<string, MergeRerunPolicy>();
  for (const raw of (spec ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf('=');
    const key = (eq < 0 ? '*' : entry.slice(0, eq)).trim().toLowerCase();
    const value = (eq < 0 ? entry : entry.slice(eq + 1)).trim();
    if (!isPolicy(value)) throw new Error(`“${entry}” needs once or infrastructure`);
    if (!/^(\*|[\w.-]+\/[\w.-]+)$/.test(key)) throw new Error(`“${key}” is not <owner/repo> or *`);
    table.set(key, value);
  }
  return table;
}

/** What is wrong with the setting, or null. */
export function mergeRerunProblem(spec: string | null | undefined): string | null {
  try {
    parseMergeRerun(spec);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The setting for `repo`: its own entry, else `*`, else `once` (also when it doesn't parse: start refuses that). */
export function mergeRerunPolicy(spec: string | null | undefined, repo: string): MergeRerunPolicy {
  let table: Map<string, MergeRerunPolicy>;
  try {
    table = parseMergeRerun(spec);
  } catch {
    return 'once';
  }
  return table.get(repo.toLowerCase()) ?? table.get('*') ?? 'once';
}

/** What GitHub says about one failed job: its conclusion, its steps and its check run's annotations. */
export interface ActionsJobFacts {
  name: string;
  conclusion: string | null;
  steps: readonly { name: string; conclusion: string | null }[];
  /** The messages of the job's annotations: where GitHub says its runner was lost or shut down. */
  annotations: readonly string[];
}

/** Why a job failed: the infrastructure (worth one more run) or anything else (a person looks); `why` is for the log. */
export interface JobFault {
  infrastructure: boolean;
  why: string;
}

/** GitHub's own words when a job's runner went away, or when the job ran out of time. */
const RUNNER_GONE = [
  /lost communication with the server/i,
  /runner has received a shutdown signal/i,
  /was not acquired by runner/i,
];
const OUT_OF_TIME = /exceeded the maximum execution time/i;

/** Steps the runner does around the job's own: setting up, checking out, cleaning up. */
const SETUP_STEPS = [
  /^set up job$/i,
  /^complete job$/i,
  /^(post )?run actions\/checkout(@\S+)?$/i,
  /^(post )?check ?out\b/i,
  /^(initialize|stop) containers$/i,
];

/**
 * Whether a failed job failed for an infrastructure reason: it timed out; GitHub says its runner was lost or shut down
 * (a cancelled job counts only then — a person or a newer push cancels too, and the job doesn't say who); or every
 * step that failed is a setup step. A failed run or test step, or a failure that names no step, is not. Pure.
 */
export function jobFault(job: ActionsJobFacts): JobFault {
  const name = `“${job.name}”`;
  if (job.conclusion === 'timed_out') return { infrastructure: true, why: `${name} timed out` };
  if (job.annotations.some((a) => RUNNER_GONE.some((re) => re.test(a))))
    return { infrastructure: true, why: `${name} lost its runner` };
  if (job.annotations.some((a) => OUT_OF_TIME.test(a)))
    return { infrastructure: true, why: `${name} timed out` };
  if (job.conclusion === 'cancelled')
    return { infrastructure: false, why: `${name} was cancelled, and nothing says the runner did it` };
  if (job.conclusion !== 'failure')
    return { infrastructure: false, why: `${name} ended ${job.conclusion ?? 'unknown'}` };
  const failed = job.steps.filter((s) => s.conclusion === 'failure');
  const first = failed[0];
  if (!first) return { infrastructure: false, why: `${name} failed without naming a step` };
  const own = failed.find((s) => !SETUP_STEPS.some((re) => re.test(s.name.trim())));
  if (own) return { infrastructure: false, why: `${name} failed in “${own.name}”` };
  return { infrastructure: true, why: `${name} failed in “${first.name}”, a setup step` };
}

/**
 * Whether failed jobs are run once more under `infrastructure`: only when every one failed for an infrastructure
 * reason; else the first that didn't says why. Pure.
 */
export function infrastructureRerun(jobs: readonly ActionsJobFacts[]): { rerun: boolean; why: string } {
  if (!jobs.length) return { rerun: false, why: 'no failed job to look at' };
  const faults = jobs.map(jobFault);
  const other = faults.find((f) => !f.infrastructure);
  if (other) return { rerun: false, why: other.why };
  return { rerun: true, why: faults.map((f) => f.why).join('; ') };
}
