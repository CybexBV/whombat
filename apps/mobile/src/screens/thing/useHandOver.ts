/**
 * *Ask {assistant} to handle these* on the phone (Whombat handle-it.md): hands everything that needs a look on the thing
 * to the assistant (`looks.handle`) and opens the thread it works in (backup-places.md BPL-15). A Whombat without it,
 * or nothing left to look into, asks today's question in a new chat instead; a failure says so in the toast.
 */
import { lookPlanWords, threadToOpen } from '@whombat/client';
import { useHandleLook } from '@whombat/client/react';
import { useRef } from 'react';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useI18n } from '../../i18n';
import { openHref } from '../../navigation/hooks';
import { showFailure } from '../feedback';

export function useHandOver(thing: string, ask: (question: string) => void): (question: string) => void {
  const { rawLocale } = useI18n();
  const lookPlanWordsHere = lookPlanWords(rawLocale);
  const { slug } = useBurrowBase();
  const question = useRef('');
  const handle = useHandleLook(slug, (outcome, thread) => {
    const open = outcome === 'ok' ? threadToOpen(thread) : null;
    if (open) openHref(open);
    else if (outcome === 'ask') ask(question.current);
    else if (outcome === 'failed') showFailure(lookPlanWordsHere.failed, rawLocale);
  });
  return (q) => {
    question.current = q;
    handle.mutate(thing);
  };
}
