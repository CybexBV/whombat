/**
 * The Vault's web copy that core doesn't hold (docs/decisions/vault.md VT-70…VT-72; AP-111): form labels, toasts,
 * confirmations and quiet empty states. The page and section words are core's `VAULT_COPY`. Short and plain, the
 * product's curly quotes, apostrophes and middle dots.
 */
import {
  type VaultAuth,
  type VaultAuthType,
  type VaultEntryKind,
  type VaultTemplate,
  vaultEntryLabel,
  vaultSavedIntro,
} from '@whombat/core/vault';
import { currentLocale } from '../../i18n/provider';

export const VAULT_TEXT = {
  loadFailed: 'Couldn’t load your Vault. Try again in a moment.',
  entryFailed: 'Couldn’t load this entry. Try again in a moment.',
  entryGone: 'This entry isn’t in your Vault any more.',
  networksFailed: 'Couldn’t load the home network list.',
  kicker: 'VAULT',
  chooseTemplate: 'What are you adding?',
  change: 'Change',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  checking: 'Checking…',
  edit: 'Edit',
  name: 'Name',
  /** The add form's name: what a person calls the thing (“Printer admin”). */
  whatFor: 'What it’s for',
  address: 'Address',
  /** A website login's address (VT-D28). */
  signInPage: 'Sign-in page',
  signsIn: 'How it signs in',
  headerName: 'Header name',
  queryName: 'Parameter name',
  username: 'Username',
  /** The add form's username while it picks the kind itself: no username means a sign-in key. */
  usernameHint: 'Leave it empty for a sign-in key.',
  /** The add form's address while it picks the kind itself. */
  anyAddressPlaceholder: 'shop.example.com or 192.168.1.20',
  namePlaceholder: {
    mcp: 'Home Assistant',
    token: 'Grafana',
    basic: 'Printer admin',
    login: 'Supplier portal',
    ssh: 'Deploy key',
    secret: 'Weather API key',
  } satisfies Record<VaultTemplate, string>,
  addressPlaceholder: {
    mcp: 'http://homeassistant.local:8123/api/mcp',
    token: 'https://api.example.com/v1',
    basic: 'http://192.168.1.20',
    login: 'https://portal.example.com/sign-in',
    ssh: '',
    secret: '',
  } satisfies Record<VaultTemplate, string>,
  secretLabel: {
    token: 'Sign-in key',
    password: 'Password',
    secret: 'Secret',
    either: 'Password or sign-in key',
  },
  secretPlaceholder: 'Paste it here',
  secretHint: 'Sealed when you save. Nobody can read it back here, not even you.',
  /** The add form's way to a server key in place of a password, and back. */
  pasteKey: 'Paste a server key instead',
  usePassword: 'Use a password instead',
  /** A private key pasted where a password goes: a password field drops its line breaks. */
  keyInPassword: 'That looks like a server key. Use “Paste a server key instead”.',
  serversNext: 'You add its servers next.',
  /** The add form's fold for what only an expert chooses, and the entry's for what only an expert reads. */
  advanced: 'Advanced',
  technical: 'Technical details',
  kind: 'Kind',
  kindAuto: 'Choose for me',
  /** The entry's last fold: removing it, behind its own confirm. */
  danger: 'Danger',
  /** The page's last line, to where the home network ranges are set (What the assistant may do). */
  homeNetworkLink: 'See home network ranges',
  /** A public address needs https; addresses on your network need the home network list (VT-11, VT-12). */
  addressHint: (networks: readonly { cidr: string; ports: readonly number[] }[]) =>
    networks.length
      ? `Public addresses need https. On your network: ${networks
          .map((n) => `${n.cidr} · ${portsText(n.ports)}`)
          .join('; ')}.`
      : 'Public addresses need https. Nothing on your network is on the home network list yet.',
  added: (name: string) => `Added “${name}” to your Vault.`,
  addedChecked: (name: string, summary: string) => `Added “${name}” to your Vault. ${summary}`,
  saved: 'Saved.',
  editAddressHint: 'A new address is checked again before it’s saved.',
  secretReplaced: 'Secret replaced.',
  replaceHint: 'The new secret replaces the old one at once.',
  removed: (name: string) => `Removed “${name}” from your Vault.`,
  /** A `secret` entry packs used before 0.113 (SST-09; AP-4113): kept until you remove it. */
  secretUnused: 'Nothing uses this any more. You can remove it.',
  noUses: 'Not used yet.',
  noTools: 'Check the connection to see its tools.',
  signsInWithNothing: 'Signs in with nothing: no secret to replace.',
  checkFailed: 'Couldn’t check it. Try again in a moment.',
  failed: 'That didn’t go through. Try again in a moment.',
  toolOn: (tool: string) => `${tool} on`,
  details: 'DETAILS',
  networkCidr: 'Network',
  networkPorts: 'Ports',
  networkNote: 'Note',
  cidrPlaceholder: '192.168.1.0/24',
  portsPlaceholder: '80, 8123',
  notePlaceholder: 'Home Assistant and the printer',
  addNetwork: 'Add network',
  networkAdded: (cidr: string) => `Added ${cidr} to the home network list.`,
  networkRemoved: (cidr: string) => `Removed ${cidr} from the home network list.`,
  removeNetworkConfirm: (cidr: string) => `Remove ${cidr}? Vault entries on it can’t be reached from now on.`,
  portsProblem: 'Use 1–16 port numbers, separated by commas.',
  networkAddedBy: (who: string) => `added by ${who}`,
  /** The quiet button under an API entry that is on: its variable in the agent's commands, “Change” opens it (AP-5241). */
  envNameRow: 'Environment variable',
  /** The agent's key from before that covers some of an SSH key's servers only (AP-4002): “Servers · staging”. */
  assistantServers: (names: string) => `Servers · ${names}`,
  /** Removing an SSH key that was in the agent's commands (AC-34, AP-619): the servers still trust its public key. */
  sshRemovedRotate: (agent: string, entry: string) =>
    `${agent} had “${entry}” in its commands and may have kept a copy. Take its public key off your servers to be sure.`,
  /**
   * An SSH key's words that core's `VAULT_SSH_COPY` doesn't hold (VT-S13; AP-598…AP-603): toasts, the confirmations of
   * a new key, the server modal's title and buttons, the key's line under PUBLIC KEY.
   */
  ssh: {
    kicker: 'SSH KEY',
    privateKeyPlaceholder: '-----BEGIN OPENSSH PRIVATE KEY-----',
    origin: { generated: 'made by Whombat', imported: 'your own key' },
    /** An `ssh` entry always has a key; an answer without one says so rather than a blank block. */
    noKey: 'No key yet. Generate one, or use your own.',
    lineCopied: 'Line copied. Add it to ~/.ssh/authorized_keys on every server.',
    /** The key's block: its label, and its plain sentence above its Technical details. */
    keyHeading: 'KEY',
    keyIntro: {
      generated: 'Whombat made this key and keeps it. It never leaves this Whombat.',
      imported: 'Your own key, kept sealed on this Whombat.',
    },
    generateTitle: (name: string) => `Generate a new key for “${name}”?`,
    generateConfirm: 'Generate a new key',
    generated: 'New key made. Put it on your servers again: see Technical details.',
    replaceTitle: (name: string) => `Replace the key of “${name}”?`,
    replaceConfirm: 'Replace the key',
    replaced: 'Key replaced. Put it on your servers again: see Technical details.',
    /** The server modal's kicker: the key it belongs to. */
    serverKicker: (entry: string) => entry.toUpperCase(),
    /** Where a public server may be (VT-S06): the runtime's SSH ports, 22 unless the Whombat allows more. */
    publicHosts: 'Servers on the internet: port 22.',
    serverAdded: (name: string) => `Added ${name}.`,
    serverAddedChecked: (name: string, summary: string) => `Added ${name}. ${summary}`,
    serverRemoved: (name: string) => `Removed ${name}.`,
    portPlaceholder: '22',
    hostPlaceholder: 'web1.example.com',
    namePlaceholder: 'web-1',
    usernamePlaceholder: 'deploy',
    trusting: 'Trusting…',
    trusted: (name: string, summary: string) => `Trusted ${name}. ${summary}`,
    trustedBefore: (fingerprint: string) => `Trusted until now: ${fingerprint}`,
    /** Under Technical details of a key that changed: the new key the server shows. */
    newHostKey: 'New host key',
    done: 'Done',
    serversLabel: (agent: string) => `Servers ${agent}’s key covers`,
    /** The give form's chooser before an agent is chosen. */
    nextKey: 'Servers the new key covers',
  },
} as const;

/** The sign-in choices of each template: MCP servers may sign in with nothing, APIs never (VT-03). */
export const TEMPLATE_AUTHS: Record<VaultTemplate, VaultAuthType[]> = {
  mcp: ['bearer', 'header', 'query', 'none'],
  token: ['bearer', 'header', 'query'],
  basic: ['basic'],
  login: ['form'],
  // An SSH key's sign-in is written by the server from the key (contracts 0.32.0): nothing to choose.
  ssh: [],
  secret: [],
};

/** CONNECTION's line about signing in: “Signs in with a sign-in key”, “Signs in as admin with a password”. */
export function signsInText(auth: VaultAuth): string {
  switch (auth.type) {
    case 'bearer':
      return 'Signs in with a sign-in key';
    case 'header':
      return `Signs in with a sign-in key in the ${auth.name} header`;
    case 'query':
      return `Signs in with a sign-in key in the ${auth.name} query parameter`;
    case 'basic':
      return `Signs in as ${auth.username} with a password`;
    case 'form':
      return `Signs in as ${auth.username} in the browser`;
    case 'none':
      return 'Signs in with nothing';
    case 'ssh_key':
      return 'Signs in with a server key';
  }
}

/** The SECRET block's label in a person's words: what the stored value is. */
export function secretBlockLabel(auth: Pick<VaultAuth, 'type'> | null): string {
  return auth?.type === 'basic' || auth?.type === 'form' ? 'PASSWORD' : 'SIGN-IN KEY';
}

/** “ports 80, 8123”, “port 443”. */
export function portsText(ports: readonly number[]): string {
  return `${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')}`;
}

/**
 * The Vault's words that name who uses an entry (less-is-more.md AP-1800; one-agent.md AP-4941): the agent by its
 * name, never “agents”. The page's lead is one sentence (AP-1751). Each entry has one row for the agent, in
 * `vaultAssistantAccessCopy`'s words (AP-4000).
 */
export interface VaultWords {
  /** The page's subtitle: “What Dusty can sign in to when it works for you.” */
  intro: string;
  /**
   * What saving from chat does and can't undo, under the intro (VS-08, core's `vaultSavedIntro`; AP-4009): on a runtime
   * with `vault.self_serve`, else null.
   */
  savedIntro: string;
  descriptionLabel: string;
  descriptionPlaceholder: string;
  noDescription: string;
  removeConfirm: (name: string) => string;
  homeNetworkIntro: string;
  /** The Vault page's line to the home network ranges, under the local network switch on What it may do. */
  homeNetworkElsewhere: string;
  /** An SSH key's servers: how a server gets the key without anyone typing it. */
  serversByChat: string;
  /**
   * The last part of an entry's line, only when it differs from the usual: nothing while the entry is on for the agent
   * (every entry starts on), “off for Dusty” when switched off — as the phone says it (AP-4992).
   */
  holders: (agentOn: boolean) => string | null;
}

export function vaultWords(agent: string): VaultWords {
  const a = agent;
  const A = a.charAt(0).toUpperCase() + a.slice(1);
  return {
    // Core's `VAULT_COPY.intro` with the agent by its name: an entry reaches it in its commands (CT-1240, CT-1532).
    intro: `What ${a} can sign in to when it works for you.`,
    savedIntro: vaultSavedIntro(a, currentLocale()),
    descriptionLabel: `What should ${a} know?`,
    descriptionPlaceholder: `What it’s for, and what ${a} may and may not do with it.`,
    noDescription: `No note for ${a} yet.`,
    removeConfirm: (name) =>
      `Remove “${name}”? ${A} can’t use it any more. The audit log keeps that it was used.`,
    homeNetworkIntro: `When “${A} may reach your local network” is off, ${a} reaches only these networks and ports.`,
    homeNetworkElsewhere: `Which parts of your home network ${a} may reach is set in Settings.`,
    serversByChat: `To add a server, ask ${a} in your chat with the server’s address. It asks for the password on a card, puts this key there and doesn’t keep the password.`,
    holders: (on) => (on ? null : `off for ${a}`),
  };
}

/**
 * An entry's line in these words: what kind it is, and that the agent can't use it when it is switched off —
 * “Sign-in key”, “Password · off for Dusty”. Where it points is the card's quieter line (core's `vaultEntryWhere`). An old
 * `secret` entry says nothing uses it.
 */
export function vaultEntryLine(
  entry: { kind: VaultEntryKind; auth: Pick<VaultAuth, 'type'> | null; agentOn: boolean },
  words: Pick<VaultWords, 'holders'>,
): string {
  const label = vaultEntryLabel(entry, currentLocale());
  if (entry.kind === 'secret') return `${label} · nothing uses it`;
  const holders = words.holders(entry.agentOn);
  return holders ? `${label} · ${holders}` : label;
}
