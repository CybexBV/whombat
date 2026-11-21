/**
 * A Whombat Feedback assessment on Hermes (docs/decisions/hermes-engine.md HE-36, feedback.md FB-21): read-only, no
 * network, only the feedback tools. What changes from the turn's ordinary configuration (`hermesConfig`):
 *
 * - Hermes's own tools: none (`platform_toolsets.acp: []`, and every toolset in `agent.disabled_toolsets` as well): no
 *   terminal or file tools, no web or browser, no memory, session search, skills or sub-agents. The tools left are the
 *   ACP client's MCP servers — Whombat's, whose token for an assessment serves only the feedback tools
 *   (`submit_assessment`, `feedback_similar_reports`, `read_attachment`, `reply_in_thread`).
 * - Nothing learned from it: memory and the memory and skill review off (the report is data, not the person's words).
 * - The one exception, when the assessor may look at the reported website (FB-28, HE-S140): the browser toolset (the
 *   plugin's browser tools, HE-S300, and Hermes's vault), whose Chromium keeps to that website (the runner's relay and
 *   Chromium's own flags), and which may only look (`ASSESSOR_BROWSER_BLOCKED` are refused by the turn's tool policy).
 *   Never Hermes's `browser_exec`.
 *
 * The turn's network is the sandbox's (the provider's endpoints only, no web key: FB-21), as before.
 */
import type { HermesRuntime } from './config';

/**
 * Hermes's toolset of `browser_exec`, its own browser since 0.22.6: model-written Python that Hermes runs beside the
 * profile's sign-ins, not in the commands' sandbox (HE-S300). Off in every turn; the plugin's browser tools take its
 * place.
 */
export const HERMES_BROWSER_EXEC_TOOLSET = 'browser-use';

/** Hermes's own toolsets (v0.22.6 `toolsets.py`, and `browser_exec`'s), all off in an assessment. */
export const HERMES_TOOLSETS = [
  'web',
  'search',
  'x_search',
  'vision',
  'video',
  'image_gen',
  'video_gen',
  'computer_use',
  'terminal',
  'skills',
  'browser',
  'cronjob',
  'file',
  'tts',
  'todo',
  'memory',
  'context_engine',
  'session_search',
  'connections',
  'project',
  'bot_room',
  'desktop_ui',
  'onboarding',
  'catalog',
  'clarify',
  'code_execution',
  'delegation',
  'kanban',
  HERMES_BROWSER_EXEC_TOOLSET,
] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Hermes's browser tools an assessor may not use (FB-28, HE-S140): typing, keys, raw CDP, scripts in the page,
 * answering its dialogs and keeping a website signed in (the plugin's `browser_keep_site`, a person's own); it looks —
 * opens, reads, clicks, scrolls, goes back — and fills a login of the reported website from the Vault (FB-33), whose
 * username it types itself only with `browser_type` when it has such a login.
 */
export const ASSESSOR_BROWSER_BLOCKED = [
  'browser_press',
  'browser_cdp',
  'browser_console',
  'browser_dialog',
  'browser_keep_site',
] as const;

/** `base` (a turn's `config.yaml` object) as an assessment's: see the file comment. Pure. */
export function hermesAssessmentConfig(
  base: Record<string, unknown>,
  _runtime: HermesRuntime,
  options: { browser?: boolean } = {},
): Record<string, unknown> {
  const agent = isObject(base.agent) ? base.agent : {};
  const auxiliary = isObject(base.auxiliary) ? base.auxiliary : {};
  return {
    ...base,
    agent: {
      ...agent,
      disabled_toolsets: HERMES_TOOLSETS.filter((t) => !(options.browser && t === 'browser')),
    },
    platform_toolsets: { acp: options.browser ? ['browser'] : [] },
    memory: { memory_enabled: false, user_profile_enabled: false },
    auxiliary: { ...auxiliary, background_review: { enabled: false } },
  };
}
