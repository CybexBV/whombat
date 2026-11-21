/**
 * The error of a step's turn Whombat stopped after it handed its T3 Code wait over and didn't end by itself
 * (`turn-waits.ts`, docs/decisions/outsiders-turns.md). On its own so the runtime can read it without the automations.
 */
export const HANDED_OVER_ERROR = 'handed_over';
