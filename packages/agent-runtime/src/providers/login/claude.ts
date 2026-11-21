/**
 * Claude sign-ins on a managed appliance (PV-03; docs/decisions/provider-subscriptions.md SUB-01…SUB-03, SUB-14).
 *
 * - API key: the person's own Anthropic Console key, stored as a 0600 file in their credential home and read by
 *   Claude Code through its `apiKeyHelper` (`claudeManagedSettings`). No CLI is involved in storing it; a free Models
 *   API request checks it.
 * - Claude subscription (`subscription_cli`, permitted since SUB-01): the person signs in to the unmodified binary
 *   in its own flow — `claude auth login --claudeai` in a PTY with `CLAUDE_CONFIG_DIR` = their home's `config/`
 *   (`claudeConfigDir`), the web UI showing that console (SUB-03). The turn side is built: a subscription home runs
 *   turns with that config dir and nothing else (`credentialEnv`), its state comes from `claude auth status --json`
 *   (`parseClaudeAuthStatus`) and turn errors. The sign-in console itself is another workstream's (it needs contract
 *   ops for the console stream); until it lands, starting this sign-in answers `CLAUDE_SUBSCRIPTION_CONSOLE_PENDING`.
 * - `subscription_sdk` is gone: Claude never runs through the Agent SDK (SUB-02, SUB-10).
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type ClaudeAuthStatus, parseClaudeAuthStatus } from '../../claude/auth-status';
import { CLAUDE_BUNDLE } from '../bundles';
import { CLAUDE_KEY_FILE, claudeConfigDir, homeLinkProblem, writePrivateFile } from '../credential-home';
import { loginEnv, runCli } from './cli';
import type { LoginOutcome } from './device';

/**
 * Why a Claude subscription sign-in can't be started yet: the console that shows Claude Code's own sign-in isn't in
 * this build (the seam the sign-in workstream fills; not a policy refusal — SUB-01 permits it).
 */
export const CLAUDE_SUBSCRIPTION_CONSOLE_PENDING =
  'Signing in to Claude Code with your Claude subscription happens in Claude Code’s own sign-in, shown here in a console. That console isn’t available in this version yet. Use your own Anthropic API key for now.';

/** Why `subscription_sdk` isn't a sign-in (shown to people). */
export const CLAUDE_SDK_SUBSCRIPTION_GONE =
  'Whombat runs Claude Code itself, not through the Agent SDK, so there is no separate Agent SDK sign-in. Sign in to Claude Code with your Claude subscription, or use your own Anthropic API key.';

/** Anthropic Console keys look like `sk-ant-…`; anything else is refused before it is stored. */
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

export function claudeKeyShapeOk(key: string): boolean {
  return KEY_SHAPE.test(key.trim());
}

export async function claudeApiKeyLogin(home: string, key: string): Promise<LoginOutcome> {
  const trimmed = key.trim();
  if (!claudeKeyShapeOk(trimmed))
    return {
      ok: false,
      reason: 'failed',
      message: 'That doesn’t look like an Anthropic API key (sk-ant-…).',
    };
  await writePrivateFile(join(home, CLAUDE_KEY_FILE), `${trimmed}\n`);
  return { ok: true };
}

export async function claudeLogout(home: string): Promise<void> {
  await rm(join(home, CLAUDE_KEY_FILE), { force: true });
}

/**
 * A Claude home's sign-in state from the CLI itself: `claude auth status --json` with `CLAUDE_CONFIG_DIR` = the home's
 * `config/` and nothing of the appliance's environment (SUB-03: Whombat never opens the CLI's credential file). For
 * the sign-in console (after `claude auth login`) and the status rows; null when the CLI didn't answer.
 */
export async function claudeLoginStatus(o: {
  command: string;
  home: string;
  host?: NodeJS.ProcessEnv;
}): Promise<ClaudeAuthStatus | null> {
  // Never outside a sandbox on a home with a link in it (SUB-41).
  if (await homeLinkProblem(o.home)) return null;
  const result = await runCli({
    command: o.command,
    args: ['auth', 'status', '--json'],
    env: loginEnv(
      { HOME: o.home, CLAUDE_CONFIG_DIR: claudeConfigDir(o.home), ...CLAUDE_BUNDLE.selfUpdate.env },
      o.host,
    ),
    timeoutMs: 20_000,
  });
  return parseClaudeAuthStatus(result.lines.join('\n'));
}
