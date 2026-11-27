/**
 * A message as one element for screen readers (VoiceOver, TalkBack): who wrote it, when, and its words in one label
 * (“Mara Okafor, 13:52. Why is pve-02 using so much memory?”), with the swipe's and the hold's actions as its own —
 * Reply, Settle, More, Copy — and one Open action per link in its words, since the words are read as one. The cards,
 * receipts and links under the words stay their own elements. Pure.
 */
import { type Inline, parseMessage, plainMessageText } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import { settleCopy } from './threadSettle';

export interface MessageA11yInput {
  /** Shown above the words; null on the same author's next message. */
  author: string | null;
  time: string | null;
  text: string;
  /** Deleted: the tombstone's words. */
  deleted: boolean;
  pinned: boolean;
}

export interface MessageA11yOptions {
  /** A tap opens its thread (Chat, Feedback): Reply. */
  reply: boolean;
  /** What its swipe settles to: Settle, Open again, or nothing. */
  settle: 'settle' | 'open_again' | null;
  /** It has a menu: More. */
  more: boolean;
  locale?: string | undefined;
}

export type MessageA11yActionName = 'reply' | 'settle' | 'open_again' | 'more' | 'copy' | `link:${number}`;

export interface MessageA11y {
  label: string;
  actions: { name: MessageA11yActionName; label: string }[];
  /** The links in its words, in order, for the `link:n` actions. */
  links: string[];
}

export function messageA11yWords(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    reply: t('data.messageA11y.reply'),
    more: t('data.messageA11y.more'),
    copy: t('data.messageA11y.copy'),
    pinned: t('data.messageA11y.pinned'),
    /** The person's own message in Chat, which shows no name (docs/decisions/chat-threads-cards.md). */
    yours: t('data.messageA11y.yours'),
    open: (what: string) => t('data.messageA11y.open', { what }),
  } as const;
}
export const MESSAGE_A11Y_WORDS = messageA11yWords();

function inlineLinks(nodes: readonly Inline[], out: { href: string; text: string }[]): void {
  for (const n of nodes) {
    if (n.type === 'link') out.push({ href: n.href, text: plainInline(n.children) || n.href });
    else if ('children' in n) inlineLinks(n.children, out);
  }
}

function plainInline(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => ('children' in n ? plainInline(n.children) : 'text' in n ? n.text : ''))
    .join('')
    .trim();
}

/** The links a message's words carry, with their words, in reading order (headings, paragraphs, lists, quotes). */
export function messageLinks(text: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const walk = (blocks: ReturnType<typeof parseMessage>) => {
    for (const b of blocks) {
      if (b.type === 'paragraph' || b.type === 'heading') inlineLinks(b.children, out);
      else if (b.type === 'quote') walk(b.children);
      else if (b.type === 'list') for (const item of b.items) walk(item);
      else if (b.type === 'table')
        for (const row of [b.header, ...b.rows]) for (const cell of row) inlineLinks(cell, out);
    }
  };
  walk(parseMessage(text));
  return out;
}

export function messageA11y(m: MessageA11yInput, o: MessageA11yOptions): MessageA11y {
  const words = m.deleted
    ? m.text
    : plainMessageText(m.text)
        .replace(/\s*\n+\s*/g, ' ')
        .trim();
  const w = messageA11yWords(o.locale);
  const settle = settleCopy(o.locale);
  const head = [m.author, m.time].filter(Boolean).join(', ');
  const label = [head, m.pinned ? w.pinned : null, words].filter(Boolean).join('. ');
  const links = m.deleted ? [] : messageLinks(m.text);
  const actions: MessageA11y['actions'] = [];
  if (o.reply) actions.push({ name: 'reply', label: w.reply });
  if (o.settle === 'settle') actions.push({ name: 'settle', label: settle.swipe });
  if (o.settle === 'open_again') actions.push({ name: 'open_again', label: settle.openAgain });
  if (o.more) actions.push({ name: 'more', label: w.more });
  if (!m.deleted && words) actions.push({ name: 'copy', label: w.copy });
  links.forEach((l, n) => {
    actions.push({ name: `link:${n}`, label: w.open(l.text) });
  });
  return { label, actions, links: links.map((l) => l.href) };
}
