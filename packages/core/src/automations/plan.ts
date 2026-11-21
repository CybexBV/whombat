/**
 * An automation plan in plain words (Whombat automation-chat.md): what its card says, written from
 * the definition alone so the card says exactly what will run, never what the agent says it does; the keys turning it on
 * gives it; and what differs from the live version. Pure: the runtime fills in names (the agent's, rooms, tracker
 * connections), and the web and the phone only draw the result, so both say the same.
 */
import type {
  AutomationDefinition,
  AutomationGrant,
  AutomationKey,
  AutomationStep,
  AutomationTrigger,
  RecipeFix,
} from '../domain/automation.js';
import {
  GITHUB_EVENT_LABELS,
  GITHUB_PR_EVENTS,
  STEP_KIND_LABELS,
  STEP_TEXT_MAX,
} from '../domain/automation.js';
import type {
  AutomationPlanChange,
  AutomationPlanLine,
  AutomationPlanPrompt,
  AutomationPlanSection,
  AutomationPlanSectionId,
  AutomationPlanState,
  AutomationPlanView,
} from '../domain/automation-plan.js';
import { mailTriggerDetail, mailWhenText } from './mail.js';
import { RECIPE_FIX_IMPORTANCE, recipeOf, trackerItemNoun, UNKNOWN_TRACKER_CONNECTION } from './recipes.js';
import { describeSchedule } from './schedule.js';

export interface PlanNames {
  /** The agent's name: the label of what it does (“DUSTY”). */
  agent: string;
  /** “Chat”; undefined when unknown. */
  conversationTitle: (id: string) => string | undefined;
  /** A tracker connection's label: “Acme Desk dev”. */
  connectionLabel?: (id: string) => string | undefined;
}

const LINE_MAX = 300;

function clip(text: string, max = LINE_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

function line(text: string, detail: string | null = null): AutomationPlanLine {
  return { text: clip(text), detail: detail ? clip(detail) : null };
}

/** The first line of a text with something in it. */
function firstLine(text: string, max = 120): string {
  return clip(text.split('\n').find((l) => l.trim()) ?? text, max);
}

/**
 * A template as a person reads it: what fills in at run time becomes a short stand-in, so “Fix #{{trigger.number}}”
 * reads “Fix #N” and a branch `feat/issue-{{trigger.number}}` reads `feat/issue-N`.
 */
export function plainTemplate(text: string): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path: string) => {
    if (/(^|\.)(number|prNumber)$/.test(path)) return 'N';
    if (path === 'run.number') return 'N';
    return '…';
  });
}

function minutes(m: number): string {
  if (m % 1440 === 0) return m === 1440 ? 'a day' : `${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? 'an hour' : `${m / 60} hours`;
  return m === 1 ? 'a minute' : `${m} minutes`;
}

/* The keys a plan gives --------------------------------------------------------------------------------------- */

/** Every key an automation's steps can use, with what the card says when it asks first. */
const ASK_TEXT: Record<AutomationKey, string> = {
  'pr.open': 'Before it opens a pull request',
  'pr.comment': 'Before it comments on GitHub',
  merge: 'Before it merges a pull request',
  'merge.main': 'Before it merges a pull request',
  'report.update': 'Before it writes back to the tracker',
  'report.reply': 'Before it replies to a customer',
  'messages.external': 'Before it calls out',
};

/** The keys a step needs to do what it does, with what each is limited to. */
function stepKeys(step: AutomationStep): { keyId: AutomationKey; repo?: string; connection?: string }[] {
  switch (step.kind) {
    case 'github_comment':
      return [{ keyId: 'pr.comment', repo: step.repo }];
    case 'open_pull_request':
      return [{ keyId: 'pr.open', repo: step.repo }];
    // The pull request's base decides which applies; both, so it merges whichever it is.
    case 'merge_pull_request':
      return [
        { keyId: 'merge.main', repo: step.repo },
        { keyId: 'merge', repo: step.repo },
      ];
    case 'tracker_update':
      return [{ keyId: 'report.update', connection: step.connectionId }];
    case 'tracker_reply':
      return [{ keyId: 'report.reply', connection: step.connectionId }];
    case 'http_callback':
      return [{ keyId: 'messages.external' }];
    default:
      return [];
  }
}

/**
 * The keys turning a plan on gives its automation: each key a step needs, limited to the repositories and tracker
 * connections those steps name, at Can — or Asks for the keys in `asks` (both merge keys when either is named). Calling a
 * URL never asks: an approval step before it does (bp-automations.md).
 */
export function definitionGrants(
  definition: AutomationDefinition,
  asks: readonly AutomationKey[] = [],
): AutomationGrant[] {
  const byKey = new Map<AutomationKey, { repos: Set<string>; connections: Set<string> }>();
  for (const step of definition.steps)
    for (const k of stepKeys(step)) {
      const entry = byKey.get(k.keyId) ?? { repos: new Set<string>(), connections: new Set<string>() };
      if (k.repo) entry.repos.add(k.repo);
      if (k.connection) entry.connections.add(k.connection);
      byKey.set(k.keyId, entry);
    }
  const asking = new Set<AutomationKey>(asks);
  if (asking.has('merge') || asking.has('merge.main')) {
    asking.add('merge');
    asking.add('merge.main');
  }
  return [...byKey].map(([keyId, scope]) => ({
    keyId,
    tier: asking.has(keyId) && keyId !== 'messages.external' ? 'ask' : 'can',
    ...(scope.repos.size ? { repos: [...scope.repos] } : {}),
    ...(scope.connections.size ? { connections: [...scope.connections] } : {}),
  }));
}

/* Sections ----------------------------------------------------------------------------------------------------- */

function whenLine(t: AutomationTrigger, names: PlanNames): AutomationPlanLine {
  const room = (id: string) => names.conversationTitle(id) ?? 'a room';
  const connection = (id: string) => names.connectionLabel?.(id) ?? UNKNOWN_TRACKER_CONNECTION;
  switch (t.kind) {
    case 'message_posted': {
      const words = t.contains.length ? ` with ${t.contains.map((w) => `“${w}”`).join(' or ')}` : '';
      const detail = [
        t.includeReplies ? 'Thread replies count too' : null,
        t.includeAgents ? `${names.agent}’s own messages count too` : null,
      ].filter((d): d is string => !!d);
      return line(`A message${words} in ${room(t.conversationId)}`, detail.join(' · ') || null);
    }
    case 'reaction_added':
      return line(`Someone reacts with ${t.value} in ${room(t.conversationId)}`);
    case 'schedule':
      return line(describeSchedule(t.schedule, t.timeZone));
    case 'github': {
      const label =
        t.event === 'checks_completed' && t.checksState === 'failed'
          ? 'Checks fail on a pull request'
          : t.event === 'checks_completed' && t.checksState === 'passed'
            ? 'Checks pass on a pull request'
            : GITHUB_EVENT_LABELS[t.event];
      const pr = GITHUB_PR_EVENTS.includes(t.event);
      const detail = [
        t.bots === false ? 'Not from bots' : null,
        pr && t.drafts === false ? 'Not draft pull requests' : null,
        t.branch ? `Branch ${t.branch}` : null,
      ].filter((d): d is string => !!d);
      return line(`${label} on ${t.repo}`, detail.join(' · ') || null);
    }
    case 'tracker':
      return t.event === 'reporter_replied'
        ? line(`A customer writes back in ${connection(t.connectionId)}`)
        : line(`A new ${trackerItemNoun(t.itemKinds)} in ${connection(t.connectionId)}`);
    case 'mail': {
      const mailbox = names.connectionLabel?.(t.connectionId);
      return line(mailWhenText(t, mailbox), mailTriggerDetail(mailbox));
    }
    case 'webhook':
      return line('Someone calls its webhook');
    case 'manual':
      return line('Only when you start it');
    default:
      // A start of a kind this Whombat no longer knows (an old plan's card, an earlier version): said plainly.
      return line(UNKNOWN_START);
  }
}

/** What an old plan's card says for a start of a kind this Whombat no longer knows. */
export const UNKNOWN_START = 'Something this Whombat no longer knows';

/** What an agent step does beyond its words: the code it reads or changes, and what it reports. */
function agentFacts(step: Extract<AutomationStep, { kind: 'dispatch_agent' }>): string[] {
  const facts: string[] = [];
  const w = step.workspace;
  if (w?.access === 'write')
    facts.push(`Changes the code of ${w.repo} on its own branch ${plainTemplate(w.branch ?? '')}`.trim());
  else if (w?.pullRequest) facts.push(`Reads the pull request’s code on ${w.repo}`);
  else if (w?.branch) facts.push(`Reads ${plainTemplate(w.branch)} of ${w.repo}`);
  else if (w) facts.push(`Reads the code of ${w.repo}`);
  if (step.assessment) facts.push('Says what it is, how important it is and how big a fix would be');
  if (step.verdict) facts.push('Says whether it’s ready');
  return facts;
}

function doesLine(step: AutomationStep, names: PlanNames): AutomationPlanLine | null {
  const room = (c: string) => (c === 'run' ? null : (names.conversationTitle(c) ?? 'another room'));
  switch (step.kind) {
    case 'dispatch_agent': {
      const facts = agentFacts(step);
      return line(step.name ?? firstLine(plainTemplate(step.prompt)), facts.join(' · ') || null);
    }
    case 'post_message': {
      const where = room(step.conversation);
      return line(
        step.name ?? `Posts a message${where ? ` in ${where}` : ''}`,
        firstLine(plainTemplate(step.text)),
      );
    }
    case 'wait':
      return line(step.name ?? `Waits ${minutes(step.minutes)}`);
    // A check named as a question (“Did the review approve it?”) is a gate between steps, not work the person reads.
    case 'condition':
      return step.name?.trim().endsWith('?')
        ? null
        : line(step.name ?? 'Goes on only when a check holds', step.name ? null : step.if);
    default:
      return null;
  }
}

/** Where its runs go in Chat: a thread per item, under the message, or a new one each time. */
function threadLine(definition: AutomationDefinition, names: PlanNames): string {
  const room = names.conversationTitle(definition.conversationId) ?? 'Chat';
  const kinds = new Set(definition.triggers.map((t) => t.kind));
  const github = definition.triggers.filter((t) => t.kind === 'github');
  if (github.length && kinds.size === 1) {
    const issues = github.some((t) => t.event === 'issue_opened');
    const prs = github.some((t) => t.event !== 'issue_opened' && t.event !== 'branch_pushed');
    const item = issues && prs ? 'issue or pull request' : issues ? 'issue' : prs ? 'pull request' : 'push';
    return `One thread per ${item} in ${room}`;
  }
  if (kinds.has('tracker') && kinds.size === 1) return `One thread per report in ${room}`;
  if (kinds.has('mail') && kinds.size === 1) return `One thread per email in ${room}`;
  if ([...kinds].every((k) => k === 'message_posted' || k === 'reaction_added'))
    return 'In a thread under the message';
  return `A thread in ${room} each time it runs`;
}

function postsLines(definition: AutomationDefinition, names: PlanNames): AutomationPlanLine[] {
  const connection = (id: string) => names.connectionLabel?.(id) ?? UNKNOWN_TRACKER_CONNECTION;
  const outside: AutomationPlanLine[] = [];
  const merges = definition.steps.some((s) => s.kind === 'merge_pull_request');
  for (const step of definition.steps)
    switch (step.kind) {
      case 'github_comment':
        outside.push(line(`Comments on GitHub on ${step.repo}`));
        break;
      case 'open_pull_request':
        // Without a merge step the pull request waits for the person, which the card says.
        outside.push(
          line(
            `Opens a pull request on ${step.repo}`,
            `From ${plainTemplate(step.branch)}${merges ? '' : ' · You merge it'}`,
          ),
        );
        break;
      case 'merge_pull_request':
        outside.push(line(`Merges the pull request once its checks pass`, step.repo));
        break;
      case 'tracker_update':
        outside.push(line(`Writes its assessment back to ${connection(step.connectionId)}`));
        break;
      case 'tracker_reply':
        outside.push(line(`Replies to the customer in ${connection(step.connectionId)}`));
        break;
      case 'http_callback': {
        // Core has no URL class (it stays free of platform APIs): the host is what follows the scheme.
        const host = /^https?:\/\/([^/?#]+)/i.exec(step.url)?.[1] ?? step.url;
        outside.push(line(`Calls ${host}`));
        break;
      }
    }
  return [line(threadLine(definition, names), outside.length ? null : 'Nothing outside Whombat'), ...outside];
}

/** What a feature request's card asks (3.12, TA-45), in words a person reads before it runs. */
function decisionLine(step: Extract<AutomationStep, { kind: 'tracker_decision' }>): AutomationPlanLine {
  return line(
    'About each feature request, with its value from 1 to 10',
    step.build
      ? 'Approve, approve and build, decline or ask the customer'
      : 'Approve, decline or ask the customer',
  );
}

/** What an approval step asks, in words a person reads before it runs. */
function approvalLine(
  step: Extract<AutomationStep, { kind: 'request_approval' }>,
  fix: Pick<RecipeFix, 'mode' | 'minImportance'> | undefined,
  tracker = false,
): AutomationPlanLine {
  if (fix && step.id === 'approve') {
    if (fix.mode === 'ask') return line('Before it fixes or changes anything');
    // A tracker report's fix doesn't depend on who filed it (report-trackers.md TA-38): only on how important the bug
    // is.
    if (tracker) {
      const bugs = RECIPE_FIX_IMPORTANCE.find((i) => i.id === fix.minImportance)?.bugs ?? 'bugs';
      return line('Before any other change it suggests', `It fixes ${bugs} on its own`);
    }
    return line(
      'Before a fix it isn’t sure about',
      'It fixes on its own only when it’s sure, the fix is small and someone with access opened the issue',
    );
  }
  const title = plainTemplate(step.title);
  // A title that is mostly what fills in at run time says nothing yet: the step's name does.
  const filled = title.replace(/…|#?N\b/g, '').replace(/[\s:.,?!-]/g, '');
  if (filled.length < 3 && step.name) return line(step.name);
  return line(title, step.name && step.name !== step.title ? step.name : null);
}

function asksLines(
  definition: AutomationDefinition,
  grants: readonly AutomationGrant[],
  outside: boolean,
): AutomationPlanLine[] {
  const lines: AutomationPlanLine[] = [];
  const recipe = recipeOf(definition);
  for (const step of definition.steps) {
    if (step.kind === 'request_approval')
      lines.push(approvalLine(step, recipe?.fix, recipe?.when.kind === 'tracker'));
    // A feature request is the person's to decide (3.12, TA-44, TA-45).
    if (step.kind === 'tracker_decision') lines.push(decisionLine(step));
  }
  const said = new Set<string>();
  for (const g of grants) {
    const text = ASK_TEXT[g.keyId];
    if (g.tier !== 'ask' || said.has(text)) continue;
    said.add(text);
    lines.push(line(text));
  }
  if (lines.length) return lines;
  return [line(outside ? 'Nothing: it does all of this on its own' : 'Nothing: it only reads and tells you')];
}

function limitsLines(definition: AutomationDefinition): AutomationPlanLine[] {
  const l = definition.limits;
  const lines = [line(`At most ${l.maxRunsPerDay} ${l.maxRunsPerDay === 1 ? 'run' : 'runs'} a day`)];
  const fix = recipeOf(definition)?.fix;
  if (fix) lines.push(line(`At most ${fix.maxPerDay} ${fix.maxPerDay === 1 ? 'fix' : 'fixes'} a day`));
  if (l.maxTokensPerDay)
    lines.push(line(`At most ${l.maxTokensPerDay.toLocaleString('en-US')} tokens a day`));
  return lines;
}

const LABELS: Record<Exclude<AutomationPlanSectionId, 'does'>, string> = {
  when: 'WHEN',
  asks: 'ASKS YOU',
  posts: 'POSTS',
  limits: 'LIMIT',
};

/**
 * The card's sections for a definition and the keys it is given: when it runs, what the agent does, what asks
 * the person first, where it posts and its limits.
 */
export function planSections(
  definition: AutomationDefinition,
  grants: readonly AutomationGrant[],
  names: PlanNames,
): AutomationPlanSection[] {
  const does = definition.steps.flatMap((s) => doesLine(s, names) ?? []);
  const posts = postsLines(definition, names);
  const outside = posts.length > 1;
  const sections: AutomationPlanSection[] = [
    { id: 'when', label: LABELS.when, lines: definition.triggers.map((t) => whenLine(t, names)) },
    ...(does.length
      ? [{ id: 'does' as const, label: clip(names.agent.toUpperCase(), 40) || 'DOES', lines: does }]
      : []),
    { id: 'asks', label: LABELS.asks, lines: asksLines(definition, grants, outside) },
    { id: 'posts', label: LABELS.posts, lines: posts },
    { id: 'limits', label: LABELS.limits, lines: limitsLines(definition) },
  ];
  const once = (lines: AutomationPlanLine[]) =>
    lines.filter((l, i) => lines.findIndex((o) => o.text === l.text && o.detail === l.detail) === i);
  return sections.map((s) => ({ ...s, lines: once(s.lines).slice(0, 24) }));
}

/** What the agent is asked in each of its steps, word for word (“What Dusty is asked”). */
export function planPrompts(definition: AutomationDefinition): AutomationPlanPrompt[] {
  return definition.steps.flatMap((s) =>
    s.kind === 'dispatch_agent'
      ? [
          {
            step: clip(s.name ?? STEP_KIND_LABELS.dispatch_agent, 80),
            text: s.prompt.slice(0, STEP_TEXT_MAX),
          },
        ]
      : [],
  );
}

/** What “Try it” does: on a recent issue, pull request or report when something like that starts it, else once now. */
export function planTryIt(definition: AutomationDefinition): 'sample' | 'now' {
  return definition.triggers.some(
    (t) =>
      (t.kind === 'github' && t.event !== 'branch_pushed') ||
      (t.kind === 'tracker' && t.event === 'item_opened'),
  )
    ? 'sample'
    : 'now';
}

const lineKey = (section: AutomationPlanSectionId, l: AutomationPlanLine) => `${section}\u0000${l.text}`;
const lineText = (l: AutomationPlanLine) => clip(l.detail ? `${l.text} (${l.detail})` : l.text);

/**
 * What a change does: the lines of the new plan the live version lacks (`added`), the ones it drops (`removed`), a line
 * that stays but reads differently under it (`changed`), and each agent step whose words changed. Empty when nothing a
 * person reads differs.
 */
export function planChanges(
  before: { sections: readonly AutomationPlanSection[]; prompts: readonly AutomationPlanPrompt[] },
  after: { sections: readonly AutomationPlanSection[]; prompts: readonly AutomationPlanPrompt[] },
  agent: string,
): AutomationPlanChange[] {
  const flat = (sections: readonly AutomationPlanSection[]) =>
    sections.flatMap((s) => s.lines.map((l) => ({ section: s.id, line: l, key: lineKey(s.id, l) })));
  const old = flat(before.sections);
  const now = flat(after.sections);
  const oldByKey = new Map(old.map((o) => [o.key, o]));
  const nowKeys = new Set(now.map((n) => n.key));
  const changes: AutomationPlanChange[] = [];
  for (const n of now) {
    const was = oldByKey.get(n.key);
    if (!was) changes.push({ change: 'added', section: n.section, text: lineText(n.line) });
    else if ((was.line.detail ?? '') !== (n.line.detail ?? ''))
      changes.push({ change: 'changed', section: n.section, text: lineText(n.line) });
  }
  for (const o of old)
    if (!nowKeys.has(o.key)) changes.push({ change: 'removed', section: o.section, text: lineText(o.line) });
  const oldPrompts = new Map(before.prompts.map((p) => [p.step, p.text]));
  for (const p of after.prompts) {
    const was = oldPrompts.get(p.step);
    if (was !== undefined && was !== p.text)
      changes.push({
        change: 'changed',
        section: 'does',
        text: clip(`What ${agent} is asked in “${p.step}”`),
      });
  }
  return changes.slice(0, 60);
}

/** The words of a plan's card for a list of what it says (a notification, search, an older app): “Plan: “Name””. */
export function planCardText(name: string, change: boolean): string {
  return change ? `A change to “${name}”` : `Plan: “${name}”`;
}

/** What “Talk about it” and an older app read of a plan's state, in a few words. */
export const AUTOMATION_PLAN_STATE_LABELS = {
  waiting: 'Waiting for you',
  accepted: 'Turned on',
  declined: 'Not now',
  replaced: 'Replaced by a newer plan',
  gone: 'Deleted',
} as const;

/** What the runtime knows of a plan to show its card (`automationPlanView`). */
export interface PlanFacts {
  planId: string;
  automationId: string;
  name: string;
  description: string;
  state: AutomationPlanState;
  definition: AutomationDefinition;
  grants: readonly AutomationGrant[];
  /** The live version it changes (its definition and keys), null for a new automation. */
  base: { definition: AutomationDefinition; grants: readonly AutomationGrant[] } | null;
  thinking: readonly string[];
  decidedById: string | null;
  decidedAt: string | null;
  version: number | null;
  createdAt: string;
}

/** A plan as its card shows it: the sections, and for a change what differs from the live version. */
export function automationPlanView(facts: PlanFacts, names: PlanNames): AutomationPlanView {
  const sections = planSections(facts.definition, facts.grants, names);
  const prompts = planPrompts(facts.definition);
  const changes = facts.base
    ? planChanges(
        {
          sections: planSections(facts.base.definition, facts.base.grants, names),
          prompts: planPrompts(facts.base.definition),
        },
        { sections, prompts },
        names.agent,
      )
    : [];
  return {
    planId: facts.planId,
    automationId: facts.automationId,
    name: facts.name,
    description: facts.description,
    state: facts.state,
    change: facts.base !== null,
    sections,
    changes,
    thinking: facts.thinking.slice(0, 4).map((t) => clip(t)),
    prompts,
    tryIt: planTryIt(facts.definition),
    decidedById: facts.decidedById,
    decidedAt: facts.decidedAt,
    version: facts.version,
    createdAt: facts.createdAt,
  };
}

/** The agent's line above a plan's card when it gives none. */
export function planMessageText(change: boolean): string {
  return change
    ? 'Here’s the change. The current version keeps running until you say yes.'
    : 'Here’s how I’d set it up. Turn it on when it looks right, or tell me what to change.';
}

/** Why a plan can't be turned on or set aside any more. */
export const AUTOMATION_PLAN_DECIDED_TEXT: Record<Exclude<AutomationPlanState, 'waiting'>, string> = {
  accepted: 'This plan is already on.',
  declined: 'You said not now to this plan. Ask for it again in Chat.',
  replaced: 'A newer plan replaced this one: use that one.',
  gone: 'This automation was deleted.',
};

/** What a turn that can't change automations hears: an automation's own run, or what strangers sent. */
export const AUTOMATION_PLAN_NOT_HERE =
  'Automations change only when the person asks in their Chat, not from inside an automation or what someone else sent.';

/* What happens, step by step ---------------------------------------------------------------------------------- */

/** The glyph a step of “What happens” gets. */
export type AutomationFlowIcon =
  | 'start'
  | 'agent'
  | 'post'
  | 'ask'
  | 'wait'
  | 'pull_request'
  | 'merge'
  | 'comment'
  | 'report'
  | 'reply'
  | 'call';

/**
 * A label on a step that reaches outside Whombat or changes code: the place it reaches (`plain`), “Changes code”
 * (`changes`), “Merges by itself” (`merges`); and “Asks you first” where its key asks.
 */
export interface AutomationFlowMark {
  label: string;
  tone: 'plain' | 'changes' | 'merges';
}

export type AutomationFlowItem =
  /** What starts it, then the other triggers (“Or …”) and where its runs show. */
  | { kind: 'when'; text: string; details: string[] }
  | {
      kind: 'step';
      id: string;
      icon: AutomationFlowIcon;
      title: string;
      details: string[];
      marks: AutomationFlowMark[];
    }
  /** A check between steps: its question, and what happens when the answer is no. */
  | { kind: 'gate'; id: string; text: string };

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const stop = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/**
 * What an automation does, step by step, in plain words (the phone's automation page, automation-page.md AP-6331): what
 * starts it, each step in order with what it reaches outside Whombat, and the checks between them with what a no does.
 * Written from the definition alone, as the plan card is, so the page says exactly what will run.
 */
export function automationFlow(
  definition: AutomationDefinition,
  grants: readonly AutomationGrant[],
  names: PlanNames,
): AutomationFlowItem[] {
  // A mark names the place: a tracker connection the viewer can't see is just “the tracker”.
  const connection = (id: string) => names.connectionLabel?.(id) ?? 'the tracker';
  const recipe = recipeOf(definition);
  const merges = definition.steps.some((s) => s.kind === 'merge_pull_request');
  const asks = (step: AutomationStep) =>
    stepKeys(step).some((k) => grants.some((g) => g.keyId === k.keyId && g.tier === 'ask'));
  const asking: AutomationFlowMark = { label: 'Asks you first', tone: 'plain' };
  const titleOf = (step: AutomationStep): string => {
    switch (step.kind) {
      case 'dispatch_agent':
        return clip(step.name ?? firstLine(plainTemplate(step.prompt)), 120);
      case 'request_approval':
        return 'Asks you first';
      case 'open_pull_request':
        return `Opens a pull request on ${step.repo}`;
      case 'merge_pull_request':
        return 'Merges it once its checks pass';
      case 'github_comment':
        return 'Comments on GitHub';
      case 'tracker_update':
        return 'Writes the assessment back to the report';
      case 'tracker_reply':
        return 'Replies to the customer';
      case 'tracker_decision':
        return 'Asks you about a feature request';
      default:
        return doesLine(step, names)?.text ?? step.name ?? STEP_KIND_LABELS[step.kind];
    }
  };
  const [first, ...others] = definition.triggers.map((t) => whenLine(t, names));
  const items: AutomationFlowItem[] = [
    {
      kind: 'when',
      text: first?.text ?? 'Only when you start it',
      details: [
        ...(first?.detail ? [first.detail] : []),
        ...others.map((l) => `Or ${lowerFirst(l.text)}`),
        threadLine(definition, names),
      ],
    },
  ];
  for (const step of definition.steps) {
    const base = { kind: 'step' as const, id: step.id, title: titleOf(step) };
    switch (step.kind) {
      case 'dispatch_agent':
        items.push({
          ...base,
          icon: 'agent',
          details: agentFacts(step).map(stop),
          marks: step.workspace?.access === 'write' ? [{ label: 'Changes code', tone: 'changes' }] : [],
        });
        break;
      case 'post_message': {
        const said = firstLine(plainTemplate(step.text));
        items.push({
          ...base,
          icon: 'post',
          details: said.replace(/[…\s]/g, '').length > 2 && step.name ? [said] : [],
          marks: [],
        });
        break;
      }
      case 'request_approval': {
        const what = approvalLine(step, recipe?.fix, recipe?.when.kind === 'tracker');
        items.push({
          ...base,
          icon: 'ask',
          details: [
            stop(what.text),
            ...(what.detail ? [stop(what.detail)] : []),
            ...(step.onDecline === 'stop' ? ['A no stops it here.'] : []),
          ],
          marks: [],
        });
        break;
      }
      case 'wait':
        items.push({ ...base, icon: 'wait', details: [], marks: [] });
        break;
      case 'condition': {
        const question = stop(step.name ?? 'It checks a condition');
        const skipTo = step.else === 'stop' ? null : step.else.skipTo;
        const target = skipTo ? definition.steps.find((s) => s.id === skipTo) : undefined;
        items.push({
          kind: 'gate',
          id: step.id,
          text: `${question} ${target ? `If not, it goes on at “${titleOf(target)}”.` : 'If not, it stops here.'}`,
        });
        break;
      }
      case 'open_pull_request':
        items.push({
          ...base,
          icon: 'pull_request',
          details: [stop(`From ${plainTemplate(step.branch)}`), ...(merges ? [] : ['You merge it.'])],
          marks: [{ label: 'GitHub', tone: 'plain' }, ...(asks(step) ? [asking] : [])],
        });
        break;
      case 'merge_pull_request':
        items.push({
          ...base,
          icon: 'merge',
          details: [`${step.repo}. If its checks fail or someone changes it, it waits for you.`],
          marks: [asks(step) ? asking : { label: 'Merges by itself', tone: 'merges' }],
        });
        break;
      case 'github_comment':
        items.push({
          ...base,
          icon: 'comment',
          details: [`On ${step.repo}.`],
          marks: [{ label: 'GitHub', tone: 'plain' }, ...(asks(step) ? [asking] : [])],
        });
        break;
      case 'tracker_update':
        items.push({
          ...base,
          icon: 'report',
          details: [],
          marks: [{ label: connection(step.connectionId), tone: 'plain' }, ...(asks(step) ? [asking] : [])],
        });
        break;
      case 'tracker_reply':
        items.push({
          ...base,
          icon: 'reply',
          details: [step.decision ? 'What you decided.' : 'When it has something to say to them.'],
          marks: [{ label: connection(step.connectionId), tone: 'plain' }, ...(asks(step) ? [asking] : [])],
        });
        break;
      case 'tracker_decision':
        items.push({
          ...base,
          icon: 'ask',
          details: [stop(decisionLine(step).text), stop(decisionLine(step).detail ?? '')],
          marks: [],
        });
        break;
      case 'http_callback': {
        const host = /^https?:\/\/([^/?#]+)/i.exec(step.url)?.[1] ?? step.url;
        items.push({
          ...base,
          icon: 'call',
          title: `Calls ${host}`,
          details: [],
          marks: [{ label: host, tone: 'changes' }],
        });
        break;
      }
    }
  }
  return items;
}
