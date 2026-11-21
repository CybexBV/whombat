/**
 * Whether a turn's failure is the tool refusing the turn's model (Whombat model-effort.md ME-05): not on the sign-in's
 * plan, not served by the AI gateway, unknown. Conservative on purpose — only a failure that says so about a model is
 * one; anything else (a sign-in, a limit, an outage, a bad request) fails as before. Pure, for the runner's fallback.
 *
 * Seen 2026-10-10: Claude Code 2.1.296 — `assistant.error` `model_not_found`, “There's an issue with the selected model
 * (claude-x). It may not exist or you may not have access to it.” (HTTP 404); the Messages API's own 404
 * `not_found_error` “model: claude-x”. Codex 0.162.1 — “{"detail":"The 'gpt-x' model is not supported when using Codex
 * with a ChatGPT account."}” (`codexErrorInfo` `other`); the Responses API's “The model `gpt-x` does not exist or you do
 * not have access to it.” (`model_not_found`).
 */

/** Provider codes that mean exactly this (Claude Code's `assistant.error`, an API's error code). */
const MODEL_CODES = new Set(['model_not_found']);

/** What a refusal of a model says. */
const REFUSED =
  /not[ _-]?found|does(?: not|n['’]t) exist|(?:is|was|are)(?: not|n['’]t) (?:available|supported|served|allowed|enabled|permitted)|not (?:available|supported|served|allowed|enabled|permitted)|unsupported|unknown model|invalid model|(?:do|does)(?: not|n['’]t) have access|no access to|issue with the selected model/i;

/** Ways a message names the model it is about without naming it. */
const ABOUT_A_MODEL =
  /selected model|\bmodel\b\s*[:=`'"‘’“”(]|\bmodel (?:id|name)\b|invalid model|unknown model|model[ _]not[ _]found/i;

/** Mentions of a sign-in, a key or a limit: those failures are never about the model alone. */
const NOT_THE_MODEL =
  /api key|log ?in|sign(?:ed)? ?in|authenticat|unauthori[sz]ed|oauth|token (?:has )?expired|rate.?limit|usage limit|quota|credit balance|billing|overloaded|context (?:window|length)/i;

export function modelRefused(
  error: { message: string; code?: string | undefined },
  model: string | null | undefined,
): boolean {
  if (!model) return false;
  if (error.code && MODEL_CODES.has(error.code)) return true;
  const text = error.message;
  if (!REFUSED.test(text) || NOT_THE_MODEL.test(text)) return false;
  const named = text.toLowerCase().includes(model.toLowerCase());
  return named || ABOUT_A_MODEL.test(text);
}
