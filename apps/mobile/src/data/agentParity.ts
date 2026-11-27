/**
 * Settings → Agent's Notes and the always-allowed commands under Keys (mobile-parity.md MQ-01; one-agent.md AP-4970,
 * AP-4972; hermes-engine-app.md AP-5272; one-person-android.md AP-5762): the agent's notes as one text (when you
 * changed it last, what an edit saves, how much of its 1,500 characters it uses), and its always-allowed commands — as
 * the web's Notes and Keys → ALWAYS ALLOWED COMMANDS read them. Pure.
 */
import {
  AGENT_NOTES_MAX,
  type AgentNotes,
  AgentNotesText,
  type CommandAllowance,
  commandAllowanceLine,
  commandAllowancesCopy,
  formatDate,
  memoryUsageText,
  notesCopy,
} from '@whombat/core';
import { formatLocaleOf } from '@whombat/core/i18n';
import { mobileTranslator } from '../i18n/translate';

/* Notes (HE-39, CT-1205) ------------------------------------------------------------------------------------------ */

/** “Changed 20 Oct”: when the notes were changed last; null while never changed. */
export function notesMeta(
  notes: Pick<AgentNotes, 'updatedAt'>,
  timeZone: string,
  now: Date,
  locale?: string,
): string | null {
  if (!notes.updatedAt) return null;
  return mobileTranslator(locale).t('data.agentParity.changed', {
    date: formatDate(notes.updatedAt, timeZone, { now }, locale),
  });
}

/** What the editor would save: the text as the server keeps it (trimmed), or why not. */
export function notesEdit(
  before: string,
  typed: string,
  locale?: string,
): { kind: 'save'; text: string } | { kind: 'unchanged' } | { kind: 'too_long'; problem: string } {
  const parsed = AgentNotesText.safeParse(typed);
  // The schema's own message is English; the phone says it in the person's words.
  if (!parsed.success)
    return {
      kind: 'too_long',
      problem: mobileTranslator(locale).t('data.agentParity.tooLong', {
        max: new Intl.NumberFormat(formatLocaleOf(locale)).format(AGENT_NOTES_MAX),
      }),
    };
  if (parsed.data === before) return { kind: 'unchanged' };
  return { kind: 'save', text: parsed.data };
}

/** “240 of 1,500 characters” under the editor (the usage line's words). */
export function notesCount(typed: string, locale?: string): string {
  return memoryUsageText([...typed.replace(/\r\n?/g, '\n').trim()].length, AGENT_NOTES_MAX, locale);
}

export { notesCopy };

/* Always-allowed commands (AC-42) ---------------------------------------------------------------------------------- */

export interface AllowanceRow {
  id: string;
  /** The exact command, in mono. */
  command: string;
  /** “web-1 · Deploy to production”. */
  line: string;
  /** “Remove: <command>” (the web's aria-label). */
  removeLabel: string;
}

export function allowanceRows(allowances: readonly CommandAllowance[], locale?: string): AllowanceRow[] {
  const remove = commandAllowancesCopy(locale).remove;
  return allowances.map((a) => ({
    id: a.id,
    command: a.command,
    line: commandAllowanceLine(a, locale),
    removeLabel: `${remove}: ${a.command}`,
  }));
}
