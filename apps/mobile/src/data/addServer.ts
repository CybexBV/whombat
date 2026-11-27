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
  type SshKeyChoice,
  signInCopy,
  sshKeyChoices,
} from '@whombat/client/hosts';
import { type HostPendingEnrollment, hostControlLevelWords, type VaultEntry } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

export function addServerCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  const A = 'data.addServer.';
  return {
    title: t(`${A}title`),
    ways: t(`${A}ways`),
    /** The password's hint ends in this link on the web (“… then forgotten. Or use a key from the Vault.”). */
    useKey: t(`${A}useKey`, { useKey: signInCopy(locale).useKey }),
    hide: t(`${A}hide`),
    done: t(`${A}done`),
    close: t(`${A}close`),
    tryAgain: t(`${A}tryAgain`),
    /** A changed key's card (connect-in-chat.md): not trusting it. */
    no: t(`${A}no`),
    moreDetail: t(`${A}moreDetail`),
    lessDetail: t(`${A}lessDetail`),
    open: (name: string) => t(`${A}open`, { name }),
    noneWaiting: t(`${A}noneWaiting`),
    notThisOne: t(`${A}notThisOne`),
    addIt: t(`${A}addIt`),
    name: t(`${A}name`),
    nameRule: t(`${A}nameRule`),
    turnedAway: (name: string) => t(`${A}turnedAway`, { name }),
    added: (name: string) => t(`${A}added`, { name }),
    absent: t(`${A}absent`),
    unavailable: t(`${A}unavailable`),
    commandFailed: t(`${A}commandFailed`),
  };
}

export const ADD_SERVER_COPY = addServerCopy();

/**
 * Leaving a job that still runs (the web's toast on Hide): Whombat carries on, and the server shows up under Servers
 * (the phone's Things).
 */
export function carriesOnText(serverName: string | null, locale?: string): string {
  const { t } = mobileTranslator(locale);
  return serverName
    ? t('data.addServer.carriesOnNamed', { name: serverName })
    : t('data.addServer.carriesOn');
}

/** What TalkBack says before a step's words (the web's marks' labels). */
export function stepWords(locale?: string): Record<InstallStep['state'], string> {
  const { t } = mobileTranslator(locale);
  return {
    done: t('data.addServer.step.done'),
    active: t('data.addServer.step.active'),
    todo: t('data.addServer.step.todo'),
    failed: t('data.addServer.step.failed'),
    late: t('data.addServer.step.late'),
  };
}

export const STEP_WORDS: Record<InstallStep['state'], string> = stepWords();

export function stepSpoken(step: InstallStep, locale?: string): string {
  return `${stepWords(locale)[step.state]}: ${step.label}${step.sub ? `. ${step.sub}` : ''}`;
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
export function serverNameProblem(name: string, locale?: string): string | null {
  return SERVER_NAME.test(name.trim()) ? null : addServerCopy(locale).nameRule;
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

export function pendingRows(
  items: readonly HostPendingEnrollment[],
  now: number,
  locale?: string,
): PendingRowView[] {
  const { t } = mobileTranslator(locale);
  const levels = hostControlLevelWords(locale);
  return items.map((e) => ({
    id: e.id,
    hostname: e.hostname,
    title: e.hostname ?? t('data.addServer.aServer'),
    meta: [e.os, e.address, e.control ? levels[e.control].title : null].filter(Boolean).join(' · '),
    asked: e.requestedAt
      ? t('data.addServer.asked', { ago: formatAgo((now - Date.parse(e.requestedAt)) / 1000, locale) })
      : '',
  }));
}
