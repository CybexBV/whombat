/**
 * What the agent remembers (contracts 0.125, CT-1200…CT-1206; since 3.0 one person's, CT-1581; Whombat hermes-engine.md
 * HE-16, HE-19, HE-39, one-person.md OP-08): Hermes keeps it, Whombat shows it and lets you change it. Pure: the files'
 * shapes, their limits and Hermes's way of counting them, and the words you read.
 *
 * - **Your memory** lives in your Hermes profile (Hermes's default one): `memory` (Hermes's `MEMORY.md`, what the agent
 *   learned working with you) and `user` (`USER.md`, about you). Entries are separated by `MEMORY_ENTRY_SEPARATOR`;
 *   Hermes counts the characters of the entries joined by it and refuses a write past the file's limit.
 * - **The agent's notes**: one text you write (Settings → Agent → Notes); Whombat puts it in your profile's
 *   `whombat.md`, never in the profiles of outsiders' turns (OP-17).
 */

import { z } from 'zod';
import { coreTranslator, coreWords } from '../i18n/catalog.js';
import { formatLocaleNumber } from '../i18n/format.js';
import { Count, Timestamp } from './common.js';

/* Your memory ------------------------------------------------------------------------------------------------------ */

/** Hermes's two memory files of a profile, by Hermes's own target names: `memory` (`MEMORY.md`) and `user` (`USER.md`). */
export const MEMORY_FILES = ['memory', 'user'] as const;
export const MemoryFile = z.enum(MEMORY_FILES);
export type MemoryFile = z.infer<typeof MemoryFile>;

/** Each file's limit in characters, as Hermes counts them (`memory.memory_char_limit`, `memory.user_char_limit`). */
export const MEMORY_FILE_LIMITS: Readonly<Record<MemoryFile, number>> = { memory: 2200, user: 1375 };

/** What separates two entries in a memory file (Hermes's `ENTRY_DELIMITER`); an entry may span lines. */
export const MEMORY_ENTRY_SEPARATOR = '\n§\n';

/** The longest text a write takes before it is counted (a file over its limit is refused, CT-1201). */
export const MEMORY_TEXT_MAX = 8000;
/** The longest text a file's view carries (a file written outside Hermes may be over its limit). */
export const MEMORY_VIEW_TEXT_MAX = 65_536;

/**
 * A file's entries as Hermes reads them: split on the whole separator (a bare `§` stays in its entry), each trimmed,
 * empty ones dropped, a repeated entry kept once (the first).
 */
export function memoryEntries(text: string): string[] {
  const entries = text
    .replace(/\r\n?/g, '\n')
    .split(MEMORY_ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(entries)];
}

/** The text of a file with these entries, as Hermes writes it. */
export function memoryFileText(entries: readonly string[]): string {
  return entries.join(MEMORY_ENTRY_SEPARATOR);
}

/** A text as it is stored: its entries (`memoryEntries`) joined again, so what is counted is what Hermes reads. */
export function normalizeMemoryFile(text: string): string {
  return memoryFileText(memoryEntries(text));
}

/** The characters a file's text uses, as Hermes counts them: code points of its entries joined by the separator. */
export function memoryChars(text: string): number {
  return [...normalizeMemoryFile(text)].length;
}

/** Why a text can't be a file's (it is over the file's limit, in Hermes's count), or null. */
export function memoryFileProblem(file: MemoryFile, text: string): string | null {
  const used = memoryChars(text);
  const limit = MEMORY_FILE_LIMITS[file];
  if (used <= limit) return null;
  return `That’s ${thousands(used)} characters; this holds ${thousands(limit)}. Shorten or remove something first.`;
}

/**
 * One memory file as you see it: the text (entries separated by `MEMORY_ENTRY_SEPARATOR`), the characters it
 * uses and its limit (Hermes's count), its version (`ifVersion` of a write; `''` while there is no file) and when it last
 * changed (null: never written).
 */
export const MemoryFileView = z.object({
  /** At most `MEMORY_VIEW_TEXT_MAX`: a file changed outside Hermes may run over its limit (Hermes keeps it, CT-1201). */
  text: z.string().max(MEMORY_VIEW_TEXT_MAX),
  used: Count,
  limit: Count,
  version: z.string().max(16),
  updatedAt: Timestamp.nullable(),
});
export type MemoryFileView = z.infer<typeof MemoryFileView>;

/** Your memory (`memory.mine`): what the agent remembers about working with you, and about you. */
export const PersonMemory = z.object({ memory: MemoryFileView, user: MemoryFileView });
export type PersonMemory = z.infer<typeof PersonMemory>;

/** An empty file's view (`limit` the file's own). */
export function emptyMemoryFile(file: MemoryFile): MemoryFileView {
  return { text: '', used: 0, limit: MEMORY_FILE_LIMITS[file], version: '', updatedAt: null };
}

/* The agent's notes ----------------------------------------------------------------------------------------------- */

/**
 * The longest notes, in characters: they go in your profile's `whombat.md` (the plugin reads at most 4,000 characters of
 * it), next to what Whombat itself says there.
 */
export const AGENT_NOTES_MAX = 1500;

/** The notes' text: trimmed, at most `AGENT_NOTES_MAX` characters (code points); empty clears them. */
export const AgentNotesText = z
  .string()
  .transform((text) => text.replace(/\r\n?/g, '\n').trim())
  .refine((text) => [...text].length <= AGENT_NOTES_MAX, {
    message: `Notes hold at most ${AGENT_NOTES_MAX.toLocaleString('en-US')} characters.`,
  });

/**
 * The agent's notes as you see them (`memory.notes`): the text, its characters and limit, and when it last changed
 * (null: never).
 */
export const AgentNotes = z.object({
  text: z.string(),
  used: Count,
  limit: Count,
  updatedAt: Timestamp.nullable(),
});
export type AgentNotes = z.infer<typeof AgentNotes>;

/* Words ------------------------------------------------------------------------------------------------------------- */

const thousands = (n: number) => n.toLocaleString('en-US');

const MEMORY_COPY_KEYS = [
  'title',
  'intro',
  'memory',
  'memoryHint',
  'user',
  'userHint',
  'empty',
  'edit',
  'save',
  'cancel',
  'clear',
  'clearQuestion',
  'cleared',
  'full',
  'changed',
] as const;

/**
 * Settings → Memory (Whombat concise-replies.md: no file names). `{agent}` is the agent's name (`memoryCopy` fills it
 * in). Shared by web and Android.
 */
export function memoryWords(
  locale?: string | null,
): Readonly<Record<(typeof MEMORY_COPY_KEYS)[number], string>> {
  return coreWords(locale, 'memory', MEMORY_COPY_KEYS);
}

export const MEMORY_COPY = memoryWords('en');

/** `MEMORY_COPY` with the agent's name filled in, in a locale. */
export function memoryCopy(
  agentName: string,
  locale?: string | null,
): { -readonly [K in keyof typeof MEMORY_COPY]: string } {
  return fill(locale ? memoryWords(locale) : MEMORY_COPY, agentName);
}

const NOTES_COPY_KEYS = ['tab', 'title', 'intro', 'placeholder', 'empty', 'edit', 'save', 'cancel'] as const;

/** The agent's notes (Settings → Agent → Notes). `{agent}` is the agent's name (`notesCopy`). */
export function notesWords(
  locale?: string | null,
): Readonly<Record<(typeof NOTES_COPY_KEYS)[number], string>> {
  return coreWords(locale, 'notes', NOTES_COPY_KEYS);
}

export const NOTES_COPY = notesWords('en');

/** `NOTES_COPY` with the agent's name filled in, in a locale. */
export function notesCopy(
  agentName: string,
  locale?: string | null,
): { -readonly [K in keyof typeof NOTES_COPY]: string } {
  return fill(locale ? notesWords(locale) : NOTES_COPY, agentName);
}

/** “1,240 of 2,200 characters” (a file's or the notes' usage line); “1.240 van 2.200 tekens” in Dutch. */
export function memoryUsageText(used: number, limit: number, locale?: string | null): string {
  const tr = coreTranslator(locale);
  const n = (x: number) => formatLocaleNumber(x, tr.locale);
  return tr.t('memory.usage', { used: n(used), limit: n(limit) });
}

function fill<T extends Record<string, string>>(
  copy: T,
  agentName: string,
): { -readonly [K in keyof T]: string } {
  return Object.fromEntries(
    Object.entries(copy).map(([k, v]) => [k, v.replaceAll('{agent}', agentName)]),
  ) as {
    -readonly [K in keyof T]: string;
  };
}
