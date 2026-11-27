/**
 * Overview's *Ask {assistant} to handle it* beside the headline (ui-refresh-status.md): the Inbox's own handle action on
 * the item the headline names. About a server, a connection or a device the assistant takes on everything there and
 * its thread opens; else, or on an older Whombat, the question goes to the thing's own thread.
 */
import { needsYouListIntent, startedChatPath, threadToOpen } from '@whombat/client';
import { useHandleLook, useStartChat, useTheAgent } from '@whombat/client/react';
import type { ChatSubject, NeedsYouItem } from '@whombat/core';
import { useRef, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { useToast } from '../../components/Toast';
import { useNeedsYouWords } from '../../i18n/words';

export function useHandleIt(burrow: string, timeZone: string) {
  const NEEDS_YOU_WORDS = useNeedsYouWords();
  const toast = useToast();
  const navigateHref = useNavigateHref();
  const { words } = useTheAgent(burrow);
  const start = useStartChat(burrow);
  const [busy, setBusy] = useState(false);
  const asked = useRef<{ text: string; subject: ChatSubject | null } | null>(null);
  const ask = async (text: string, subject: ChatSubject | null) => {
    const result = await start.mutateAsync({ text, subject, reuseThread: true });
    if (result.status === 'ok') navigateHref(startedChatPath(result.data));
    else toast.show(NEEDS_YOU_WORDS.failed);
  };
  const handle = useHandleLook(burrow, (outcome, thread) => {
    const question = asked.current;
    asked.current = null;
    setBusy(false);
    const open = outcome === 'ok' ? threadToOpen(thread) : null;
    if (open) navigateHref(open);
    else if (outcome === 'ok') toast.show(NEEDS_YOU_WORDS.handling(words));
    else if (outcome === 'ask' && question) void ask(question.text, question.subject);
    else toast.show(NEEDS_YOU_WORDS.failed);
  });
  const run = (item: NeedsYouItem) => {
    const intent = needsYouListIntent(item, { kind: 'handle' }, Date.now(), timeZone);
    if (!intent) return;
    setBusy(true);
    if (intent.type === 'handle') {
      asked.current = { text: intent.text, subject: intent.subject };
      handle.mutate(intent.key);
    } else if (intent.type === 'ask') {
      void ask(intent.text, intent.subject)
        .catch(() => toast.show(NEEDS_YOU_WORDS.failed))
        .finally(() => setBusy(false));
    } else setBusy(false);
  };
  return { label: NEEDS_YOU_WORDS.handle(words), run, busy };
}
