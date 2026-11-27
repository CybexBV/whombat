/**
 * Remote help's phone-only pieces (app docs/decisions/remote-help.md AP-4470…): the no-passkey dialog as Android's alert
 * answering `TurnOnRemoteHelpDeps.confirm`, how much of a command line the sheet shows, the file it shares or saves
 * (its name the phone's own, from the visit's id), and what TalkBack reads for a step. The card's states, the flow and
 * the words are the shared client's (`@whombat/client/managed`); the UI is `RemoteHelpSection.tsx`. Pure TypeScript.
 */
import {
  type RemoteHelpChoice,
  type RemoteHelpStepRow,
  remoteHelpConfirmText,
  remoteHelpWords,
} from '@whombat/client/managed';
import { remoteHelpTranscriptName } from '@whombat/protocol/session';

/* The no-passkey dialog (RH-04) ----------------------------------------------------------------------------------- */

export interface AlertButton {
  text: string;
  style?: 'cancel' | 'default' | 'destructive';
  onPress?: () => void;
}

/** React Native's `Alert.alert`, as far as the dialog uses it. */
export type ShowAlert = (
  title: string,
  message: string,
  buttons: AlertButton[],
  options: { cancelable: boolean; onDismiss: () => void },
) => void;

/**
 * “Turn on remote help?” without a passkey (AP-4473): the shared title and sentence, Cancel and Turn on.
 * Turn on answers true; Cancel, the back button or a tap beside it false (and only the first answer counts).
 */
export function remoteHelpConfirm(
  alert: ShowAlert,
  locale?: string | null,
): (choice: RemoteHelpChoice) => Promise<boolean> {
  const { confirm } = remoteHelpWords(locale);
  return (choice) =>
    new Promise<boolean>((resolve) => {
      let answered = false;
      const answer = (yes: boolean) => {
        if (answered) return;
        answered = true;
        resolve(yes);
      };
      alert(
        confirm.title,
        remoteHelpConfirmText(choice.level, choice.duration, locale),
        [
          { text: confirm.cancel, style: 'cancel', onPress: () => answer(false) },
          { text: confirm.turnOn, onPress: () => answer(true) },
        ],
        { cancelable: true, onDismiss: () => answer(false) },
      );
    });
}

/* The command line in the sheet (AP-4476) ------------------------------------------------------------------------- */

/**
 * At most this many characters of a command line show in the sheet: one Text that size still scrolls on a phone, and a
 * visit's record can be 50 MB (`REMOTE_HELP_LIMITS.transcriptBytesPerVisit`). Share and Download give all of it.
 */
export const TRANSCRIPT_SHOWN_CHARS = 64 * 1024;

/** The start of a command line as the sheet shows it, cut at a line where it can be; `cut` when something is left out. */
export function transcriptShown(
  text: string,
  max: number = TRANSCRIPT_SHOWN_CHARS,
): { text: string; cut: boolean } {
  // The record's last new line (and a blank line or two) would show as empty space under it.
  if (text.length <= max) return { text: text.trimEnd(), cut: false };
  let head = text.slice(0, max);
  const line = head.lastIndexOf('\n');
  if (line >= max / 2) head = head.slice(0, line);
  // Never half a character: a lone high surrogate at the end goes too.
  else if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return { text: head, cut: true };
}

/**
 * The file a command line is shared or saved as: `whombat-remote-help-<visit>.txt` from the visit's id (checked by the
 * protocol), never a name the box sent, since it becomes a path in the app's cache.
 */
export function transcriptFileName(visitId: string): string {
  return remoteHelpTranscriptName(visitId);
}

/** What sharing and saving a file needs of the phone (expo-file-system, expo-sharing, “Save as”). */
export interface TranscriptFiles {
  /** Writes `bytes` to the app's cache as `name`; the copy's URI. */
  writeCache(name: string, bytes: Uint8Array): string;
  removeCache(name: string): void;
  /** Android's share sheet for the copy. */
  share(uri: string, name: string): Promise<void>;
  /** Asks where to save `name` (“Save as”, else a folder); the new document's URI, or null when backed out. */
  pickTarget(name: string): Promise<string | null>;
  writeDocument(uri: string, bytes: Uint8Array): void;
  removeDocument(uri: string): void;
}

/** Share (AP-4477): a copy in the cache for the share sheet, gone afterwards whatever happened. */
export async function shareTranscript(
  files: TranscriptFiles,
  visitId: string,
  bytes: Uint8Array,
): Promise<void> {
  const name = transcriptFileName(visitId);
  try {
    await files.share(files.writeCache(name, bytes), name);
  } finally {
    try {
      files.removeCache(name);
    } catch {
      // already gone
    }
  }
}

/**
 * Download (AP-4477): the box's bytes where you choose; false when they backed out. A write that fails takes
 * the half file away again.
 */
export async function downloadTranscript(
  files: TranscriptFiles,
  visitId: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const uri = await files.pickTarget(transcriptFileName(visitId));
  if (!uri) return false;
  try {
    files.writeDocument(uri, bytes);
  } catch (error) {
    try {
      files.removeDocument(uri);
    } catch {
      // The provider wouldn't delete it: nothing more to do.
    }
    throw error;
  }
  return true;
}

/* TalkBack -------------------------------------------------------------------------------------------------------- */

/** The help code as TalkBack reads it, one character at a time (“K Q 7 2 M X”): the dot only groups it for the eye. */
export function helpCodeSpoken(code: string): string {
  return [...code.replace(/[^0-9A-Za-z]/g, '')].join(' ');
}

/** A step read as one line: its time, then its words with the command line (“14:02, Ran systemctl status voice”). */
export function remoteHelpStepLabel(row: Pick<RemoteHelpStepRow, 'time' | 'text' | 'code'>): string {
  const words = row.code ? `${row.text} ${row.code}` : row.text;
  return row.time ? `${row.time}, ${words}` : words;
}
