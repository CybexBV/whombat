/**
 * `session/update` → Whombat turn events (bp-acp.md BP-E06):
 *
 * - `agent_message_chunk` (text) → `text_delta`; the reply for `final` is the last message — the text after
 *   the last tool call, or of the last `messageId` — so “I’ll set my status first.” before a tool call is not
 *   posted as part of the answer (as the native providers post Claude's result / Codex's final answer); when
 *   the last message is empty, all of the text;
 * - `agent_thought_chunk`, `plan`, `plan_update`, compaction and notices → `thinking`;
 * - `tool_call` → `tool_call` (Whombat MCP tools by their bare name, so the runner sees `post_message`), and
 *   `tool_result` once the call completed or failed (also from a later `tool_call_update`); both carry the
 *   `toolCallId`, the call its `kind` and `locations`, the result the tail of its text `content` (or a string
 *   `rawOutput`) and a Whombat tool's structured `rawOutput` (work-supervision WS-11);
 * - `usage_update` → the context size and cost, used for `final`'s usage when `session/prompt` reports none.
 *
 * Replayed history (`session/load`) and the user's own chunks are dropped by the caller. An agent whose replies always
 * carry a `messageId` (Hermes's gateway) says its notices without one (“⏩ Steer queued …”, a lost turn's recovery):
 * with `notices: 'without-message-id'` those are `thinking`, never part of the reply.
 */
import type {
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  Usage,
} from '@agentclientprotocol/sdk';
import type { ToolCategory, ToolOutcome, TurnEvent, TurnUsage } from '../contract';
import { contentText, jsonObject, outputTail } from '../support/tool-output';
import { describeToolCall, type KnownToolCall } from './permissions';

type ToolFields = Parameters<typeof describeToolCall>[0];

interface ToolEntry {
  fields: ToolFields;
  known: KnownToolCall;
  done: boolean;
  content: ToolCallContent[] | null;
  rawOutput: unknown;
}

const KIND_CATEGORY: Record<ToolKind, ToolCategory> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  execute: 'command',
  fetch: 'web',
  think: 'other',
  switch_mode: 'other',
  other: 'other',
};

/** What an ACP tool call is: a Whombat tool is an MCP tool, the rest by the runtime's `kind`. */
export function acpToolCategory(known: KnownToolCall): ToolCategory {
  if (known.whombat) return 'mcp';
  return known.kind ? KIND_CATEGORY[known.kind] : 'other';
}

function pathsOf(locations: ToolCallLocation[] | null | undefined): string[] | undefined {
  const paths = (locations ?? []).map((l) => l.path).filter((p) => typeof p === 'string' && p);
  return paths.length ? paths : undefined;
}

/** A repeated chunk shorter than this may be real text (a word said twice): kept. */
const REPEAT_MIN = 16;

export interface AcpEventMapperOptions {
  /** `without-message-id`: a message chunk without a `messageId` is the agent's notice, not reply text. */
  notices?: 'without-message-id';
  /** The agent's own word for what a call is, where its `kind` doesn't say (Hermes names, all `other`). */
  category?: (known: KnownToolCall) => ToolCategory | null;
}

export class AcpEventMapper {
  readonly #options: AcpEventMapperOptions;
  readonly #tools = new Map<string, ToolEntry>();
  #text = '';
  /** The current message: text since the last tool call or message id change. */
  #last = '';
  #lastId: string | null = null;
  #afterTool = false;
  #context: { used: number; costUsd?: number } | null = null;

  constructor(options: AcpEventMapperOptions = {}) {
    this.#options = options;
  }

  /** The reply: the last message, or all the text when that is empty. */
  get text(): string {
    return this.#last.trim() ? this.#last : this.#text;
  }

  /** A new answer starts (a follow-up the agent runs after it answered): the text so far was the last one's. */
  restart(): void {
    this.#text = '';
    this.#last = '';
    this.#lastId = null;
    this.#afterTool = false;
  }

  /** Whether the runtime reported usage of any kind. */
  get usageSeen(): boolean {
    return this.#context !== null;
  }

  /** What Whombat knows about a tool call the runtime announced (permission requests name only its id). */
  tool(toolCallId: string): { fields: ToolFields; known: KnownToolCall } | null {
    return this.#tools.get(toolCallId) ?? null;
  }

  map(update: SessionUpdate): TurnEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type !== 'text' || !update.content.text) return [];
        const id = update.messageId ?? null;
        if (id === null && this.#options.notices === 'without-message-id') return [{ type: 'thinking' }];
        if (this.#afterTool || (id !== null && this.#lastId !== null && id !== this.#lastId)) {
          // A new message: separate it from the one before in the full text.
          if (this.#text && !/\s$/.test(this.#text)) this.#text += '\n\n';
          this.#last = '';
        }
        this.#afterTool = false;
        if (id !== null) this.#lastId = id;
        // Hermes repeats a refused Codex turn's last sentence under the same message id (hermes-engine.md HE-37): a
        // chunk of a sentence or more that the message already ends with is that repeat, never new text.
        let chunk = update.content.text;
        if (chunk.trim().length >= REPEAT_MIN && this.#last.trimEnd().endsWith(chunk.trim())) return [];
        // The whole message sent again with something after it (a final reply that no longer matched what streamed):
        // only what is new is part of the reply.
        const said = this.#last.trim();
        if (said.length >= REPEAT_MIN && chunk.trimStart().startsWith(said)) {
          chunk = chunk.trimStart().slice(said.length);
          if (!chunk.trim()) return [];
        }
        this.#text += chunk;
        this.#last += chunk;
        return [{ type: 'text_delta', text: chunk }];
      }
      case 'agent_thought_chunk':
      case 'plan':
      case 'plan_update':
      case 'plan_removed':
      case 'compaction_update':
      case 'compaction_summary_chunk':
      case 'notice':
        return [{ type: 'thinking' }];
      case 'tool_call': {
        const fields: ToolFields = {
          title: update.title,
          name: update.name ?? null,
          kind: update.kind ?? null,
          rawInput: update.rawInput,
          _meta: update._meta ?? null,
        };
        const known = describeToolCall(fields);
        const entry: ToolEntry = {
          fields,
          known,
          done: false,
          content: update.content ?? null,
          rawOutput: update.rawOutput,
        };
        this.#tools.set(update.toolCallId, entry);
        this.#afterTool = true;
        const events: TurnEvent[] = [this.#call(update.toolCallId, entry, update.locations)];
        return [...events, ...this.#finish(update.toolCallId, entry, update.status)];
      }
      case 'tool_call_update': {
        let entry = this.#tools.get(update.toolCallId);
        const events: TurnEvent[] = [];
        if (!entry) {
          // An update for a call we never saw announced: announce it now.
          const fields: ToolFields = {
            title: update.title ?? null,
            name: update.name ?? null,
            kind: update.kind ?? null,
            rawInput: update.rawInput,
            _meta: update._meta ?? null,
          };
          entry = {
            fields,
            known: describeToolCall(fields),
            done: false,
            content: null,
            rawOutput: undefined,
          };
          this.#tools.set(update.toolCallId, entry);
          this.#afterTool = true;
          events.push(this.#call(update.toolCallId, entry, update.locations));
        }
        if (update.content) entry.content = update.content;
        if (update.rawOutput !== undefined) entry.rawOutput = update.rawOutput;
        return [...events, ...this.#finish(update.toolCallId, entry, update.status)];
      }
      case 'usage_update': {
        const cost =
          update.cost && update.cost.currency.toUpperCase() === 'USD' ? update.cost.amount : undefined;
        this.#context = { used: update.used, ...(cost !== undefined ? { costUsd: cost } : {}) };
        return [];
      }
      default:
        return [];
    }
  }

  #call(id: string, entry: ToolEntry, locations: ToolCallLocation[] | null | undefined): TurnEvent {
    const paths = pathsOf(locations);
    return {
      type: 'tool_call',
      name: entry.known.name,
      input: entry.fields.rawInput ?? {},
      category:
        (entry.known.whombat ? null : this.#options.category?.(entry.known)) ?? acpToolCategory(entry.known),
      id,
      ...(paths ? { paths } : {}),
    };
  }

  #finish(id: string, entry: ToolEntry, status: ToolCallStatus | null | undefined): TurnEvent[] {
    if (entry.done || (status !== 'completed' && status !== 'failed')) return [];
    entry.done = true;
    const ok = status === 'completed';
    const text =
      contentText(entry.content) ?? (typeof entry.rawOutput === 'string' ? entry.rawOutput : undefined);
    const raw =
      typeof entry.rawOutput === 'object' && entry.rawOutput !== null && !Array.isArray(entry.rawOutput)
        ? (entry.rawOutput as Record<string, unknown>)
        : undefined;
    // A Whombat tool's commit outcome: its structured output, or the JSON text Whombat's MCP server returns.
    const structuredRaw = raw && typeof raw.status === 'string' ? raw : undefined;
    const structured = entry.known.whombat ? (structuredRaw ?? jsonObject(text)) : undefined;
    const tail = outputTail(text);
    const outcome: ToolOutcome = {
      ...(ok ? {} : { error: 'error' as const }),
      ...(tail ? { output: tail } : {}),
      ...(structured ? { structured } : {}),
    };
    return [{ type: 'tool_result', name: entry.known.name, ok, id, outcome }];
  }

  /**
   * Usage for `final`: `session/prompt`'s own (input includes cache reads and writes, as the Claude adapter
   * counts it), else the context size of the last `usage_update` as input with no output counted; the cost
   * when the runtime reported one in USD.
   */
  usage(reported: Usage | null | undefined): TurnUsage | undefined {
    const costUsd = this.#context?.costUsd;
    if (reported) {
      return {
        inputTokens:
          reported.inputTokens + (reported.cachedReadTokens ?? 0) + (reported.cachedWriteTokens ?? 0),
        outputTokens: reported.outputTokens,
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    }
    if (!this.#context) return undefined;
    return {
      inputTokens: this.#context.used,
      outputTokens: 0,
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }
}
