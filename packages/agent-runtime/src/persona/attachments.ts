/**
 * A message's files in a turn's prompt (Workstream A).
 * `attachmentNote` names a message's files next to its text, with their ids, so the agent can refer to them
 * (and read text ones with `read_attachment`). The attachments section after the prompt says what the turn
 * does with each (`attachmentSection` in ../attachments.ts).
 */
import type { DispatchContext } from '@whombat/core/contracts';
import type { Message } from '@whombat/core/domain';
import { describeAttachment } from '../attachments';

export function attachmentNote(_context: DispatchContext, message: Message): string | null {
  if (!message.attachments.length) return null;
  const files = message.attachments.map((a) => `${describeAttachment(a)} · ${a.id}`);
  return `[${files.length === 1 ? 'file' : 'files'}: ${files.join('; ')}]`;
}
