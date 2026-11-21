/**
 * “What {assistant} may do” (settings-groups.md): every permission the person gave, on one page, by thing,
 * in one vocabulary — **Just watch · Ask me first · Go ahead** — the same words as the servers' choice and the keys'
 * tiers. The page lists what was decided (on cards, with “Always allow” and “Don't ask again”); each row changes where
 * it already could. Pure, shared by the web and the phone.
 */
import {
  CONNECTION_ACCESS_LEVELS,
  type ConnectionAccessLevel,
  HOST_ASKS_FIRST_DEFAULT,
  type HostAsksFirst,
} from '@whombat/core/domain';
import { keyLabel, type Tier } from '@whombat/core/keys';
import { agentWords } from './agentName';

/** The three words. */
export type PermissionWord = 'watch' | 'ask' | 'go';

export const PERMISSION_WORDS: Readonly<Record<PermissionWord, string>> = {
  watch: 'Just watch',
  ask: 'Ask me first',
  go: 'Go ahead',
};

/** A key tier in the three words: Off is Just watch, Ask is Ask me first, On is Go ahead. */
export const TIER_WORD: Readonly<Record<Tier, PermissionWord>> = { cannot: 'watch', ask: 'ask', can: 'go' };

/** A server's choice in the three words: before risky actions is Ask me first, never asking is Go ahead. */
export const ASKS_WORD: Readonly<Record<HostAsksFirst, PermissionWord>> = { risky: 'ask', never: 'go' };

/** A connection's level in the three words: Look only is Just watch, Manage is Go ahead (risky steps still ask). */
export const ACCESS_WORD: Readonly<Record<ConnectionAccessLevel, PermissionWord>> = {
  read: 'watch',
  manage: 'go',
};

/** What a server row needs from the servers list. */
export interface PermissionServer {
  id: string;
  name: string;
  asksFirst?: HostAsksFirst | null;
  /** The server's switches: nothing but checks on is a server Whombat only watches. */
  remoteControl?: { console?: boolean; power?: boolean; manage?: boolean; hostShell?: boolean } | null;
  hostsThisWhombat?: boolean;
}

export interface PermissionConnection {
  id: string;
  name: string;
  access?: ConnectionAccessLevel | null;
}

export interface PermissionRow {
  key: string;
  title: string;
  word: PermissionWord;
  /** What the word means here, in a sentence. */
  line: string;
}

/** A server's row: watched only when none of its switches lets Whombat change anything there. */
export function serverPermission(server: PermissionServer, agent: string): PermissionRow {
  const N = agentWords(agent).Name;
  const rc = server.remoteControl;
  const watchOnly = !!rc && !rc.console && !rc.power && !rc.manage && !rc.hostShell;
  const word: PermissionWord = watchOnly ? 'watch' : ASKS_WORD[server.asksFirst ?? HOST_ASKS_FIRST_DEFAULT];
  const line =
    word === 'watch'
      ? `${N} only looks at how it’s doing.`
      : word === 'ask'
        ? `${N} asks you before commands, restarts, updates and deleting.`
        : server.hostsThisWhombat
          ? `${N} goes ahead and tells you what it did. It always asks before restarting or updating ${server.name}, which runs this Whombat.`
          : `${N} goes ahead and tells you what it did.`;
  return { key: `server:${server.id}`, title: server.name, word, line };
}

/** A connection's row (Look only or Manage, chosen when it was connected). */
export function connectionPermission(conn: PermissionConnection, agent: string): PermissionRow {
  const N = agentWords(agent).Name;
  const level: ConnectionAccessLevel =
    conn.access && (CONNECTION_ACCESS_LEVELS as readonly string[]).includes(conn.access)
      ? conn.access
      : 'manage';
  const word = ACCESS_WORD[level];
  return {
    key: `connection:${conn.id}`,
    title: conn.name,
    word,
    line:
      word === 'watch'
        ? `${N} looks and changes nothing.`
        : `${N} makes changes. Deleting and anything risky still asks you first.`,
  };
}

/**
 * Changing the person's settings as a row of the summary (Whombat assistant-settings.md): “Change settings for you” by
 * the tier of its key (no grant: Just watch). Removing something always asks, whatever it says.
 */
export function settingsKeyRow(grants: readonly { keyId: string; tier: Tier }[]): {
  label: string;
  tier: Tier;
} {
  return {
    label: keyLabel('settings.change'),
    tier: grants.find((g) => g.keyId === 'settings.change')?.tier ?? 'cannot',
  };
}

/** The key rows that are about code (deploying, merging, pushing): a developer's. */
export const DEVELOPER_KEY_ROWS: readonly string[] = ['deploy', 'merge', 'branch.main.push'];

/**
 * The keys' rows summed up by word: “Ask me first: Deploy, Merge into main”. Words without rows are left out; the code
 * rows only where GitHub or website feedback is connected (`developer`), as they mean nothing to anyone else.
 */
export function keysSummary(
  rows: readonly { label: string; tier: Tier; row?: string }[],
  { developer = true }: { developer?: boolean } = {},
): { word: PermissionWord; labels: string[] }[] {
  const by: Record<PermissionWord, string[]> = { go: [], ask: [], watch: [] };
  for (const row of rows) {
    if (!developer && row.row && DEVELOPER_KEY_ROWS.includes(row.row)) continue;
    by[TIER_WORD[row.tier]].push(row.label);
  }
  return (['ask', 'go', 'watch'] as const)
    .filter((w) => by[w].length > 0)
    .map((word) => ({ word, labels: by[word] }));
}

/** The page's words, the assistant by its name. */
export function permissionsText(agent: string) {
  const { Name: N } = agentWords(agent);
  return {
    intro: `${N} learns what you’re happy with as you go: each time you answer “Always allow” or “Don’t ask again”, it shows here.`,
    did: 'WHAT IT DID',
    didTitle: `Everything ${N} did`,
    didLine: 'What it changed for you, newest first. Undo works for a day.',
    didButton: 'See it',
    servers: 'SERVERS',
    serversNone: 'No servers yet.',
    connections: 'CONNECTIONS',
    connectionsNone: 'Nothing connected yet.',
    connectionsHow: 'Chosen when each one was connected. To change it, connect it again.',
    signIn: `WHAT ${N.toUpperCase()} CAN SIGN IN TO`,
    signInLine: (n: number) =>
      n === 0
        ? `${N} can’t use anything in your Vault yet.`
        : `${N} can use ${n === 1 ? '1 sign-in' : `${n} sign-ins`} from your Vault.`,
    signInButton: 'See them',
    network: 'HOME NETWORK',
    keys: 'KEYS',
    keysLine: (word: PermissionWord) => `${PERMISSION_WORDS[word]}:`,
    keysChange: 'Change them',
    commands: (n: number) =>
      n === 0 ? 'No commands always allowed.' : `${n === 1 ? '1 command' : `${n} commands`} always allowed.`,
    /** The commands always allowed, folded under the keys until opened: its name and how many. */
    commandsFold: 'Always allowed commands',
    commandsCount: (n: number) => (n === 0 ? 'none yet' : String(n)),
    serverLabel: (server: string) => `When ${N} wants to change something on ${server}`,
  };
}
