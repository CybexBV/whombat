/**
 * What the assistant may do with each operation of the session allowlist (docs/decisions/assistant-settings.md): one
 * entry per op, like `OPERATION_SAFETY`, so a new op can't be added without saying whether the assistant may read or
 * change it, and where a person finds it in Settings. Pure data: the server enforces it, the assistant's skill is
 * written from it.
 */
import type { SettingsPageId } from './pages.js';

/**
 * - `none`: not a setting (messages, chats, runs, sign-in flows…): the assistant has its own tools for those, or none.
 * - `never`: a setting that stays the person's: the assistant can say where it is, never read or change it through
 *   the settings tools (its own permissions, approvals, devices and passkeys, remote help, secrets).
 * - `read`: the assistant may read it (a read op).
 * - `change`: the assistant may change it as the person asks, as its settings key says (Go ahead · Ask me first · Just
 *   watch).
 * - `ask`: the assistant may change it only after the person's yes on a card, every time, whatever the key says
 *   (destructive changes, and changes that could cut the person off).
 */
export const ASSISTANT_ACCESS = ['none', 'never', 'read', 'change', 'ask'] as const;
export type AssistantAccess = (typeof ASSISTANT_ACCESS)[number];

export interface AssistantSetting {
  readonly access: AssistantAccess;
  /** Where a person finds it (every access but `none`). */
  readonly page?: SettingsPageId;
  /**
   * What it does, as a short imperative phrase in sentence case with no full stop (“Join a Wi-Fi network”, “Turn
   * notifications on or off”): the approval card's title and the assistant's index. Every access but `none`.
   */
  readonly words?: string;
  /**
   * Parts of a `change` op's input the assistant may not set as the key says (`guarded`): by their path in the input
   * (`body.fields`), what a change that sets one is instead. A connection may be renamed while its address and access
   * stay the person's, because a new address is where its stored secret is sent next.
   */
  readonly guard?: Readonly<Record<string, GuardedAccess>>;
}

/** What a guarded part of an input makes the change: it always asks, or it stays the person's. */
export type GuardedAccess = 'ask' | 'never';

const entry = (access: AssistantAccess, page?: SettingsPageId, words?: string): AssistantSetting =>
  Object.freeze({ access, ...(page ? { page } : {}), ...(words ? { words } : {}) });

/** Not a setting. */
export const NONE: AssistantSetting = entry('none');
/** A setting that stays the person's: the assistant only says where it is. */
export const never = (page: SettingsPageId, words: string) => entry('never', page, words);
/** The assistant may read it. */
export const read = (page: SettingsPageId, words: string) => entry('read', page, words);
/** The assistant may change it, as its settings key says. */
export const change = (page: SettingsPageId, words: string) => entry('change', page, words);
/** The assistant may change it only after the person's yes, every time. */
export const ask = (page: SettingsPageId, words: string) => entry('ask', page, words);

/** A `change` whose parts in `guard` always ask or stay the person's when the input sets them. */
export const guarded = (
  setting: AssistantSetting,
  guard: Readonly<Record<string, GuardedAccess>>,
): AssistantSetting => Object.freeze({ ...setting, guard: Object.freeze({ ...guard }) });

/** From least to most held back: what an input's guarded part can raise a change to. */
const STRICTNESS: readonly AssistantAccess[] = ['read', 'change', 'ask', 'never', 'none'];

/** The value at a dotted path of an op's input, undefined when it isn't there. */
function valueAt(input: unknown, path: string): unknown {
  let at: unknown = input;
  for (const part of path.split('.')) {
    if (!at || typeof at !== 'object' || !Object.hasOwn(at, part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/**
 * What the assistant may do with this op and this input: the entry's access, raised by every guarded part the input
 * sets (`connections.update` with a new address stays the person's, with only a new name it is a change).
 */
export function accessForInput(setting: AssistantSetting, input: unknown): AssistantAccess {
  let access = setting.access;
  for (const [path, raised] of Object.entries(setting.guard ?? {}))
    if (valueAt(input, path) !== undefined && STRICTNESS.indexOf(raised) > STRICTNESS.indexOf(access))
      access = raised;
  return access;
}
