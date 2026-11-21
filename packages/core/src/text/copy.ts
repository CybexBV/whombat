/**
 * Dynamic screen copy shared by web and mobile. Static strings stay in the components; everything that
 * interpolates data lives here so both apps say exactly the same thing. Verbatim from the mocks.
 */

import type { AgentStatus } from '../domain/agent.js';
import {
  type AgentSetupStatus,
  type HermesProblem,
  type LiveProvider,
  PROVIDER_LABELS,
  type ProviderSetup,
} from '../domain/providers.js';
import type { RunStatus } from '../domain/run.js';
import { formatDiffStat, formatOf, plural } from './format.js';
import { type DateInput, formatAgo, formatClock, formatSeconds, formatUpdated } from './time.js';

const upper = (s: string) => s.toUpperCase();

/** `PLAN · 4 STEPS` */
export function formatPlanLabel(steps: number): string {
  return `PLAN · ${upper(plural(steps, 'step'))}`;
}

/** `RESEARCH · PDF LIBRARIES` */
export function formatResearchLabel(topic: string): string {
  return `RESEARCH · ${upper(topic)}`;
}

/** `14 sources · 3 tested` */
export function formatResearchMeta(sources: number, tested: number): string {
  return `${plural(sources, 'source')} · ${tested} tested`;
}

/** `INBOX · 7 UNREAD`, `TODAY` */
export function formatDigestLabel(title: string, summary: string | null): string {
  return upper(summary ? `${title} · ${summary}` : title);
}

/** `REVIEW · 2 CHANGES REQUESTED` */
export function formatReviewLabel(changesRequested: number): string {
  return `REVIEW · ${upper(plural(changesRequested, 'change'))} REQUESTED`;
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  live: 'LIVE',
  paused: 'PAUSED',
  done: 'DONE',
  failed: 'FAILED',
  taken_over: 'TAKEN OVER',
};

/** `RUN · LIVE`, `RUN · DONE` */
export function formatRunLabel(status: RunStatus): string {
  return `RUN · ${RUN_STATUS_LABELS[status]}`;
}

/** Run page kicker: `RUN · LIVE · BANJO · STARTED 11:22`. */
export function formatRunKicker(
  status: RunStatus,
  agentName: string,
  startedAt: DateInput,
  timeZone: string,
): string {
  return `${formatRunLabel(status)} · ${upper(agentName)} · STARTED ${formatClock(startedAt, timeZone)}`;
}

/** Run card line under the progress bar: `Now: Editing billing/pdf/format.ts` while live, the summary when done. */
export function runNowText(run: { status: RunStatus; activity: string; summary: string | null }): string {
  switch (run.status) {
    case 'live':
      return `Now: ${run.activity}`;
    case 'paused':
      return `Paused: ${run.activity}`;
    case 'taken_over':
      return run.summary ?? `Taken over: ${run.activity}`;
    default:
      return run.summary ?? run.activity;
  }
}

/** Live log line colour: `✓` ok, `✗` bad, `$` command, else plain. */
export function logLineTone(text: string): 'ok' | 'bad' | 'command' | 'plain' {
  if (text.startsWith('✓')) return 'ok';
  if (text.startsWith('✗')) return 'bad';
  if (text.startsWith('$')) return 'command';
  return 'plain';
}

/** The live log shows the last 12 lines. */
export const RUN_LOG_VISIBLE_LINES = 12;

/** `Banjo’s keys for this run` */
export function runKeysTitle(agentName: string): string {
  return `${agentName}’s keys for this run`;
}

/** `scoped to feat/invoice-pdf` */
export function runKeysScope(branch: string): string {
  return `scoped to ${branch}`;
}

/** Typing indicator: `Banjo is thinking`. */
export function typingLabel(name: string): string {
  return `${name} is thinking`;
}

/** Empty Chat heading. */
export function dmEmptyTitle(agentName: string): string {
  return `This is the start of your chat with ${agentName}`;
}

/** Composer placeholder: `Comment on PR #482`, `Message Dusty`. */
export function composerPlaceholder(
  c: { kind: 'branch'; prNumber: number } | { kind: 'dm'; agentName: string },
): string {
  return c.kind === 'branch' ? `Comment on PR #${c.prNumber}` : `Message ${c.agentName}`;
}

/** Commits card footer: `+214 −12 · 6 files · signed by Banjo`. */
export function formatCommitsFooter(
  diff: { add: number; del: number; files: number },
  signerName: string,
): string {
  return `${formatDiffStat(diff)} · signed by ${signerName}`;
}

/** Search answer meta: `answered from 3 receipts · 1.8s`. */
export function formatAnswerMeta(receipts: number, durationMs: number | null): string {
  const base = `answered from ${plural(receipts, 'receipt')}`;
  return durationMs === null ? base : `${base} · ${formatSeconds(durationMs)}`;
}

/** Search result marker: `receipt 1`. */
export function receiptMarker(n: number): string {
  return `receipt ${n}`;
}

/** Audit log subtitle. */
export function auditSubtitle(burrowName: string, agentName: string): string {
  return `Every action in ${burrowName}, signed by whoever took it. People and ${agentName} write to the same log, and entries can’t be edited afterwards.`;
}

/** Toast after Export CSV. */
export function exportToast(count: number): string {
  return `Exported ${count} signed ${count === 1 ? 'event' : 'events'} as CSV.`;
}

/** Toast after finishing onboarding. */
export function welcomeToast(burrowName: string, agentName: string): string {
  return `Welcome to ${burrowName}. ${agentName} is already here.`;
}

/** Toast after merging. */
export function mergeToast(prNumber: number): string {
  return `Merged PR #${prNumber}. Nice digging, everyone.`;
}

/** Branch pane note under Merge into main, while the agent holds no merge key. */
export function mergeNote(agentName: string): string {
  return `Merging is for people. ${agentName} doesn’t hold a merge key.`;
}

/** Files tab footnote. */
export function filesNote(agentName: string): string {
  return `Every patch here is a signed event from ${agentName}’s key. Open any file to comment on a line.`;
}

/** Onboarding footer buttons. */
export function onboardingBackLabel(step: number): string {
  return step === 0 ? 'Skip for now' : 'Back';
}

export function onboardingNextLabel(step: number, lastStep: number, burrowName: string): string {
  return step === lastStep ? `Open ${burrowName || 'the burrow'}` : 'Continue';
}

/** `STEP 2 OF 4` */
export function onboardingStepLabel(step: number, count: number): string {
  return `STEP ${step + 1} OF ${count}`;
}

/** Onboarding repo row: `TypeScript · updated 2 hours ago`. */
export function formatRepoMeta(
  language: string | null,
  pushedAt: DateInput | null,
  now: DateInput,
  timeZone: string,
): string {
  const updated = pushedAt ? `updated ${formatUpdated(pushedAt, now, timeZone)}` : 'not updated yet';
  return language ? `${language} · ${updated}` : updated;
}

/** Canvas presence: `2 here`. */
export function formatPresence(n: number): string {
  return `${n} here`;
}

/**
 * Canvas provenance: `Drafted by Toffee from Priya’s request · edited by Mara, Dusty · 12 min ago`.
 * Names are short names.
 */
export function formatCanvasProvenance(
  p: { createdBy: string; requestedBy: string | null; editors: readonly string[] },
  updatedAt: DateInput,
  now: DateInput,
  timeZone: string,
): string {
  const parts = [`Drafted by ${p.createdBy}${p.requestedBy ? ` from ${p.requestedBy}’s request` : ''}`];
  if (p.editors.length) parts.push(`edited by ${p.editors.join(', ')}`);
  parts.push(formatAgo(updatedAt, now, timeZone));
  return parts.join(' · ');
}

/** Thread pane context: `#billing-v2 · PDF libraries`. */
export function threadContext(where: string, topic: string | null): string {
  return topic ? `${where} · ${topic}` : where;
}

/** Deploy check/test summary pill: `38 of 41 passed · 3 failing in invoice_format_test`. */
export function formatChecksPill(passed: number, total: number, failingIn?: string): string {
  const base = `${formatOf(passed, total)} passed`;
  if (passed >= total) return base;
  return `${base} · ${total - passed} failing${failingIn ? ` in ${failingIn}` : ''}`;
}

/** Search shortcut hint: ⌘K on macOS, Ctrl K elsewhere (DECISIONS B-03). */
export function searchShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘K' : 'Ctrl K';
}

/** Toast for a live "needs you" notification: `#billing-v2: Deploy feat/invoice-pdf to staging.` */
export function needsYouToast(where: string, text: string): string {
  return `${where}: ${text}`;
}

/** Toast after connecting GitHub. */
export function githubConnectedToast(agentName: string): string {
  return `GitHub connected. Switch on the repos ${agentName} should see.`;
}

/** "Connected as @acme": the GitHub account every GitHub action is performed as. */
export function githubConnectedAs(login: string): string {
  return `Connected as @${login}`;
}

/* AI providers (docs/decisions/agent-setup.md) ------------------------------------------------------- */

/**
 * A provider row's status line: `Ready · 2.1.278 (Claude Code)`, `Installed, not logged in`, `Not installed`… ChatGPT
 * (`codex`, 2.1, CT-1451) is ready whenever Hermes is and needs nothing installed or logged in on the machine: `Ready`
 * without the runner's version (it names the engine, which people never read), `Not ready` otherwise.
 */
export function providerStateLabel(
  setup: Pick<ProviderSetup, 'state' | 'version'> & { provider?: LiveProvider },
): string {
  if (setup.provider === 'codex') {
    if (setup.state === 'ready') return 'Ready';
    if (setup.state === 'missing' || setup.state === 'logged_out') return 'Not ready';
  }
  switch (setup.state) {
    case 'ready':
      return setup.version ? `Ready · ${setup.version}` : 'Ready';
    case 'logged_out':
      return 'Installed, not logged in';
    case 'missing':
      return 'Not installed';
    case 'error':
      return 'Can’t start';
    case 'unknown':
      return 'Not checked yet';
  }
}

/** ChatGPT isn't ready: Hermes, which runs it, isn't (CT-1451). */
const CHATGPT_NOT_READY_FIX =
  'ChatGPT needs nothing installed. It works once this Whombat is running; restarting this Whombat usually fixes it.';

/**
 * What to run on the host to make a provider ready; `command` is shown as code (GitHubNotice). ChatGPT has nothing to
 * install or log in to there (CT-1451): it works once this Whombat does, and each person signs in in Settings → AI.
 */
export function providerFix(
  setup: Pick<ProviderSetup, 'provider' | 'state' | 'detail'>,
): { text: string; command: string | null } | null {
  const claude = setup.provider === 'claude';
  switch (setup.state) {
    case 'ready':
    case 'unknown':
      return null;
    case 'missing':
      return claude
        ? {
            text: 'Install it on the host with npm i -g @anthropic-ai/claude-code, then run claude there and sign in with /login.',
            command: 'npm i -g @anthropic-ai/claude-code',
          }
        : { text: CHATGPT_NOT_READY_FIX, command: null };
    case 'logged_out':
      return claude
        ? { text: 'On the host, run claude and sign in with /login.', command: 'claude' }
        : { text: CHATGPT_NOT_READY_FIX, command: null };
    case 'error':
      return {
        text: `${setup.detail ?? 'It didn’t start.'} Run whombat doctor on the host for details.`,
        command: 'whombat doctor',
      };
  }
}

/** Where people set the providers up after onboarding. */
export const AI_PROVIDER_SETTINGS = 'Settings → AI sign-in';

/**
 * Why the agent can't start on this Whombat (Hermes isn't ready, CT-1160), in words owners can act on: what to do on
 * this Whombat, never the engine's name (concise-replies.md). Settings → AI and the shell notice show it.
 */
export const ENGINE_PROBLEM_COPY: Readonly<Record<HermesProblem, string>> = {
  missing: 'Part of this Whombat is missing. Updating this Whombat puts it back.',
  outdated: 'Part of this Whombat is out of date. Updating this Whombat fixes it.',
  broken: 'Part of this Whombat didn’t start. Restarting this Whombat usually fixes it.',
  storage: 'This Whombat’s disk is full or can’t be written. Free some space, then restart it.',
};

/** The agent's own words when it can't start (the agent's quiet reply, `unrunnableReply`). */
const ENGINE_PROBLEM_REPLY: Readonly<Record<HermesProblem, string>> = {
  missing: 'I can’t reply yet: part of this Whombat is missing. Once it’s updated, ask me again.',
  outdated: 'I can’t reply yet: part of this Whombat is out of date. Once it’s updated, ask me again.',
  broken:
    'I can’t reply yet: part of this Whombat didn’t start. Restarting it usually fixes that; then ask me again.',
  storage:
    'I can’t reply yet: this Whombat’s disk is full or can’t be written. Once there’s room again, ask me again.',
};

/** Why an agent's turn can't run on this Whombat right now (the agent's quiet reply). */
export type UnrunnableCause =
  | { kind: 'no_runner' }
  /** Hermes isn't ready on the runner (CT-1160). */
  | { kind: 'engine'; problem: HermesProblem }
  | { kind: 'provider'; provider: LiveProvider }
  /** The agent (or the thread) is on `local` and the burrow has no model on its network (CT-1170). */
  | { kind: 'local' }
  | { kind: 'no_provider' };

export function unrunnableReply(cause: UnrunnableCause): string {
  switch (cause.kind) {
    case 'no_runner':
      return 'I can’t reply right now: part of Whombat is restarting. Ask me again in a minute.';
    case 'engine':
      return ENGINE_PROBLEM_REPLY[cause.problem];
    case 'provider':
      return `I can’t reply yet: ${PROVIDER_LABELS[cause.provider]} isn’t set up on this Whombat. Once it is (${AI_PROVIDER_SETTINGS}), ask me again.`;
    case 'local':
      return `I can’t reply yet: the custom AI model isn’t set up. Once it’s set up (${AI_PROVIDER_SETTINGS}), ask me again.`;
    case 'no_provider':
      return 'I can’t reply yet: I’m not connected to Claude Code or ChatGPT. Pick one in Settings → AI sign-in, then ask me again.';
  }
}

/** The shell notice while the agent can't reply (`agentsCanReply` is false). */
export function agentsBlockedNotice(
  status: Pick<AgentSetupStatus, 'runner' | 'hermes' | 'providers'>,
  agentName: string,
): string {
  if (!status.runner.connected) return `${agentName} can’t reply right now: part of Whombat is restarting.`;
  if (!status.hermes) return `${agentName} can’t reply yet: this Whombat is still starting.`;
  if (!status.hermes.ready) {
    const text = ENGINE_PROBLEM_COPY[status.hermes.problem ?? 'broken'];
    return `${agentName} can’t reply yet: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  }
  return `${agentName} can’t reply yet: neither Claude Code nor ChatGPT is ready on this Whombat.`;
}

/* The agent's working line (whombat-app ui-improvements item 2, CT-158) ------------------------------------------ */

/**
 * The muted second line while an agent is actually working: `Working: Rounding VAT before formatting.`, from a live
 * run's activity or, while its status is `working`, its `doing`. Null otherwise.
 */
export function agentWorkingText(
  agent: { status: AgentStatus; doing: string },
  liveActivity?: string | null,
): string | null {
  const live = liveActivity?.trim();
  if (live) return `Working: ${live}`;
  const doing = agent.doing.trim();
  if (agent.status !== 'working' || !doing) return null;
  return `Working: ${doing}`;
}
