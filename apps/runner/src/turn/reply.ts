/**
 * What a turn puts in front of people: whether something of it is there already (a posting tool), its final text —
 * posted where the agent was asked, never twice — and “{name} is thinking” while it works
 * on an answer (working-signal.md WG-01).
 */

import { connectWhombatMcp, type TurnEvent, type TurnUsage, type WhombatMcp } from '@whombat/agent-runtime';
import {
  CouncilFinishOutput,
  CouncilOkOutput,
  CouncilStartOutput,
  CouncilTellOutput,
  DelegateFinishOutput,
  DelegateOfferOutput,
  type DispatchContext,
  MCP_POSTING_TOOLS,
  type McpToolName,
} from '@whombat/core';
import { NO_REPLY, splitMore } from '../prompt';
import type { TurnDeps } from './deps';

/** Where a turn's final text goes: the turn's thread (the trigger's), else the conversation. */
export function finalThreadOf(ctx: DispatchContext): string | null {
  return ctx.dispatch.threadRootId ?? null;
}

/** Posts the turn's final text where the agent was asked (in the thread when the trigger was a reply). */
async function postFinal(ctx: DispatchContext, finalText: string, mcp: WhombatMcp): Promise<boolean> {
  // A last `MORE:` line offers “More detail” only alongside an answer.
  const { text, more } = splitMore(finalText);
  if (!text) return false;
  const extra = more ? { more } : {};
  const thread = finalThreadOf(ctx);
  const res = thread
    ? await mcp.call('reply_in_thread', { messageId: thread, text, ...extra })
    : await mcp.call('post_message', { conversationId: ctx.conversation.id, text, ...extra });
  return res.ok;
}

type PostingDeps = Pick<TurnDeps, 'connectMcp' | 'serverUrl' | 'log'>;
const BOOKKEEPING_TOOLS = new Set(['report_done', 'set_status', 'run_log', 'run_step', 'run_files']);
/**
 * Tools whose card is the turn's answer: the agent's words go above or under the council's or the checklist's card,
 * and anything it says besides would sit under the card, repeat it and hide the card's quick replies. Each answers
 * with its own success status (`started`, `offered`, `finished`, `ok`), read through its contract: a refusal, or an
 * outcome that isn't the tool's, is no card.
 */
type CardOutcome = { safeParse(v: unknown): { success: boolean; data?: unknown } };
const CARD_ANSWER_TOOLS = new Map<string, CardOutcome>([
  ['council_start', CouncilStartOutput],
  ['council_note', CouncilOkOutput],
  ['council_tell', CouncilTellOutput],
  ['council_finish', CouncilFinishOutput],
  ['delegate_offer', DelegateOfferOutput],
  ['delegate_finish', DelegateFinishOutput],
]);

/** Whether a card tool's result put its card in front of people. */
function cardShown(name: string, structured: Record<string, unknown> | undefined): boolean {
  const read = CARD_ANSWER_TOOLS.get(name)?.safeParse(structured);
  return !!read?.success && (read.data as { status?: unknown }).status !== 'refused';
}

/** Posts a final text over the turn's own MCP connection; a failed Chat delivery fails the turn. */
async function postFinalText(ctx: DispatchContext, deps: PostingDeps, text: string): Promise<boolean> {
  const mcp = await (deps.connectMcp ?? ((t) => connectWhombatMcp(t)))({
    url: new URL(ctx.mcpPath, deps.serverUrl).toString(),
    token: ctx.agentToken.token,
  });
  try {
    const posted = await postFinal(ctx, text, mcp);
    if (!posted) {
      if (ctx.dispatch.mode === 'reply')
        throw new Error('The answer could not be posted to the conversation.');
      deps.log('warn', `${ctx.agent.name} could not post its reply in ${ctx.conversation.title}`, {
        dispatchId: ctx.dispatch.id,
      });
    }
    return posted;
  } finally {
    await mcp.close().catch(() => {});
  }
}

export class TurnReply {
  /** Something of the turn's is in front of people. A progress message is not its final answer. */
  posted = false;
  /**
   * Replies show "{name} is thinking" until the agent has said something (in an earlier attempt too, when a restart cut
   * the turn off after it posted), and again once it acts after that (working-signal.md WG-01); runs and answers do not.
   */
  thinking: boolean;
  /** What the turn's model calls used, with its last final text. */
  usage: TurnUsage | undefined;
  #finalText = '';
  #workedSincePost = false;
  /** It started a run without a checkout of its own, whose turn answers. */
  #handedToRun = false;
  /** A council's or a checklist's card says what the turn had to say. */
  #answeredByCard = false;
  #posts = new Map<string, unknown>();
  #postedTexts = new Set<string>();
  #earlierUsage: TurnUsage | undefined;
  readonly #ctx: DispatchContext;

  constructor(ctx: DispatchContext) {
    this.#ctx = ctx;
    const postedBefore = ctx.dispatch.postedAt != null;
    this.thinking = ctx.dispatch.mode === 'reply' && !postedBefore;
  }

  /** A tool call; true when the turn thinks again, which a beat should say soon. */
  toolCall(ev: Extract<TurnEvent, { type: 'tool_call' }>): boolean {
    // Wait for the result before counting a message as delivered.
    if (MCP_POSTING_TOOLS.has(ev.name as McpToolName) || CARD_ANSWER_TOOLS.has(ev.name)) {
      this.#posts.set(ev.id ?? ev.name, ev.input);
      this.thinking = false;
    } else {
      if (!BOOKKEEPING_TOOLS.has(ev.name)) this.#workedSincePost = true;
      if (this.thinking || this.#ctx.dispatch.mode !== 'reply') return false;
      // Still at work after it said something (“I’m using the health-report skill …”): thinking again, or
      // nothing on screen says so until its answer (working-signal.md WG-01).
      this.thinking = true;
      return true;
    }
    return false;
  }

  /** A failed posting call must not hide the answer. Bookkeeping never counts as delivery. */
  toolResult(ev: Extract<TurnEvent, { type: 'tool_result' }>): void {
    const structured = ev.outcome?.structured;
    const status = structured?.status;
    const card = CARD_ANSWER_TOOLS.has(ev.name);
    const ok = ev.ok && (card ? cardShown(ev.name, structured) : status === undefined || status === 'ok');
    // Without a checkout, `start_run` has the turn end with only NO_REPLY: the run shows in the thread, and its own
    // turn answers.
    if (ev.name === 'start_run' && !this.#ctx.workspace) {
      if (ok) {
        this.#handedToRun = true;
        this.#workedSincePost = false;
      }
      return;
    }
    if (!card && !MCP_POSTING_TOOLS.has(ev.name as McpToolName)) return;
    const key = ev.id ?? ev.name;
    const input = this.#posts.get(key) as { text?: unknown } | undefined;
    this.#posts.delete(key);
    if (!ok) return;
    this.posted = true;
    this.#workedSincePost = false;
    if (card) {
      this.#answeredByCard = true;
      return;
    }
    if (typeof input?.text === 'string') this.#postedTexts.add(splitMore(input.text).text);
  }

  /** The provider's answer so far, and the turn's usage so far. */
  final(ev: Extract<TurnEvent, { type: 'final' }>): void {
    this.#finalText = ev.text;
    this.usage = combinedUsage(this.#earlierUsage, ev.usage);
  }

  /** The model was refused and the turn runs again (ME-05): what the refused attempt said is not its answer. */
  discardFinal(): void {
    this.#finalText = '';
  }

  /** A person's direct request must end with an answer after its work, not just a progress message or hint. */
  get needsCompletion(): boolean {
    const { dispatch, conversation, outside } = this.#ctx;
    const direct = ['dm', 'mention', 'expand'].includes(dispatch.trigger);
    return (
      !outside &&
      conversation.kind === 'dm' &&
      dispatch.mode === 'reply' &&
      direct &&
      !this.#answeredByCard &&
      ((!this.posted && !this.#handedToRun && !dispatch.postedAt) || this.#workedSincePost) &&
      (!splitMore(this.#finalText).text || this.#finalText.trim() === NO_REPLY)
    );
  }

  /** Keep the first attempt's usage while asking the same session to give its missing answer. */
  beginRecovery(): void {
    this.#earlierUsage = this.usage;
    this.#finalText = '';
    this.thinking = true;
  }

  /**
   * A follow-up the turn took (steering.md SX-06): any distinct answer it gave before goes out now,
   * and the turn works on a new request — thinking again, its own final text to come.
   */
  async steered(deps: PostingDeps): Promise<void> {
    const answered = this.#unposted();
    if (answered) await this.#deliver(deps, answered);
    this.#finalText = '';
    this.#postedTexts.clear();
    this.#workedSincePost = false;
    this.#handedToRun = false;
    this.#answeredByCard = false;
    this.posted = false;
    this.thinking = this.#ctx.dispatch.mode === 'reply';
  }

  /**
   * The provider's answer is complete while it still does its own upkeep (hermes-engine.md HE-S20): the answer goes out
   * now, and nothing says the agent is thinking any more.
   */
  async answered(deps: PostingDeps): Promise<void> {
    const text = this.#unposted();
    if (text) await this.#deliver(deps, text);
    this.thinking = false;
  }

  /** At the end of the turn: its answer, even when it sent a progress message earlier. */
  async postFinal(deps: PostingDeps): Promise<void> {
    const text = this.#unposted();
    if (text) await this.#deliver(deps, text);
  }

  async #deliver(deps: PostingDeps, text: string): Promise<void> {
    this.posted = await postFinalText(this.#ctx, deps, text);
    this.#postedTexts.add(splitMore(text).text);
    this.#workedSincePost = false;
  }

  /**
   * The final text still to post, or null. `NO_REPLY`: a retry of a turn that already posted had nothing new to say
   * (`turnPrompt`); a scheduled check that found nothing.
   */
  #unposted(): string | null {
    if (this.#answeredByCard) return null;
    // Runs and search answers have their own completion tools and keep their delivery rules.
    if (this.#ctx.dispatch.mode !== 'reply' && this.posted) return null;
    const text = this.#finalText.trim();
    const body = splitMore(text).text;
    return body && text !== NO_REPLY && !this.#postedTexts.has(body) ? text : null;
  }
}

function combinedUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (!a || !b) return a ?? b;
  const sum = (key: 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd') =>
    a[key] === undefined && b[key] === undefined ? {} : { [key]: (a[key] ?? 0) + (b[key] ?? 0) };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...sum('cacheReadTokens'),
    ...sum('cacheWriteTokens'),
    ...sum('costUsd'),
    ...(a.largestCallInputTokens !== undefined || b.largestCallInputTokens !== undefined
      ? { largestCallInputTokens: Math.max(a.largestCallInputTokens ?? 0, b.largestCallInputTokens ?? 0) }
      : {}),
  };
}
