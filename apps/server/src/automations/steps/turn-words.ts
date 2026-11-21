/**
 * What an agent step says about its turn in plain words (docs/decisions/outsiders-turns.md, concise-replies.md): why it
 * waits while its turn is queued behind another outsiders' turn, and why it failed. Pure.
 */
import { classifyTurnFailure, hermesProfileBusy } from '@whombat/agent-runtime/failures';
import type { TurnFailureCode } from '@whombat/core';

/**
 * Why a step's turn waits, from the outsiders' turn ahead of it: a website Feedback assessment (trigger `feedback`) or
 * the turn of another customer's report or reply.
 */
export function turnWaitsWords(ahead: { trigger: string }): string {
  return ahead.trigger === 'feedback'
    ? 'Waiting for a website feedback report to finish'
    : 'Waiting for another customer report to finish';
}

/** The end of “{agent} couldn’t finish because …” per failure, for a reader who isn't a developer. */
const BECAUSE: Partial<Record<TurnFailureCode, string>> = {
  signin: 'its AI sign-in isn’t working',
  usage_limit: 'the AI usage limit was reached',
  provider: 'the AI service had a problem',
  refused: 'the AI model wouldn’t answer this one',
  sandbox: 'its workspace couldn’t start',
  timeout: 'it took too long',
  runner: 'it was interrupted',
  workspace: 'it couldn’t open the code project',
};

/**
 * The failed step's line: “Dusty couldn’t finish because the AI service had a problem.” The reason is the turn's
 * recorded failure, else what its error says; nothing more when neither says why.
 */
export function turnFailedWords(
  agentName: string,
  turn: { failure?: { code: TurnFailureCode } | null; error?: string | null },
): string {
  if (hermesProfileBusy(turn.error))
    return `${agentName} couldn’t finish because other reports kept it waiting too long.`;
  const code = turn.failure?.code ?? classifyTurnFailure({ error: turn.error ?? '' }).code;
  const because = BECAUSE[code];
  return because ? `${agentName} couldn’t finish because ${because}.` : `${agentName} couldn’t finish.`;
}

/** What a waiting agent step keeps while its turn is queued behind another (step output `queuedBehind`). */
export interface QueuedNote {
  /** The words it shows (`turnWaitsWords`). */
  note: string;
  /** Its summary before (“Asked Dusty”), shown again once its turn is taken. */
  asked: string;
}

export function queuedNoteOf(output: unknown): QueuedNote | null {
  const q = (output as { queuedBehind?: unknown } | null)?.queuedBehind as Partial<QueuedNote> | undefined;
  return q && typeof q.note === 'string' && typeof q.asked === 'string'
    ? { note: q.note, asked: q.asked }
    : null;
}

/** The step's summary with the note after what it asked: “Asked Dusty · Waiting for another customer report to finish”. */
export function queuedSummary(asked: string, note: string): string {
  return asked ? `${asked} · ${note}` : note;
}
