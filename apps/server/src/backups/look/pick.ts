/**
 * What the person picked in a look, as the backup file's records (backup-look.md): which collectors run, which of their
 * records go to the restorer, and — once it ran — whether each picked thing came back, was here already or couldn't
 * come back. Pure.
 */
import type { BackupCategoryId } from '@whombat/core';
import type { BackupLookCategory } from '@whombat/protocol/session';

/** One picked thing: its kind and the backup's own id. */
export type PickedItem =
  | { kind: 'thread'; id: string }
  | { kind: 'chat'; id: string }
  | { kind: 'file'; id: string }
  | { kind: 'automation'; id: string }
  | { kind: 'connection'; id: string }
  | { kind: 'account'; id: string }
  | { kind: 'feedback'; id: string }
  | { kind: 'github' }
  | { kind: 'vault'; id: string }
  | { kind: 'notes' }
  | { kind: 'home'; home: 'person' | 'outside' }
  | { kind: 'skills' };

const ID = /^[a-z]{2,4}_[A-Za-z0-9_-]{1,64}$/;

/** The item id's kind and id, or null for one this box doesn't know. */
export function parseItemId(itemId: string): PickedItem | null {
  if (itemId === 'notes') return { kind: 'notes' };
  if (itemId === 'skills') return { kind: 'skills' };
  if (itemId === 'connection:github') return { kind: 'github' };
  if (itemId === 'home:person' || itemId === 'home:outside')
    return { kind: 'home', home: itemId === 'home:person' ? 'person' : 'outside' };
  const at = itemId.indexOf(':');
  if (at < 0) return null;
  const kind = itemId.slice(0, at);
  const id = itemId.slice(at + 1);
  if (!ID.test(id)) return null;
  switch (kind) {
    case 'thread':
    case 'chat':
    case 'file':
    case 'automation':
    case 'connection':
    case 'account':
    case 'feedback':
    case 'vault':
      return { kind, id } as PickedItem;
    default:
      return null;
  }
}

/** The item id of a picked thing (the inverse of `parseItemId`). */
export function itemIdOf(item: PickedItem): string {
  switch (item.kind) {
    case 'notes':
    case 'skills':
      return item.kind;
    case 'github':
      return 'connection:github';
    case 'home':
      return `home:${item.home}`;
    default:
      return `${item.kind}:${item.id}`;
  }
}

/** The look category a picked thing is listed under. */
export function categoryOfItem(item: PickedItem): BackupLookCategory {
  switch (item.kind) {
    case 'thread':
    case 'chat':
      return 'messages';
    case 'file':
      return 'files';
    case 'automation':
      return 'automations';
    case 'connection':
    case 'account':
    case 'feedback':
    case 'github':
      return 'connections';
    case 'vault':
      return 'vault';
    case 'notes':
    case 'home':
      return 'memories';
    case 'skills':
      return 'skills';
  }
}

export interface LookPick {
  /** Categories brought back whole (only what isn't here comes back). */
  whole: Set<BackupLookCategory>;
  items: PickedItem[];
  /** Thread roots, and the conversation each is in (its `conversation` record comes along). */
  threads: Map<string, string>;
  /** Whole conversations (task chats, branch rooms). */
  chats: Set<string>;
  files: Set<string>;
  /** The conversations the picked files are in (the files collector reads Files by conversation). */
  fileConversations: Set<string>;
  automations: Set<string>;
  connections: Set<string>;
  accounts: Set<string>;
  feedback: Set<string>;
  github: boolean;
  vault: Set<string>;
  notes: boolean;
  homes: Set<'person' | 'outside'>;
  skills: boolean;
}

/**
 * The pick from the items (each already found in the backup: a thread with the conversation it is in) and the whole
 * categories.
 */
export function makePick(
  items: readonly { item: PickedItem; conversation?: string | null }[],
  whole: readonly BackupLookCategory[] = [],
): LookPick {
  const pick: LookPick = {
    whole: new Set(whole),
    items: items.map((i) => i.item),
    threads: new Map(),
    chats: new Set(),
    files: new Set(),
    fileConversations: new Set(),
    automations: new Set(),
    connections: new Set(),
    accounts: new Set(),
    feedback: new Set(),
    github: false,
    vault: new Set(),
    notes: false,
    homes: new Set(),
    skills: false,
  };
  for (const { item, conversation } of items) {
    switch (item.kind) {
      case 'thread':
        if (conversation) pick.threads.set(item.id, conversation);
        break;
      case 'chat':
        pick.chats.add(item.id);
        break;
      case 'file':
        pick.files.add(item.id);
        if (conversation) pick.fileConversations.add(conversation);
        break;
      case 'automation':
        pick.automations.add(item.id);
        break;
      case 'connection':
        pick.connections.add(item.id);
        break;
      case 'account':
        pick.accounts.add(item.id);
        break;
      case 'feedback':
        pick.feedback.add(item.id);
        break;
      case 'github':
        pick.github = true;
        break;
      case 'vault':
        pick.vault.add(item.id);
        break;
      case 'notes':
        pick.notes = true;
        break;
      case 'home':
        pick.homes.add(item.home);
        break;
      case 'skills':
        pick.skills = true;
        break;
    }
  }
  return pick;
}

/** The backup file categories whose collectors run for a pick, in the file's order. */
export function pickedCategories(pick: LookPick): BackupCategoryId[] {
  const out = new Set<BackupCategoryId>(pick.whole);
  for (const item of pick.items) out.add(categoryOfItem(item));
  // A thread's or a chat's files come with its messages.
  return (['messages', 'files', 'automations', 'connections', 'vault', 'memories', 'skills'] as const).filter(
    (c) => out.has(c),
  );
}

/**
 * The conversations the collectors read for a pick: those of the picked threads, chats and files, or every one when
 * chats or files come back whole (null).
 */
export function pickedConversations(pick: LookPick): Set<string> | null {
  if (pick.whole.has('messages') || pick.whole.has('files')) return null;
  return new Set([...pick.chats, ...pick.threads.values(), ...pick.fileConversations]);
}

type Rec = { type?: unknown } & Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * Which records of the collectors go to the restorer: the picked things and what belongs to them (a thread's replies
 * and the choice of what answers in it, a chat's canvases and their comments, an account's sign-in app). Stateful in
 * the order the collectors write (a canvas before its comments, accounts before the apps).
 */
export class PickFilter {
  readonly #canvases = new Set<string>();
  readonly #providers = new Set<string>();

  constructor(private readonly pick: LookPick) {}

  keep(category: BackupCategoryId, value: Rec): boolean {
    const p = this.pick;
    if (p.whole.has(category as BackupLookCategory)) return true;
    const type = str(value.type);
    switch (category) {
      case 'messages': {
        const conversation = str(value.conversation);
        if (type === 'conversation') {
          const id = str(value.id) ?? '';
          return p.chats.has(id) || [...p.threads.values()].includes(id);
        }
        if (type === 'message') {
          const id = str(value.id) ?? '';
          const root = str(value.threadRoot);
          return (
            (conversation !== null && p.chats.has(conversation)) ||
            p.threads.has(id) ||
            (root !== null && p.threads.has(root))
          );
        }
        if (type === 'chat_thread_runtime') {
          const root = str(value.root);
          return (
            (conversation !== null && p.chats.has(conversation)) || (root !== null && p.threads.has(root))
          );
        }
        if (type === 'canvas') {
          const keep = conversation !== null && p.chats.has(conversation);
          if (keep) this.#canvases.add(str(value.id) ?? '');
          return keep;
        }
        if (type === 'canvas_comment') return this.#canvases.has(str(value.canvas) ?? '');
        return false;
      }
      case 'files':
        return type === 'file' && p.files.has(str(value.id) ?? '');
      case 'automations':
        if (type === 'automation') return p.automations.has(str(value.id) ?? '');
        // The places automations may send to that the person approved: an automation that comes back may need them.
        return type === 'destination' && p.automations.size > 0;
      case 'connections':
        if (type === 'connection') return p.connections.has(str(value.id) ?? '');
        if (type === 'connector_account') {
          const keep = p.accounts.has(str(value.id) ?? '');
          if (keep) this.#providers.add(str(value.provider) ?? '');
          return keep;
        }
        // The sign-in app a Google or Microsoft account needs (kept as it is when one is here).
        if (type === 'connector_app') return this.#providers.has(str(value.provider) ?? '');
        if (type === 'feedback_source') return p.feedback.has(str(value.id) ?? '');
        if (type === 'github') return p.github;
        return false;
      case 'vault':
        return type === 'vault_entry' && p.vault.has(str(value.id) ?? '');
      case 'memories':
        if (type === 'agent_notes') return p.notes;
        if (type === 'hermes_home') return p.homes.has(value.home as 'person' | 'outside');
        return false;
      case 'skills':
        return type === 'hermes_skills' && p.skills;
      default:
        return false;
    }
  }
}

/** What a restored record did (the restorer's outcome). */
export type Outcome = 'added' | 'updated' | 'unchanged' | 'kept' | 'skipped' | 'detail';

/**
 * The key the restore reports a record's outcome under (null: not one a picked thing is judged by): a message, a file,
 * an automation, a connection of any kind, a Vault entry, the notes, a Hermes home, the skills.
 */
export function outcomeKey(category: BackupCategoryId, value: Rec): string | null {
  const type = str(value.type);
  const id = str(value.id);
  if (category === 'messages' && type === 'message' && id) return `message:${id}`;
  if (category === 'files' && type === 'file' && id) return `file:${id}`;
  if (category === 'automations' && type === 'automation' && id) return `automation:${id}`;
  if (category === 'connections') {
    if (type === 'connection' && id) return `connection:${id}`;
    if (type === 'connector_account' && id) return `account:${id}`;
    if (type === 'feedback_source' && id) return `feedback:${id}`;
    if (type === 'github') return 'connection:github';
  }
  if (category === 'vault' && type === 'vault_entry' && id) return `vault:${id}`;
  if (category === 'memories' && type === 'agent_notes') return 'notes';
  if (category === 'memories' && type === 'hermes_home') return `home:${str(value.home) ?? ''}`;
  if (category === 'skills' && type === 'hermes_skills') return 'skills';
  return null;
}

export type ItemOutcome = 'back' | 'already' | 'not_back';

/**
 * Whether a picked thing came back from its records' outcomes: something of it added (or a Hermes home filled in) is
 * back; nothing added but there already is “already here”; nothing at all couldn't come back.
 */
export function itemOutcome(outcomes: readonly (Outcome | undefined)[]): ItemOutcome {
  if (outcomes.some((o) => o === 'added' || o === 'updated')) return 'back';
  if (outcomes.some((o) => o === 'unchanged' || o === 'kept')) return 'already';
  return 'not_back';
}

/**
 * The outcome keys a picked thing is judged by: a thread's or a chat's messages (from the records that went to the
 * restorer), anything else its own record.
 */
export function keysOfItem(item: PickedItem, messagesOf: (item: PickedItem) => readonly string[]): string[] {
  if (item.kind === 'thread' || item.kind === 'chat') return messagesOf(item).map((id) => `message:${id}`);
  return [itemIdOf(item)];
}
