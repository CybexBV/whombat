import type { DelegationVerification } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { inputFingerprint, verificationOf, verificationPassed } from './verification';

const revision = 'a'.repeat(40);
const base = 'b'.repeat(40);
const inputs = 'c'.repeat(64);
const check = { name: 'check', revision, state: 'passing' as const };
const app = { name: 'app', revision, state: 'passing' as const };
const proof = (over: Partial<DelegationVerification> = {}): DelegationVerification => ({
  revision,
  base,
  inputs,
  generation: 2,
  expected: ['check', 'app'],
  results: [check, app],
  ...over,
});
const line = (value: unknown) => `Verification: ${JSON.stringify(value)}`;

describe('a task’s verification evidence', () => {
  it('parses a one-line proof and accepts every required pass for the current inputs', () => {
    const parsed = verificationOf(`Finished the work.\n${line(proof())}\nNote: Everything works together.`);
    expect(parsed).toEqual(proof());
    expect(verificationPassed(parsed, inputs, 2)).toBe(true);
  });

  it('does not treat a short success statement, an empty answer or malformed JSON as evidence', () => {
    for (const answer of [null, '', 'Checks: passing', 'Verification: {broken', line({ revision })])
      expect(verificationOf(answer)).toBeNull();
    expect(verificationPassed(null, inputs, 2)).toBe(false);
  });

  it('uses the last proof, including a malformed last proof, instead of an earlier pass', () => {
    const failing = proof({ results: [{ name: 'check', revision, state: 'failing' }] });
    expect(verificationOf(`${line(proof())}\n${line(failing)}`)).toEqual(failing);
    expect(verificationPassed(verificationOf(`${line(proof())}\n${line(failing)}`), inputs, 2)).toBe(false);
    expect(verificationOf(`${line(proof())}\nVerification: {unfinished`)).toBeNull();
  });

  it.each(['failing', 'running', 'missing'] as const)('refuses a required check that is %s', (state) => {
    const evidence = proof({ results: [{ name: 'check', revision, state }, app] });
    expect(verificationPassed(evidence, inputs, 2)).toBe(false);
  });

  it('refuses a missing required context or a result from a different revision', () => {
    expect(verificationPassed(proof({ results: [check] }), inputs, 2)).toBe(false);
    expect(
      verificationPassed(
        proof({ results: [{ name: 'check', revision: base, state: 'passing' }, app] }),
        inputs,
        2,
      ),
    ).toBe(false);
  });

  it('refuses duplicate expected contexts and duplicate results for a required context', () => {
    expect(verificationOf(line(proof({ expected: ['check', 'check'] })))).toBeNull();
    expect(verificationPassed(proof({ results: [...proof().results, check] }), inputs, 2)).toBe(false);
    expect(verificationOf(line(proof({ expected: ['check', ' check '] })))).toBeNull();
  });

  it('requires an explicit, consistent declaration when a repository has no checks', () => {
    const empty = proof({ expected: [], results: [] });
    expect(verificationOf(line(empty))).toBeNull();
    expect(verificationPassed(empty, inputs, 2)).toBe(false);
    expect(verificationPassed({ ...empty, noChecks: true }, inputs, 2)).toBe(true);
    expect(verificationOf(line({ ...empty, noChecks: true, results: proof().results }))).toBeNull();
    expect(verificationOf(line(proof({ noChecks: true })))).toBeNull();
  });

  it('refuses old generations, stale inputs and invalid revision or digest shapes', () => {
    expect(verificationPassed(proof(), inputs, 1)).toBe(false);
    expect(verificationPassed(proof(), 'd'.repeat(64), 2)).toBe(false);
    for (const invalid of [
      proof({ revision: 'short' }),
      proof({ base: 'not-a-commit' }),
      proof({ inputs: 'not-a-digest' }),
      proof({ generation: -1 }),
      proof({ generation: 1.5 }),
    ])
      expect(verificationOf(line(invalid))).toBeNull();
  });

  it('refuses empty context names and more than a hundred contexts or results', () => {
    expect(verificationOf(line(proof({ expected: ['   '] })))).toBeNull();
    expect(verificationOf(line(proof({ results: [{ name: '', revision, state: 'passing' }] })))).toBeNull();
    expect(
      verificationOf(line(proof({ expected: Array.from({ length: 101 }, (_, n) => `check-${n}`) }))),
    ).toBeNull();
    expect(verificationOf(line(proof({ results: Array(101).fill(check) })))).toBeNull();
  });
});

const task = (id: string, over: Partial<Parameters<typeof inputFingerprint>[0][number]> = {}) => ({
  id,
  kind: 'task',
  attempt: 1,
  pr: `https://github.com/example/project/pull/${id}`,
  branch: `delegate/${id}`,
  answer: 'Finished the task.\nChecks: passing',
  mergeState: 'waiting',
  picked: true,
  ...over,
});

describe('the input fingerprint', () => {
  it('is stable across task ordering and ignores the final check itself', () => {
    const a = task('a');
    const b = task('b');
    expect(inputFingerprint([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(inputFingerprint([b, a, task('final', { kind: 'final' })])).toBe(inputFingerprint([a, b]));
  });

  it('changes when work is added, retried, changed, kept open, selected or removed', () => {
    const a = task('a');
    const before = inputFingerprint([a]);
    for (const change of [
      { attempt: 2 },
      { pr: 'https://github.com/example/project/pull/other' },
      { branch: 'delegate/retried' },
      { answer: 'A new answer after more work.' },
      { mergeState: 'kept' },
      { picked: false },
    ])
      expect(inputFingerprint([{ ...a, ...change }])).not.toBe(before);
    expect(inputFingerprint([a, task('b')])).not.toBe(before);
    expect(inputFingerprint([])).not.toBe(before);
  });

  it('stays valid when the checked work is merged or transient progress changes', () => {
    const a = task('a');
    const before = inputFingerprint([a]);
    const merged = { ...a, mergeState: 'merged', state: 'done', checks: 'passing', mergeAnswer: 'Merged.' };
    const checking = { ...a, mergeState: 'merging', state: 'working', checks: 'running' };
    expect(inputFingerprint([merged])).toBe(before);
    expect(inputFingerprint([checking])).toBe(before);
  });
});
