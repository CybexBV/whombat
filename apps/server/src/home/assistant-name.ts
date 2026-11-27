/**
 * How Whombat's words name the agent (docs/decisions/archive/assistant-name.md AN-01; one-agent.md OA-23): by its own name
 * (“Dusty can’t use it until then.”), since “Whombat” is the product and the box; “your assistant” when no name can be
 * known (the burrow has no agent yet). Never a pronoun for it.
 */
import { tServer } from '../i18n/catalog';

/** The assistant as a sentence names it: its name, else “Your assistant” (`start`) or “your assistant”. */
export function assistantCalled(
  name: string | null | undefined,
  start = true,
  locale?: string | null,
): string {
  const known = name?.trim();
  if (known) return known;
  return tServer(locale, start ? 'home.assistant.start' : 'home.assistant.mid');
}
