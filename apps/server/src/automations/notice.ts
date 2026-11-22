/**
 * Run notices (docs/decisions/bp-automations.md BP-C28): a run that failed, was stopped or needs a person says so in
 * the thread it started from, with a link to the run. Posted by the automation's principal in the transition's own
 * commit, so once per such change and never without it.
 */
import { webOrigin } from '../commands/burrows';
import type { ApplyContext } from '../commit/types';
import { postMessage } from '../domain/messages';
import { loadConversationRow } from '../read/conversations';
import { publisherCheck } from './authority';
import { outsidersRun } from './runs';
import { startsRunThread } from './steps/thread';

/** At most `max` characters, cut at a word with “…”. */
function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).trimEnd()}…`;
}

/** Where people read about a run: its page in the web app. */
export function automationRunUrl(ctx: Pick<ApplyContext, 'services' | 'burrow'>, number: number): string {
  return `${webOrigin(ctx.services)}/${ctx.burrow.slug}/automation-runs/${number}`;
}

/**
 * Posts the notice when the automation may post there: the run has a thread — or was started by a message, whose run
 * posts in its publisher's own room and starts its thread there with the notice (one-agent.md OA-S100) — and its
 * publisher is still allowed and in the room. `ctx.actor` must be the automation's principal.
 */
export async function postRunNotice(
  ctx: ApplyContext,
  run: {
    id: string;
    number: number;
    burrowId: string;
    publishedById: string;
    conversationId: string;
    threadRootId: string | null;
    trigger: { kind: string; messageId?: string | null };
  },
  name: string,
  status: 'failed' | 'cancelled' | 'needs_review',
  error: string | null,
): Promise<void> {
  if (!run.threadRootId && !run.trigger.messageId) return;
  const who = await publisherCheck(ctx.tx, run.burrowId, run.publishedById);
  if (!who.ok) return;
  const conversation = await loadConversationRow(ctx.tx, run.conversationId);
  if (!conversation || conversation.burrowId !== run.burrowId) return;
  // Said like a colleague would: what happened to which automation, Whombat's own reason in a sentence or two, and the
  // run's page behind a link for whoever wants the steps (no run number, no bare address).
  const reason = error ? ` ${clipWords(error.replace(/\s+/g, ' ').trim(), 240)}` : '';
  const head =
    status === 'needs_review'
      ? `“${name}” is waiting for you to check a step.`
      : status === 'cancelled'
        ? `“${name}” was stopped.`
        : `“${name}” didn’t finish.`;
  const posted = await postMessage(ctx, {
    conversation,
    text: `${head}${reason} [See what happened](${automationRunUrl(ctx, run.number)})`,
    threadRootId: run.threadRootId,
    mentions: [],
    dispatch: false,
    outsidersRun: outsidersRun(run.trigger),
  });
  if (!run.threadRootId) await startsRunThread(ctx.tx, run.id, posted.id);
}
