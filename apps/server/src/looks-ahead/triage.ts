/**
 * The triage pass (docs/decisions/looks-ahead.md): a few times a day one quiet turn sees the new inbox mail as a
 * numbered list and picks, by number, what needs a closer check (`ahead_triage`). Here: which mails the list holds and in
 * what order, and the command that ends the pass and keeps its picks on its row for the watcher.
 */
import { AHEAD_TRIAGE_MAIL_MAX, AheadTriageInput, aheadMailSignal } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { type AheadCheckRow, aheadChecks } from '../db/schema/index';
import { badRequest, forbidden } from '../lib/errors';
import type { SweptMail } from './mail';
import { checkOfTurn } from './store';

/** One mail of a triage pass as its row keeps it: what the turn is shown, and what a later mail check needs. */
export type TriageMail = NonNullable<AheadCheckRow['event']['triage']>['mails'][number];

/** What a check hears when it isn't a triage pass but calls `ahead_triage`. */
export const NOT_A_TRIAGE =
  'ahead_triage only ends a look through new mail: end this check with ahead_report.';
/** What a triage pass hears when it calls anything but `ahead_triage`. */
export const TRIAGE_ONLY =
  'While you look through new mail you only pick: end with ahead_triage and the numbers of the mails that need the person.';

/**
 * The mails a triage pass lists (pure): at most `AHEAD_TRIAGE_MAIL_MAX`, those with a booking or deadline word or a word
 * of a rule first, then the newest, each numbered `m1`… in that order.
 */
export function triageMailList(mails: readonly SweptMail[], rules: readonly string[]): TriageMail[] {
  const ranked = mails
    .map((m) => ({
      m,
      signal: aheadMailSignal({ subject: m.message.subject, snippet: m.message.snippet, rules }),
    }))
    .sort((a, b) => Number(b.signal) - Number(a.signal) || Date.parse(b.m.start) - Date.parse(a.m.start))
    .slice(0, AHEAD_TRIAGE_MAIL_MAX);
  return ranked.map(({ m }, i) => ({
    ref: `m${i + 1}`,
    connectionId: m.account.connectionId,
    provider: m.account.provider,
    account: m.account.email.slice(0, 120),
    messageId: m.message.id,
    threadId: m.message.threadId,
    from: m.message.from.slice(0, 320),
    subject: (m.message.subject || '(no subject)').slice(0, 300),
    date: m.start,
    snippet: m.message.snippet.slice(0, 600),
    ...(m.message.unread ? { unread: true } : {}),
  }));
}

/**
 * The end of a triage pass: its picks by number, each mapped to a mail it listed and, when given, to a matter it was
 * shown. An unknown number is refused so the turn can correct it. The picks wait on the row (`quiet`) until the watcher
 * starts them as mail checks. Once only.
 */
export const triageAhead = defineCommand({
  name: 'ahead.triage',
  schema: z.object({ dispatchId: z.string().min(1).max(64), picks: AheadTriageInput.shape.picks }),
  async apply(tx, ctx, input): Promise<{ picked: number }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant picks mail to check.');
    const row = await checkOfTurn(tx, ctx.burrow.id, input.dispatchId);
    if (!row || row.agentId !== ctx.actor.id) throw forbidden(NOT_A_TRIAGE);
    if (row.source !== 'triage' || !row.event.triage) throw forbidden(NOT_A_TRIAGE);
    if (row.state !== 'checking') throw forbidden('You already picked for this look through new mail.');
    const { triage } = row.event;
    const mails = new Set(triage.mails.map((m) => m.ref));
    const matters = new Map((triage.matters ?? []).map((m) => [m.ref, m.id]));
    const picks: { ref: string; matterId?: string }[] = [];
    for (const pick of input.picks) {
      if (!mails.has(pick.mail))
        throw badRequest(
          `${pick.mail} isn’t in the list: pick by the numbers given (m1 to m${triage.mails.length}).`,
        );
      const matterId = pick.matter ? matters.get(pick.matter) : undefined;
      if (pick.matter && !matterId)
        throw badRequest(
          matters.size
            ? `${pick.matter} isn’t one of the things kept an eye on: use k1 to k${matters.size}, or leave matter out.`
            : `${pick.matter} isn’t one of the things kept an eye on: leave matter out.`,
        );
      if (picks.some((p) => p.ref === pick.mail)) continue;
      picks.push({ ref: pick.mail, ...(matterId ? { matterId } : {}) });
    }
    await tx
      .update(aheadChecks)
      .set({ state: 'quiet', reportedAt: ctx.now, event: { ...row.event, triage: { ...triage, picks } } })
      .where(eq(aheadChecks.id, row.id));
    // Signed with counts only: which mail was picked stays out of the log.
    await ctx.emit({
      type: 'ahead.triaged',
      kind: 'System',
      text: null,
      where: null,
      payload: { aheadCheckId: row.id, count: triage.count, picked: picks.length },
    });
    return { picked: picks.length };
  },
});
