/**
 * A conversation's Files in a turn (docs/decisions/files-space.md FS-08…FS-10; as built FS-R01…). Provider-neutral and
 * pure: which of the dispatch's Files a turn copies (`planTurnFiles`: newest first, at most `FILES_TURN_FILE_MAX_BYTES`
 * per file and `FILES_TURN_TOTAL_MAX_BYTES` in all, the rest listed with why), and what the user turn says about them
 * (`filesTurnLines`). The system prompt's line is static (`FILES_HOME_LINE`), so the cached prefix stays the same
 * from turn to turn (prompt-efficiency.md PE-02); counts, sizes and names are the turn's.
 */
import {
  type DispatchContext,
  FILES_HOME_LINK,
  FILES_TURN_FILE_MAX_BYTES,
  FILES_TURN_TOTAL_MAX_BYTES,
  type FileRef,
} from '@whombat/core/contracts';
import { fileSize } from './attachments';
import { defuseDelimiters } from './persona/defuse';

/** Where a person's turn finds the Files: `~/files` in the agent's home, read-only (`FILES_HOME_LINK`, OP-S109). */
export const FILES_IN_HOME = `~/${FILES_HOME_LINK}`;

/**
 * The system prompt of a person's turn (FS-10, FS-18): where the conversation's files are and how results go back. Only
 * people put a file into Files (“Save to Files”), so the agent never says it saved one there.
 */
export const FILES_HOME_LINE = `- The conversation’s files (what was shared, posted or saved here) are at ${FILES_IN_HOME}, read-only, in their folders: write what you make elsewhere (~/work). Share a result with upload_file and attach it to your reply; people keep what they want in Files with “Save to Files”.`;

/** Why a file of the conversation isn't at `~/files` this turn. */
export type FileLeftOut = 'too_large' | 'over_total' | 'unavailable' | 'not_listed';

export interface TurnFilesPlan {
  /** Every file of the conversation, and their bytes (also those beyond the dispatch's list). */
  count: number;
  totalBytes: number;
  /** What the turn copies, newest first. */
  included: FileRef[];
  /** What it leaves out, newest first, with why. */
  left: { ref: FileRef; why: Exclude<FileLeftOut, 'not_listed'> }[];
  /** Files beyond the dispatch's list (`truncated`): older than every listed one. */
  notListed: number;
}

/** Newest first; the dispatch's order (the server's) where two were added at the same moment. */
function newestFirst(entries: readonly FileRef[]): FileRef[] {
  return entries
    .map((ref, i) => ({ ref, i, at: Date.parse(ref.addedAt) || 0 }))
    .sort((a, b) => b.at - a.at || a.i - b.i)
    .map((x) => x.ref);
}

/**
 * What a turn copies of its conversation's Files (FS-09): newest first, each up to `fileBytes`, all of them up to
 * `totalBytes`; a file that doesn't fit is left out and the ones after it still may be. Null without Files.
 */
export function planTurnFiles(
  files: DispatchContext['files'],
  bounds: { fileBytes: number; totalBytes: number } = {
    fileBytes: FILES_TURN_FILE_MAX_BYTES,
    totalBytes: FILES_TURN_TOTAL_MAX_BYTES,
  },
): TurnFilesPlan | null {
  if (!files) return null;
  const included: FileRef[] = [];
  const left: TurnFilesPlan['left'] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const ref of newestFirst(files.entries)) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    if (ref.size > bounds.fileBytes) left.push({ ref, why: 'too_large' });
    else if (total + ref.size > bounds.totalBytes) left.push({ ref, why: 'over_total' });
    else {
      included.push(ref);
      total += ref.size;
    }
  }
  return {
    count: Math.max(files.count, seen.size),
    totalBytes: files.totalBytes,
    included,
    left,
    notListed: Math.max(0, files.count - seen.size),
  };
}

/** How many left-out files the user turn names; the rest are counted. */
export const FILES_LEFT_OUT_NAMED = 12;

const plural = (n: number) => (n === 1 ? '1 file' : `${n} files`);

/** A file as the user turn names it: its path in the tree when it has one, else its folder and name. */
function nameOf(ref: FileRef): string {
  return defuseDelimiters(ref.folder ? `${ref.folder}/${ref.name}` : ref.name);
}

function whyText(why: FileLeftOut, bounds: { fileBytes: number; totalBytes: number }): string {
  switch (why) {
    case 'too_large':
      return `larger than the ${fileSize(bounds.fileBytes)} a turn copies`;
    case 'over_total':
      return `past the ${fileSize(bounds.totalBytes)} a turn copies in all, newest first`;
    case 'unavailable':
      return 'it couldn’t be fetched';
    default:
      return 'not listed';
  }
}

/**
 * What the user turn says about the conversation's Files (FS-10):
 * - a person's turn: how many are at `~/files` and their size, and what was left out with why;
 * - any other turn with Files: how many there are, and that `list_files` and `read_attachment` reach them.
 * Nothing when the conversation has no Files (or the server sent none).
 */
export function filesTurnLines(
  plan: TurnFilesPlan | null,
  where: 'home' | null,
  /** What the turn really has: the included files minus those it couldn't fetch or place. */
  placed: { count: number; bytes: number; unavailable: readonly FileRef[] } | null = null,
  bounds: { fileBytes: number; totalBytes: number } = {
    fileBytes: FILES_TURN_FILE_MAX_BYTES,
    totalBytes: FILES_TURN_TOTAL_MAX_BYTES,
  },
): string[] {
  if (!plan || plan.count === 0) return [];
  const all = `${plural(plan.count)}, ${fileSize(plan.totalBytes)}`;
  if (!where)
    return [
      `This conversation’s Files hold ${all}: list_files lists them and read_attachment reads text ones. Other types can’t be opened in this turn; say so if one matters.`,
    ];
  const got = placed ?? {
    count: plan.included.length,
    bytes: plan.included.reduce((n, r) => n + r.size, 0),
    unavailable: [],
  };
  const at = FILES_IN_HOME;
  const lines = [
    got.count === plan.count
      ? `This conversation’s Files: ${all}, all at ${at}.`
      : `This conversation’s Files: ${all}; ${got.count === 0 ? 'none of them is' : `${plural(got.count)} (${fileSize(got.bytes)}) ${got.count === 1 ? 'is' : 'are'}`} at ${at}.`,
  ];
  const missing = new Set(got.unavailable.map((r) => r.id));
  const left: { ref: FileRef; why: FileLeftOut }[] = [
    ...plan.included.filter((r) => missing.has(r.id)).map((ref) => ({ ref, why: 'unavailable' as const })),
    ...plan.left,
  ];
  if (left.length || plan.notListed) {
    const named = left
      .slice(0, FILES_LEFT_OUT_NAMED)
      .map((l) => `${nameOf(l.ref)} (${fileSize(l.ref.size)}, ${whyText(l.why, bounds)})`);
    const more = left.length - named.length + plan.notListed;
    lines.push(
      `Not there in this turn: ${named.join('; ')}${named.length ? (more ? `; and ${more} more` : '') : `${plural(more)}, older ones`}. list_files lists every file; say so when one you need isn’t there, and don’t guess what it contains.`,
    );
  }
  return lines;
}
