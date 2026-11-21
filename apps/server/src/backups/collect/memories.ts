/**
 * Memories (`memories.jsonl`, BF-05; hermes-engine.md HE-39, HE-S115, HE-S123; one-person.md OP-S75): the person's Hermes
 * home — what the agent remembers about working with them and about them, and their sessions — and the outside turns'
 * home (OP-17), each as the runner's archive; and the agent's notes.
 */
import { type BackupMemoriesLine, HERMES_HOMES } from '@whombat/core';
import { agentNotesOf } from '../../memory/notes';
import { hermesArchive } from './hermes';
import type { CategoryOut, CollectScope } from './scope';

const rec = (v: BackupMemoriesLine) => v as BackupMemoriesLine & { type: string } & Record<string, unknown>;

export async function collectMemories(scope: CollectScope, out: CategoryOut): Promise<void> {
  const notes = await agentNotesOf(scope.db, scope.burrow.id);
  if (notes) await out.record(rec({ type: 'agent_notes', text: notes.text, updatedAt: notes.updatedAt }));
  for (const home of HERMES_HOMES) {
    const archive = await hermesArchive(scope, out, { kind: 'profile', home }, 'memories');
    if (archive) await out.record(rec({ type: 'hermes_home', home, archive }));
  }
}
