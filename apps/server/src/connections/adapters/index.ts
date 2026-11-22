/** The server adapters by catalog id (docs/decisions/connections-catalog.md CX-34): which typed tools run where. */

import { DROPBOX_FILES } from './files-dropbox';
import { NEXTCLOUD_FILES } from './files-nextcloud';
import { PS5_ADAPTER } from './ps5';
import { PS5_CALL_WORDS } from './ps5-words';
import { TODOIST_TASKS } from './tasks-todoist';
import type { Adapter } from './types';

const ADAPTERS: Readonly<Record<string, Adapter>> = {
  dropbox: DROPBOX_FILES,
  nextcloud: NEXTCLOUD_FILES,
  ps5: PS5_ADAPTER,
  todoist: TODOIST_TASKS,
};

const builtinAdapters = new Map<string, Adapter>();

/** A provisioned builtin's typed tools (registered at startup, so the adapters stay free of import cycles). */
export function registerBuiltinAdapter(catalogId: string, adapter: Adapter): void {
  builtinAdapters.set(catalogId, adapter);
}

/**
 * Plain words for a call of a builtin's tool (one-whombat-servers.md ONE-DH21): `ask` is what the approval says Whombat
 * wants to do (“restart web on pve-02”), `done` what it posts after a yes ran it. Null: the generic words.
 */
export interface CallWords {
  ask(tool: string, args: Readonly<Record<string, unknown>>): string | null;
  /**
   * A sentence the approval card adds after the ask, for what a person must know before saying yes (restarting the
   * server this Whombat runs on: “This Whombat goes down too.”, incus-unraid-server.md IU-S07). Null: nothing.
   */
  note?(tool: string, args: Readonly<Record<string, unknown>>): string | null;
  done?(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    result: { ok: true; isError: boolean; content: string } | { ok: false; message: string },
  ): string | null;
  /**
   * Whether the call starts a task Whombat follows and tells the chat about when it ends (a backup, an install;
   * task-feedback.md TF-05): the agent that asks is told that, not that it is woken with the result.
   */
  startsTask?(tool: string, args: Readonly<Record<string, unknown>>): boolean;
  /**
   * Whether Whombat says what happened after a yes itself (`done`'s words) instead of waking the agent with the result:
   * only where the agent can't carry on after it (a restart of the server this Whombat runs on, task-feedback.md TF-S10).
   */
  saysItself?(tool: string, args: Readonly<Record<string, unknown>>): boolean;
}

const callWords = new Map<string, CallWords>();

export function registerCallWords(catalogId: string, words: CallWords): void {
  callWords.set(catalogId, words);
}

export function callWordsFor(catalogId: string): CallWords | null {
  return callWords.get(catalogId) ?? null;
}

registerCallWords('ps5', PS5_CALL_WORDS);

/**
 * The other connections a builtin's call acts through as well as its own, by id, from its arguments (a Servers backup
 * place on a TrueNAS): a yes to the call is bound to where each of them goes too, and the call signs as each only there.
 */
export type CallReaches = (tool: string, args: Readonly<Record<string, unknown>>) => readonly string[];

const reaches = new Map<string, CallReaches>();

export function registerCallReaches(catalogId: string, fn: CallReaches): void {
  reaches.set(catalogId, fn);
}

/** The ids of the other connections a call of `tool` on a `catalogId` connection acts through (none for most). */
export function callReaches(
  catalogId: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): readonly string[] {
  return reaches.get(catalogId)?.(tool, args) ?? [];
}

/** The adapter of an entry, or null (its typed tools aren't served here). */
export function adapterFor(catalogId: string): Adapter | null {
  return ADAPTERS[catalogId] ?? builtinAdapters.get(catalogId) ?? null;
}
