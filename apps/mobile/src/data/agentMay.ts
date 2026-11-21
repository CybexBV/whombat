/**
 * “What {assistant} may do” on the phone (the shared `agentPermissions` of `@whombat/client`; the web's PermissionsTab):
 * every permission on one page, by thing, in three words — Just watch · Ask me first · Go ahead. What it did first (the
 * Done screen); each server with its word and, where Whombat may change something there, the Ask me first · Go ahead
 * choice (`serverAsksRow`, saved as on the server's page); each connection at the level it was connected with; how many
 * Vault sign-ins it may use; the keys summed up by word, with the commands always allowed and the way to change them in
 * Advanced. It lists what was decided, mostly on cards (“Always allow”, “Don’t ask again”). Pure.
 */
import {
  connectionPermission,
  keysSummary,
  PERMISSION_WORDS,
  type PermissionConnection,
  type PermissionRow,
  type PermissionServer,
  type PermissionWord,
  permissionsText,
  serverPermission,
  settingsKeyRow,
} from '@whombat/client';
import { catalogEntry, type HostAsksFirst, thingId } from '@whombat/core';
import type { Grant } from '@whombat/core/domain';
import { accessDraft, accessOptions, accessView } from './agentSettings';
import { serverAsksRow } from './serverAsks';

/** A server's row: the shared row, its page, and its choice where it has one. */
export interface MayServerRow extends PermissionRow {
  serverId: string;
  /** The server's page (`server:pve-02`). */
  thing: string;
  /** The word as it reads (“Just watch”), shown where there is no choice. */
  wordText: string;
  /** Ask me first · Go ahead; null on a server Whombat only watches (its word only). */
  choice: {
    value: HostAsksFirst;
    options: { value: HostAsksFirst; label: string }[];
    /** The choice for TalkBack: “When Dusty wants to change something on thetitan”. */
    label: string;
  } | null;
  accessibilityLabel: string;
}

/** A connection's row: the shared row, its page and its word. */
export interface MayConnectionRow extends PermissionRow {
  thing: string;
  wordText: string;
  accessibilityLabel: string;
}

/** A list section: its rows, what it says when there are none, and whether it still waits for them. */
export interface MaySection<R> {
  label: string;
  rows: R[];
  /** “No servers yet.” when there are none; null while loading or with rows. */
  empty: string | null;
  loading: boolean;
}

export interface MayView {
  intro: string;
  did: { label: string; title: string; line: string; button: string };
  /** Null on a Whombat without servers to look after. */
  servers: MaySection<MayServerRow> | null;
  /** Null where the connections can't be read. */
  connections: (MaySection<MayConnectionRow> & { how: string | null }) | null;
  /** Null until the Vault answers. */
  signIn: { label: string; title: string; names: string | null; button: string } | null;
  keys: {
    label: string;
    /** “Ask me first:” and the keys it covers, “Deploy · Merge into main”. */
    words: { word: PermissionWord; title: string; labels: string }[];
    /** “2 commands always allowed.”; null while they load. */
    commands: string | null;
    change: string;
  };
}

/** A catalog connection as the list gives it (`connections.list`). */
export interface MayConnection extends Omit<PermissionConnection, 'name'> {
  catalogId: string;
  label?: string | null;
}

/** A Vault entry as the list gives it: on for the assistant or not. */
export interface MayVaultEntry {
  name: string;
  kind: string;
  agentOn: boolean;
}

export interface MayFacts {
  agent: string;
  /** Whether the Whombat looks after servers (`hosts.status`); undefined until it answers. */
  serversPresent: boolean | undefined;
  /** The servers; undefined while they load, null when they can't be read. */
  servers: readonly PermissionServer[] | null | undefined;
  /** The connections; undefined while they load, null when they can't be read. */
  connections: readonly MayConnection[] | null | undefined;
  /** The Vault's entries; undefined until it answers, null when it can't be read. */
  vault: readonly MayVaultEntry[] | null | undefined;
  /** What the assistant holds now. */
  grants: readonly Grant[];
  /** The host has a deploy workflow (the Deploy key's row says when it hasn't). */
  deployWorkflow?: boolean | undefined;
  /** How many commands are always allowed; undefined while they load. */
  commands: number | null | undefined;
}

function serverRow(server: PermissionServer, agent: string): MayServerRow {
  const t = permissionsText(agent);
  const row = serverPermission(server, agent);
  const asks =
    row.word === 'watch'
      ? null
      : serverAsksRow({
          server: server.name,
          asksFirst: server.asksFirst,
          hostsThisWhombat: server.hostsThisWhombat,
          available: true,
        });
  const wordText = PERMISSION_WORDS[row.word];
  return {
    ...row,
    serverId: server.id,
    thing: thingId('server', server.id),
    wordText,
    choice: asks ? { value: asks.value, options: asks.options, label: t.serverLabel(server.name) } : null,
    accessibilityLabel: `${row.title}, ${wordText}. ${row.line}`,
  };
}

function connectionRow(c: MayConnection, agent: string): MayConnectionRow {
  const name = c.label || catalogEntry(c.catalogId)?.name || c.catalogId;
  const row = connectionPermission({ id: c.id, name, access: c.access ?? null }, agent);
  const wordText = PERMISSION_WORDS[row.word];
  return {
    ...row,
    thing: thingId(c.catalogId === 'device' ? 'device' : 'connection', c.id),
    wordText,
    accessibilityLabel: `${row.title}, ${wordText}. ${row.line}`,
  };
}

export function agentMayView(f: MayFacts): MayView {
  const t = permissionsText(f.agent);

  const servers: MayView['servers'] =
    f.serversPresent === false
      ? null
      : {
          label: t.servers,
          rows: (f.servers ?? []).map((s) => serverRow(s, f.agent)),
          empty: f.servers === undefined || (f.servers?.length ?? 0) > 0 ? null : t.serversNone,
          loading: f.servers === undefined,
        };

  const connections: MayView['connections'] =
    f.connections === null
      ? null
      : {
          label: t.connections,
          rows: (f.connections ?? []).map((c) => connectionRow(c, f.agent)),
          empty: f.connections && f.connections.length === 0 ? t.connectionsNone : null,
          loading: f.connections === undefined,
          how: f.connections?.length ? t.connectionsHow : null,
        };

  // The sign-ins it may use: entries on for it, but not the old secrets nothing reads.
  const usable = f.vault ? f.vault.filter((e) => e.agentOn && e.kind !== 'secret') : null;
  const signIn: MayView['signIn'] = usable
    ? {
        label: t.signIn,
        title: t.signInLine(usable.length),
        names: usable.length ? usable.map((e) => e.name).join(' · ') : null,
        button: t.signInButton,
      }
    : null;

  // The risky keys as the keys page shows them, summed up by word.
  const opts = accessOptions();
  const rows = accessView(accessDraft(f.grants, opts), opts, { deployWorkflow: f.deployWorkflow }).rows;
  const words = keysSummary([
    settingsKeyRow(f.grants),
    ...rows.map((r) => ({ label: r.label, tier: r.tier })),
  ]).map(({ word, labels }) => ({
    word,
    title: t.keysLine(word),
    labels: labels.join(' · '),
  }));

  return {
    intro: t.intro,
    did: { label: t.did, title: t.didTitle, line: t.didLine, button: t.didButton },
    servers,
    connections,
    signIn,
    keys: {
      label: t.keys,
      words,
      commands: typeof f.commands === 'number' ? t.commands(f.commands) : null,
      change: t.keysChange,
    },
  };
}
