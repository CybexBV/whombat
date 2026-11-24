/**
 * An in-memory 1Password for tests (docs/decisions/onepassword-sync.md): vaults with a `contentVersion` that grows with
 * every change, items with versions and times, archiving, a `put` refused for a stale version, “too many requests”,
 * refused tokens, a read-only token, a create that is made but whose answer is lost, items a `get` can't read this
 * time or no longer finds although the list showed them, and a call held until the test lets it go. It speaks `OnePasswordApi`, as the worker's pool does, and records
 * every call (never a value).
 */
import type {
  OnePasswordItem,
  OnePasswordItemField,
  OnePasswordItemOverview,
  OnePasswordNewItem,
  OnePasswordVaultOverview,
  OnePasswordWebsite,
} from '@whombat/core';
import { type OnePasswordApi, OnePasswordError, type OnePasswordFailure } from '../pool';

interface FakeVault {
  id: string;
  title: string;
  contentVersion: number;
  items: Map<string, OnePasswordItem>;
  archived: Map<string, OnePasswordItem>;
}

interface FakeToken {
  vaults: string[];
  readOnly: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * An item as the real SDK sends it back: a field without a section has `sectionId: null`, a field without details
 * `details: null`, an item without a document `document: null` (seen on a real account; a shape that only had
 * `undefined` there once hid a refusal of every new Login).
 */
function asSent(item: OnePasswordItem): OnePasswordItem {
  return {
    ...item,
    fields: item.fields.map((f) => ({ ...f, sectionId: f.sectionId ?? null, details: f.details ?? null })),
    document: item.document ?? null,
  };
}

let seq = 0;
/** An id like 1Password's: 26 lower-case letters and digits. */
export function fakeOnePasswordId(): string {
  seq++;
  return `fake${String(seq).padStart(6, '0')}${Math.random().toString(36).slice(2, 18)}`
    .replace(/[^a-z0-9]/g, '')
    .padEnd(26, 'x')
    .slice(0, 26);
}

export class FakeOnePassword implements OnePasswordApi {
  readonly vaults = new Map<string, FakeVault>();
  readonly tokens = new Map<string, FakeToken>();
  /** Every call, by name (`overview`, `list`, `get`, `create`, `put`, `archive`, `check`). */
  calls: string[] = [];
  /** Every call fails with this until it is set back to null. */
  failAll: OnePasswordFailure | null = null;
  /** The next calls of a name fail with these, one each. */
  readonly failNext = new Map<string, OnePasswordFailure[]>();
  /** The next `create`s are made in the vault, but their answers are lost (the worker died after sending them). */
  loseCreates = 0;
  /** Items a `get` answers as `failed` (1Password couldn't read them this time), as the SDK's batch does. */
  readonly unreadable = new Set<string>();
  /** Items the list still shows but a `get` answers as not found (gone between the two reads). */
  readonly readMissing = new Set<string>();
  /** Every item id a `get` asked for, in order. */
  gets: string[] = [];
  readonly #pauses = new Map<string, { reached: () => void; gate: Promise<void> }>();
  #clock: number;

  /** `clockStart`: when its times start (development's stand-in starts at now, so they stay later than kept ones). */
  constructor(options: { clockStart?: number } = {}) {
    this.#clock = options.clockStart ?? Date.parse('2026-11-24T08:00:00.000Z');
  }

  /** A time 1Password would write: always later than the last. */
  now(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }

  addToken(token: string, vaults: string[], options: { readOnly?: boolean } = {}): void {
    this.tokens.set(token, { vaults, readOnly: options.readOnly ?? false });
  }

  addVault(title: string, id = fakeOnePasswordId()): string {
    this.vaults.set(id, { id, title, contentVersion: 1, items: new Map(), archived: new Map() });
    return id;
  }

  vault(id: string): FakeVault {
    const v = this.vaults.get(id);
    if (!v) throw new Error(`no fake vault ${id}`);
    return v;
  }

  /** An item as the person would make it in 1Password's app. */
  addLogin(
    vaultId: string,
    input: {
      title: string;
      url?: string | null;
      username?: string;
      password?: string;
      totp?: string;
      extra?: OnePasswordItemField[];
      websites?: OnePasswordWebsite[];
    },
  ): OnePasswordItem {
    const fields: OnePasswordItemField[] = [];
    if (input.username !== undefined)
      fields.push({ id: 'username', title: 'username', fieldType: 'Text', value: input.username });
    if (input.password !== undefined)
      fields.push({ id: 'password', title: 'password', fieldType: 'Concealed', value: input.password });
    if (input.totp)
      fields.push({
        id: 'onetimepassword',
        title: 'one-time password',
        sectionId: 'add more',
        fieldType: 'Totp',
        value: input.totp,
      });
    fields.push(...(input.extra ?? []));
    return this.#store(vaultId, {
      title: input.title,
      category: 'Login',
      fields,
      sections: input.totp ? [{ id: 'add more', title: '' }] : [],
      websites:
        input.websites ??
        (input.url ? [{ url: input.url, label: 'website', autofillBehavior: 'AnywhereOnWebsite' }] : []),
      notes: 'Recovery codes: 1111 2222',
      tags: ['work'],
    });
  }

  addApiCredential(
    vaultId: string,
    input: { title: string; hostname?: string; credential?: string; username?: string },
  ): OnePasswordItem {
    const fields: OnePasswordItemField[] = [];
    if (input.credential !== undefined)
      fields.push({ id: 'credential', title: 'credential', fieldType: 'Concealed', value: input.credential });
    if (input.username !== undefined)
      fields.push({ id: 'username', title: 'username', fieldType: 'Text', value: input.username });
    if (input.hostname !== undefined)
      fields.push({ id: 'hostname', title: 'hostname', fieldType: 'Text', value: input.hostname });
    return this.#store(vaultId, {
      title: input.title,
      category: 'ApiCredentials',
      fields,
      sections: [],
      websites: [],
      notes: '',
      tags: [],
    });
  }

  addOther(vaultId: string, title: string, category: string): OnePasswordItem {
    return this.#store(vaultId, {
      title,
      category,
      fields: [],
      sections: [],
      websites: [],
      notes: '',
      tags: [],
    });
  }

  /** The person changes an item in 1Password's app. */
  edit(itemId: string, change: (item: OnePasswordItem) => void): OnePasswordItem {
    const { vault, item } = this.#find(itemId);
    const next = clone(item);
    change(next);
    next.version = item.version + 1;
    next.updatedAt = this.now();
    vault.items.set(itemId, next);
    vault.contentVersion++;
    return clone(next);
  }

  /** The person deletes an item in 1Password (gone from the vault). */
  remove(itemId: string): void {
    const { vault } = this.#find(itemId);
    vault.items.delete(itemId);
    vault.contentVersion++;
  }

  item(itemId: string): OnePasswordItem | undefined {
    for (const v of this.vaults.values()) {
      const found = v.items.get(itemId) ?? v.archived.get(itemId);
      if (found) return clone(found);
    }
    return undefined;
  }

  /** Active items of a vault. */
  items(vaultId: string): OnePasswordItem[] {
    return [...this.vault(vaultId).items.values()].map(clone);
  }

  isArchived(itemId: string): boolean {
    return [...this.vaults.values()].some((v) => v.archived.has(itemId));
  }

  /** A field's value of an item (tests only read what they set). */
  field(itemId: string, id: string): string | undefined {
    return this.item(itemId)?.fields.find((f) => f.id === id)?.value;
  }

  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }

  /**
   * Holds the next call of a name until `release`: `reached` resolves when it arrives (before it is recorded or
   * answered), so a test can change Whombat while a pass waits on 1Password.
   */
  pause(name: string): { reached: Promise<void>; release: () => void } {
    let reached: () => void = () => {};
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#pauses.set(name, { reached, gate });
    return { reached: arrived, release };
  }

  async #held(name: string): Promise<void> {
    const pause = this.#pauses.get(name);
    if (!pause) return;
    this.#pauses.delete(name);
    pause.reached();
    await pause.gate;
  }

  /* OnePasswordApi ----------------------------------------------------------------------------- */

  async check(token: string) {
    await this.#held('check');
    const t = this.#enter('check', token);
    return {
      vaults: t.vaults.map((id) => ({ id, title: this.vault(id).title })),
    };
  }

  async overview(token: string, vaultId: string): Promise<OnePasswordVaultOverview> {
    await this.#held('overview');
    this.#enter('overview', token, vaultId);
    const v = this.vault(vaultId);
    return {
      id: v.id,
      title: v.title,
      description: '',
      vaultType: 'USER_CREATED',
      activeItemCount: v.items.size,
      contentVersion: v.contentVersion,
      attributeVersion: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
  }

  async list(token: string, vaultId: string): Promise<OnePasswordItemOverview[]> {
    await this.#held('list');
    this.#enter('list', token, vaultId);
    return [...this.vault(vaultId).items.values()].map((i) => ({
      id: i.id,
      title: i.title,
      category: i.category,
      vaultId: i.vaultId,
      websites: clone(i.websites),
      tags: [...i.tags],
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      state: 'active',
    }));
  }

  async get(token: string, vaultId: string, itemIds: readonly string[]) {
    await this.#held('get');
    this.#enter('get', token, vaultId);
    if (itemIds.length > 50) throw new OnePasswordError('invalid', 'At most 50 items at once.');
    const v = this.vault(vaultId);
    const items: OnePasswordItem[] = [];
    const missing: string[] = [];
    const failed: string[] = [];
    this.gets.push(...itemIds);
    for (const id of itemIds) {
      const item = v.items.get(id);
      if (this.unreadable.has(id)) failed.push(id);
      else if (item && !this.readMissing.has(id)) items.push(clone(item));
      else missing.push(id);
    }
    return { items, missing, failed };
  }

  async create(token: string, input: OnePasswordNewItem): Promise<OnePasswordItem> {
    await this.#held('create');
    const t = this.#enter('create', token, input.vaultId);
    if (t.readOnly) throw new OnePasswordError('forbidden', 'You do not have permission to create items.');
    const item = this.#store(input.vaultId, clone(input));
    if (this.loseCreates > 0) {
      this.loseCreates--;
      throw new OnePasswordError('stopped', '1Password sync stopped unexpectedly');
    }
    return item;
  }

  async put(token: string, input: OnePasswordItem): Promise<OnePasswordItem> {
    await this.#held('put');
    const t = this.#enter('put', token, input.vaultId);
    if (t.readOnly)
      throw new OnePasswordError('forbidden', 'You do not have permission to update this item.');
    const { vault, item } = this.#find(input.id);
    if (input.version !== item.version)
      throw new OnePasswordError('failed', 'the item has changed since it was read (version conflict)');
    const next = asSent(clone(input));
    next.version = item.version + 1;
    next.updatedAt = this.now();
    next.createdAt = item.createdAt;
    vault.items.set(next.id, next);
    vault.contentVersion++;
    return clone(next);
  }

  async archive(token: string, vaultId: string, itemId: string): Promise<void> {
    await this.#held('archive');
    const t = this.#enter('archive', token, vaultId);
    if (t.readOnly)
      throw new OnePasswordError('forbidden', 'You do not have permission to archive this item.');
    const v = this.vault(vaultId);
    const item = v.items.get(itemId);
    if (!item) throw new OnePasswordError('not_found', 'item not found');
    v.items.delete(itemId);
    v.archived.set(itemId, item);
    v.contentVersion++;
  }

  /* Inside ------------------------------------------------------------------------------------- */

  #enter(name: string, token: string, vaultId?: string): FakeToken {
    this.calls.push(name);
    if (this.failAll) throw new OnePasswordError(this.failAll, `${this.failAll} (fake)`);
    const queued = this.failNext.get(name);
    const next = queued?.shift();
    if (next) throw new OnePasswordError(next, `${next} (fake)`);
    const t = this.tokens.get(token);
    if (!t) throw new OnePasswordError('auth', 'invalid service account token');
    if (vaultId !== undefined && !t.vaults.includes(vaultId))
      throw new OnePasswordError('not_found', 'vault not found');
    return t;
  }

  #find(itemId: string): { vault: FakeVault; item: OnePasswordItem } {
    for (const vault of this.vaults.values()) {
      const item = vault.items.get(itemId);
      if (item) return { vault, item };
    }
    throw new OnePasswordError('not_found', 'item not found');
  }

  #store(
    vaultId: string,
    input: Pick<
      OnePasswordItem,
      'title' | 'category' | 'fields' | 'sections' | 'websites' | 'notes' | 'tags'
    >,
  ): OnePasswordItem {
    const v = this.vault(vaultId);
    const at = this.now();
    const item = asSent({
      id: fakeOnePasswordId(),
      title: input.title,
      category: input.category,
      vaultId,
      fields: clone(input.fields),
      sections: clone(input.sections),
      notes: input.notes,
      tags: [...input.tags],
      websites: clone(input.websites),
      version: 1,
      files: [],
      createdAt: at,
      updatedAt: at,
    });
    v.items.set(item.id, item);
    v.contentVersion++;
    return clone(item);
  }
}
