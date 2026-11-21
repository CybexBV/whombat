/**
 * What the provider mappers keep of a tool's output for activity evidence (work-supervision WS-14): the tail of
 * its text, bounded here once more by the runner, which also redacts it. Pure.
 */
import { TOOL_OUTPUT_TAIL } from '../contract';

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : null;
}

/** The last `max` characters of `text`, or undefined when there is none. */
export function outputTail(text: string | null | undefined, max = TOOL_OUTPUT_TAIL): string | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  return text.length > max ? text.slice(text.length - max) : text;
}

/**
 * The text of a tool result's content: a string, or MCP / Messages API content blocks (`{type: 'text', text}`;
 * images and other blocks are left out), joined by newlines.
 */
export function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const raw of content) {
    const block = obj(raw);
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text);
    // ACP wraps content blocks: `{type: 'content', content: {type: 'text', text}}`.
    const inner = obj(block?.content);
    if (block?.type === 'content' && inner?.type === 'text' && typeof inner.text === 'string' && inner.text)
      parts.push(inner.text);
  }
  return parts.length ? parts.join('\n') : undefined;
}

/** A JSON object in `text` (a Whombat MCP tool's result as its text content), else undefined. */
export function jsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return obj(JSON.parse(trimmed)) ?? undefined;
  } catch {
    return undefined;
  }
}
