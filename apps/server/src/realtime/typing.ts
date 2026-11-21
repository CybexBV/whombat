/**
 * The agent's thinking indicator (ephemeral, never stored; people's typing went with one person per Whombat,
 * one-person.md OP-S14). An indicator lives `TYPING_TTL_MS` (6 s) unless it
 * is refreshed; when it lapses (or is stopped) an `active: false` frame clears it on every client.
 *
 * An agent's “thinking” names the turn that thinks (`typing.dispatchId`, contracts CT-295): what Stop on that line
 * cancels (docs/decisions/review-features.md RF-01). Turns nobody stops from the line (a Feedback assessment, an
 * automation step) leave it out.
 */
import { TYPING_TTL_MS, topics } from '@whombat/core';
import type { Clock } from '../lib/time';
import type { RealtimeBus } from './bus';

export interface TypingKey {
  conversationId: string;
  threadRootId: string | null;
  principalId: string;
}

export class TypingService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** The turn each active indicator names (agents' thinking only). */
  private readonly turns = new Map<string, string>();

  constructor(
    private readonly bus: RealtimeBus,
    private readonly clock: Clock,
    private readonly ttlMs = TYPING_TTL_MS,
  ) {}

  private key(k: TypingKey): string {
    return `${k.conversationId}|${k.threadRootId ?? ''}|${k.principalId}`;
  }

  private frame(k: TypingKey, active: boolean, dispatchId: string | null) {
    const now = this.clock();
    this.bus.publish({
      topic: topics.conversation(k.conversationId),
      event: {
        type: 'typing',
        conversationId: k.conversationId,
        threadRootId: k.threadRootId,
        principalId: k.principalId,
        active,
        expiresAt: new Date(now.getTime() + (active ? this.ttlMs : 0)).toISOString(),
        ...(dispatchId ? { dispatchId } : {}),
      },
      eventId: null,
      at: now.toISOString(),
      outboxId: null,
    });
  }

  /**
   * Starts or refreshes an indicator ("Dusty is thinking"). `dispatchId`: the agent's turn that thinks (absent: the turn
   * it named before, if any).
   */
  start(k: TypingKey, dispatchId?: string | null): void {
    const id = this.key(k);
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    if (dispatchId) this.turns.set(id, dispatchId);
    else if (dispatchId === null || !existing) this.turns.delete(id);
    const turn = this.turns.get(id) ?? null;
    this.frame(k, true, turn);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.turns.delete(id);
      this.frame(k, false, turn);
    }, this.ttlMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** Clears an indicator now (reply posted, dispatch finished, turn stopped). */
  stop(k: TypingKey): void {
    const id = this.key(k);
    const existing = this.timers.get(id);
    if (!existing) return;
    clearTimeout(existing);
    this.timers.delete(id);
    const turn = this.turns.get(id) ?? null;
    this.turns.delete(id);
    this.frame(k, false, turn);
  }

  /** The turn an active thinking indicator names, if any. */
  turnOf(k: TypingKey): string | null {
    return this.timers.has(this.key(k)) ? (this.turns.get(this.key(k)) ?? null) : null;
  }

  isActive(k: TypingKey): boolean {
    return this.timers.has(this.key(k));
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.turns.clear();
  }
}
