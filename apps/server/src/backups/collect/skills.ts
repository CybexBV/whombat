/**
 * Skills (`skills.jsonl`, BF-05; hermes-engine.md HE-41, HE-S123; one-person.md OP-08): the agent's one skills list —
 * built-in, from the hub and learned, with what is off or removed and its bookkeeping — as the runner's archive.
 */
import type { BackupSkillsLine } from '@whombat/core';
import { hermesArchive } from './hermes';
import type { CategoryOut, CollectScope } from './scope';

const rec = (v: BackupSkillsLine) => v as BackupSkillsLine & { type: string } & Record<string, unknown>;

export async function collectSkills(scope: CollectScope, out: CategoryOut): Promise<void> {
  const archive = await hermesArchive(scope, out, { kind: 'skills' }, 'skills');
  if (!archive) return;
  const skills = await scope.source.skillsCount().catch(() => null);
  await out.record(rec({ type: 'hermes_skills', skills: skills ?? 0, archive }));
}
