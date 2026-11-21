/**
 * Copy for the commands the agent asks about (Whombat agent-computer.md AC-41, AC-42; contracts 0.36.0, CT-217, CT-221;
 * since 3.0 without the computer, CT-1530). Shared by web, Android, the runner (what an agent reads when a command is
 * refused) and the server.
 */
import { KEY_CATALOG } from '../keys/catalog.js';
import { BLOCKED_GUIDANCE } from '../text/outcomes.js';
import { type CommandCategory, type CommandScope, commandCategoryKey } from './commands.js';
import type { CommandAllowance } from './schemas.js';

/* Commands (AC-41, AC-42) ------------------------------------------------------------------------------------- */

/** What each category is called on a card and in Access settings. */
export const COMMAND_CATEGORY_LABELS: Readonly<Record<CommandCategory, string>> = {
  deploy: 'Deploy',
  deploy_production: 'Deploy to production',
  merge: 'Merge into main',
  push_main: 'Push to main',
  destructive: 'Destructive command on another machine',
  message_external: 'Message outside your Whombat',
  web: 'Look something up on the web',
  browser: 'Use the browser',
};

/** The two categories that aren't shell commands but a Hermes tool call at Ask (CT-1236): their words say “this”. */
export function isToolCategory(category: CommandCategory): boolean {
  return category === 'web' || category === 'browser';
}

/** The `run_command` card's buttons, in order (AC-42), with the agent's name: “Always allow for Banjo”. */
export function commandScopeLabels(agentName: string): Readonly<Record<CommandScope, string>> {
  return { once: 'Allow once', task: 'Allow for this task', agent: `Always allow for ${agentName}` };
}

/** The `run_command` card's decline button. */
export const COMMAND_DECLINE_CTA = 'Don’t allow';

/** How a refused command ends (AC-41): exit 126 for Off and a no, 125 when nobody answered in time. */
export const COMMAND_EXIT_CODES = { refused: 126, timedOut: 125 } as const;

/** The approval wait for a command (AC-41, `WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES`). */
export const COMMAND_APPROVAL_WAIT_MINUTES_DEFAULT = 15;

/**
 * Off (exit 126): “This command needs the key “Deploy to production”, which Banjo doesn’t hold, so it didn’t run. If
 * you need it, ask for the key with request_approval (grant_key) in one line and carry on with what you can do
 * without it.” (RA-12, 0.44.0)
 */
export function commandBlockedText(category: CommandCategory, agentName: string): string {
  const label = KEY_CATALOG[commandCategoryKey(category)].label;
  const what = isToolCategory(category) ? 'This' : 'This command';
  const ran = isToolCategory(category) ? 'it didn’t happen' : 'it didn’t run';
  return `${what} needs the key “${label}”, which ${agentName} doesn’t hold, so ${ran}. If you need it, ${BLOCKED_GUIDANCE}.`;
}

/** Ask, while the card waits: what the agent's command (or web or browser tool) prints before it waits. */
export function commandWaitingText(category: CommandCategory): string {
  const label = KEY_CATALOG[commandCategoryKey(category)].label;
  const what = isToolCategory(category) ? 'This' : 'This command';
  return `${what} needs a person’s yes (“${label}”). A card with it is in the thread; waiting for an answer…`;
}

/**
 * Ask, when the command doesn't say what it is for (exit 126; no card yet): the person decides by the why on the card,
 * so the agent runs it again with one (`commandWhy`).
 */
export function commandWhyNeededText(category: CommandCategory): string {
  const label = KEY_CATALOG[commandCategoryKey(category)].label;
  return `This command needs a person’s yes (“${label}”), and they decide by why you need it, so it didn’t run. Run it again with a first line # why: <what it is for, in one plain sentence>; they read that line on its card.`;
}

/**
 * A no (exit 126): “Mara said no; the command didn’t run.”; for a web or browser tool call (CT-1236) “Mara said no; it
 * didn’t happen.”
 */
export function commandDeclinedText(personName: string, category?: CommandCategory): string {
  return category && isToolCategory(category)
    ? `${personName} said no; it didn’t happen.`
    : `${personName} said no; the command didn’t run.`;
}

/** No answer in time (exit 125): the card stays, and a later yes wakes the agent. */
export function commandTimedOutText(minutes: number): string {
  return `Nobody answered in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}; the command didn’t run. The card stays in the thread: do what doesn’t depend on it, then end your turn with one line saying what waits; when a person allows it, you’ll be woken and may run it then.`;
}

/**
 * Allowed, the command (or a web or browser tool call, CT-1236) goes ahead: “Allowed once by Mara.”, “Allowed for this
 * task by Mara.”, “Always allowed by Mara.”.
 */
export function commandAllowedText(scope: CommandScope, personName: string): string {
  if (scope === 'task') return `Allowed for this task by ${personName}.`;
  if (scope === 'agent') return `Always allowed by ${personName}.`;
  return `Allowed once by ${personName}.`;
}

/** The agent's Access settings: commands always allowed (AC-42). */
export const COMMAND_ALLOWANCES_COPY = {
  title: 'ALWAYS ALLOWED COMMANDS',
  empty: 'No commands are always allowed. “Always allow” on a command card adds one here.',
  remove: 'Remove',
  removed: 'Removed. The command asks again next time.',
} as const;

/** One allowance's second line: “web-1 · Deploy to production”, or just the key. */
export function commandAllowanceLine(allowance: Pick<CommandAllowance, 'keyId' | 'target'>): string {
  const label = KEY_CATALOG[allowance.keyId].label;
  return allowance.target ? `${allowance.target} · ${label}` : label;
}
