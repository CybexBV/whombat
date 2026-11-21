/**
 * Naming a Whombat (whombat-switcher.md AP-3086, AP-3087): the directory's name is what the list and the burrow name's
 * menu show, and until someone names a Whombat they show its id. The person names them on the list; web and phone
 * check the name and word a refusal the same way.
 */
import { ControlError } from './control';
import { COPY } from './copy';

/** The directory's limit (`DisplayName`: trimmed, 1–80 characters). */
export const WHOMBAT_NAME_MAX = 80;

/** What is wrong with a typed name, or null when control will take it (trimmed). */
export function whombatNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return COPY.appliances.nameErrors.empty;
  if (trimmed.length > WHOMBAT_NAME_MAX) return COPY.appliances.nameErrors.long;
  return null;
}

/** Why control didn't take the name, in the list's words. */
export function renameErrorText(error: unknown): string {
  const t = COPY.appliances.nameErrors;
  if (error instanceof ControlError) {
    if (error.code === 'not_found') return t.missing;
  }
  return t.failed;
}
