/**
 * What a notification's push says (docs/decisions/notifications.md NT-14…NT-15; contracts CT-286): the title and
 * the start of the text, as two plain lines the phone shows. Pure — `notify()` builds one per inbox row, unless the
 * recipient turned “Show message text in notifications” off; then the phone (and the self-hosted transports) show
 * the generic text for the kind.
 *
 * Every line passes `PushPreview` (`PUSH_PREVIEW_TITLE_RE` / `PUSH_PREVIEW_BODY_RE`): one line, no control, format
 * or surrogate code points, no separator but U+0020, at most 80 / 160 code points.
 */
import {
  PUSH_PREVIEW_BODY_MAX,
  PUSH_PREVIEW_TITLE_MAX,
  type PushKind,
  type PushPreview,
} from '@whombat/control-contracts/device';
import type { PushPayload } from '@whombat/core';
import { isEnglish, type ServerMessageKey, tServer } from '../i18n/catalog';

/** The title when there is nothing else to say (previews off, or a title that sanitized to nothing). */
export const GENERIC_PUSH_TITLE = 'Whombat';

/**
 * The phone's generic line per control `PushKind` (the app's `PUSH_TEXT`, `LiveNotifications.GENERIC_TEXT`): what a
 * push says without a preview. The self-hosted transports use the same words.
 */
export const GENERIC_PUSH_TEXT: Record<PushKind, string> = {
  message: 'An agent has an update for you',
  mention: 'Someone mentioned you',
  approval: 'Something is waiting for your approval',
  run: 'A run has news',
  update: 'Your Whombat has an update',
  backup: 'Your Whombat’s backups need a look',
  security: 'A security change on your Whombat',
  generic: 'Whombat needs you',
};

/** docs/local-ipc.md: the notification kinds as control's generic `PushKind`. */
export function pushKind(kind: PushPayload['kind']): PushKind {
  switch (kind) {
    case 'needs_you':
    case 'approval_updated':
      return 'approval';
    case 'mention':
      return 'mention';
    // A reply in a thread you're in is a message, not a mention (essentials-people.md EP-13).
    case 'agent_update':
    case 'direct':
    case 'reply':
      return 'message';
    case 'run_progress':
      return 'run';
  }
}

/** The generic line for a notification kind (previews off), in the recipient's language. */
export function genericPushText(kind: PushPayload['kind'], locale?: string | null): string {
  const generic = pushKind(kind);
  if (isEnglish(locale)) return GENERIC_PUSH_TEXT[generic];
  return tServer(locale, `managed.push.generic.${generic}` as ServerMessageKey);
}

const DROPPED = /[\p{Cf}\p{Cs}]/u;
const SPACE = /[\p{Cc}\p{Z}\s]/u;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * One preview line of at most `max` code points: whitespace, separators and controls (newlines, tabs, NBSP) become
 * one space, format characters (zero-width joiners, bidi marks, BOM) and lone surrogates go, spaces collapse and the
 * ends are trimmed. A longer line is cut at a character boundary with “…” as its last code point.
 */
export function previewLine(text: string, max: number): string {
  let out = '';
  // `for…of` walks code points; a lone surrogate comes as itself.
  for (const ch of text) {
    if (DROPPED.test(ch)) continue;
    out += SPACE.test(ch) ? ' ' : ch;
  }
  out = out.replace(/ {2,}/g, ' ').trim();
  if (countCodePoints(out) <= max) return out;
  let kept = '';
  let size = 0;
  for (const { segment } of graphemes.segment(out)) {
    const n = countCodePoints(segment);
    if (size + n > max - 1) break;
    kept += segment;
    size += n;
  }
  // A single grapheme longer than the line (a run of combining marks): cut by code point.
  if (kept === '') kept = [...out].slice(0, max - 1).join('');
  return `${kept.trimEnd()}…`;
}

function countCodePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** The title line (never empty: “Whombat” when nothing is left). */
export function previewTitle(text: string): string {
  return previewLine(text, PUSH_PREVIEW_TITLE_MAX) || GENERIC_PUSH_TITLE;
}

/** The text line (may be empty). */
export function previewBody(text: string): string {
  return previewLine(text, PUSH_PREVIEW_BODY_MAX);
}

/** The notification kinds an inbox row has. */
export type NotificationPushKind = 'needs_you' | 'mention' | 'agent_update' | 'direct' | 'reply';

/**
 * Who and where, before sanitizing: “Dusty mentioned you in #general”, “Dusty replied in #general”, “Dusty ·
 * #general”, an agent in its DM just “Dusty”, “Needs you · #general”.
 */
export function notificationPushTitle(
  kind: NotificationPushKind,
  actor: string,
  where: string,
  locale?: string | null,
): string {
  // A notification's place is stored in English (“Direct” for a DM); the reader's language says it.
  const place = where === 'Direct' ? tServer(locale, 'managed.push.direct') : where;
  switch (kind) {
    case 'needs_you':
      return tServer(locale, 'managed.push.needsYou', { where: place });
    case 'mention':
      return tServer(locale, 'managed.push.mention', { actor, where: place });
    case 'reply':
      return tServer(locale, 'managed.push.reply', { actor, where: place });
    case 'direct':
      return `${actor} · ${place}`;
    case 'agent_update':
      return where === 'Direct' ? actor : `${actor} · ${place}`;
  }
}

/** A notification's preview: its title and the start of its text, both valid `PushPreview` lines. */
export function buildPushPreview(input: {
  kind: NotificationPushKind;
  actor: string;
  where: string;
  text: string;
  locale?: string | null;
}): PushPreview {
  return {
    title: previewTitle(
      notificationPushTitle(input.kind, input.actor.trim() || GENERIC_PUSH_TITLE, input.where, input.locale),
    ),
    body: previewBody(input.text),
  };
}

/**
 * Message Markdown with every fenced code block (```…``` or ~~~…~~~, an unclosed one to the end) as “(code)”: a
 * preview never shows code.
 */
export function withoutCodeBlocks(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      // A backtick fence's info string has no backtick (CommonMark).
      if (open?.[1] && !(open[1].startsWith('`') && line.slice(open[0].length).includes('`'))) {
        fence = open[1];
        out.push('(code)');
        continue;
      }
      out.push(line);
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (close?.[1] && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
  }
  return out.join('\n');
}

/** One notification per conversation thread on the phone (NT-15): a channel's main timeline is `main`. */
export function threadPushGroup(conversationId: string, threadRootId: string | null): string {
  return `thread:${conversationId}:${threadRootId ?? 'main'}`;
}

/** One notification per approval on the phone (NT-15); a decided approval's is cleared (NT-16). */
export function approvalPushGroup(approvalId: string): string {
  return `approval:${approvalId}`;
}
