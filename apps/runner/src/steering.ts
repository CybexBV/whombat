/**
 * Same-person follow-ups into a running turn (docs/decisions/steering.md). The server offers them with every beat's
 * answer (`ProgressResponse.inject`, oldest first) until this runner reports them delivered (`ProgressBody.injected`)
 * or the turn ends; it then closes each delivered follow-up's queued dispatch as merged into this turn.
 *
 * Per message, once: its files are fetched and checked as a trigger's are (`prepareTurnFiles`), it is rendered like the
 * turn's request, and handed to the provider (`TurnSteering`) in order. The provider's `steered` event is the delivery;
 * a queued dispatch is reported when every message the server offered for it in its latest answer was delivered. A
 * message the provider refused, or that never got that far, is never reported: its dispatch runs as its own turn.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  attachmentNote,
  type ProviderCapabilities,
  promptText,
  showsMessageFiles,
  type TurnSteer,
  type TurnSteering,
} from '@whombat/agent-runtime';
import { type DispatchContext, type Message, TURN_INJECT_MAX, type TurnInjection } from '@whombat/core';
import type { RunnerApi } from './api';
import { prepareTurnFiles } from './attachments';
import type { FilesCache } from './files-cache';

type State = 'preparing' | 'ready' | 'sent' | 'delivered' | 'refused' | 'failed';

export interface FollowUpDeps {
  api: RunnerApi;
  workspacesRoot: string;
  log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: Record<string, unknown>) => void;
  filesCache?: FilesCache;
}

/** A person's first name, an agent's name (the request's own way of naming people). */
function nameOf(ctx: DispatchContext, id: string): string {
  const p = ctx.principals.find((x) => x.id === id);
  if (!p) return 'Someone';
  return p.kind === 'person' ? (p.name.split(/\s+/)[0] ?? p.name) : p.name;
}

/**
 * A follow-up as the model reads it (SX-08): who added what while it worked, with the message's files, like the turn's
 * request (“Mara is asking you: …”); then that it belongs to this turn, and, when it doesn't name the agent outside a
 * DM, that it may not be for it (reply-to.md RT-05).
 */
export function followUpPrompt(ctx: DispatchContext, m: Message): string {
  const note = showsMessageFiles(ctx, m) ? attachmentNote(ctx, m) : null;
  const lines = [
    `${nameOf(ctx, m.authorId)} added this while you were working (message ${m.id}): ${promptText(m)}${note ? ` ${note}` : ''}`.trim(),
    'It is part of what you are doing now: take it into account, and answer it in this turn together with the rest.',
  ];
  if (ctx.conversation.kind !== 'dm' && !m.mentions.includes(ctx.agent.id))
    lines.push('They didn’t name you; if it isn’t meant for you, carry on without answering it.');
  return lines.join('\n');
}

/** Whether a turn takes follow-ups at all: a person's chat or run turn, never an assessment or an answer. */
export function takesFollowUps(ctx: DispatchContext): boolean {
  const d = ctx.dispatch;
  if (d.mode === 'answer') return false;
  // A Looks ahead check takes none: nobody's words may join a turn that reads strangers' text (looks-ahead.md).
  return !['feedback', 'search', 'expand', 'automation', 'ahead'].includes(d.trigger);
}

/** The follow-ups of a turn whose provider can take them (`capabilities().steering`); null otherwise. */
export function followUpsFor(
  ctx: DispatchContext,
  caps: ProviderCapabilities,
  opts: { deps: FollowUpDeps; signal: AbortSignal },
): TurnFollowUps | null {
  if (!caps.steering || !takesFollowUps(ctx)) return null;
  return new TurnFollowUps({ ctx, caps, ...opts });
}

export class TurnFollowUps implements TurnSteering {
  readonly #ctx: DispatchContext;
  readonly #deps: FollowUpDeps;
  readonly #caps: ProviderCapabilities;
  readonly #signal: AbortSignal;
  /** Per message id: how far it got. */
  readonly #states = new Map<string, State>();
  /** Ready for the provider before it opened, in order. */
  readonly #ready: TurnSteer[] = [];
  /** The server's latest offer: queued dispatch → its message ids. */
  #latest = new Map<string, string[]>();
  #take: ((steer: TurnSteer) => boolean) | null = null;
  #closed = false;
  #chain: Promise<void> = Promise.resolve();
  #n = 0;
  readonly #dirs: string[] = [];
  readonly #releases: (() => Promise<void>)[] = [];

  constructor(opts: {
    ctx: DispatchContext;
    deps: FollowUpDeps;
    caps: ProviderCapabilities;
    signal: AbortSignal;
  }) {
    this.#ctx = opts.ctx;
    this.#deps = opts.deps;
    this.#caps = opts.caps;
    this.#signal = opts.signal;
  }

  /* The provider's side (TurnSteering) ------------------------------------------------------------------------- */

  open(take: (steer: TurnSteer) => boolean): void {
    if (this.#closed) return;
    this.#take = take;
    for (const steer of this.#ready.splice(0)) this.#hand(steer);
  }

  close(): void {
    this.#closed = true;
    this.#take = null;
    for (const steer of this.#ready.splice(0)) this.#states.set(steer.id, 'refused');
  }

  /* The runner's side ---------------------------------------------------------------------------------------- */

  /** A beat's answer: what the server offers now (replacing the last offer); new messages start on their way. */
  offer(items: readonly TurnInjection[]): void {
    const latest = new Map<string, string[]>();
    for (const item of items) {
      latest.set(item.dispatchId, [...(latest.get(item.dispatchId) ?? []), item.messageId]);
      if (this.#states.has(item.messageId) || this.#closed || this.#signal.aborted) continue;
      this.#states.set(item.messageId, 'preparing');
      this.#chain = this.#chain.then(() => this.#prepare(item));
    }
    this.#latest = latest;
  }

  /** The provider's `steered`: true when it is one of the follow-ups this turn handed it. */
  steered(id: string): boolean {
    if (this.#states.get(id) !== 'sent') return false;
    this.#states.set(id, 'delivered');
    this.#deps.log('info', `${this.#ctx.agent.name} · took a follow-up into the turn (${id})`, {
      dispatchId: this.#ctx.dispatch.id,
    });
    return true;
  }

  /** The queued dispatches to report delivered: every message the latest offer named for each was delivered. */
  injected(): string[] {
    const out: string[] = [];
    for (const [dispatchId, messages] of this.#latest)
      if (messages.every((m) => this.#states.get(m) === 'delivered')) out.push(dispatchId);
    return out.slice(0, TURN_INJECT_MAX);
  }

  /** Waits for what is being prepared (tests), then forgets the files fetched for follow-ups. */
  async release(): Promise<void> {
    await this.#chain.catch(() => {});
    for (const release of this.#releases.splice(0)) await release().catch(() => {});
    for (const dir of this.#dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  /** Waits until everything offered so far was prepared and handed on (tests). */
  settled(): Promise<void> {
    return this.#chain;
  }

  async #prepare(item: TurnInjection): Promise<void> {
    if (this.#closed || this.#signal.aborted) {
      this.#states.set(item.messageId, 'refused');
      return;
    }
    try {
      let section = '';
      let attachments: TurnSteer['attachments'];
      if (item.attachments.length) {
        // Its own folder under the workspaces root (which every task sandbox denies), like the turn's files.
        const root = join(
          this.#deps.workspacesRoot,
          '.scratch',
          `follow-up-${safe(this.#ctx.dispatch.id)}-${++this.#n}`,
        );
        this.#dirs.push(root);
        const files = await prepareTurnFiles(
          { ...this.#ctx, attachments: item.attachments, trigger: item.message, thread: null, window: [] },
          { ...this.#deps, workspacesRoot: root },
          this.#caps,
          this.#signal,
        );
        this.#releases.push(files.release);
        section = files.section;
        attachments = files.attachments;
      }
      const steer: TurnSteer = {
        id: item.messageId,
        prompt: `${followUpPrompt(this.#ctx, item.message)}${section ? `\n${section}` : ''}`,
        ...(attachments?.length ? { attachments } : {}),
      };
      if (this.#closed) this.#states.set(steer.id, 'refused');
      else if (this.#take) this.#hand(steer);
      else {
        this.#states.set(steer.id, 'ready');
        this.#ready.push(steer);
      }
    } catch (err) {
      this.#states.set(item.messageId, 'failed');
      this.#deps.log('warn', `a follow-up could not be prepared: ${String(err)}`, {
        dispatchId: this.#ctx.dispatch.id,
        messageId: item.messageId,
      });
    }
  }

  #hand(steer: TurnSteer): void {
    const take = this.#take;
    this.#states.set(steer.id, take?.(steer) ? 'sent' : 'refused');
  }
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}
