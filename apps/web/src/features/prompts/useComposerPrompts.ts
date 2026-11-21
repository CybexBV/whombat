import { PROMPT_WORDS } from '@whombat/client';
import type { Prompt, PromptProject } from '@whombat/core';
import { useCallback, useMemo, useState } from 'react';
import type { ComposerPrompts } from '../messaging/Composer';
import { usePromptProjects, usePrompts, useUsePrompt } from './usePrompts';

export interface ComposerPromptsOptions {
  burrow: string;
  /** The person's Chat room; null: prompts aren't offered here. */
  conversationId: string | null | undefined;
  /** In a thread's reply box: its first message, so the prompt's message is a reply there. */
  rootId?: string | null;
  /** After the prompt's message is posted (the room opens its thread, as after sending). */
  onPosted?: (where: { messageId: string; rootId: string }) => void;
}

/**
 * What a Chat composer needs to offer the person's prompts after `/` (docs/app/decisions/prompts-web.md): the list (none
 * on a box without prompts), T3 Code's projects while the picker is open, and using one, whose failure is the composer's
 * notice (`useFailed`).
 */
export function useComposerPrompts({ burrow, conversationId, rootId, onPosted }: ComposerPromptsOptions): {
  prompts: ComposerPrompts | null;
  /** The Whombat has prompts (Save as prompt is offered). */
  available: boolean;
  notice: string | null;
  clearNotice: () => void;
} {
  const offered = !!conversationId;
  const list = usePrompts(burrow, offered);
  const [picker, setPicker] = useState(false);
  const projects = usePromptProjects(burrow, offered && picker);
  const { run } = useUsePrompt(burrow);
  const [notice, setNotice] = useState<string | null>(null);
  const use = useCallback(
    async (prompt: Prompt, project: PromptProject) => {
      if (!conversationId) return false;
      setNotice(null);
      try {
        const where = await run(prompt, { conversationId, rootId }, project);
        onPosted?.(where);
        return true;
      } catch {
        setNotice(PROMPT_WORDS.useFailed);
        return false;
      }
    },
    [conversationId, rootId, run, onPosted],
  );
  const shown = offered && list.prompts.length > 0;
  const prompts = useMemo<ComposerPrompts | null>(
    () => (shown ? { list: list.prompts, projects, onPicker: setPicker, use } : null),
    [shown, list.prompts, projects, use],
  );
  const clearNotice = useCallback(() => setNotice(null), []);
  return { prompts, available: offered && list.available, notice, clearNotice };
}
