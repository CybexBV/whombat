/**
 * Text Whombat Feedback writes into the report thread (docs/decisions/feedback.md FB-22): agent text — the assessor's
 * reply (FB-32) and its thread replies — shown as inert plain text, no Markdown, no mentions, no links, so nothing an
 * assessor echoes from a visitor's report can format, mention, link or command anything. The assessment itself is on
 * the `assessment` card, where clients show every field as plain text.
 */
import { canonicalJson, type FeedbackAssessment, sha256Hex } from '@whombat/core';

/** U+2060 WORD JOINER: invisible, and it keeps `@Name` from being a mention and `https://` from being a link. */
const JOIN = '⁠';

/**
 * Agent or visitor text as inert plain text on one line: whitespace collapsed, every Markdown character escaped
 * (`parseInline` honours `\\` escapes), `@` followed by a word joiner (so `@Dusty` is neither parsed as a mention by
 * `resolveMentions` nor rendered as one) and `://` broken the same way (no bare links).
 */
export function inertText(text: string, max = 1200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return cut
    .replace(/[\\`*_~[\]()#>]/g, (c) => `\\${c}`)
    .replace(/@/g, `@${JOIN}`)
    .replace(/:\/\//g, `:${JOIN}//`);
}

/** Source characters an assessor's reply keeps (escaping at most doubles them, so it stays a valid message). */
export const INERT_REPLY_MAX = 3900;

/**
 * An assessor's `reply_in_thread` text (and the runner's final-text fallback) as inert plain text (review-2 F2): the
 * same neutralization as the summary line by line — Markdown characters escaped, `@` and `://` broken, so no mention,
 * link, emphasis or code — and every line started with a word joiner, so no line is a heading, list, quote, rule or
 * code fence either. Line breaks are kept (at most one blank line in a row).
 */
export function inertReply(text: string, max = INERT_REPLY_MAX): string {
  const src = text.replace(/\r\n?/g, '\n').trim();
  const cut = src.length > max ? `${src.slice(0, max - 1)}…` : src;
  return cut
    .split('\n')
    .map((line) => (line.trim() ? `${JOIN}${inertText(line, max)}` : ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** sha256 of the canonical assessment (binds a handoff to exactly what was assessed, FB-24). */
export function assessmentHash(assessment: FeedbackAssessment): string {
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(assessment))));
}
