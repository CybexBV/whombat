import { createHash } from 'node:crypto';
import { DelegationVerification } from '@whombat/core';

/** Only the last claim counts: a later failed or malformed attempt cannot reuse an earlier success. */
export function verificationOf(answer: string | null): DelegationVerification | null {
  const lines = answer?.matchAll(/^[\t ]*Verification:[\t ]*(.*)$/gm);
  if (!lines) return null;
  let json: string | undefined;
  for (const line of lines) json = line[1];
  if (json === undefined) return null;
  try {
    const parsed = DelegationVerification.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every required context must report a pass on the checked revision; silence never counts as success. */
export function verificationPassed(
  proof: DelegationVerification | null | undefined,
  expectedInputs: string,
  generation: number,
): boolean {
  const parsed = DelegationVerification.safeParse(proof);
  if (!parsed.success) return false;
  const evidence = parsed.data;
  if (evidence.inputs !== expectedInputs || evidence.generation !== generation) return false;
  if (evidence.expected.length === 0) return evidence.noChecks === true && evidence.results.length === 0;
  const results = new Map<string, number>();
  for (const result of evidence.results) {
    if (result.revision !== evidence.revision || result.state !== 'passing') return false;
    results.set(result.name, (results.get(result.name) ?? 0) + 1);
  }
  return evidence.expected.every((name) => results.get(name) === 1);
}

interface VerificationInputTask {
  id: string;
  kind?: string;
  attempt: number;
  pr: string | null;
  branch: string | null;
  answer: string | null;
  mergeState: string | null;
  picked: boolean;
}

/** Hash the submitted work and the person's choices, which stay stable when that same work is merged. */
export function inputFingerprint(tasks: readonly VerificationInputTask[]): string {
  const inputs = tasks
    .filter((task) => task.kind !== 'final')
    .map((task) => ({
      id: task.id,
      attempt: task.attempt,
      pr: task.pr,
      branch: task.branch,
      answer: task.answer,
      kept: task.mergeState === 'kept',
      picked: task.picked,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}
