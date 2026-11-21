/**
 * `api.memory.*` for `createFixtureFetch()` (contracts 0.125, CT-1200…CT-1206): Mara's memory and the agent's notes
 * (`memory.ts`), with writes applied to an in-memory copy. Answers follow the contracts: `too_long` over a
 * file's limit, `conflict` for a write based on another version.
 */
import { ERROR_STATUS, SetAgentNotesBody, WriteMemoryBody } from '@whombat/core/contracts';
import {
  emptyMemoryFile,
  MEMORY_FILES,
  type MemoryFile,
  memoryEntries,
  memoryFileProblem,
  type PersonMemory,
} from '@whombat/core/domain';
import { AGENT_NOTES, MARA_MEMORY, memoryFileView } from './memory.js';
import { SEED_NOW } from './time.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function error(
  code: keyof typeof ERROR_STATUS,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, ERROR_STATUS[code]);
}

/** The fixture world's memory: Mara's files and the notes. */
export function createMemoryWorld() {
  return { mine: structuredClone(MARA_MEMORY) as PersonMemory, notes: structuredClone(AGENT_NOTES) };
}

export type MemoryWorld = ReturnType<typeof createMemoryWorld>;

/** Answers a `memory.*` endpoint, or null when `id` is not one. */
export async function handleMemory(
  world: MemoryWorld,
  id: string,
  params: Record<string, string>,
  url: URL,
  req: Request,
): Promise<Response | null> {
  if (!id.startsWith('memory.')) return null;
  const now = SEED_NOW.toISOString();
  switch (id) {
    case 'memory.mine':
      return json(world.mine);
    case 'memory.write': {
      const file = params.file as MemoryFile;
      if (!MEMORY_FILES.includes(file)) return error('not_found', 'No such memory.');
      const parsed = WriteMemoryBody.safeParse(await req.json());
      if (!parsed.success) return error('validation_failed', parsed.error.issues[0]?.message ?? 'Not valid.');
      const current = world.mine[file];
      if (parsed.data.ifVersion !== undefined && parsed.data.ifVersion !== current.version)
        return error('conflict', 'It changed since you opened it.');
      const problem = memoryFileProblem(file, parsed.data.text);
      if (problem) return error('validation_failed', problem, { reason: 'too_long' });
      world.mine = { ...world.mine, [file]: memoryFileView(file, memoryEntries(parsed.data.text), now) };
      return json(world.mine);
    }
    case 'memory.clear': {
      const only = url.searchParams.get('file') as MemoryFile | null;
      const files = only ? [only] : MEMORY_FILES;
      for (const file of files) world.mine = { ...world.mine, [file]: emptyMemoryFile(file) };
      return json(world.mine);
    }
    case 'memory.notes':
      return json(world.notes);
    case 'memory.setNotes': {
      const parsed = SetAgentNotesBody.safeParse(await req.json());
      if (!parsed.success) return error('validation_failed', parsed.error.issues[0]?.message ?? 'Not valid.');
      const text = parsed.data.text;
      world.notes = {
        ...world.notes,
        text,
        used: [...text].length,
        updatedAt: now,
      };
      return json(world.notes);
    }
    default:
      return null;
  }
}

/** Every memory endpoint the fixture fetch serves. */
export const MEMORY_ENDPOINT_IDS = [
  'memory.mine',
  'memory.write',
  'memory.clear',
  'memory.notes',
  'memory.setNotes',
] as const;
