/**
 * Definition validation beyond the Zod shape: size, unique step ids, references only to earlier steps,
 * forward-only skips (so a definition cannot loop), parseable conditions and schedules. Import, the editor's
 * JSON view, the structured form, `draft_automation` and publish all go through `validateDefinition`.
 */
import type { z } from 'zod';
import {
  AUTOMATION_DEFINITION_MAX_BYTES,
  AutomationDefinition,
  AutomationExport,
  type AutomationStep,
  type AutomationTrigger,
  EXTERNAL_STEP_KINDS,
  type GitHubTriggerEvent,
  stepKindLabel,
  TRIGGER_KIND_LABELS,
} from '../domain/automation.js';
import { ExprError, parseExpr, referencedSteps } from './expr.js';
import { mailTriggerProblems, mailWhenText } from './mail.js';
import { checkSchedule, describeSchedule, ScheduleError } from './schedule.js';
import { templatePaths } from './template.js';

export type ValidationResult =
  | { ok: true; definition: AutomationDefinition; problems: [] }
  | { ok: false; definition: null; problems: string[] };

function issuePath(path: readonly PropertyKey[]): string {
  return path
    .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
    .join('')
    .replace(/^\./, '');
}

export function zodProblems(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => {
    const where = issuePath(i.path);
    if (i.code === 'unrecognized_keys')
      return `${where ? `${where}: ` : ''}unknown field ${i.keys.map((k) => `“${k}”`).join(', ')}.`;
    if (i.code === 'invalid_union' && i.path.at(-1) !== undefined)
      return `${where}: not a kind of step or trigger Whombat knows.`;
    return `${where ? `${where}: ` : ''}${i.message}`;
  });
}

/** Size of a value's JSON in bytes (UTF-8). */
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value) ?? '';
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // a surrogate pair: one 4-byte character
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Plain-English problem when a step is disallowed in a mail-triggered automation: incoming mail comes from outsiders,
 * so mail automations may never check out a repository (`workspace`) or run any external-effect step other than
 * `connection_actions` (which always asks a person on a card first).
 */
export function mailStepProblem(step: AutomationStep): string | null {
  if (step.kind === 'dispatch_agent' && step.workspace) {
    return 'A mail automation can’t give the agent a repository checkout.';
  }
  if (step.kind !== 'connection_actions' && EXTERNAL_STEP_KINDS.includes(step.kind)) {
    return `A mail automation can’t use “${stepKindLabel(step.kind)}” steps; use approved connection actions instead.`;
  }
  return null;
}

/** Validation problems for definitions that include a `mail` trigger. */
export function mailDefinitionProblems(def: AutomationDefinition): string[] {
  if (!def.triggers.some((t) => t.kind === 'mail')) return [];
  const problems: string[] = [];
  def.steps.forEach((s, i) => {
    const err = mailStepProblem(s);
    if (err) problems.push(`steps[${i}]: ${err}`);
  });
  return problems;
}

/** Semantic checks of a definition that already matches the schema. */
export function definitionProblems(def: AutomationDefinition, now = Date.now()): string[] {
  const problems: string[] = [];
  const ids = new Map<string, number>();
  def.steps.forEach((s, i) => {
    if (ids.has(s.id)) problems.push(`steps[${i}]: the id “${s.id}” is used twice.`);
    else ids.set(s.id, i);
  });
  const count = (kind: AutomationTrigger['kind']) => def.triggers.filter((t) => t.kind === kind).length;
  if (count('schedule') > 1) problems.push('triggers: only one schedule per automation.');
  if (count('webhook') > 1) problems.push('triggers: only one webhook per automation.');
  if (count('manual') && def.triggers.length > 1)
    problems.push('triggers: “Only when started by hand” can’t be combined with other triggers.');

  def.triggers.forEach((t, i) => {
    if (t.kind === 'github' && t.event === 'issue_opened' && t.branch)
      problems.push(`triggers[${i}].branch: issues have no branch.`);
    if (t.kind === 'tracker' && t.itemKinds && new Set(t.itemKinds).size !== t.itemKinds.length)
      problems.push(`triggers[${i}].itemKinds: each kind of report only once.`);
    if (t.kind === 'mail') {
      for (const err of mailTriggerProblems(t)) problems.push(`triggers[${i}].${err}`);
    }
    if (t.kind === 'schedule') {
      try {
        checkSchedule(t.schedule, t.timeZone, now);
      } catch (err) {
        if (err instanceof ScheduleError) problems.push(`triggers[${i}].schedule: ${err.message}`);
        else throw err;
      }
    }
  });

  const earlier = (i: number, ref: string, where: string) => {
    const at = ids.get(ref);
    if (at === undefined) problems.push(`${where}: there is no step “${ref}”.`);
    else if (at >= i) problems.push(`${where}: “${ref}” doesn’t come before this step.`);
  };
  const checkTemplate = (i: number, text: string, where: string) => {
    for (const path of templatePaths(text)) {
      const [root, step] = path.split('.');
      if (root === 'steps' && step) earlier(i, step, where);
      else if (root !== 'trigger' && root !== 'steps' && root !== 'run')
        problems.push(`${where}: {{${path}}} is not something a step can use.`);
    }
  };

  def.steps.forEach((s, i) => {
    const at = `steps[${i}]`;
    switch (s.kind) {
      case 'dispatch_agent':
        checkTemplate(i, s.prompt, `${at}.prompt`);
        if (s.workspace?.branch) checkTemplate(i, s.workspace.branch, `${at}.workspace.branch`);
        if (s.workspace?.pullRequest) {
          checkTemplate(i, s.workspace.pullRequest, `${at}.workspace.pullRequest`);
          if (s.workspace.access !== 'read')
            problems.push(`${at}.workspace: a pull request's checkout is only for reading.`);
          if (s.workspace.branch)
            problems.push(`${at}.workspace: a checkout is of a branch or of a pull request, not both.`);
        }
        if (s.workspace?.access === 'write' && !s.workspace.branch)
          problems.push(`${at}.workspace: an agent that writes code needs a branch of its own.`);
        if (s.assessment && s.verdict)
          problems.push(`${at}: an agent gives a verdict or an assessment, not both.`);
        if (s.proposeActions && (s.verdict || s.assessment))
          problems.push(`${at}: an agent can’t combine proposeActions with verdict or assessment.`);
        // `trackerAccess` is ignored since 0.71 (TA-23): looking inside the organization follows the tracker's token.
        break;
      case 'post_message':
        checkTemplate(i, s.text, `${at}.text`);
        for (const ref of s.attachFrom) earlier(i, ref, `${at}.attachFrom`);
        break;
      case 'request_approval':
        checkTemplate(i, s.title, `${at}.title`);
        checkTemplate(i, s.details, `${at}.details`);
        if (s.bindBranch) checkTemplate(i, s.bindBranch.branch, `${at}.bindBranch.branch`);
        break;
      case 'condition':
        try {
          for (const ref of referencedSteps(parseExpr(s.if))) earlier(i, ref, `${at}.if`);
        } catch (err) {
          if (err instanceof ExprError) problems.push(`${at}.if: ${err.message}`);
          else throw err;
        }
        if (s.else !== 'stop') {
          const target = ids.get(s.else.skipTo);
          if (target === undefined) problems.push(`${at}.else: there is no step “${s.else.skipTo}”.`);
          else if (target <= i) problems.push(`${at}.else: a condition can only skip ahead.`);
        }
        break;
      case 'open_pull_request':
        checkTemplate(i, s.branch, `${at}.branch`);
        checkTemplate(i, s.title, `${at}.title`);
        checkTemplate(i, s.body, `${at}.body`);
        break;
      case 'http_callback':
        checkTemplate(i, s.body, `${at}.body`);
        break;
      case 'github_comment':
        checkTemplate(i, s.number, `${at}.number`);
        checkTemplate(i, s.text, `${at}.text`);
        break;
      case 'merge_pull_request':
        checkTemplate(i, s.number, `${at}.number`);
        break;
      case 'tracker_update':
      case 'tracker_reply':
      case 'tracker_decision': {
        checkTemplate(i, s.report, `${at}.report`);
        earlier(i, s.from, `${at}.from`);
        // It writes what that step's agent reported (0.69, TA-11; 0.75, TA-25: its reply; 3.12, TA-44: what is put to
        // the person): an agent step that reports an assessment.
        const from = def.steps[ids.get(s.from) ?? -1];
        if (from && ids.get(s.from) !== undefined && (ids.get(s.from) as number) < i)
          if (from.kind !== 'dispatch_agent' || !from.assessment)
            problems.push(`${at}.from: “${s.from}” isn’t an agent step that reports an assessment.`);
        // A reply that tells a decision (3.12, TA-46): an earlier `tracker_decision` step.
        if (s.kind === 'tracker_reply' && s.decision) {
          earlier(i, s.decision, `${at}.decision`);
          const decision = def.steps[ids.get(s.decision) ?? -1];
          if (decision && (ids.get(s.decision) as number) < i && decision.kind !== 'tracker_decision')
            problems.push(`${at}.decision: “${s.decision}” isn’t a step that asks about a feature request.`);
        }
        break;
      }
      case 'connection_actions': {
        earlier(i, s.from, `${at}.from`);
        const from = def.steps[ids.get(s.from) ?? -1];
        if (from && ids.get(s.from) !== undefined && (ids.get(s.from) as number) < i)
          if (from.kind !== 'dispatch_agent' || !from.proposeActions)
            problems.push(`${at}.from: “${s.from}” isn’t an agent step that proposes actions.`);
        break;
      }
      case 'wait':
        break;
    }
  });
  problems.push(...mailDefinitionProblems(def));
  return problems;
}

/** Validates a definition from any source (form, JSON, import, an agent's draft). */
export function validateDefinition(value: unknown, now = Date.now()): ValidationResult {
  if (jsonBytes(value) > AUTOMATION_DEFINITION_MAX_BYTES)
    return { ok: false, definition: null, problems: ['This automation is too big (64 KB at most).'] };
  const parsed = AutomationDefinition.safeParse(value);
  if (!parsed.success) return { ok: false, definition: null, problems: zodProblems(parsed.error) };
  const problems = definitionProblems(parsed.data, now);
  return problems.length
    ? { ok: false, definition: null, problems }
    : { ok: true, definition: parsed.data, problems: [] };
}

/** Parses an exported file (`{whombat: "automation", name, definition}`). */
export function parseAutomationExport(
  value: unknown,
  now = Date.now(),
): { ok: true; file: AutomationExport } | { ok: false; problems: string[] } {
  if (jsonBytes(value) > AUTOMATION_DEFINITION_MAX_BYTES)
    return { ok: false, problems: ['This file is too big (64 KB at most).'] };
  const parsed = AutomationExport.safeParse(value);
  if (!parsed.success) return { ok: false, problems: zodProblems(parsed.error) };
  const problems = definitionProblems(parsed.data.definition, now);
  return problems.length ? { ok: false, problems } : { ok: true, file: parsed.data };
}

/** Short words for a GitHub trigger in `triggerSummary` (0.66; was the raw event name). */
const GITHUB_TRIGGER_SUMMARY: Record<GitHubTriggerEvent, string> = {
  issue_opened: 'New issues',
  pr_opened: 'New pull requests',
  pr_updated: 'New commits on pull requests',
  checks_completed: 'Checks on pull requests',
  review_submitted: 'Reviews on pull requests',
  branch_pushed: 'Pushes',
};

/** “New reports in Acme Desk dev”, “New bug reports in …”, “New feature requests in …” (0.69, TA-04). */
function trackerSummary(kinds: readonly string[] | undefined): string {
  const set = new Set(kinds ?? ['bug', 'feature']);
  if (set.size !== 1) return 'New reports';
  return set.has('bug') ? 'New bug reports' : 'New feature requests';
}

/**
 * “Message in #bugs · 🐛 in #bugs · Every day at 09:00 · Europe/Amsterdam”. A tracker trigger names its connection's
 * label (0.69), “a tracker connection” when the viewer can't see it.
 */
export function triggerSummary(
  triggers: readonly AutomationTrigger[],
  conversationTitle: (id: string) => string | undefined = () => undefined,
  connectionLabel: (id: string) => string | undefined = () => undefined,
): string {
  return triggers
    .map((t) => {
      const room = (id: string) => conversationTitle(id) ?? 'a private room';
      switch (t.kind) {
        case 'message_posted':
          return t.contains.length
            ? `Message with “${t.contains[0]}”${t.contains.length > 1 ? '…' : ''} in ${room(t.conversationId)}`
            : `Message in ${room(t.conversationId)}`;
        case 'reaction_added':
          return `${t.value} in ${room(t.conversationId)}`;
        case 'schedule':
          return describeSchedule(t.schedule, t.timeZone);
        case 'github':
          return `${GITHUB_TRIGGER_SUMMARY[t.event]}${t.event === 'checks_completed' && t.checksState === 'failed' ? ' (failed)' : ''} on ${t.repo}`;
        case 'webhook':
          return 'Webhook';
        case 'manual':
          return TRIGGER_KIND_LABELS.manual;
        case 'tracker':
          // “Customer replies in Acme Desk dev” (0.75, TA-31).
          return `${t.event === 'reporter_replied' ? 'Customer replies' : trackerSummary(t.itemKinds)} in ${connectionLabel(t.connectionId) ?? 'a tracker connection'}`;
        case 'mail':
          return mailWhenText(t, connectionLabel(t.connectionId));
      }
      return '';
    })
    .join(' · ');
}
