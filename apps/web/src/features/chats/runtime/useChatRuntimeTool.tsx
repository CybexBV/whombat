import {
  chatDefaultBody,
  chatMadeDefaultText,
  chatModelsOf,
  chatRuntimeInEffect,
  chatRuntimeRefusalText,
  chatRuntimeShown,
  chatStartRuntime,
  chatThreadChoice,
  chatThreadState,
  modelRuntimeSaved,
} from '@whombat/client';
import { useChatRuntime, useMakeChatDefault, useSetThreadRuntime, useTheAgent } from '@whombat/client/react';
import { type ChatRuntime, type ChatRuntimeView, type Message, modelEffortCopy } from '@whombat/core';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import { useLocaleWords } from '../../../i18n/words';
import { ChatRuntimeButton } from './ChatRuntimeButton';

/** “Make this Neo’s default” (CR-03): the whole choice as the assistant's runtime, then the toast or the refusal. */
function useMakeDefault(burrow: string, view: ChatRuntimeView | undefined, after?: () => void) {
  const MODEL_EFFORT_COPY = useLocaleWords(modelEffortCopy);
  const { agent: assistant } = useTheAgent(burrow);
  const toast = useToast();
  const make = useMakeChatDefault(burrow);
  if (!view || !assistant) return undefined;
  return (runtime: ChatRuntime) => {
    const body = chatDefaultBody(runtime);
    make.make(runtime).then(
      (result) => {
        if (result.status !== 'ok') return void toast.show(chatRuntimeRefusalText(result));
        const saved = result.data.agent.runtime;
        if (!modelRuntimeSaved(body, saved, chatModelsOf(view, runtime.provider)))
          return void toast.show(MODEL_EFFORT_COPY.notSaved);
        toast.show(chatMadeDefaultText(view, saved));
        after?.();
      },
      (error) => toast.show(chatRuntimeRefusalText(error)),
    );
  };
}

export interface TopRuntime {
  /** The button for the Chat's top-level box; null where it doesn't show. */
  tool: ReactNode;
  /** What the next top-level message carries (`SendMessageBody.runtime`); undefined: the assistant's own. */
  runtime: ChatRuntime | undefined;
  /** After sending: back to the assistant's default (CR-02). */
  reset: () => void;
}

/**
 * The Chat's top-level box (CR-01, CR-02; AP-2684, AP-2690): the choice lives in the composer, goes with the next
 * top-level message, and goes back to the assistant's default after sending. Only in the Chat room, with an assistant on
 * Claude Code or ChatGPT.
 */
export function useTopRuntime(burrow: string, inChat: boolean): TopRuntime {
  const { data: view } = useChatRuntime(burrow, null, { enabled: inChat });
  const [draft, setDraft] = useState<ChatRuntime | null>(null);
  const reset = useCallback(() => setDraft(null), []);
  const makeDefault = useMakeDefault(burrow, view, reset);
  const shown = chatRuntimeShown({ room: inChat ? 'chat' : null, view });
  const runtime = shown && view ? chatRuntimeInEffect({ default: view.default }, draft) : null;
  const tool =
    view && runtime ? (
      <ChatRuntimeButton
        view={view}
        runtime={runtime}
        inThread={false}
        onChange={setDraft}
        onMakeDefault={makeDefault}
      />
    ) : null;
  return { tool, runtime: shown ? chatStartRuntime(draft, view) : undefined, reset };
}

/**
 * A Chat thread's reply box (CR-01, CR-02; AP-2682, AP-2690): the thread's own choice, saved at once and applied from
 * its next turn; a refusal puts it back and says why.
 */
export function useThreadRuntimeTool(
  burrow: string,
  rootId: string,
  replies: readonly Pick<Message, 'ranOn'>[],
  inChat: boolean,
): ReactNode {
  const toast = useToast();
  const { data: view } = useChatRuntime(burrow, rootId, { enabled: inChat });
  const set = useSetThreadRuntime(burrow, { onRefused: (text) => toast.show(text) });
  const makeDefault = useMakeDefault(burrow, view);
  const state = useMemo(() => chatThreadState(replies), [replies]);
  if (!view || !chatRuntimeShown({ room: inChat ? 'chat' : null, view })) return null;
  const runtime = chatRuntimeInEffect(view);
  if (!runtime) return null;
  return (
    <ChatRuntimeButton
      view={view}
      runtime={runtime}
      inThread
      threadState={state}
      onChange={(next) => set.mutate({ rootId, runtime: chatThreadChoice(next, view) })}
      onMakeDefault={makeDefault}
    />
  );
}
