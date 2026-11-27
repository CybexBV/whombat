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
import { coreTranslator } from '../i18n/catalog.js';
import { formatLocaleOf } from '../i18n/locale.js';
import { formatDiffStat, formatOf } from './format.js';
import { type DateInput, formatAgo, formatClock, formatSeconds, formatUpdated } from './time.js';

const upper = (s: string, locale?: string | null) => s.toLocaleUpperCase(formatLocaleOf(locale));

/** `PLAN · 4 STEPS` */
export function formatPlanLabel(steps: number, locale?: string | null): string {
  return coreTranslator(locale).tp('copy.planLabel', steps);
}

/** `RESEARCH · PDF LIBRARIES` */
export function formatResearchLabel(topic: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.researchLabel', { topic: upper(topic, locale) });
}

/** `14 sources · 3 tested` */
export function formatResearchMeta(sources: number, tested: number, locale?: string | null): string {
  const tr = coreTranslator(locale);
  return tr.t('copy.researchMeta', { sources: tr.tp('copy.researchSources', sources), tested });
}

/** `INBOX · 7 UNREAD`, `TODAY` */
export function formatDigestLabel(title: string, summary: string | null, locale?: string | null): string {
  return upper(summary ? `${title} · ${summary}` : title, locale);
}

/** `REVIEW · 2 CHANGES REQUESTED` */
export function formatReviewLabel(changesRequested: number, locale?: string | null): string {
  return coreTranslator(locale).tp('copy.reviewLabel', changesRequested);
}

const RUN_STATUSES: readonly RunStatus[] = ['live', 'paused', 'done', 'failed', 'taken_over'];

/** Run status pills in a locale (`LIVE`, `KLAAR`). */
export function runStatusLabels(locale?: string | null): Record<RunStatus, string> {
  const tr = coreTranslator(locale);
  return Object.fromEntries(RUN_STATUSES.map((s) => [s, tr.t(`copy.runStatus.${s}`)])) as Record<
    RunStatus,
    string
  >;
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = runStatusLabels('en');

/** `RUN · LIVE`, `RUN · DONE` */
export function formatRunLabel(status: RunStatus, locale?: string | null): string {
  const tr = coreTranslator(locale);
  return tr.t('copy.runLabel', { status: tr.t(`copy.runStatus.${status}`) });
}

/** Run page kicker: `RUN · LIVE · BANJO · STARTED 11:22`. */
export function formatRunKicker(
  status: RunStatus,
  agentName: string,
  startedAt: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  return coreTranslator(locale).t('copy.runKicker', {
    label: formatRunLabel(status, locale),
    agent: upper(agentName, locale),
    time: formatClock(startedAt, timeZone),
  });
}

/** Run card line under the progress bar: `Now: Editing billing/pdf/format.ts` while live, the summary when done. */
export function runNowText(
  run: { status: RunStatus; activity: string; summary: string | null },
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  switch (run.status) {
    case 'live':
      return tr.t('copy.runNow', { activity: run.activity });
    case 'paused':
      return tr.t('copy.runPaused', { activity: run.activity });
    case 'taken_over':
      return run.summary ?? tr.t('copy.runTakenOver', { activity: run.activity });
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
export function runKeysTitle(agentName: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.runKeysTitle', { agent: agentName });
}

/** `scoped to feat/invoice-pdf` */
export function runKeysScope(branch: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.runKeysScope', { branch });
}

/** Typing indicator: `Banjo is thinking`. */
export function typingLabel(name: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.typing', { name });
}

/** Empty Chat heading. */
export function dmEmptyTitle(agentName: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.dmEmpty', { agent: agentName });
}

/** Composer placeholder: `Comment on PR #482`, `Message Dusty`. */
export function composerPlaceholder(
  c: { kind: 'branch'; prNumber: number } | { kind: 'dm'; agentName: string },
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  return c.kind === 'branch'
    ? tr.t('copy.composerBranch', { number: c.prNumber })
    : tr.t('copy.composerDm', { agent: c.agentName });
}

/** Commits card footer: `+214 −12 · 6 files · signed by Banjo`. */
export function formatCommitsFooter(
  diff: { add: number; del: number; files: number },
  signerName: string,
  locale?: string | null,
): string {
  return coreTranslator(locale).t('copy.commitsFooter', {
    diff: formatDiffStat(diff, locale),
    signer: signerName,
  });
}

/** Search answer meta: `answered from 3 receipts · 1.8s`. */
export function formatAnswerMeta(
  receipts: number,
  durationMs: number | null,
  locale?: string | null,
): string {
  const base = coreTranslator(locale).tp('copy.answerReceipts', receipts);
  return durationMs === null ? base : `${base} · ${formatSeconds(durationMs, locale)}`;
}

/** Search result marker: `receipt 1`. */
export function receiptMarker(n: number, locale?: string | null): string {
  return coreTranslator(locale).t('copy.receiptMarker', { n });
}

/** Audit log subtitle. */
export function auditSubtitle(burrowName: string, agentName: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.auditSubtitle', { burrow: burrowName, agent: agentName });
}

/** Toast after Export CSV. */
export function exportToast(count: number, locale?: string | null): string {
  return coreTranslator(locale).tp('copy.exportToast', count);
}

/** Toast after finishing onboarding. */
export function welcomeToast(burrowName: string, agentName: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.welcomeToast', { burrow: burrowName, agent: agentName });
}

/** Toast after merging. */
export function mergeToast(prNumber: number, locale?: string | null): string {
  return coreTranslator(locale).t('copy.mergeToast', { number: prNumber });
}

/** Branch pane note under Merge into main, while the agent holds no merge key. */
export function mergeNote(agentName: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.mergeNote', { agent: agentName });
}

/** Files tab footnote. */
export function filesNote(agentName: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.filesNote', { agent: agentName });
}

/** Onboarding footer buttons. */
export function onboardingBackLabel(step: number, locale?: string | null): string {
  return coreTranslator(locale).t(step === 0 ? 'copy.onboardingSkip' : 'copy.onboardingBack');
}

export function onboardingNextLabel(
  step: number,
  lastStep: number,
  burrowName: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  return step === lastStep
    ? tr.t('copy.onboardingOpen', { burrow: burrowName || tr.t('copy.onboardingTheBurrow') })
    : tr.t('copy.onboardingContinue');
}

/** `STEP 2 OF 4` */
export function onboardingStepLabel(step: number, count: number, locale?: string | null): string {
  return coreTranslator(locale).t('copy.onboardingStep', { step: step + 1, count });
}

/** Onboarding repo row: `TypeScript · updated 2 hours ago`. */
export function formatRepoMeta(
  language: string | null,
  pushedAt: DateInput | null,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const updated = pushedAt
    ? tr.t('copy.repoUpdated', { when: formatUpdated(pushedAt, now, timeZone, locale) })
    : tr.t('copy.repoNotUpdated');
  return language ? `${language} · ${updated}` : updated;
}

/** Canvas presence: `2 here`. */
export function formatPresence(n: number, locale?: string | null): string {
  return coreTranslator(locale).t('copy.presence', { n });
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
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const parts = [
    p.requestedBy
      ? tr.t('copy.draftedByFrom', { name: p.createdBy, requester: p.requestedBy })
      : tr.t('copy.draftedBy', { name: p.createdBy }),
  ];
  if (p.editors.length) parts.push(tr.t('copy.editedBy', { names: p.editors.join(', ') }));
  parts.push(formatAgo(updatedAt, now, timeZone, locale));
  return parts.join(' · ');
}

/** Thread pane context: `#billing-v2 · PDF libraries`. */
export function threadContext(where: string, topic: string | null): string {
  return topic ? `${where} · ${topic}` : where;
}

/** Deploy check/test summary pill: `38 of 41 passed · 3 failing in invoice_format_test`. */
export function formatChecksPill(
  passed: number,
  total: number,
  failingIn?: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const base = tr.t('copy.checksPassed', { of: formatOf(passed, total, locale) });
  if (passed >= total) return base;
  return failingIn
    ? tr.t('copy.checksFailingIn', { base, count: total - passed, where: failingIn })
    : tr.t('copy.checksFailing', { base, count: total - passed });
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
export function githubConnectedToast(agentName: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.githubConnectedToast', { agent: agentName });
}

/** "Connected as @acme": the GitHub account every GitHub action is performed as. */
export function githubConnectedAs(login: string, locale?: string | null): string {
  return coreTranslator(locale).t('copy.githubConnectedAs', { login });
}

/* AI providers (docs/decisions/agent-setup.md) ------------------------------------------------------- */

/**
 * A provider row's status line: `Ready · 2.1.278 (Claude Code)`, `Installed, not logged in`, `Not installed`… ChatGPT
 * (`codex`, 2.1, CT-1451) is ready whenever Hermes is and needs nothing installed or logged in on the machine: `Ready`
 * without the runner's version (it names the engine, which people never read), `Not ready` otherwise.
 */
export function providerStateLabel(
  setup: Pick<ProviderSetup, 'state' | 'version'> & { provider?: LiveProvider },
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (setup.provider === 'codex') {
    if (setup.state === 'ready') return tr.t('copy.provider.ready');
    if (setup.state === 'missing' || setup.state === 'logged_out') return tr.t('copy.provider.notReady');
  }
  switch (setup.state) {
    case 'ready':
      return setup.version
        ? tr.t('copy.provider.readyVersion', { version: setup.version })
        : tr.t('copy.provider.ready');
    case 'logged_out':
      return tr.t('copy.provider.loggedOut');
    case 'missing':
      return tr.t('copy.provider.missing');
    case 'error':
      return tr.t('copy.provider.error');
    case 'unknown':
      return tr.t('copy.provider.unknown');
  }
}

/**
 * What to run on the host to make a provider ready; `command` is shown as code (GitHubNotice). ChatGPT has nothing to
 * install or log in to there (CT-1451): it works once this Whombat does, and each person signs in in Settings → AI.
 */
export function providerFix(
  setup: Pick<ProviderSetup, 'provider' | 'state' | 'detail'>,
  locale?: string | null,
): { text: string; command: string | null } | null {
  const tr = coreTranslator(locale);
  const claude = setup.provider === 'claude';
  switch (setup.state) {
    case 'ready':
    case 'unknown':
      return null;
    case 'missing':
      return claude
        ? { text: tr.t('copy.provider.claudeInstall'), command: 'npm i -g @anthropic-ai/claude-code' }
        : { text: tr.t('copy.provider.chatgptFix'), command: null };
    case 'logged_out':
      return claude
        ? { text: tr.t('copy.provider.claudeLogin'), command: 'claude' }
        : { text: tr.t('copy.provider.chatgptFix'), command: null };
    case 'error':
      return {
        text: tr.t('copy.provider.doctor', { detail: setup.detail ?? tr.t('copy.provider.didntStart') }),
        command: 'whombat doctor',
      };
  }
}

/** Where people set the providers up after onboarding, in a locale. */
export function aiProviderSettingsPath(locale?: string | null): string {
  return coreTranslator(locale).t('copy.providerSettings');
}

/** Where people set the providers up after onboarding. */
export const AI_PROVIDER_SETTINGS = aiProviderSettingsPath('en');

/**
 * Why the agent can't start on this Whombat (Hermes isn't ready, CT-1160), in words owners can act on: what to do on
 * this Whombat, never the engine's name (concise-replies.md). Settings → AI and the shell notice show it.
 */
export function engineProblemCopy(locale?: string | null): Readonly<Record<HermesProblem, string>> {
  const tr = coreTranslator(locale);
  return {
    missing: tr.t('copy.engine.missing'),
    outdated: tr.t('copy.engine.outdated'),
    broken: tr.t('copy.engine.broken'),
    storage: tr.t('copy.engine.storage'),
  };
}

export const ENGINE_PROBLEM_COPY: Readonly<Record<HermesProblem, string>> = engineProblemCopy('en');

/** Why an agent's turn can't run on this Whombat right now (the agent's quiet reply). */
export type UnrunnableCause =
  | { kind: 'no_runner' }
  /** Hermes isn't ready on the runner (CT-1160). */
  | { kind: 'engine'; problem: HermesProblem }
  | { kind: 'provider'; provider: LiveProvider }
  /** The agent (or the thread) is on `local` and the burrow has no model on its network (CT-1170). */
  | { kind: 'local' }
  | { kind: 'no_provider' };

/** The agent's own words when it can't run, in the person's locale (the agent's quiet reply). */
export function unrunnableReply(cause: UnrunnableCause, locale?: string | null): string {
  const tr = coreTranslator(locale);
  switch (cause.kind) {
    case 'no_runner':
      return tr.t('copy.unrunnable.noRunner');
    case 'engine':
      return tr.t(`copy.engineReply.${cause.problem}`);
    case 'provider':
      return tr.t('copy.unrunnable.provider', {
        provider: PROVIDER_LABELS[cause.provider],
        settings: aiProviderSettingsPath(locale),
      });
    case 'local':
      return tr.t('copy.unrunnable.local', { settings: aiProviderSettingsPath(locale) });
    case 'no_provider':
      return tr.t('copy.unrunnable.noProvider');
  }
}

/** The shell notice while the agent can't reply (`agentsCanReply` is false). */
export function agentsBlockedNotice(
  status: Pick<AgentSetupStatus, 'runner' | 'hermes' | 'providers'>,
  agentName: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (!status.runner.connected) return tr.t('copy.blocked.restarting', { agent: agentName });
  if (!status.hermes) return tr.t('copy.blocked.starting', { agent: agentName });
  if (!status.hermes.ready) {
    const text = engineProblemCopy(locale)[status.hermes.problem ?? 'broken'];
    return tr.t('copy.blocked.engine', {
      agent: agentName,
      reason: `${text.charAt(0).toLowerCase()}${text.slice(1)}`,
    });
  }
  return tr.t('copy.blocked.noProvider', { agent: agentName });
}

/* The agent's working line (whombat-app ui-improvements item 2, CT-158) ------------------------------------------ */

/**
 * The muted second line while an agent is actually working: `Working: Rounding VAT before formatting.`, from a live
 * run's activity or, while its status is `working`, its `doing`. Null otherwise.
 */
export function agentWorkingText(
  agent: { status: AgentStatus; doing: string },
  liveActivity?: string | null,
  locale?: string | null,
): string | null {
  const tr = coreTranslator(locale);
  const live = liveActivity?.trim();
  if (live) return tr.t('copy.working', { what: live });
  const doing = agent.doing.trim();
  if (agent.status !== 'working' || !doing) return null;
  return tr.t('copy.working', { what: doing });
}
