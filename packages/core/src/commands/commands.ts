/**
 * Commands the agent asks about (Whombat agent-computer.md AC-40…AC-42, contracts 0.36.0, CT-217): the
 * categories `classifyCommand` finds, the key each one needs, how they rank, and the scope a person allows one for.
 */
import { z } from 'zod';
import type { KeyId } from '../keys/catalog.js';

/**
 * What a consequential command does (AC-40), in severity order, most severe first (`COMMAND_CATEGORY_RANK`):
 *
 * - `deploy_production`: reaches a production server of the Vault (ssh, scp, rsync, sftp, `docker -H`, or a deploy tool
 *   naming one), by its name, host or address.
 * - `push_main`: `git push` to a default branch (`main`, `master`, `HEAD:main`, `+main`, `refs/heads/main`, `--all`,
 *   `--mirror`).
 * - `merge`: `gh pr merge` (and `gh api … pulls/N/merge`).
 * - `deploy`: a deploy tool (`fly deploy`, `wrangler deploy`, `vercel --prod`, `kubectl apply`, `helm upgrade`,
 *   `terraform apply`, `pulumi up`, `docker push`, `npm publish`, …).
 * - `destructive`: a destructive command on another machine (over ssh: `rm -rf`, `DROP TABLE`, `TRUNCATE`, `docker
 *   compose down`, `systemctl stop`, `mkfs`, `dd of=/dev/…`; `docker -H ssh://…`; a database client on another host
 *   dropping or truncating).
 * - `message_external`: a message to the outside world (`sendmail`, `mail`, `swaks`, webhooks of Slack, Discord,
 *   Telegram and Teams).
 *
 * A command several parts of which match gets the most severe category. Destructive commands on the person's
 * Whombat, inside the commands' wrapper, are not asked about (AC-40).
 *
 * Since 0.125 (CT-1236; Whombat hermes-engine.md HE-44) two more, which `classifyCommand` never finds: the runner asks
 * with them when a Hermes tool call needs a person's yes because the agent's key asks — `web` (a web search or fetch,
 * key “Browse the web”) and `browser` (Hermes's browser, key “Use a web browser”). Their `command` is the tool's name,
 * `target` the address's host (null when there is none) and `reason` the query or the address.
 */
export const COMMAND_CATEGORIES = [
  'deploy',
  'deploy_production',
  'merge',
  'push_main',
  'destructive',
  'message_external',
  'web',
  'browser',
] as const;
export const CommandCategory = z.enum(COMMAND_CATEGORIES);
export type CommandCategory = z.infer<typeof CommandCategory>;

/** Most severe first: when several parts of a command match, the first of these wins. */
export const COMMAND_CATEGORY_RANK: readonly CommandCategory[] = [
  'deploy_production',
  'push_main',
  'merge',
  'deploy',
  'destructive',
  'message_external',
  'browser',
  'web',
];

/** The key each category needs (AC-41). */
export const COMMAND_CATEGORY_KEYS: Readonly<Record<CommandCategory, KeyId>> = {
  deploy: 'deploy',
  deploy_production: 'deploy.production',
  merge: 'merge.main',
  push_main: 'branch.main.push',
  destructive: 'commands.destructive',
  message_external: 'messages.external',
  web: 'web.browse',
  browser: 'browser.use',
};

/** The key a category needs: deploy → `deploy`, deploy to production → `deploy.production`, … (AC-41). */
export function commandCategoryKey(category: CommandCategory): KeyId {
  return COMMAND_CATEGORY_KEYS[category];
}

/** The more severe of two categories (`COMMAND_CATEGORY_RANK`). */
export function moreSevereCategory(a: CommandCategory, b: CommandCategory): CommandCategory {
  return COMMAND_CATEGORY_RANK.indexOf(a) <= COMMAND_CATEGORY_RANK.indexOf(b) ? a : b;
}

/**
 * How long a person's yes lasts (AC-42): `once` this command in this turn; `task` the same command and target for the
 * rest of the run (of the thread when there is no run); `agent` always, stored as a `CommandAllowance`.
 */
export const COMMAND_SCOPES = ['once', 'task', 'agent'] as const;
export const CommandScope = z.enum(COMMAND_SCOPES);
export type CommandScope = z.infer<typeof CommandScope>;

/** The longest command an approval or an allowance holds (characters). */
export const COMMAND_MAX = 8000;
/** The longest target (a server name, a host, a branch, a repository). */
export const COMMAND_TARGET_MAX = 253;
/** The longest reason an agent gives with a command. */
export const COMMAND_REASON_MAX = 500;

/**
 * A command as allowances compare it (AC-42): runs of whitespace (spaces, tabs, line breaks) become one space, and the
 * ends are trimmed. Quoting is kept as written, so `rm -rf "a b"` and `rm -rf a b` differ; whitespace inside quotes is
 * collapsed too (a command that differs only there is the same command).
 */
export function normaliseCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

/** A comment line of the shell (`# why: …`); `#!` names an interpreter and is none. */
const COMMENT_LINE = /^\s*#(?!!)(.*)$/;

/**
 * What the agent says a command is for, and the command itself: the comment lines it starts with (`# why: stop the
 * soak test first`), joined, without the `why:`; and what follows them, which is all the shell runs. The person reads
 * the why on the command's card. Null when the command starts with no comment.
 */
export function commandWhy(command: string): { why: string | null; command: string } {
  const lines = command.split('\n');
  const said: string[] = [];
  let i = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const comment = COMMENT_LINE.exec(line);
    if (comment) said.push(comment[1] ?? '');
    else if (line.trim() !== '') break;
  }
  const why = said
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^why\s*:\s*/i, '')
    .slice(0, COMMAND_REASON_MAX)
    .trim();
  return { why: why || null, command: lines.slice(i).join('\n').trim() };
}
