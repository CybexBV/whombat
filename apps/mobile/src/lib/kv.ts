/** Persisted settings keys and the store interface (the secure store in the app, memory in tests). */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Secure-store keys (letters, digits, `.`, `-`, `_` only). */
export const STORAGE_KEYS = {
  /** `system`, `light` or `dark`. */
  theme: 'whombat.theme',
  /** The emoji this person reacted with lately, newest first (essentials AP-507). */
  recentEmoji: 'whombat.recentEmoji',
  /** When the person said “Not now” to turning on notifications; kept on this phone. */
  pushPrompt: 'whombat.pushPrompt',
  /** With two pages, the list's share of the window where the person last left the line between them. */
  pageSplit: 'whombat.pageSplit',
  /** With two pages, `1` while Chat's list is hidden and what is beside it takes the whole width. */
  chatFullWidth: 'whombat.chatFullWidth',
  /** With two pages, the other tabs whose list is hidden while something is open beside it (`Dashboard,Automations`). */
  fullWidthTabs: 'whombat.fullWidthTabs',
  /** `off` while this phone's “Moving faces” is off; absent: on. */
  faceMotion: 'whombat.faceMotion',
} as const;

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}
