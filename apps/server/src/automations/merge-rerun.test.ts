/**
 * Which failed GitHub Actions jobs a merge step runs once more (automation-recipes.md, “Failed checks run once more”): the per-repository setting
 * and what counts as an infrastructure fault.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import {
  type ActionsJobFacts,
  infrastructureRerun,
  jobFault,
  mergeRerunPolicy,
  mergeRerunProblem,
} from './merge-rerun';

const job = (over: Partial<ActionsJobFacts> = {}): ActionsJobFacts => ({
  name: 'test',
  conclusion: 'failure',
  steps: [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Run actions/checkout@v4', conclusion: 'success' },
    { name: 'Run tests', conclusion: 'failure' },
    { name: 'Complete job', conclusion: 'success' },
  ],
  annotations: ['Process completed with exit code 1.'],
  ...over,
});

describe('the setting', () => {
  it('is once unless a repository, or every one, says infrastructure', () => {
    expect(mergeRerunPolicy(undefined, 'AcmeHQ/development')).toBe('once');
    expect(mergeRerunPolicy('infrastructure', 'acme/web')).toBe('infrastructure');
    const spec = 'AcmeHQ/development=infrastructure, *=once';
    expect(mergeRerunPolicy(spec, 'acmehq/Development')).toBe('infrastructure');
    expect(mergeRerunPolicy(spec, 'acme/Fusebox')).toBe('once');
    expect(mergeRerunPolicy('*=infrastructure,acme/web=once', 'acme/web')).toBe('once');
  });

  it('refuses what it can’t read, at start', () => {
    expect(mergeRerunProblem('acme/web=infrastructure,once')).toBeNull();
    expect(mergeRerunProblem('acme/web=twice')).toContain('acme/web=twice');
    expect(mergeRerunProblem('acme=infrastructure')).toContain('acme');
    expect(() => loadConfig({ WHOMBAT_MERGE_RERUN: 'acme/web=always' })).toThrow(/WHOMBAT_MERGE_RERUN/);
    expect(loadConfig({ WHOMBAT_MERGE_RERUN: 'acme/web=infrastructure' }).WHOMBAT_MERGE_RERUN).toBe(
      'acme/web=infrastructure',
    );
  });
});

describe('jobFault', () => {
  it('takes a timeout, a lost or shut-down runner and a failed setup step as the infrastructure', () => {
    expect(jobFault(job({ conclusion: 'timed_out' })).infrastructure).toBe(true);
    for (const message of [
      'The self-hosted runner: falcon-ci-2 lost communication with the server. Verify the machine is running.',
      'The runner has received a shutdown signal. This can happen when the runner service is stopped.',
      'The job running on runner falcon-ci-1 has exceeded the maximum execution time of 60 minutes.',
    ]) {
      expect(jobFault(job({ annotations: [message] })).infrastructure).toBe(true);
      expect(jobFault(job({ conclusion: 'cancelled', annotations: [message] })).infrastructure).toBe(true);
    }
    for (const setup of [
      'Set up job',
      'Run actions/checkout@v4',
      'Checkout',
      'Post Run actions/checkout@v4',
      'Complete job',
    ])
      expect(
        jobFault(job({ steps: [{ name: setup, conclusion: 'failure' }], annotations: [] })),
      ).toMatchObject({ infrastructure: true, why: expect.stringContaining(setup) });
  });

  it('takes a failed run or test step, a cancel nobody explains and an unnamed failure as not', () => {
    expect(jobFault(job())).toEqual({ infrastructure: false, why: '“test” failed in “Run tests”' });
    expect(
      jobFault(
        job({
          steps: [
            { name: 'Set up job', conclusion: 'failure' },
            { name: 'cargo test', conclusion: 'failure' },
          ],
        }),
      ),
    ).toMatchObject({ infrastructure: false, why: expect.stringContaining('cargo test') });
    expect(
      jobFault(job({ conclusion: 'cancelled', annotations: ['The operation was canceled.'] })).infrastructure,
    ).toBe(false);
    expect(jobFault(job({ steps: [], annotations: [] })).infrastructure).toBe(false);
    expect(jobFault(job({ conclusion: 'startup_failure', steps: [] })).infrastructure).toBe(false);
  });
});

describe('infrastructureRerun', () => {
  const lost = job({ name: 'test (linux)', conclusion: 'timed_out' });
  it('runs them once more only when every failed job was the infrastructure', () => {
    expect(
      infrastructureRerun([
        lost,
        job({ name: 'lint', steps: [{ name: 'Set up job', conclusion: 'failure' }] }),
      ]),
    ).toMatchObject({ rerun: true });
    expect(infrastructureRerun([lost, job({ name: 'unit' })])).toEqual({
      rerun: false,
      why: '“unit” failed in “Run tests”',
    });
    expect(infrastructureRerun([]).rerun).toBe(false);
  });
});
