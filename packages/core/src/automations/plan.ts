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
import { GITHUB_PR_EVENTS, STEP_KIND_LABELS, STEP_TEXT_MAX } from '../domain/automation.js';
import type {
  AutomationPlanChange,
  AutomationPlanLine,
  AutomationPlanPrompt,
  AutomationPlanSection,
  AutomationPlanSectionId,
  AutomationPlanState,
  AutomationPlanView,
} from '../domain/automation-plan.js';
import {
  type CoreMessageKey,
  type CoreTranslator,
  coreTranslator,
  coreWords,
  hasCoreMessage,
  tCore,
} from '../i18n/catalog.js';
import { formatLocaleNumber } from '../i18n/format.js';
import {
  cooldownOf,
  directActionDetail,
  directActionText,
  homeTriggerDetail,
  homeWhenText,
  protectTriggerDetail,
  protectWhenText,
} from './direct.js';
import { findMyTriggerDetail, findMyWhenText } from './findmy.js';
import { mailTriggerDetail, mailWhenText } from './mail.js';
import { recipeOf } from './recipes.js';
import { describeSchedule } from './schedule.js';
import { thingWhenText } from './thing.js';
import { trackerItemKind } from './validate.js';

export interface PlanNames {
  /** The agent's name: the label of what it does (“DUSTY”). */
  agent: string;
  /** “Chat”; undefined when unknown. */
  conversationTitle: (id: string) => string | undefined;
  /** A tracker connection's label: “Acme Desk dev”. */
  connectionLabel?: (id: string) => string | undefined;
  /** The viewer's locale tag (`en-GB`, `nl-NL`); null or absent is English. The stored definition stays English. */
  locale?: string | null;
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

function minutes(tr: CoreTranslator, m: number): string {
  if (m % 1440 === 0) return m === 1440 ? tr.t('plan.span.day') : tr.t('plan.span.days', { n: m / 1440 });
  if (m % 60 === 0) return m === 60 ? tr.t('plan.span.hour') : tr.t('plan.span.hours', { n: m / 60 });
  return m === 1 ? tr.t('plan.span.minute') : tr.t('plan.span.minutes', { n: m });
}

/* The keys a plan gives --------------------------------------------------------------------------------------- */

/** What the card says when a key an automation's steps can use asks first. */
function askText(tr: CoreTranslator, key: AutomationKey): string {
  return tr.t(`plan.ask.key.${key}`);
}

/** The tag to hand on to other words: the translator's locale, or the pseudo locale while testing. */
function tagOf(tr: CoreTranslator): string {
  return tr.language === 'pseudo' ? 'pseudo' : tr.locale;
}

/** The translator a view is drawn with: the viewer's locale, else English. */
function translatorOf(names: { locale?: string | null }, locale?: string | null): CoreTranslator {
  return coreTranslator(locale ?? names.locale);
}

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

function whenLine(t: AutomationTrigger, names: PlanNames, tr: CoreTranslator): AutomationPlanLine {
  const locale = tagOf(tr);
  const room = (id: string) => names.conversationTitle(id) ?? tr.t('plan.aRoom');
  const connection = (id: string) => names.connectionLabel?.(id) ?? tr.t('recipe.tracker.unknown');
  switch (t.kind) {
    case 'message_posted': {
      const words = t.contains.length
        ? tr.t('plan.when.message.words', {
            words: t.contains.map((w) => `“${w}”`).join(tr.t('plan.orJoin')),
          })
        : '';
      const detail = [
        t.includeReplies ? tr.t('plan.when.replies') : null,
        t.includeAgents ? tr.t('plan.when.agents', { agent: names.agent }) : null,
      ].filter((d): d is string => !!d);
      return line(
        tr.t('plan.when.message', { words, room: room(t.conversationId) }),
        detail.join(' · ') || null,
      );
    }
    case 'reaction_added':
      return line(tr.t('plan.when.reaction', { value: t.value, room: room(t.conversationId) }));
    case 'schedule':
      return line(describeSchedule(t.schedule, t.timeZone, locale));
    case 'github': {
      const label =
        t.event === 'checks_completed' && t.checksState === 'failed'
          ? tr.t('plan.when.github.checksFailed')
          : t.event === 'checks_completed' && t.checksState === 'passed'
            ? tr.t('plan.when.github.checksPassed')
            : tr.t(`plan.when.github.${t.event}`);
      const pr = GITHUB_PR_EVENTS.includes(t.event);
      const detail = [
        t.bots === false ? tr.t('plan.when.notBots') : null,
        pr && t.drafts === false ? tr.t('plan.when.notDrafts') : null,
        t.branch ? tr.t('plan.when.branch', { branch: t.branch }) : null,
      ].filter((d): d is string => !!d);
      return line(tr.t('plan.when.github', { label, repo: t.repo }), detail.join(' · ') || null);
    }
    case 'tracker':
      return t.event === 'reporter_replied'
        ? line(tr.t('plan.when.trackerReplied', { connection: connection(t.connectionId) }))
        : line(
            tr.t(`plan.when.tracker.${trackerItemKind(t.itemKinds)}`, {
              connection: connection(t.connectionId),
            }),
          );
    case 'mail': {
      const mailbox = names.connectionLabel?.(t.connectionId);
      return line(mailWhenText(t, mailbox, locale), mailTriggerDetail(mailbox, locale));
    }
    case 'thing':
      return line(thingWhenText(t, locale));
    case 'findmy':
      return line(
        findMyWhenText(t, locale),
        findMyTriggerDetail(names.connectionLabel?.(t.connectionId), locale),
      );
    case 'home_state':
      return line(
        homeWhenText(t, locale),
        homeTriggerDetail(names.connectionLabel?.(t.connectionId), locale),
      );
    case 'protect':
      return line(
        protectWhenText(t, locale),
        protectTriggerDetail(names.connectionLabel?.(t.connectionId), locale),
      );
    case 'webhook':
      return line(tr.t('plan.when.webhook'));
    case 'manual':
      return line(tr.t('plan.when.manual'));
    default:
      // A start of a kind this Whombat no longer knows (an old plan's card, an earlier version): said plainly.
      return line(tr.t('plan.unknownStart'));
  }
}

/** What an old plan's card says for a start of a kind this Whombat no longer knows. */
export const UNKNOWN_START = 'Something this Whombat no longer knows';

/** What an agent step does beyond its words: the code it reads or changes, and what it reports. */
function agentFacts(step: Extract<AutomationStep, { kind: 'dispatch_agent' }>, tr: CoreTranslator): string[] {
  const facts: string[] = [];
  const w = step.workspace;
  if (w?.access === 'write')
    facts.push(tr.t('plan.fact.changes', { repo: w.repo, branch: plainTemplate(w.branch ?? '') }).trim());
  else if (w?.pullRequest) facts.push(tr.t('plan.fact.readsPr', { repo: w.repo }));
  else if (w?.branch)
    facts.push(tr.t('plan.fact.readsBranch', { branch: plainTemplate(w.branch), repo: w.repo }));
  else if (w) facts.push(tr.t('plan.fact.reads', { repo: w.repo }));
  if (step.assessment) facts.push(tr.t('plan.fact.assessment'));
  if (step.verdict) facts.push(tr.t('plan.fact.verdict'));
  return facts;
}

function doesLine(step: AutomationStep, names: PlanNames, tr: CoreTranslator): AutomationPlanLine | null {
  const room = (c: string) => (c === 'run' ? null : (names.conversationTitle(c) ?? tr.t('plan.anotherRoom')));
  switch (step.kind) {
    case 'dispatch_agent': {
      const facts = agentFacts(step, tr);
      return line(step.name ?? firstLine(plainTemplate(step.prompt)), facts.join(' · ') || null);
    }
    case 'post_message': {
      const where = room(step.conversation);
      return line(
        step.name ?? (where ? tr.t('plan.does.postIn', { room: where }) : tr.t('plan.does.post')),
        firstLine(plainTemplate(step.text)),
      );
    }
    case 'wait':
      return line(step.name ?? tr.t('plan.does.wait', { span: minutes(tr, step.minutes) }));
    // Said from the step itself, never from its name: the card must say exactly what runs.
    case 'run_action':
      return line(directActionText(step, tagOf(tr)), directActionDetail(tagOf(tr), step));
    // A check named as a question (“Did the review approve it?”) is a gate between steps, not work the person reads.
    case 'condition':
      return step.name?.trim().endsWith('?')
        ? null
        : line(step.name ?? tr.t('plan.does.condition'), step.name ? null : step.if);
    default:
      return null;
  }
}

/** Where its runs go in Chat: a thread per item, under the message, or a new one each time. */
function threadLine(definition: AutomationDefinition, names: PlanNames, tr: CoreTranslator): string {
  // Steps that only act or wait post nothing: their runs are on the automation's page.
  if (definition.steps.every((s) => s.kind === 'run_action' || s.kind === 'wait' || s.kind === 'condition'))
    return tr.t('plan.thread.none');
  const room = names.conversationTitle(definition.conversationId) ?? tr.t('plan.chat');
  const kinds = new Set(definition.triggers.map((t) => t.kind));
  const github = definition.triggers.filter((t) => t.kind === 'github');
  const per = (item: CoreMessageKey) => tr.t('plan.thread.per', { item: tr.t(item), room });
  if (github.length && kinds.size === 1) {
    const issues = github.some((t) => t.event === 'issue_opened');
    const prs = github.some((t) => t.event !== 'issue_opened' && t.event !== 'branch_pushed');
    return per(
      issues && prs
        ? 'plan.item.issueOrPr'
        : issues
          ? 'plan.item.issue'
          : prs
            ? 'plan.item.pr'
            : 'plan.item.push',
    );
  }
  if (kinds.has('tracker') && kinds.size === 1) return per('plan.item.report');
  if (kinds.has('mail') && kinds.size === 1) return per('plan.item.email');
  if ([...kinds].every((k) => k === 'message_posted' || k === 'reaction_added'))
    return tr.t('plan.thread.underMessage');
  return tr.t('plan.thread.eachRun', { room });
}

/** The host of a URL a step calls. Core has no URL class (it stays free of platform APIs): what follows the scheme. */
function hostOf(url: string): string {
  return /^https?:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;
}

function postsLines(
  definition: AutomationDefinition,
  names: PlanNames,
  tr: CoreTranslator,
): AutomationPlanLine[] {
  const connection = (id: string) => names.connectionLabel?.(id) ?? tr.t('recipe.tracker.unknown');
  const outside: AutomationPlanLine[] = [];
  const merges = definition.steps.some((s) => s.kind === 'merge_pull_request');
  for (const step of definition.steps)
    switch (step.kind) {
      case 'github_comment':
        outside.push(line(tr.t('plan.posts.comment', { repo: step.repo })));
        break;
      case 'open_pull_request':
        // Without a merge step the pull request waits for the person, which the card says.
        outside.push(
          line(
            tr.t('plan.posts.openPr', { repo: step.repo }),
            [
              tr.t('plan.posts.from', { branch: plainTemplate(step.branch) }),
              ...(merges ? [] : [tr.t('plan.posts.youMerge')]),
            ].join(' · '),
          ),
        );
        break;
      case 'merge_pull_request':
        outside.push(line(tr.t('plan.posts.merge'), step.repo));
        break;
      case 'tracker_update':
        outside.push(line(tr.t('plan.posts.writesBack', { connection: connection(step.connectionId) })));
        break;
      case 'tracker_reply':
        outside.push(line(tr.t('plan.posts.replies', { connection: connection(step.connectionId) })));
        break;
      case 'connection_actions':
        outside.push(line(tr.t('plan.posts.actions'), tr.t('plan.posts.actionsDetail')));
        break;
      case 'http_callback':
        outside.push(line(tr.t('plan.posts.calls', { host: hostOf(step.url) })));
        break;
    }
  // A step that acts on a server or Home Assistant reaches outside Whombat too; its own line is under DOES.
  const acts = definition.steps.some((s) => s.kind === 'run_action');
  return [
    line(
      threadLine(definition, names, tr),
      outside.length || acts ? null : tr.t('plan.posts.nothingOutside'),
    ),
    ...outside,
  ];
}

/** What a feature request's card asks (3.12, TA-45), in words a person reads before it runs. */
function decisionLine(
  step: Extract<AutomationStep, { kind: 'tracker_decision' }>,
  tr: CoreTranslator,
): AutomationPlanLine {
  return line(tr.t('plan.decision'), step.build ? tr.t('plan.decision.build') : tr.t('plan.decision.plain'));
}

/** What an approval step asks, in words a person reads before it runs. */
function approvalLine(
  step: Extract<AutomationStep, { kind: 'request_approval' }>,
  fix: Pick<RecipeFix, 'mode' | 'minImportance'> | undefined,
  tr: CoreTranslator,
  tracker = false,
): AutomationPlanLine {
  if (fix && step.id === 'approve') {
    if (fix.mode === 'ask') return line(tr.t('plan.ask.fixAsk'));
    // A tracker report's fix doesn't depend on who filed it (report-trackers.md TA-38): only on how important the bug
    // is.
    if (tracker) {
      const key = `plan.bugs.${fix.minImportance}`;
      const bugs = hasCoreMessage(key) ? tr.t(key) : tr.t('plan.bugs.low');
      return line(tr.t('plan.ask.trackerOther'), tr.t('plan.ask.trackerFixes', { bugs }));
    }
    return line(tr.t('plan.ask.unsure'), tr.t('plan.ask.unsureDetail'));
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
  tr: CoreTranslator,
): AutomationPlanLine[] {
  const lines: AutomationPlanLine[] = [];
  const recipe = recipeOf(definition);
  for (const step of definition.steps) {
    if (step.kind === 'request_approval')
      lines.push(approvalLine(step, recipe?.fix, tr, recipe?.when.kind === 'tracker'));
    // A feature request is the person's to decide (3.12, TA-44, TA-45).
    if (step.kind === 'tracker_decision') lines.push(decisionLine(step, tr));
    if (step.kind === 'connection_actions')
      lines.push(line(tr.t('plan.ask.connections'), tr.t('plan.ask.connectionsDetail')));
  }
  const said = new Set<string>();
  for (const g of grants) {
    const text = askText(tr, g.keyId);
    if (g.tier !== 'ask' || said.has(text)) continue;
    said.add(text);
    lines.push(line(text));
  }
  if (lines.length) return lines;
  return [line(outside ? tr.t('plan.ask.nothingOutside') : tr.t('plan.ask.nothingReads'))];
}

function limitsLines(definition: AutomationDefinition, tr: CoreTranslator): AutomationPlanLine[] {
  const l = definition.limits;
  const lines = [line(tr.tp('plan.limit.runs', l.maxRunsPerDay))];
  const fix = recipeOf(definition)?.fix;
  if (fix) lines.push(line(tr.tp('plan.limit.fixes', fix.maxPerDay)));
  if (l.maxTokensPerDay) {
    const tokens = formatLocaleNumber(l.maxTokensPerDay, tr.locale);
    lines.push(line(tr.t('plan.limit.tokens', { tokens })));
  }
  const cooldown = cooldownOf(definition);
  if (cooldown > 0) lines.push(line(tr.tp('plan.limit.cooldown', cooldown)));
  return lines;
}

const LABEL_KEYS: Record<Exclude<AutomationPlanSectionId, 'does'>, CoreMessageKey> = {
  when: 'plan.section.when',
  asks: 'plan.section.asks',
  posts: 'plan.section.posts',
  limits: 'plan.section.limits',
};

/**
 * The card's sections for a definition and the keys it is given: when it runs, what the agent does, what asks
 * the person first, where it posts and its limits.
 */
export function planSections(
  definition: AutomationDefinition,
  grants: readonly AutomationGrant[],
  names: PlanNames,
  locale?: string | null,
): AutomationPlanSection[] {
  const tr = translatorOf(names, locale);
  const label = (id: keyof typeof LABEL_KEYS) => tr.t(LABEL_KEYS[id]);
  const does = definition.steps.flatMap((s) => doesLine(s, names, tr) ?? []);
  const posts = postsLines(definition, names, tr);
  const outside = posts.length > 1 || definition.steps.some((s) => s.kind === 'run_action');
  // An automation that acts without AI and has no agent step does what it does itself: Whombat's, not the agent's.
  const ownly =
    definition.steps.some((s) => s.kind === 'run_action') &&
    !definition.steps.some((s) => s.kind === 'dispatch_agent');
  const doer = ownly
    ? tr.t('plan.section.whombat')
    : clip(names.agent.toUpperCase(), 40) || tr.t('plan.section.does');
  const sections: AutomationPlanSection[] = [
    { id: 'when', label: label('when'), lines: definition.triggers.map((t) => whenLine(t, names, tr)) },
    ...(does.length
      ? [
          {
            id: 'does' as const,
            label: doer,
            lines: does,
          },
        ]
      : []),
    { id: 'asks', label: label('asks'), lines: asksLines(definition, grants, outside, tr) },
    { id: 'posts', label: label('posts'), lines: posts },
    { id: 'limits', label: label('limits'), lines: limitsLines(definition, tr) },
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
  locale?: string | null,
): AutomationPlanChange[] {
  const tr = coreTranslator(locale);
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
        text: clip(tr.t('plan.change.prompt', { agent, step: p.step })),
      });
  }
  return changes.slice(0, 60);
}

/** The words of a plan's card for a list of what it says (a notification, search, an older app): “Plan: “Name””. */
export function planCardText(name: string, change: boolean, locale?: string | null): string {
  return tCore(locale, change ? 'plan.card.change' : 'plan.card.new', { name });
}

/** What “Talk about it” and an older app read of a plan's state, in a few words. */
export const AUTOMATION_PLAN_STATE_LABELS = {
  waiting: 'Waiting for you',
  accepted: 'Turned on',
  declined: 'Not now',
  replaced: 'Replaced by a newer plan',
  gone: 'Deleted',
} as const;

/** `AUTOMATION_PLAN_STATE_LABELS` in a locale. */
export function automationPlanStateLabels(locale?: string | null): Record<AutomationPlanState, string> {
  return coreWords(locale, 'plan.state', ['waiting', 'accepted', 'declined', 'replaced', 'gone']);
}

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
export function automationPlanView(
  facts: PlanFacts,
  names: PlanNames,
  locale?: string | null,
): AutomationPlanView {
  const tag = locale ?? names.locale;
  const sections = planSections(facts.definition, facts.grants, names, tag);
  const prompts = planPrompts(facts.definition);
  const changes = facts.base
    ? planChanges(
        {
          sections: planSections(facts.base.definition, facts.base.grants, names, tag),
          prompts: planPrompts(facts.base.definition),
        },
        { sections, prompts },
        names.agent,
        tag,
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
export function planMessageText(change: boolean, locale?: string | null): string {
  return tCore(locale, change ? 'plan.message.change' : 'plan.message.new');
}

/** Why a plan can't be turned on or set aside any more. */
export const AUTOMATION_PLAN_DECIDED_TEXT: Record<Exclude<AutomationPlanState, 'waiting'>, string> = {
  accepted: 'This plan is already on.',
  declined: 'You said not now to this plan. Ask for it again in Chat.',
  replaced: 'A newer plan replaced this one: use that one.',
  gone: 'This automation was deleted.',
};

/** `AUTOMATION_PLAN_DECIDED_TEXT` in a locale. */
export function automationPlanDecidedText(
  locale?: string | null,
): Record<Exclude<AutomationPlanState, 'waiting'>, string> {
  return coreWords(locale, 'plan.decided', ['accepted', 'declined', 'replaced', 'gone']);
}

/** What a turn that can't change automations hears: an automation's own run, or what strangers sent. */
export const AUTOMATION_PLAN_NOT_HERE =
  'Automations change only when the person asks in their Chat, not from inside an automation or what someone else sent.';

/** `AUTOMATION_PLAN_NOT_HERE` in a locale. */
export function automationPlanNotHere(locale?: string | null): string {
  return tCore(locale, 'plan.notHere');
}

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
  | 'call'
  /** A step that acts on a server or Home Assistant by itself, without AI. */
  | 'act';

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
  locale?: string | null,
): AutomationFlowItem[] {
  const tr = translatorOf(names, locale);
  // A mark names the place: a tracker connection the viewer can't see is just “the tracker”.
  const connection = (id: string) => names.connectionLabel?.(id) ?? tr.t('plan.theTracker');
  const recipe = recipeOf(definition);
  const merges = definition.steps.some((s) => s.kind === 'merge_pull_request');
  const asks = (step: AutomationStep) =>
    stepKeys(step).some((k) => grants.some((g) => g.keyId === k.keyId && g.tier === 'ask'));
  const asking: AutomationFlowMark = { label: tr.t('flow.mark.asks'), tone: 'plain' };
  const titleOf = (step: AutomationStep): string => {
    switch (step.kind) {
      case 'dispatch_agent':
        return clip(step.name ?? firstLine(plainTemplate(step.prompt)), 120);
      case 'request_approval':
        return tr.t('flow.title.approval');
      case 'open_pull_request':
        return tr.t('plan.posts.openPr', { repo: step.repo });
      case 'merge_pull_request':
        return tr.t('flow.title.merge');
      case 'github_comment':
        return tr.t('flow.title.comment');
      case 'tracker_update':
        return tr.t('flow.title.writesBack');
      case 'tracker_reply':
        return tr.t('flow.title.reply');
      case 'tracker_decision':
        return tr.t('flow.title.decision');
      case 'connection_actions':
        return tr.t('flow.title.actions');
      case 'run_action':
        return directActionText(step, tagOf(tr));
      default:
        return doesLine(step, names, tr)?.text ?? step.name ?? tr.t(`plan.stepKind.${step.kind}`);
    }
  };
  const [first, ...others] = definition.triggers.map((t) => whenLine(t, names, tr));
  const items: AutomationFlowItem[] = [
    {
      kind: 'when',
      text: first?.text ?? tr.t('plan.when.manual'),
      details: [
        ...(first?.detail ? [first.detail] : []),
        ...others.map((l) => tr.t('flow.or', { text: lowerFirst(l.text) })),
        threadLine(definition, names, tr),
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
          details: agentFacts(step, tr).map(stop),
          marks:
            step.workspace?.access === 'write' ? [{ label: tr.t('flow.mark.changes'), tone: 'changes' }] : [],
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
        const what = approvalLine(step, recipe?.fix, tr, recipe?.when.kind === 'tracker');
        items.push({
          ...base,
          icon: 'ask',
          details: [
            stop(what.text),
            ...(what.detail ? [stop(what.detail)] : []),
            ...(step.onDecline === 'stop' ? [tr.t('flow.declineStops')] : []),
          ],
          marks: [],
        });
        break;
      }
      case 'wait':
        items.push({ ...base, icon: 'wait', details: [], marks: [] });
        break;
      case 'condition': {
        const question = stop(step.name ?? tr.t('flow.checkCondition'));
        const skipTo = step.else === 'stop' ? null : step.else.skipTo;
        const target = skipTo ? definition.steps.find((s) => s.id === skipTo) : undefined;
        items.push({
          kind: 'gate',
          id: step.id,
          text: target
            ? tr.t('flow.gate.skipTo', { question, title: titleOf(target) })
            : tr.t('flow.gate.stop', { question }),
        });
        break;
      }
      case 'open_pull_request':
        items.push({
          ...base,
          icon: 'pull_request',
          details: [
            stop(tr.t('plan.posts.from', { branch: plainTemplate(step.branch) })),
            ...(merges ? [] : [tr.t('flow.youMerge')]),
          ],
          marks: [{ label: 'GitHub', tone: 'plain' }, ...(asks(step) ? [asking] : [])],
        });
        break;
      case 'merge_pull_request':
        items.push({
          ...base,
          icon: 'merge',
          details: [tr.t('flow.mergeDetail', { repo: step.repo })],
          marks: [asks(step) ? asking : { label: tr.t('flow.mark.merges'), tone: 'merges' }],
        });
        break;
      case 'github_comment':
        items.push({
          ...base,
          icon: 'comment',
          details: [tr.t('flow.onRepo', { repo: step.repo })],
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
          details: [step.decision ? tr.t('flow.reply.decided') : tr.t('flow.reply.something')],
          marks: [{ label: connection(step.connectionId), tone: 'plain' }, ...(asks(step) ? [asking] : [])],
        });
        break;
      case 'tracker_decision':
        items.push({
          ...base,
          icon: 'ask',
          details: [stop(decisionLine(step, tr).text), stop(decisionLine(step, tr).detail ?? '')],
          marks: [],
        });
        break;
      case 'connection_actions':
        items.push({
          ...base,
          icon: 'ask',
          details: [tr.t('flow.actionsDetail')],
          marks: [asking],
        });
        break;
      case 'run_action':
        items.push({
          ...base,
          icon: 'act',
          details: [stop(directActionDetail(tagOf(tr), step))],
          marks: [{ label: tr.t('flow.mark.withoutAi'), tone: 'changes' }],
        });
        break;
      case 'http_callback': {
        const host = hostOf(step.url);
        items.push({
          ...base,
          icon: 'call',
          title: tr.t('plan.posts.calls', { host }),
          details: [],
          marks: [{ label: host, tone: 'changes' }],
        });
        break;
      }
    }
  }
  return items;
}
