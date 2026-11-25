/**
 * What Looks ahead's commands, the watcher and a check's turn all read (docs/decisions/looks-ahead.md): the setting as
 * stored, the findings told today, the check a turn works on, whether a key is Allowed, and the scrubbing every word
 * Whombat keeps or posts goes through. Kept apart from the commands so the matters and the triage pass can use them
 * without a loop between the modules.
 */
import { AHEAD_TEXT_MAX, decide, type KeyId, keepingDatesAndTimes } from '@whombat/core';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { aheadChecks, aheadMatters, looksAheadSettings } from '../db/schema/index';
import { loadGrants } from '../read/principals';
import type { AheadSettings } from './calendars';

/** The setting as stored, or the default (on, incoming mail on, every default calendar, no rules, nothing stopped). */
export async function aheadSettingsOf(tx: Pick<Tx, 'select'>, burrowId: string): Promise<AheadSettings> {
  const [row] = await tx.select().from(looksAheadSettings).where(eq(looksAheadSettings.burrowId, burrowId));
  return row
    ? {
        on: row.on,
        mailOn: row.mailOn,
        calendarsOff: row.calendarsOff,
        calendarsOn: row.calendarsOn,
        rules: row.rules,
        stopped: row.stopped,
      }
    : { on: true, mailOn: true, calendarsOff: [], calendarsOn: [], rules: [], stopped: [] };
}

/**
 * Findings told since `since`. News on something the person asked Whombat to keep an eye on isn't counted: they asked
 * for it, so it never uses up the day's findings.
 */
export async function findingsSince(tx: Pick<Tx, 'select'>, burrowId: string, since: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        eq(aheadChecks.state, 'told'),
        gte(aheadChecks.reportedAt, since),
        sql`not exists (select 1 from ${aheadMatters} where ${aheadMatters.id} = ${aheadChecks.matterId} and ${aheadMatters.origin} = 'person')`,
      ),
    );
  return row?.n ?? 0;
}

/** The check a Looks ahead turn works on, locked, or null. */
export async function checkOfTurn(tx: Tx, burrowId: string, dispatchId: string) {
  const [row] = await tx
    .select()
    .from(aheadChecks)
    .where(and(eq(aheadChecks.burrowId, burrowId), eq(aheadChecks.dispatchId, dispatchId)))
    .for('update');
  return row ?? null;
}

/** Whether the agent's key is Allowed (not Ask, not Off): nobody is there to say yes while it checks ahead. */
export async function keyAllowedIn(db: Db | Tx, agentId: string, key: KeyId): Promise<boolean> {
  const grants = await loadGrants(db, agentId);
  return decide({ id: agentId, kind: 'agent' }, grants, key).outcome === 'allow';
}

/**
 * The assistant's words as plain text that can hold no link, picture, site, address or phone number: markup characters
 * go first, then every address (`http:`, `https:`, `mailto:`, `data:`, `www.`, e-mail), bare sites and phone numbers,
 * again until nothing changes, so none can be put back together from what is left. Its sources are Whombat's.
 */
export function findingWords(text: string): string {
  let words = text;
  for (let i = 0; i < 5; i++) {
    const next = keepingDatesAndTimes(words, (text) =>
      text
        .replace(/<[^>]*>/g, ' ')
        .replace(/!(?=\[)/g, '')
        .replace(/[`*_#>|~[\]]/g, '')
        .replace(/\S*(?:https?:|mailto:|data:|www\.|@)\S*/gi, ' ')
        // A bare site (“tickets-rebook.example”) and a phone number aren't for it to give: its sources are.
        .replace(/\b[\p{L}\d-]+(?:\.[\p{L}\d-]+)*\.[a-z]{2,}\b\/?\S*/giu, ' ')
        .replace(/\+?\d[\d\s().-]{7,}\d/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (next === words) break;
    words = next;
  }
  return words.slice(0, AHEAD_TEXT_MAX);
}

/** Scrubs a short label (an action chip, a note, a matter's title) with the same no-link/no-markup rules. */
export function cleanShortLabel(text: string | undefined, max: number): string | null {
  if (!text) return null;
  const cleaned = findingWords(text).slice(0, max).trim();
  return cleaned.length >= 2 ? cleaned : null;
}
