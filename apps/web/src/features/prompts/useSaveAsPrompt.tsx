import { PROMPT_WORDS } from '@whombat/client';
import type { Message } from '@whombat/core';
import { type ReactNode, useState } from 'react';
import { useToast } from '../../components/Toast';
import { PromptEditor } from './PromptEditor';

/**
 * “Save as prompt” on the person's own messages (docs/app/decisions/prompts-web.md): the editor with the message's
 * words and a title from their first line; after Save, “Saved to your prompts”. `item` is null for a message that
 * isn't theirs, has no words, or where prompts aren't offered.
 */
export function useSaveAsPrompt(
  burrow: string,
  meId: string | null | undefined,
  offered: boolean,
): {
  item: (m: Message) => { label: string; onSelect: () => void } | null;
  element: ReactNode;
} {
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const item = (m: Message) =>
    offered && meId && m.authorId === meId && m.text.trim() && !m.card
      ? { label: PROMPT_WORDS.saveFromMessage, onSelect: () => setText(m.text) }
      : null;
  const element = (
    <PromptEditor
      burrow={burrow}
      open={text !== null}
      onOpenChange={(open) => {
        if (!open) setText(null);
      }}
      prompt={null}
      fromText={text ?? ''}
      onSaved={() => toast.show(PROMPT_WORDS.saved)}
    />
  );
  return { item, element };
}
