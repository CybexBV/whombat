/** What a tracker read gives an agent has the tokens it was read with taken out (docs/decisions/report-trackers.md). */

export const SCRUBBED = '[token removed]';

/** `text` with every occurrence of each secret replaced. Secrets shorter than 8 characters are left alone. */
export function scrubSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join(SCRUBBED);
  return out;
}
