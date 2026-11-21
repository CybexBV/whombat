/**
 * The person's Hermes memory (docs/decisions/hermes-engine.md HE-39, HE-S122): `MEMORY.md` (what the agent learned
 * working with them) and `USER.md` (about them) in their Hermes home, read and changed through the runner (HE-38),
 * by the person only (one-person.md OP-08). The account is always the caller's own; nothing here takes another.
 */
import {
  HERMES_MEMORY_DELIMITER,
  HERMES_MEMORY_ENTRIES_MAX,
  HERMES_MEMORY_ENTRY_MAX,
  type HermesMemoryFile,
  type HermesMemoryState,
  MEMORY_VIEW_TEXT_MAX,
  type MemoryFileView,
  type PersonMemory,
} from '@whombat/core';
import { HermesHomeCallError, hermesHome } from '../hermes-home/service';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';

export function fileView(state: HermesMemoryState): MemoryFileView {
  return {
    text: state.entries.join(HERMES_MEMORY_DELIMITER).slice(0, MEMORY_VIEW_TEXT_MAX),
    used: state.chars,
    limit: state.limit,
    version: state.version,
    updatedAt: state.updatedAt,
  };
}

/** The entries of a text as a person wrote it (entries separated by the delimiter; an empty text empties the file). */
export function entriesOf(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split(HERMES_MEMORY_DELIMITER);
}

/** What a refused step means to the person (concise-replies.md: no file names, no codes in the words). */
function refusal(err: unknown, agentName: string): never {
  if (!(err instanceof HermesHomeCallError)) throw err;
  switch (err.code) {
    case 'busy':
      throw new ApiError('conflict', `${agentName} is working for you right now. Try again in a moment.`, {
        details: { reason: 'busy' },
      });
    case 'conflict':
      throw new ApiError(
        'conflict',
        `${agentName} changed this while you were editing. Look again, then save.`,
        {
          details: { reason: 'changed' },
        },
      );
    case 'too_long':
      throw new ApiError(
        'validation_failed',
        'That’s more than this holds. Shorten or remove something first.',
        {
          details: { reason: 'too_long' },
        },
      );
    case 'unavailable':
    case 'unknown_outcome':
      throw new ApiError('unavailable', `${agentName} can’t be reached right now. Try again in a moment.`, {
        details: { reason: err.code },
      });
    default:
      throw new ApiError('internal', 'That didn’t work. Try again in a moment.', {
        details: { reason: 'failed' },
      });
  }
}

export async function readPersonMemory(services: Services, agentName: string): Promise<PersonMemory> {
  const both = await hermesHome(services)
    .call('memory.read', {})
    .catch((err: unknown) => refusal(err, agentName));
  return { memory: fileView(both.memory), user: fileView(both.user) };
}

export async function writePersonMemory(
  services: Services,
  agentName: string,
  change: { file: HermesMemoryFile; text: string; ifVersion?: string },
): Promise<PersonMemory> {
  const entries = entriesOf(change.text);
  if (entries.some((e) => e.length > HERMES_MEMORY_ENTRY_MAX) || entries.length > HERMES_MEMORY_ENTRIES_MAX)
    refusal(new HermesHomeCallError('too_long', 'too long'), agentName);
  await hermesHome(services)
    .call('memory.write', {
      file: change.file,
      entries,
      ...(change.ifVersion !== undefined ? { ifVersion: change.ifVersion } : {}),
    })
    .catch((err: unknown) => refusal(err, agentName));
  return readPersonMemory(services, agentName);
}

export async function clearPersonMemory(
  services: Services,
  agentName: string,
  file?: HermesMemoryFile,
): Promise<PersonMemory> {
  const both = await hermesHome(services)
    .call('memory.clear', file ? { file } : {})
    .catch((err: unknown) => refusal(err, agentName));
  return { memory: fileView(both.memory), user: fileView(both.user) };
}
