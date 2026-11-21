/**
 * Which folder is which on Email (IMAP) (docs/decisions/connections-more.md CM-25…CM-27): the inbox is `INBOX`; Sent,
 * Drafts, Trash, Archive, Spam and All Mail are found by their SPECIAL-USE flag (RFC 6154, or what imapflow read from
 * XLIST and well-known names), else by the names mail programs use. A folder asked for by name matches its whole path or,
 * when that is unique, its last part, in any case.
 *
 * Labels: on IMAP a label is a folder (CM-27). A message's labels are its folder (Gmail's own ids for the special ones:
 * `INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM`; the path for the others) and `STARRED`, `UNREAD`, `DRAFT` from its flags.
 */
import type { FolderPick } from './search';
import type { MailboxInfo } from './session';

export type FolderRole = Extract<FolderPick, { role: string }>['role'];

const SPECIAL_USE: Record<FolderRole, string> = {
  inbox: '\\Inbox',
  sent: '\\Sent',
  drafts: '\\Drafts',
  trash: '\\Trash',
  archive: '\\Archive',
  junk: '\\Junk',
  all: '\\All',
  flagged: '\\Flagged',
};

/** Names mail programs give a folder without SPECIAL-USE, most common first. */
const NAMES: Record<FolderRole, string[]> = {
  inbox: ['inbox'],
  sent: ['sent', 'sent items', 'sent messages', 'sent mail'],
  drafts: ['drafts', 'draft'],
  trash: ['trash', 'deleted items', 'deleted messages', 'bin'],
  archive: ['archive', 'archives'],
  junk: ['junk', 'spam', 'junk e-mail', 'junk email', 'bulk mail'],
  all: ['all mail'],
  flagged: ['starred', 'flagged'],
};

/** The name a role's folder gets when Whombat has to make it (only Archive and Drafts are ever made). */
export const FOLDER_NAMES: Record<'archive' | 'drafts' | 'trash', string> = {
  archive: 'Archive',
  drafts: 'Drafts',
  trash: 'Trash',
};

const lastPart = (m: MailboxInfo) => {
  const parts = m.delimiter ? m.path.split(m.delimiter) : [m.path];
  return (parts[parts.length - 1] ?? m.path).toLowerCase();
};

const usable = (list: readonly MailboxInfo[]) => list.filter((m) => !m.noSelect);

/** The folder of a role, or null when the account has none. */
export function folderByRole(list: readonly MailboxInfo[], role: FolderRole): MailboxInfo | null {
  const folders = usable(list);
  if (role === 'inbox')
    return (
      folders.find((m) => m.path.toUpperCase() === 'INBOX') ?? {
        path: 'INBOX',
        specialUse: '\\Inbox',
        delimiter: '/',
        noSelect: false,
      }
    );
  const flag = SPECIAL_USE[role];
  const bySpecial = folders.find((m) => m.specialUse === flag);
  if (bySpecial) return bySpecial;
  for (const name of NAMES[role]) {
    // `Sent` before `INBOX.Sent`: a top-level folder wins, then one under the inbox (Courier, older Dovecot).
    const found =
      folders.find((m) => m.path.toLowerCase() === name) ?? folders.find((m) => lastPart(m) === name);
    if (found) return found;
  }
  return null;
}

/** A folder by name (whole path, else a unique last part), any case; null when there is none. */
export function folderByName(list: readonly MailboxInfo[], name: string): MailboxInfo | null {
  const folders = usable(list);
  const wanted = name.trim().toLowerCase();
  if (wanted === 'inbox') return folderByRole(list, 'inbox');
  const exact = folders.find((m) => m.path.toLowerCase() === wanted);
  if (exact) return exact;
  const byLast = folders.filter((m) => lastPart(m) === wanted);
  return byLast.length === 1 ? (byLast[0] as MailboxInfo) : null;
}

export function pickFolder(list: readonly MailboxInfo[], pick: FolderPick): MailboxInfo | null {
  return 'role' in pick ? folderByRole(list, pick.role) : folderByName(list, pick.name);
}

/** The role of a folder (by SPECIAL-USE or name), or null for an ordinary one. */
export function roleOf(list: readonly MailboxInfo[], path: string): FolderRole | null {
  for (const role of Object.keys(SPECIAL_USE) as FolderRole[])
    if (folderByRole(list, role)?.path === path) return role;
  return null;
}

const ROLE_LABELS: Partial<Record<FolderRole, string>> = {
  inbox: 'INBOX',
  sent: 'SENT',
  drafts: 'DRAFT',
  trash: 'TRASH',
  junk: 'SPAM',
};

/** A message's labels: its folder (Gmail's id for a special one) and what its flags say. */
export function labelsOf(folderLabel: string, flags: readonly string[]): string[] {
  const has = (f: string) => flags.some((x) => x.toLowerCase() === f.toLowerCase());
  const labels = [folderLabel];
  if (has('\\Flagged')) labels.push('STARRED');
  if (!has('\\Seen')) labels.push('UNREAD');
  if (has('\\Draft') && folderLabel !== 'DRAFT') labels.push('DRAFT');
  return labels.map((l) => l.slice(0, 200));
}

/** The label a folder shows as: Gmail's id for the inbox, Sent, Drafts, Trash and Spam, else its path. */
export function folderLabel(list: readonly MailboxInfo[], path: string): string {
  const role = roleOf(list, path);
  return (role && ROLE_LABELS[role]) || path;
}
