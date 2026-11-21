/**
 * The runner's side of a turn's words (docs/decisions/hermes-engine.md HE-34): `SOUL.md`, `whombat.md` and the per-turn
 * preface are rendered by `@whombat/agent-runtime`'s `persona/prompt.ts` from the dispatch context; the runner reads the
 * “More detail” hint off a final text (`splitMore`) and prepares the sandbox and network the agent's keys allow.
 */
import { MORE_HINT_MAX } from '@whombat/core';

export {
  AUTOMATION_REPLY_LINE,
  NO_REPLY,
  networkFor,
  personaGrants,
  REPLY_STYLE_LINES,
  reviewsChange,
  sandboxFor,
  soulMd,
  turnPrompt,
  WRITING_LINES,
  whombatMd,
} from '@whombat/agent-runtime';

/** The final-text line that offers “More detail” (`MORE: the two other options`), see `splitMore`. */
const MORE_LINE = /(?:^|\n)[ \t]*MORE:[ \t]*([^\n]*)\s*$/;

/**
 * A turn's final text posted as its reply, and the “More detail” hint on its last `MORE:` line (concise-replies.md
 * CNR-04). The line never shows in the message; an empty one offers nothing.
 */
export function splitMore(text: string): { text: string; more: string | null } {
  const m = MORE_LINE.exec(text);
  if (!m) return { text: text.trim(), more: null };
  const hint = (m[1] ?? '').trim().slice(0, MORE_HINT_MAX);
  return { text: text.slice(0, m.index).trim(), more: hint || null };
}
