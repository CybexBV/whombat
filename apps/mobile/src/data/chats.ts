/**
 * Starting a thread with the agent on the phone (Whombat one-whombat.md ONE-06; one-whombat-mobile.md AP-1357…;
 * chat-channel.md AP-2455): the sheet's words, which say the assistant's name (assistant-name.md AN-01,
 * assistant-name-mobile.md AP-1534). The task chats' list went with the Chats tab (one-layout-android.md AP-2640). Pure;
 * the sheet is `screens/NewChatSheet.tsx`.
 */

import type { AgentWords } from '@whombat/client';
import type { ChatSubject } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

export function chatsCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    newChat: t('chats.chatsCopy.newChat'),
    newChatField: (w: AgentWords) => w.ask,
    newChatPlaceholder: (w: AgentWords) => w.askPlaceholder,
  } as const;
}
export const CHATS_COPY = chatsCopy();

/** Under “Ask about pve-02” (mock 2): what the agent sees about the subject (“Neo sees …”). */
export function askAboutLine(subject: ChatSubject, w: AgentWords, locale?: string): string {
  return mobileTranslator(locale).t(`data.chats.sees.${subject.kind}`, { name: w.Name });
}
