/**
 * What Dusty remembers in the mock world (contracts 0.125, CT-1200…CT-1206; since 3.0 one person's, CT-1581): Mara's
 * memory in her Hermes profile — what Dusty learned working with her, and about her — and the agent's notes she wrote.
 */
import {
  AGENT_NOTES_MAX,
  type AgentNotes,
  emptyMemoryFile,
  MEMORY_FILE_LIMITS,
  type MemoryFile,
  type MemoryFileView,
  memoryChars,
  memoryEntries,
  memoryFileText,
  type PersonMemory,
} from '@whombat/core/domain';
import { at } from './time.js';

/** A memory file's view of these entries, as the runner reads it. */
export function memoryFileView(
  file: MemoryFile,
  entries: readonly string[],
  updatedAt: string | null,
): MemoryFileView {
  if (entries.length === 0) return emptyMemoryFile(file);
  const text = memoryFileText(memoryEntries(memoryFileText(entries)));
  return {
    text,
    used: memoryChars(text),
    limit: MEMORY_FILE_LIMITS[file],
    version: memoryVersion(text),
    updatedAt,
  };
}

/** A stable stand-in for the file's version (the runner's is a sha256 prefix): 16 hex digits of a simple hash. */
function memoryVersion(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** Mara's memory: what Dusty learned working with her, and about her. */
export const MARA_MEMORY: PersonMemory = {
  memory: memoryFileView(
    'memory',
    [
      'The billing API deploys from main through the deploy workflow; staging first, production after a yes.',
      'Grafana dashboards for billing are in the “Billing” folder.',
      'Home Assistant: the hallway lights are light.hallway; the front door lock always asks first.',
    ],
    at('10:48'),
  ),
  user: memoryFileView(
    'user',
    [
      'Mara Visser; works on billing and the office setup.',
      'Prefers short answers with the next step first.',
    ],
    at('09:12', -2),
  ),
};

/** The agent's notes, as Mara wrote them. */
export const AGENT_NOTES_TEXT =
  'Backups run at 02:00; don’t restart the NAS between 01:30 and 03:00.\nAsk before deploying billing-api to production.';

export const AGENT_NOTES: AgentNotes = {
  text: AGENT_NOTES_TEXT,
  used: [...AGENT_NOTES_TEXT].length,
  limit: AGENT_NOTES_MAX,
  updatedAt: at('16:20', -3),
};
