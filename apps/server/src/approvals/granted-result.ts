/**
 * An approved call's result as the agent woken after the yes reads it (docs/decisions/home-redesign.md HR-04; contracts
 * CT-407): kept on the approval, sealed (`approvals.result_enc`, AAD `approval:<id>:result`), opened for the turn's
 * `DispatchContext.grantedResult`; and the one plain line posted when nobody can be woken. `result.ts` keeps and wakes.
 */
import { GRANTED_RESULT_TEXT_MAX, type GrantedResultContext } from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { approvals } from '../db/schema/index';
import type { KeyCustody } from '../keys/custody';

/** AAD of an approval's sealed call result. */
export function approvalResultAad(approvalId: string): string {
  return `approval:${approvalId}:result`;
}

/** A call's answer as the woken turn reads it: cut at `GRANTED_RESULT_TEXT_MAX`, never half a character. */
export function grantedResult(
  outcome: GrantedResultContext['outcome'],
  text: string,
  truncated = false,
): GrantedResultContext {
  if (text.length <= GRANTED_RESULT_TEXT_MAX) return { outcome, text, truncated };
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > GRANTED_RESULT_TEXT_MAX) break;
    out += ch;
  }
  return { outcome, text: out, truncated: true };
}

/** The one plain line when nobody can be woken to say it (HR-04). */
export function plainResultLine(result: GrantedResultContext): string {
  if (result.outcome === 'done') return 'Done.';
  if (result.outcome === 'error') return 'It didn’t work: the service said it couldn’t do it.';
  return `It didn’t work. ${result.text}`.slice(0, 300);
}

/** The result kept with the approval, opened for the turn it woke; null when there is none or it doesn't open. */
export async function grantedResultOf(
  db: Db,
  custody: KeyCustody,
  approvalId: string,
): Promise<GrantedResultContext | null> {
  const [row] = await db
    .select({ id: approvals.id, resultEnc: approvals.resultEnc })
    .from(approvals)
    .where(eq(approvals.id, approvalId));
  if (!row?.resultEnc) return null;
  try {
    const parsed = JSON.parse(custody.open(approvalResultAad(row.id), row.resultEnc)) as GrantedResultContext;
    return grantedResult(parsed.outcome, String(parsed.text ?? ''), parsed.truncated === true);
  } catch {
    return null;
  }
}
