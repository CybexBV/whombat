import { z } from 'zod';
import { tCore } from '../i18n/catalog.js';
import { AttachmentId, ConversationId, MessageId, PrincipalId, VaultEntryId } from '../ids.js';
import { VAULT_SSH_SERVER_NAME_MAX, VaultEntryKind, VaultEntryName } from '../vault/schemas.js';
import { MessageCard } from './cards.js';
import { RanOn } from './chat-runtime.js';
import { Count, Timestamp } from './common.js';
import { ChatSubject, ThreadSettle } from './conversation.js';
import { JobResult } from './job-result.js';

/**
 * Maximum message length (UTF-16 code units, as `String.length` counts). 8000 until contracts 0.22; 48 000 since
 * 0.23 (CT-151), so an agent's HTML page or a long table fits inline. A message must also stay within
 * {@link MESSAGE_MAX_JSON_BYTES} ({@link messageTextFits}).
 */
export const MESSAGE_MAX_LENGTH = 48_000;

/**
 * Most bytes a message's text may take as a JSON string (UTF-8, quotes and escapes included; CT-151). A message with
 * its envelope, attachments and reactions then stays inside one 64 KiB session message, with 16 KiB to spare (`SESSION_MAX_CONTROL_BYTES`):
 * `messages.send`'s outcome and the `message.created` event carry the whole text. A page larger than this goes as an
 * `.html` attachment (`upload_file`), which clients preview the same way.
 */
export const MESSAGE_MAX_JSON_BYTES = 48 * 1024;

/** The bytes `text` takes as a JSON string (UTF-8, with its quotes and escapes), without building it. */
export function messageTextJsonBytes(text: string): number {
  let n = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09)
      n += 2;
    else if (c < 0x20) n += 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 6; // a lone surrogate is escaped as \uXXXX
    } else if (c >= 0xd800 && c <= 0xdfff) n += 6;
    else n += 3;
  }
  return n;
}

/** Whether `text` fits a message: at most {@link MESSAGE_MAX_LENGTH} characters and {@link MESSAGE_MAX_JSON_BYTES}. */
export function messageTextFits(text: string): boolean {
  return text.length <= MESSAGE_MAX_LENGTH && messageTextJsonBytes(text) <= MESSAGE_MAX_JSON_BYTES;
}

/** The message people see when their text doesn't fit ({@link messageTextFits}), in a locale. */
export function messageTooLong(locale?: string | null): string {
  return tCore(locale, 'message.tooLong');
}

export const MESSAGE_TOO_LONG = messageTooLong('en');

/**
 * A message's text as a command takes it (trimmed; may be empty where attachments stand in for it): within both
 * limits (CT-151). Outputs (`Message.text`) check only the length.
 */
export const MessageTextInput = z
  .string()
  .trim()
  .max(MESSAGE_MAX_LENGTH, MESSAGE_TOO_LONG)
  .refine((t) => messageTextJsonBytes(t) <= MESSAGE_MAX_JSON_BYTES, MESSAGE_TOO_LONG);

/** Text reactions as sf2 pills: "finally · 4", "+1 · 3". */
export const ReactionValue = z.string().trim().min(1).max(32);

export const Reaction = z.object({
  value: ReactionValue,
  count: z.number().int().positive(),
  /** The viewer reacted with this value. */
  mine: z.boolean(),
  principalIds: z.array(PrincipalId),
});
export type Reaction = z.infer<typeof Reaction>;

/**
 * How an attachment can be used, decided from its bytes (never the client's word): `image` (png, jpeg, gif,
 * webp; shown inline and sent to models as image input), `text` (valid UTF-8 without NULs: logs, code,
 * Markdown, JSON, CSV, HTML, SVG), `document` (PDF) and `file` (anything else: download only). A closed set that
 * old clients parse strictly, so it doesn't grow: how a client shows an attachment (an HTML page, an AVIF image, an
 * audio or video player) follows from `contentType` and the name (`attachmentPreview` in `@whombat/core/text`, CT-152).
 */
export const AttachmentKind = z.enum(['image', 'text', 'document', 'file']);
export type AttachmentKind = z.infer<typeof AttachmentKind>;

/**
 * A file on a message. `url` is a stable relative API path (`/api/v1/burrows/{slug}/attachments/{id}`),
 * authorized on every request, never a signed or expiring URL. `contentType` is the sniffed type.
 */
export const Attachment = z.object({
  id: AttachmentId,
  /** Display name: no directories or control characters (docs/decisions/bp-attachments.md). */
  name: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  size: Count,
  url: z.string().min(1).max(2048),
  kind: AttachmentKind.default('file'),
  /** Pixel size of an image (null for other kinds), so clients can lay out before it loads. */
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  /**
   * A smaller copy of a PNG or JPEG image for tiles (0.55, CT-298, Whombat RF-04): the longest side at most
   * `THUMBNAIL_MAX_EDGE` (720) pixels, a stable relative API path (`attachmentThumbnailUrl`, authorized like `url`). Null
   * or absent when there is none (other kinds and formats, not made; an image already within the edge may have none).
   * Clients fall back to `url`. Over a session it is the attachment's `preview` download variant.
   */
  thumbnailUrl: z.string().min(1).max(2048).nullable().optional(),
  /** The thumbnail's pixel size, with `thumbnailUrl`. */
  thumbnailWidth: z.number().int().positive().nullable().optional(),
  thumbnailHeight: z.number().int().positive().nullable().optional(),
  /**
   * Whether a message's file is in its conversation's Files now (0.59, CT-312, Whombat files-space.md FS-14): a file a
   * person sent is, a file an agent posted only once someone saved it (“Save to Files”, `files.save`), and neither once
   * it was removed from Files. Set on the files of messages only; absent elsewhere (show no Save to Files).
   */
  inFiles: z.boolean().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

/** Most quick replies an agent can offer under a message (docs/decisions/rich-messages.md RM-05). */
export const SUGGESTIONS_MAX = 3;

/** One quick reply: the words the reader sends when they tap it (“Archive the two promos”). */
export const Suggestion = z.string().trim().min(1).max(80);

/** Longest note an agent leaves about what its short reply left out (`MessageMore.hint`). */
export const MORE_HINT_MAX = 200;

/**
 * What an agent's short reply left out, offered as “More detail” under it (docs/decisions/concise-replies.md).
 * The agent sets `hint` when it posts; the first person who asks sets `requestedById` / `requestedAt`, and the
 * agent then posts the detail in the same place.
 */
export const MessageMore = z.object({
  /** In the agent's words, for its own next turn: “the two other options and their trade-offs”. */
  hint: z.string().trim().min(1).max(MORE_HINT_MAX),
  requestedById: PrincipalId.nullable(),
  requestedAt: Timestamp.nullable(),
});
export type MessageMore = z.infer<typeof MessageMore>;

/**
 * Where a message's text came from when it isn't simply its author's own words (docs/decisions/feedback.md,
 * review-2 F1). `feedback_assessment`: written by an agent while it assessed a website visitor's report (its thread
 * replies, the rendered summary, its final text) — steerable by the visitor, so every other agent's prompt shows it
 * inside an untrusted-data block, and automations ignore it. `feedback_handoff`: Whombat's fixed text of an approved
 * development handoff; the developer agent gets the report and the assessment as data with it, and automations
 * ignore it too.
 */
export const MessageProvenance = z.enum(['feedback_assessment', 'feedback_handoff']);
export type MessageProvenance = z.infer<typeof MessageProvenance>;

/** Most link previews earlier versions stored under one message (0.26, CT-174). */
export const LINK_PREVIEWS_MAX = 3;
export const LINK_PREVIEW_TITLE_MAX = 200;
export const LINK_PREVIEW_DESCRIPTION_MAX = 300;
export const LINK_PREVIEW_SITE_NAME_MAX = 100;

/**
 * A page's title and description that earlier versions stored under a message for a link in its text (0.26, CT-174;
 * `messages.previews`). Chat shows links in the text only, so nothing shows these; the type stays so stored rows and
 * backup files keep their shape.
 */
export const LinkPreview = z.object({
  /** The link as written in the message: http or https only. */
  url: z.url({ protocol: /^https?$/ }).max(2048),
  title: z.string().min(1).max(LINK_PREVIEW_TITLE_MAX),
  description: z.string().max(LINK_PREVIEW_DESCRIPTION_MAX).nullable(),
  siteName: z.string().max(LINK_PREVIEW_SITE_NAME_MAX).nullable(),
});
export type LinkPreview = z.infer<typeof LinkPreview>;

/**
 * What a secret in a message reads as once the Vault has it (0.112.0, CT-783; Whombat vault-self-serve.md VS-07): six
 * U+2022 bullets in place of every occurrence. Clients render it as text.
 */
export const VAULT_BLANKED = '••••••';

/** Most `vaultSaved` items on one message (CT-783). */
export const MESSAGE_VAULT_SAVES_MAX = 5;

/**
 * What the Vault did with a secret blanked in a message (CT-783): `saved` it is in the person's Vault now (`vault_save`,
 * a new entry or a replaced secret); `used_once` a server's password put an SSH key on that server and was forgotten
 * (`vault_add_server`, VS-11).
 */
export const MESSAGE_VAULT_SAVE_HOWS = ['saved', 'used_once'] as const;
export const MessageVaultSaveHow = z.enum(MESSAGE_VAULT_SAVE_HOWS);
export type MessageVaultSaveHow = z.infer<typeof MessageVaultSaveHow>;

/**
 * One line under a message whose secret was blanked (CT-783; VS-07, VS-11): the entry it went to (or whose key a
 * password put on a server), its kind, how, the server's name for `used_once` (null for `saved`), and when.
 * `vaultSavedLine` writes it: “Saved to your Vault · Plex”, “Used once to put “Servers” on web-1, not kept”.
 */
export const MessageVaultSave = z.object({
  entryId: VaultEntryId,
  name: VaultEntryName,
  kind: VaultEntryKind,
  how: MessageVaultSaveHow,
  server: z.string().min(1).max(VAULT_SSH_SERVER_NAME_MAX).nullable(),
  at: Timestamp,
});
export type MessageVaultSave = z.infer<typeof MessageVaultSave>;

/**
 * A message as clients see it. A thread is the set of messages with `threadRootId = root.id`;
 * the root carries `replyCount`, `lastReplyAt` and the stacked heads (`threadParticipantIds`).
 */
/**
 * The card a message held before it moved to the thread's end (Whombat card-moves.md CM-07): a council's or a
 * checklist's, by its id. Its message now is the thread's message whose card has this kind and id.
 */
export const MovedCard = z.object({
  kind: z.enum(['council', 'delegation']),
  id: z.string().min(1).max(64),
});
export type MovedCard = z.infer<typeof MovedCard>;

export const Message = z.object({
  id: MessageId,
  conversationId: ConversationId,
  authorId: PrincipalId,
  createdAt: Timestamp,
  editedAt: Timestamp.nullable(),
  text: z.string().max(MESSAGE_MAX_LENGTH),
  /** Principals mentioned with `@Name`, in order of first mention. */
  mentions: z.array(PrincipalId),
  card: MessageCard.nullable(),
  /**
   * Quick replies an agent offers with its question; the newest message's show as chips the reader taps to
   * answer (`replySuggestions`). Always empty on people's messages.
   */
  suggestions: z.array(Suggestion).max(SUGGESTIONS_MAX).default([]),
  /** An agent's offer of more detail (`MessageMore`); null on people's messages and complete replies. */
  more: MessageMore.nullable().default(null),
  attachments: z.array(Attachment),
  reactions: z.array(Reaction),
  threadRootId: MessageId.nullable(),
  replyCount: Count,
  lastReplyAt: Timestamp.nullable(),
  /** Up to three repliers for the thread link's stacked heads. */
  threadParticipantIds: z.array(PrincipalId),
  /** Client-generated id echoed back so optimistic messages can be reconciled. */
  clientId: z.string().max(64).nullable(),
  /** Set only on messages whose text isn't simply the author's own (`MessageProvenance`); absent otherwise. */
  provenance: MessageProvenance.nullable().optional(),
  /**
   * A deleted thread root kept for its replies (0.26, CT-173): text, attachments, card and previews are gone and
   * clients show “This message was deleted.”. Absent or null otherwise; a deleted message without replies is removed.
   */
  deletedAt: Timestamp.nullable().optional(),
  /** When a member pinned it (0.26, CT-174); absent or null when it isn't pinned. */
  pinnedAt: Timestamp.nullable().optional(),
  pinnedById: PrincipalId.nullable().optional(),
  /**
   * What the thread is about (0.93, CT-440; Whombat chat-channel.md CHT-05): a server, a connection or a device, set on
   * a thread's first message in Chat only (`chats.start` with a subject), shown as a chip on it. Absent or null
   * otherwise.
   */
  subject: ChatSubject.nullable().optional(),
  /**
   * What answered it (0.96, CT-460; Whombat chat-runtime.md CR-07, CR-08): on an assistant's replies in Chat only — the
   * provider, model, effort and fast replies, and why fast or the model asked for didn't happen. Absent or null on
   * every other message.
   */
  ranOn: RanOn.nullable().optional(),
  /**
   * Secrets in this message the Vault took (0.112, CT-783; Whombat vault-self-serve.md VS-07, VS-11): the text holds
   * `VAULT_BLANKED` where each was, and clients show `vaultSavedLine` for each item under it, linking a `saved` one to
   * its entry (only its owner can open it). Set by the server on the person's message and the assistant's own that held
   * it, sent as `message.updated`; `editedAt` stays. Absent otherwise.
   */
  vaultSaved: z.array(MessageVaultSave).max(MESSAGE_VAULT_SAVES_MAX).optional(),
  /**
   * The thread this message starts is settled (3.8; Whombat chat-settle.md): on a thread's first message in Chat or
   * Feedback only, where the room folds it into one line. Absent or null otherwise.
   */
  settled: ThreadSettle.nullable().optional(),
  /**
   * The council's or checklist's card that was on this message and moved to the thread's end with its next news
   * (Whombat card-moves.md CM-04, CM-07): the message keeps only the agent's words, and clients show a link to where the
   * card is now. Absent or null otherwise.
   */
  movedCard: MovedCard.nullable().optional(),
  /**
   * The council's or Tasks card as it was on this message when it moved on, kept because the person wrote after it
   * (Whombat card-moves.md): clients fold it under the message's words, read-only, with `movedCard`'s link to the
   * newest. Never a live card: its buttons don't show. Absent or null otherwise.
   */
  earlierCard: MessageCard.nullable().optional(),
  /**
   * The message is the result of a job handed to T3 Code (Whombat t3code.md T3-55): its text is T3 Code's report as it
   * wrote it, posted by Whombat in the assistant's name, and this carries the facts and the person's answers
   * (`JobResult`). Clients lay the report out under T3 Code's name; one that doesn't know the field shows the text.
   * The server replaces the text and this when the job runs again and ends (`message.updated`; `editedAt` stays).
   * Absent or null on every other message.
   */
  jobResult: JobResult.nullable().optional(),
});
export type Message = z.infer<typeof Message>;

/** What a deleted thread root shows instead of its text, in a locale. */
export function messageDeletedText(locale?: string | null): string {
  return tCore(locale, 'message.deleted');
}

export const MESSAGE_DELETED_TEXT = messageDeletedText('en');

/** Beside the time of an edited message, in a locale. */
export function messageEditedLabel(locale?: string | null): string {
  return tCore(locale, 'message.edited');
}

export const MESSAGE_EDITED_LABEL = messageEditedLabel('en');

/** Most pinned messages `conversations.pins` lists per conversation, newest pin first (CT-174). */
export const PINS_MAX = 50;

/** Whether a message is a tombstone (a deleted thread root kept for its replies). */
export function isDeletedMessage(m: { deletedAt?: string | null }): boolean {
  return Boolean(m.deletedAt);
}

/** Who is looking at a message, for the edit / delete / pin rules. `role` is the person's role in the burrow. */
export interface MessageViewer {
  id: string;
  kind: 'person' | 'agent';
}

/**
 * Whether the viewer may edit a message (CT-173): people edit their own messages' text; not a card, not a deleted
 * message. An attachment-only message may gain text. Agents don't edit through the API.
 */
export function canEditMessage(
  m: Pick<Message, 'authorId' | 'card'> & { deletedAt?: string | null },
  viewer: MessageViewer | undefined,
): boolean {
  return viewer?.kind === 'person' && m.authorId === viewer.id && !m.card && !m.deletedAt;
}

/**
 * Whether the viewer may delete a message (CT-173): the person deletes any message on their Whombat (since 3.0,
 * CT-1517). Never a message that is already a tombstone; agents don't delete through the API.
 */
export function canDeleteMessage(
  m: Pick<Message, 'authorId'> & { deletedAt?: string | null },
  viewer: MessageViewer | undefined,
): boolean {
  return viewer?.kind === 'person' && !m.deletedAt;
}

/** Whether the viewer may pin or unpin a message (CT-174): any person in the conversation; not a tombstone. */
export function canPinMessage(m: { deletedAt?: string | null }, viewer: MessageViewer | undefined): boolean {
  return viewer?.kind === 'person' && !m.deletedAt;
}

/**
 * Mentions an edit adds (CT-173): ids in `after` that weren't in `before`, in order. Only these are woken (agents) or
 * notified (people), once, like a send; nothing else is sent again.
 */
export function addedMentions(before: readonly string[], after: readonly string[]): string[] {
  const had = new Set(before);
  return [...new Set(after)].filter((id) => !had.has(id));
}

/** "finally · 4" */
export function formatReaction(r: Pick<Reaction, 'value' | 'count'>): string {
  return `${r.value} · ${r.count}`;
}

/** Parses the mock's "finally · 4" form. */
export function parseReaction(text: string): { value: string; count: number } | null {
  const m = /^(.+?) · (\d+)$/.exec(text);
  return m ? { value: m[1] as string, count: Number(m[2]) } : null;
}

/**
 * The quick replies to show under a list of messages (oldest first: one conversation's main list, or one
 * thread): the newest message's, when an agent wrote it and it is not the viewer's own. Anything said after
 * it (the reader's answer, another message, a reply in its thread) retires them, so they never pile up in
 * the history.
 */
export function replySuggestions(
  messages: readonly Pick<Message, 'id' | 'authorId' | 'suggestions' | 'replyCount'>[],
  viewerId: string | undefined,
  isAgent: (principalId: string) => boolean,
): { messageId: string; authorId: string; suggestions: string[] } | null {
  const last = messages.at(-1);
  if (
    !last ||
    last.suggestions.length === 0 ||
    last.replyCount > 0 ||
    last.authorId === viewerId ||
    !isAgent(last.authorId)
  )
    return null;
  return { messageId: last.id, authorId: last.authorId, suggestions: last.suggestions };
}

/** Whether the viewer gets “More detail” under a message: the agent offered it, nobody asked yet, and the viewer is a person. */
export function canAskForMore(
  message: Pick<Message, 'authorId' | 'more'>,
  author: { kind: 'person' | 'agent' | 'system' } | undefined,
  viewer: { id: string; kind: 'person' | 'agent' | 'system' } | undefined,
): boolean {
  if (!message.more || message.more.requestedAt || author?.kind !== 'agent') return false;
  return viewer?.kind === 'person' && viewer.id !== message.authorId;
}

/**
 * What tapping a quick reply sends. In the person's own room with the agent the words as they are (it wakes the agent);
 * in a branch room `@Name` in front, since only a mention wakes it there, unless the words mention it.
 */
export function suggestionMessage(text: string, agentName: string, inAgentDm: boolean): string {
  const name = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (inAgentDm || new RegExp(`(^|[^\\p{L}\\p{N}])@${name}(?![\\p{L}\\p{N}])`, 'u').test(text)) return text;
  return `@${agentName} ${text}`;
}
