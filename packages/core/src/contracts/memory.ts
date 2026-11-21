/**
 * What the agent remembers (contracts 0.125, CT-1200…CT-1206; since 3.0 one person's, CT-1581; Whombat hermes-engine.md
 * HE-38, HE-39, one-person.md OP-08). Spread into `api.memory`.
 *
 * - `memory.mine`, `memory.write`, `memory.clear`: the person's memory in their Hermes profile (`PersonMemory`): what
 *   the agent remembers about working with them (`memory`) and about them (`user`). The server reads and writes it
 *   through the runner (HE-38), never the files.
 * - `memory.notes`, `memory.setNotes`: the agent's notes (`AgentNotes`), which the person writes; they go in the
 *   person's profile's `whombat.md`.
 */
import { z } from 'zod';
import { AgentNotes, AgentNotesText, MEMORY_TEXT_MAX, MemoryFile, PersonMemory } from '../domain/memory.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

/**
 * A new text for one of the memory files (entries separated by `MEMORY_ENTRY_SEPARATOR`; an empty text empties
 * it). `ifVersion` is the file's `version` the edit started from: when the agent changed the file since, the write
 * answers `conflict` and changes nothing.
 */
export const WriteMemoryBody = z.object({
  text: z.string().max(MEMORY_TEXT_MAX),
  ifVersion: z.string().max(16).optional(),
});
export type WriteMemoryBody = z.input<typeof WriteMemoryBody>;

/** The agent's notes as the person saves them (an empty text clears them). */
export const SetAgentNotesBody = z.object({ text: AgentNotesText });
export type SetAgentNotesBody = z.input<typeof SetAgentNotesBody>;

export const memoryEndpoints = {
  mine: endpoint({
    id: 'memory.mine',
    method: 'GET',
    path: '/burrows/:burrow/memory',
    summary: 'What the agent remembers about working with you and about you, from your Hermes profile.',
    params: B,
    response: PersonMemory,
  }),
  write: endpoint({
    id: 'memory.write',
    method: 'PUT',
    path: '/burrows/:burrow/memory/:file',
    summary:
      'Replace one of the memory files (`memory` or `user`) with a text. Over the file’s limit (Hermes’s count) is `validation_failed` with `details.reason` `too_long`; a file the agent changed since `ifVersion` is `conflict`; while the agent is working, `conflict` with `details.reason` `busy` (try again after).',
    params: B.extend({ file: MemoryFile }),
    body: WriteMemoryBody,
    response: PersonMemory,
  }),
  clear: endpoint({
    id: 'memory.clear',
    method: 'DELETE',
    path: '/burrows/:burrow/memory',
    summary:
      'Forget what the agent remembers about you: both memory files emptied, or only `file`. While the agent is working, `conflict` with `details.reason` `busy`.',
    params: B,
    query: z.object({ file: MemoryFile.optional() }),
    response: PersonMemory,
  }),
  notes: endpoint({
    id: 'memory.notes',
    method: 'GET',
    path: '/burrows/:burrow/agent/notes',
    summary: 'The agent’s notes (Settings → Agent → Notes): what it should know in every chat.',
    params: B,
    response: AgentNotes,
  }),
  setNotes: endpoint({
    id: 'memory.setNotes',
    method: 'PUT',
    path: '/burrows/:burrow/agent/notes',
    summary: 'Replace the agent’s notes (an empty text clears them). The next turn reads them.',
    params: B,
    body: SetAgentNotesBody,
    response: AgentNotes,
  }),
};
