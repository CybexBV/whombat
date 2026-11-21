/**
 * Gmail's search words on Email (IMAP) (docs/decisions/connections-more.md CM-25, connections-more-mail.md CM-M03): the
 * words agents already know become one IMAP `SEARCH` in one folder.
 *
 * | words | IMAP |
 * |---|---|
 * | `from:` `to:` `cc:` `bcc:` `subject:` | FROM, TO, CC, BCC, SUBJECT |
 * | `is:unread` `is:read` `is:starred` | UNSEEN, SEEN, FLAGGED (`is:unstarred`: UNFLAGGED) |
 * | `newer_than:7d` `older_than:2m` | SINCE / BEFORE that many days, months (m) or years (y) ago |
 * | `after:` `before:` (`YYYY/MM/DD`, `YYYY-MM-DD`, or Unix seconds) | SINCE / BEFORE |
 * | `has:attachment` | a multipart/mixed message (HEADER Content-Type), the nearest IMAP has |
 * | `in:<folder>`, `label:<folder>` | the folder (default the inbox; `sent`, `drafts`, `trash`, `archive`, `spam` by SPECIAL-USE) |
 * | `"quoted words"`, plain words | TEXT |
 * | `-` before a term | NOT |
 * | `a OR b` | OR |
 *
 * Anything else is searched as words. The folder is chosen afterwards (`folders.ts`); searching never changes a flag.
 */
import type { SearchObject } from 'imapflow';

/** A folder by its SPECIAL-USE role (`\Sent`), or by name (`Receipts`, any case). */
export type FolderPick =
  | { role: 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk' | 'all' | 'flagged' }
  | { name: string };

export interface MailQuery {
  folder: FolderPick;
  criteria: SearchObject;
}

const ROLE_WORDS: Record<string, Extract<FolderPick, { role: string }>['role']> = {
  inbox: 'inbox',
  sent: 'sent',
  sentmail: 'sent',
  drafts: 'drafts',
  draft: 'drafts',
  trash: 'trash',
  bin: 'trash',
  archive: 'archive',
  archived: 'archive',
  spam: 'junk',
  junk: 'junk',
  all: 'all',
  anywhere: 'all',
  allmail: 'all',
  starred: 'flagged',
};

/** One word of a query: an operator with its value, or plain text; `negated` with a leading `-`. */
interface Term {
  key: string | null;
  value: string;
  negated: boolean;
}

/** Splits a query into terms and `OR`s, keeping quoted values whole (`subject:"Q3 plan"`). */
function tokenize(query: string): (Term | 'OR')[] {
  const out: (Term | 'OR')[] = [];
  for (const m of query.matchAll(/(-)?(?:([A-Za-z_]+):)?(?:"([^"]*)"?|(\S+))/g)) {
    const [, minus, key, quoted, plain] = m;
    const value = (quoted ?? plain ?? '').trim();
    if (!key && !minus && quoted === undefined && value === 'OR') out.push('OR');
    else if (value) out.push({ key: key ? key.toLowerCase() : null, value, negated: !!minus });
  }
  return out;
}

const DAY_MS = 86_400_000;

/** `7d`, `2m`, `1y` (Gmail's units) as the date that long before `now`; null when it isn't one. */
function ago(value: string, now: Date): Date | null {
  const m = /^(\d{1,5})([dmy])$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const d = new Date(now.getTime());
  const unit = m[2]?.toLowerCase();
  if (unit === 'd') return new Date(now.getTime() - n * DAY_MS);
  if (unit === 'm') d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d;
}

/** `2026/10/19`, `2026-10-19`, `2026/1/5` or Unix seconds as a date; null otherwise. */
function dateOf(value: string): Date | null {
  const v = value.trim();
  if (/^\d{9,11}$/.test(v)) return new Date(Number(v) * 1000);
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) ? null : d;
}

/** IMAP dates are days: `YYYY-MM-DD` of the date in UTC. */
const day = (d: Date) => d.toISOString().slice(0, 10);

/** One term as search criteria (an operator it doesn't know: its words). */
function criterion(term: Term, now: Date): SearchObject {
  const words = (): SearchObject => ({ text: term.key ? `${term.key}:${term.value}` : term.value });
  if (!term.key) return { text: term.value };
  const value = term.value;
  switch (term.key) {
    case 'from':
    case 'to':
    case 'cc':
    case 'bcc':
    case 'subject':
      return { [term.key]: value };
    case 'is': {
      const v = value.toLowerCase();
      if (v === 'unread') return { seen: false };
      if (v === 'read') return { seen: true };
      if (v === 'starred' || v === 'flagged') return { flagged: true };
      if (v === 'unstarred') return { flagged: false };
      return words();
    }
    case 'newer_than':
    case 'newer': {
      const d = ago(value, now);
      return d ? { since: day(d) } : words();
    }
    case 'older_than':
    case 'older': {
      const d = ago(value, now);
      return d ? { before: day(d) } : words();
    }
    case 'after': {
      const d = dateOf(value);
      return d ? { since: day(d) } : words();
    }
    case 'before': {
      const d = dateOf(value);
      return d ? { before: day(d) } : words();
    }
    case 'has':
      return value.toLowerCase() === 'attachment'
        ? { header: { 'content-type': 'multipart/mixed' } }
        : words();
    default:
      return words();
  }
}

function folderOf(value: string): FolderPick {
  const role = ROLE_WORDS[value.toLowerCase().replace(/[\s_-]+/g, '')];
  return role ? { role } : { name: value };
}

const negate = (c: SearchObject, negated: boolean): SearchObject => (negated ? { not: c } : c);

/**
 * Ands criteria into one SearchObject. IMAP ands every key of a search, but an object holds each key once: a key seen
 * again (two plain words, two `from:`) goes into a nested operand, `or: [rest]` (a one-element OR is its operand) or
 * `not: { not: rest }`, which imapflow puts in parentheses.
 */
export function and(list: SearchObject[]): SearchObject {
  if (list.length === 0) return { all: true };
  const out: SearchObject = {};
  const rest: SearchObject[] = [];
  for (const c of list) {
    if (Object.keys(c).some((k) => k in out)) rest.push(c);
    else Object.assign(out, c);
  }
  if (rest.length === 0) return out;
  const tail = and(rest);
  if (!('or' in out)) return { ...out, or: [tail] };
  if (!('not' in out)) return { ...out, not: { not: tail } };
  return { or: [out], not: { not: tail } };
}

/**
 * The folder and search criteria of a Gmail-style query, at `now` (for `newer_than:`). An empty query lists the inbox.
 */
export function parseMailQuery(query: string, now: Date): MailQuery {
  let folder: FolderPick = { role: 'inbox' };
  const list: SearchObject[] = [];
  let pendingOr = false;
  for (const token of tokenize(query.slice(0, 500))) {
    if (token === 'OR') {
      pendingOr = list.length > 0;
      continue;
    }
    if (token.key === 'in' || token.key === 'label') {
      // `-in:spam` would mean every other folder: IMAP searches one, so it is left out.
      if (!token.negated) folder = folderOf(token.value);
      pendingOr = false;
      continue;
    }
    const c = negate(criterion(token, now), token.negated);
    if (pendingOr) list.push({ or: [list.pop() as SearchObject, c] });
    else list.push(c);
    pendingOr = false;
  }
  return { folder, criteria: and(list) };
}
