/**
 * The provider's turn, its events mapped onto the turn: the session it runs in, how fast it ran, the rate-limit
 * readings, what it put in front of people and whether it thinks, a push before a pull request opens, the follow-ups it
 * took, its answer and its failure — each of the latter also recorded on its sign-in. A model the tool refuses before
 * the turn did anything runs the turn once more on the tool's default (model-effort.md ME-05).
 */

import { modelRefused, type TurnEvent } from '@whombat/agent-runtime';
import { recordCredentialOutcome } from '../managed';
import { loopDefault, type ReadyTurn } from './prepare';
import type { TurnScope } from './scope';

/** Events that mean the turn did something: after one, a refused model is an ordinary failure (ME-05). */
const ACTING_EVENTS: ReadonlySet<TurnEvent['type']> = new Set([
  'tool_call',
  'tool_result',
  'permission',
  'final',
  'steered',
]);

const RECOVER_REPLY =
  'The work in this session has ended without an answer to the person. Give the result now, from what you already found: what you found or did, what remains uncertain, and anything they need to decide. Do not repeat the investigation or run tools. An earlier progress message and report_done are not the answer. Your final text will be posted in the conversation. Do not end with only NO_REPLY or a MORE: hint.';

export async function runProvider(
  turn: Pick<
    TurnScope,
    | 'ctx'
    | 'deps'
    | 'id'
    | 'stop'
    | 'session'
    | 'reply'
    | 'verdict'
    | 'readings'
    | 'ran'
    | 'progress'
    | 'checkout'
  >,
  ready: ReadyTurn,
  signal: AbortSignal = turn.stop.signal,
): Promise<void> {
  const { ctx, deps, id, stop, session, reply, verdict, readings, ran, progress, checkout } = turn;
  const { input, live, model, credential, activity } = ready;
  // The model a refused one falls back to: none named (the CLI's own default), or on Hermes's own loop the list's
  // default, which has to be named (HE-S48); null: no other model to run on.
  const fallbackModel = (): string | null | undefined => {
    const fallback = loopDefault(input, ready.provider.kind, deps.registry);
    return fallback === input.model ? null : fallback;
  };
  let started = false;
  // A model the tool refuses before the turn did anything (no tool call, no message): the same turn once more on the
  // tool's default, and the completion says so (model-effort.md ME-05). Anything else fails as before.
  for (let attempt = 1; attempt <= 2 && !signal.aborted; attempt++) {
    /** The turn did something: a tool, a permission, an answer, a follow-up taken. */
    let acted = false;
    let refusedModel: string | null = null;
    const sessionBefore = session.id;
    // What this attempt runs on (CR-R05): the last attempt's counts; its speed as the provider says (CR-R04).
    if (live) ran.facts = model.ran(input);
    for await (const ev of ready.provider.runTurn(input, signal) as AsyncIterable<TurnEvent>) {
      // Until the provider's first event: the CLI's own start (TE-12).
      if (!started) {
        started = true;
        ready.step('provider');
      }
      if (activity.observe(ev)) progress.flushSoon();
      if (ACTING_EVENTS.has(ev.type)) acted = true;
      switch (ev.type) {
        case 'session':
          session.id = ev.sessionId;
          if (input.freshIfSessionGone && ev.sessionId !== input.resumeSessionId)
            deps.log('info', `${ctx.agent.name} · its session was gone on this host; a fresh one started`, {
              dispatchId: id,
            });
          break;
        case 'speed':
          // How fast it ran, and why not when it asked (CR-07, CR-08); the last one of the attempt counts.
          if (ran.facts) ran.facts.speed = { fast: ev.fast, ...(ev.skipped ? { skipped: ev.skipped } : {}) };
          break;
        case 'rate_limits':
          // A gateway turn's readings are the gateway's pool, nobody's subscription (AIG-10): not reported.
          if (ready.viaGateway) break;
          readings.observe(ev.usage);
          progress.flushSoon();
          break;
        case 'tool_call':
          if (reply.toolCall(ev)) progress.flushSoon();
          // Opening a pull request needs the branch on GitHub: push what the agent committed first
          // (the server waits a moment for it before asking GitHub).
          if (ev.name === 'open_pull_request') await checkout.push('before opening the pull request');
          break;
        case 'tool_result':
          reply.toolResult(ev);
          break;
        case 'steered':
          if (progress.followUps?.steered(ev.id)) {
            await reply.steered(deps);
            progress.flushSoon();
          }
          break;
        case 'final':
          reply.final(ev);
          if (credential) await recordCredentialOutcome(credential, { ok: true });
          break;
        case 'answered':
          // The answer is complete while the provider still does its own upkeep (HE-S20): out now.
          await reply.answered(deps);
          progress.flushSoon();
          break;
        case 'error':
          if (
            attempt === 1 &&
            !input.replyOnly &&
            !acted &&
            !reply.posted &&
            live &&
            input.model &&
            !ev.credentialState &&
            modelRefused(ev, input.model) &&
            fallbackModel() !== null
          ) {
            refusedModel = ev.message;
            break;
          }
          verdict.providerFailed(ev);
          if (credential)
            await recordCredentialOutcome(credential, {
              ok: false,
              state: ev.credentialState,
              ...(ev.credentialUntil ? { until: ev.credentialUntil } : {}),
            });
          break;
        default:
          break;
      }
      if (signal.aborted) break;
    }
    if (!refusedModel || !input.model || signal.aborted) break;
    ran.modelFallback = { model: input.model, detail: refusedModel.slice(0, 500) };
    deps.log(
      'warn',
      `${ctx.agent.name} · ${input.model} wasn’t available (${refusedModel.slice(0, 200)}); the turn runs again on the default model`,
      { dispatchId: id },
    );
    // The tool's default and its efforts; the session as it was before (a fresh one the refusal started is dropped). The
    // first attempt closed the follow-ups: they wait for their own turn. Fast replies only if the default offers them
    // (chat-runtime-runner.md CR-R07).
    const fallback = fallbackModel();
    delete input.model;
    if (fallback) input.model = fallback;
    model.apply(input);
    delete input.steering;
    session.id = sessionBefore;
    reply.discardFinal();
  }
  if (!reply.needsCompletion || stop.aborted || verdict.failure || verdict.refusal || verdict.managedOutcome)
    return;
  if (!input.replyOnly && session.id && ready.provider.capabilities().sessionResume) {
    deps.log('warn', `${ctx.agent.name} · recovering its missing answer`, { dispatchId: id });
    reply.beginRecovery();
    progress.flushSoon();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), deps.replyRecoveryMs ?? 45_000);
    timer.unref?.();
    try {
      await runProvider(
        turn,
        {
          ...ready,
          input: {
            ...input,
            prompt: RECOVER_REPLY,
            resumeSessionId: session.id,
            freshIfSessionGone: false,
            replyOnly: true,
            attachments: [],
            steering: undefined,
          },
        },
        AbortSignal.any([stop.signal, deadline.signal]),
      );
    } catch (error) {
      if (!deadline.signal.aborted || stop.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!reply.needsCompletion || stop.aborted || verdict.failure || verdict.refusal) return;
  }
  verdict.refusal =
    'I finished checking, but couldn’t put together the answer. Try again and I’ll pick up from what I found.';
  verdict.refusalCode = 'reply_incomplete';
}
