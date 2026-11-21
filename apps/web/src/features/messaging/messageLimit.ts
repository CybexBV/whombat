/**
 * How long a message may be (AP-327): 48 000 characters within 48 KiB of JSON (`messageTextFits`, CT-151).
 */
import { MESSAGE_TOO_LONG, messageTextFits } from '@whombat/core';

/** Whether `text` (trimmed, as sent) may be sent to this Whombat. */
export function messageFits(text: string): boolean {
  return messageTextFits(text);
}

/** What the composer says when the draft doesn't fit. */
export const TOO_LONG_NOTE = MESSAGE_TOO_LONG;
