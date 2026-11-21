/**
 * How long the prompt cache a turn writes lives (docs/decisions/prompt-efficiency.md PE-DR10, PE-12), by which the
 * server judges a resumed turn's cache result. Pure. Goes with Whombat's session store in step 3 (hermes-engine.md
 * HE-S35): Hermes keeps the sessions then.
 */

/**
 * Turns a person's message started (PE-DR10, after Hermes Agent): a mention, a DM, “More detail” and a search question.
 * The next one comes when the person writes again, often after more than five minutes, so their prompt cache is kept an
 * hour. Every other turn is machine-paced — a schedule, a reflection, a job's wake-up, an automation, a run, a retry,
 * the answer to an approval or a Vault entry, a Feedback assessment — and keeps Claude Code's own choice
 * (5 minutes on an API key).
 */
const PERSON_PACED_TRIGGERS: ReadonlySet<string> = new Set(['mention', 'dm', 'expand', 'search']);

/** Whether a dispatch trigger is paced by a person typing (its prompt cache lives an hour) rather than by Whombat. */
export function personPacedTrigger(trigger: string | null | undefined): boolean {
  return PERSON_PACED_TRIGGERS.has(trigger ?? '');
}

/** The prompt cache's lifetime when nobody asks for more (Anthropic's 5 minutes; OpenAI's in-memory cache likewise). */
export const PROMPT_CACHE_TTL_MS = 5 * 60_000;
/** Claude Code's longer prompt cache (`promptCacheTtl: "1h"`), for the turns a person paces (PE-DR10). */
export const PROMPT_CACHE_LONG_TTL_MS = 60 * 60_000;

/**
 * How long the prompt cache a turn writes lives (PE-12): an hour for a person-paced Claude turn (PE-DR10), five minutes
 * otherwise — Codex 0.157 has no lifetime switch, and a machine-paced Claude turn keeps Claude Code's own choice (five
 * minutes on an API key; on a subscription it may keep an hour, which this rule doesn't count on).
 */
export function promptCacheTtlMs(provider: string, trigger: string | null | undefined): number {
  return provider === 'claude' && personPacedTrigger(trigger)
    ? PROMPT_CACHE_LONG_TTL_MS
    : PROMPT_CACHE_TTL_MS;
}
