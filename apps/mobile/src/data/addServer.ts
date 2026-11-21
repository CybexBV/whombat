/**
 * Add a server on the phone (Whombat server-signin.md SI-01…SI-12; server-signin-mobile.md AP-1697…): what the phone
 * adds to the shared rules and words of `@whombat/client/hosts` (`install.ts`: the levels' question, the form and its
 * body, the job's steps, key note and outcome, the command's words), so web and phone say the same — the screen's own
 * words, what TalkBack says for a step, the key pickers' rows, Waiting for you's rows and the note when the person
 * leaves a job that still runs. Pure; the screen is `screens/AddServerScreen.tsx`.
 */
import {
  formatAgo,
  type InstallStep,
  SIGN_IN_COPY,
  type SshKeyChoice,
  sshKeyChoices,
} from '@whombat/client/hosts';
import { HOST_CONTROL_LEVEL_WORDS, type HostPendingEnrollment, type VaultEntry } from '@whombat/core';

export const ADD_SERVER_COPY = {
  title: 'Add a server',
  ways: 'How to add it',
  /** The password's hint ends in this link on the web (“… then forgotten. Or use a key from the Vault.”). */
  useKey: `Or ${SIGN_IN_COPY.useKey}`,
  hide: 'Hide',
  done: 'Done',
  close: 'Close',
  tryAgain: 'Try again',
  /** A changed key's card (connect-in-chat.md): not trusting it. */
  no: 'No',
  moreDetail: 'More detail',
  lessDetail: 'Less detail',
  open: (name: string) => `Open ${name}`,
  noneWaiting: 'No server yet. Once the command has run, it shows up here within a few seconds.',
  notThisOne: 'Not this one',
  addIt: 'Add it',
  name: 'Name',
  nameRule: 'Letters, digits, dots and dashes.',
  turnedAway: (name: string) => `Turned ${name} away.`,
  added: (name: string) => `Added ${name}. Its first report comes in a moment.`,
  absent: 'Servers aren’t set up on this Whombat.',
  unavailable: 'Servers aren’t reachable right now.',
  commandFailed: 'The command couldn’t be made.',
} as const;

/**
 * Leaving a job that still runs (the web's toast on Hide): Whombat carries on, and the server shows up under Servers
 * (the phone's Things).
 */
export function carriesOnText(serverName: string | null): string {
  return serverName
    ? `Whombat carries on. ${serverName} shows up under Servers when it’s ready.`
    : 'Whombat carries on adding it. It shows up under Servers when it’s ready.';
}

/** What TalkBack says before a step's words (the web's marks' labels). */
export const STEP_WORDS: Record<InstallStep['state'], string> = {
  done: 'Done',
  active: 'Under way',
  todo: 'Still to come',
  failed: 'Stopped here',
  late: 'Not yet',
};

export function stepSpoken(step: InstallStep): string {
  return `${STEP_WORDS[step.state]}: ${step.label}${step.sub ? `. ${step.sub}` : ''}`;
}

/** `SHA256:q3Vx…T8w`: a fingerprint's first four and last three characters, for a row on a narrow screen. */
export function shortFingerprint(fingerprint: string): string {
  const at = fingerprint.indexOf(':');
  const algo = at >= 0 ? fingerprint.slice(0, at + 1) : '';
  const hash = at >= 0 ? fingerprint.slice(at + 1) : fingerprint;
  return hash.length <= 9 ? fingerprint : `${algo}${hash.slice(0, 4)}…${hash.slice(-3)}`;
}

export interface KeyRow extends SshKeyChoice {
  /** The whole fingerprint (TalkBack), and its short form (the row). */
  fingerprint: string;
  short: string;
}

/** The person's own SSH keys for the pickers: the shared choices (their order), each with its fingerprint. */
export function keyRows(entries: readonly Pick<VaultEntry, 'id' | 'name' | 'kind' | 'auth'>[]): KeyRow[] {
  const prints = new Map(
    entries.flatMap((e) => (e.auth?.type === 'ssh_key' ? [[e.id, e.auth.fingerprint] as const] : [])),
  );
  return sshKeyChoices(entries).map((c) => {
    const fingerprint = prints.get(c.id) ?? '';
    return { ...c, fingerprint, short: fingerprint ? shortFingerprint(fingerprint) : '' };
  });
}

/* Waiting for you (servers that ran a command made before SI-07) ---------------------------------------------------- */

const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/;

/** Null when `name` will do as a server's name, else the rule (the web's). */
export function serverNameProblem(name: string): string | null {
  return SERVER_NAME.test(name.trim()) ? null : ADD_SERVER_COPY.nameRule;
}

export interface PendingRowView {
  id: string;
  /** Its host name, or null when it didn't say. */
  hostname: string | null;
  /** `nas-02`, or “A server”. */
  title: string;
  /** `Debian GNU/Linux 12 · 10.100.0.22 · Full control`. */
  meta: string;
  /** `Asked 4 min ago`, or ''. */
  asked: string;
}

export function pendingRows(items: readonly HostPendingEnrollment[], now: number): PendingRowView[] {
  return items.map((e) => ({
    id: e.id,
    hostname: e.hostname,
    title: e.hostname ?? 'A server',
    meta: [e.os, e.address, e.control ? HOST_CONTROL_LEVEL_WORDS[e.control].title : null]
      .filter(Boolean)
      .join(' · '),
    asked: e.requestedAt ? `Asked ${formatAgo((now - Date.parse(e.requestedAt)) / 1000)}` : '',
  }));
}
