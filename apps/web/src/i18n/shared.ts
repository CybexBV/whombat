/**
 * The shared packages' words that are English-only there, in the page's language (`liveWords`). Same names and shapes
 * as `@whombat/client`'s, so a screen switches by importing them from here. The English is the packages' own, copied
 * verbatim into `en.ts`.
 */
import {
  type AppPlace,
  type AppPlaceWords,
  agentWords,
  CHAT_WORDS as CHAT_WORDS_EN,
  INBOX_WORDS as INBOX_WORDS_EN,
  PLACES_WORDS as PLACES_WORDS_EN,
  SEARCH_WORDS as SEARCH_WORDS_EN,
  SETTLE_WORDS as SETTLE_WORDS_EN,
} from '@whombat/client';
import { liveTranslator, liveWords } from './live';

/** What every screen calls the places (Chat, Feedback, Overview…). */
export const CHAT_WORDS = liveWords(CHAT_WORDS_EN, 'chat', {
  'chat.feedbackUnread': ['n'],
  'chat.replyTo': ['name'],
});

/** Search's screen. */
export const SEARCH_WORDS: typeof SEARCH_WORDS_EN = Object.defineProperties(
  liveWords(SEARCH_WORDS_EN, 'search', { 'search.loadingTitle': ['q'], 'search.noResultsTitle': ['q'] }),
  {
    results: { enumerable: true, value: (n: number) => liveTranslator().tp('search.results', n) },
    noChats: {
      enumerable: true,
      value: (q: string) =>
        q ? liveTranslator().t('search.noChatsFor', { q }) : liveTranslator().t('search.noChats'),
    },
  },
);

/** The phone-width top bar and its drawer. */
export const PLACES_WORDS: typeof PLACES_WORDS_EN = Object.defineProperties(
  liveWords(PLACES_WORDS_EN, 'places'),
  {
    needYouLabel: { enumerable: true, value: (n: number) => liveTranslator().tp('places.needYouLabel', n) },
    chatUnread: {
      enumerable: true,
      value: (n: number, feedback: boolean) =>
        liveTranslator().tp(feedback ? 'places.chatUnreadFeedback' : 'places.chatUnread', n),
    },
    inboxWaiting: {
      enumerable: true,
      value: (n: number, broken: boolean) =>
        liveTranslator().tp(broken ? 'places.inboxWaitingBroken' : 'places.inboxWaiting', n),
    },
  },
);

/** The Inbox's words. */
export const INBOX_WORDS = liveWords(INBOX_WORDS_EN, 'inbox');

/** Settling threads. */
export const SETTLE_WORDS = liveWords(SETTLE_WORDS_EN, 'settle');

const PLACES: readonly AppPlace[] = [
  'search',
  'chat',
  'inbox',
  'automations',
  'files',
  'vault',
  'usage',
  'settings',
];

/** Each place's name and line, with the assistant by its name, in the page's language. */
export function appPlaceWords(agent: string): Record<AppPlace, AppPlaceWords> {
  const tr = liveTranslator();
  const name = agentWords(agent, tr.tag).Name;
  const out = {} as Record<AppPlace, AppPlaceWords>;
  for (const place of PLACES) {
    out[place] = {
      label: tr.t(`place.${place}.label`),
      line: tr.t(`place.${place}.line`, { agent: name }),
    };
  }
  return out;
}
