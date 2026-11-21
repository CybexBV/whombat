/**
 * An automation at a glance (0.72, CT-328; Whombat docs/decisions/automation-list.md): what a row of the Automations
 * list shows instead of the summary sentence — a tile for what starts it, a few words for the trigger, the agent, where
 * it answers, and tags for what it may do, mildest first. Pure; the runtime fills in names as for `summary`, and the
 * web and Android only draw it, so both say the same.
 */
import type {
  AutomationDefinition,
  AutomationDoes,
  AutomationGlance,
  AutomationGlanceTag,
  AutomationRecipe,
  AutomationSource,
  AutomationStep,
  AutomationTrigger,
  GitHubTrigger,
  RecipeGitHubEvent,
  RecipeJob,
} from '../domain/automation.js';
import { mailWhenText } from './mail.js';
import { mergesFix, recipeOf, repliesToCustomer, trackerItemNoun, writesBack } from './recipes.js';
import { describeSchedule } from './schedule.js';
import { triggerSummary } from './validate.js';

export interface GlanceNames {
  /** “Chat”; undefined when unknown. The runtime says “a private room” for rooms the viewer isn't in. */
  conversationTitle: (id: string) => string | undefined;
  /** A tracker connection's label: “Acme Desk dev”; “a tracker connection” when the viewer can't see it. */
  connectionLabel?: (id: string) => string | undefined;
}

/** The tags' words, by what they say. */
export const AUTOMATION_DOES_LABELS: Record<AutomationDoes, string> = {
  assess: 'Assesses',
  review: 'Reviews',
  answer: 'Answers',
  check: 'Checks the repository',
  instructions: 'Follows your instructions',
  agent: 'Asks the agent',
  post: 'Posts a message',
  approval: 'Asks a person',
  comment: 'Comments on GitHub',
  write_back: 'Writes back to the tracker',
  callback: 'Calls a URL',
  open_pr: 'Opens a pull request',
  fix_ask: 'Fixes after a yes',
  fix_auto: 'Fixes when sure',
  merge: 'Merges when checks pass',
  reply: 'Replies to customers',
};

const TONES: Record<AutomationDoes, AutomationGlanceTag['tone']> = {
  assess: 'plain',
  review: 'plain',
  answer: 'plain',
  check: 'plain',
  instructions: 'plain',
  agent: 'plain',
  post: 'plain',
  approval: 'plain',
  comment: 'plain',
  write_back: 'plain',
  callback: 'changes',
  open_pr: 'changes',
  fix_ask: 'changes',
  fix_auto: 'changes',
  merge: 'merges',
  reply: 'changes',
};

const TONE_ORDER: readonly AutomationGlanceTag['tone'][] = ['plain', 'changes', 'merges'];

const JOB_DOES: Record<RecipeJob, AutomationDoes> = {
  assess: 'assess',
  review: 'review',
  answer: 'answer',
  check: 'check',
  custom: 'instructions',
};

/** What a GitHub event is called on the trigger chip (“New issue · Fusebox”). */
const GITHUB_EVENT_SHORT: Record<RecipeGitHubEvent, string> = {
  issue_opened: 'New issue',
  pr_opened: 'New pull request',
  pr_updated: 'New commits',
  checks_failed: 'Failed checks',
};

const SOURCES: Record<AutomationTrigger['kind'], AutomationSource> = {
  github: 'github',
  tracker: 'tracker',
  mail: 'mail',
  schedule: 'schedule',
  message_posted: 'message',
  reaction_added: 'reaction',
  webhook: 'webhook',
  manual: 'manual',
};

/** The tags, deduplicated and mildest first; in the order given within a tone. `product`: a tracker's name. */
function tags(ids: readonly AutomationDoes[], product?: string): AutomationGlanceTag[] {
  const unique = [...new Set(ids)];
  const label = (id: AutomationDoes) =>
    id === 'write_back' && product ? `Writes back to ${product}` : AUTOMATION_DOES_LABELS[id];
  return TONE_ORDER.flatMap((tone) =>
    unique.filter((id) => TONES[id] === tone).map((id) => ({ id, label: label(id), tone })),
  );
}

/** “New issue or new pull request”. */
function githubEvents(events: readonly RecipeGitHubEvent[]): string {
  const words = events.map((e, i) => (i === 0 ? GITHUB_EVENT_SHORT[e] : GITHUB_EVENT_SHORT[e].toLowerCase()));
  if (words.length <= 1) return words[0] ?? 'Activity';
  return `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

/** At most `max` characters, “…” when cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** “Fusebox” of `acme/Fusebox`. */
function repoName(repo: string): string {
  return repo.slice(repo.indexOf('/') + 1) || repo;
}

/** “Weekdays at 09:00”: the schedule without its time zone (the list is read in the viewer's). */
function scheduleWords(...args: Parameters<typeof describeSchedule>): string {
  const words = describeSchedule(...args);
  const zone = ` · ${args[1]}`;
  return words.endsWith(zone) ? words.slice(0, -zone.length) : words;
}

function recipeGlance(recipe: AutomationRecipe, names: GlanceNames): AutomationGlance {
  const when = recipe.when;
  const does: AutomationDoes[] = [JOB_DOES[recipe.job]];
  if (recipe.replyOnGitHub && when.kind === 'github') does.push('comment');
  if (writesBack(recipe)) does.push('write_back');
  if (repliesToCustomer(recipe)) does.push('reply');
  if (recipe.fix) does.push(recipe.fix.mode === 'auto' ? 'fix_auto' : 'fix_ask');
  if (mergesFix(recipe)) does.push('merge');
  const room = clip(names.conversationTitle(recipe.conversationId) ?? 'a private room', 120);
  const base = {
    agentStep: true,
    room,
    does: tags(does, when.kind === 'tracker' ? when.words?.product : undefined),
  };
  switch (when.kind) {
    case 'github':
      return {
        source: 'github',
        repo: when.repo,
        trigger: `${githubEvents(when.events)} · ${repoName(when.repo)}`,
        ...base,
      };
    case 'tracker': {
      const kind = trackerItemNoun(when.itemKinds);
      const connection = names.connectionLabel?.(when.connectionId) ?? 'a tracker connection';
      return {
        source: 'tracker',
        repo: null,
        trigger: clip(`New ${kind} · ${connection}`, 160),
        ...base,
      };
    }
    case 'message': {
      // The room is the next chip: it listens where it answers.
      const first = when.contains[0];
      const words = first ? `Message with “${first}”${when.contains.length > 1 ? '…' : ''}` : 'Any message';
      return { source: 'message', repo: null, trigger: clip(words, 160), ...base };
    }
    case 'schedule':
      return {
        source: 'schedule',
        repo: null,
        trigger: scheduleWords(when.schedule, when.timeZone),
        ...base,
      };
    case 'manual':
      return { source: 'manual', repo: null, trigger: 'Started by hand', ...base };
    case 'mail':
      return {
        source: 'mail',
        repo: null,
        trigger: clip(mailWhenText(when, names.connectionLabel?.(when.connectionId)), 160),
        ...base,
      };
  }
}

function stepDoes(step: AutomationStep): AutomationDoes | null {
  switch (step.kind) {
    case 'dispatch_agent':
      if (step.assessment) return 'assess';
      if (step.verdict) return 'review';
      return 'agent';
    case 'post_message':
      return 'post';
    case 'request_approval':
      return 'approval';
    case 'github_comment':
      return 'comment';
    case 'tracker_update':
      return 'write_back';
    case 'tracker_reply':
      return 'reply';
    // It asks the person (3.12, TA-44), as an approval does.
    case 'tracker_decision':
      return 'approval';
    case 'http_callback':
      return 'callback';
    case 'open_pull_request':
      return 'open_pr';
    case 'merge_pull_request':
      return 'merge';
    case 'wait':
    case 'condition':
      return null;
  }
}

/**
 * An automation's definition at a glance: from its recipe when it still is one (`recipeOf`), else from its triggers and
 * steps — the first trigger for the tile and the words (“and 1 more” when there are others), whether the agent does a
 * step, the definition's room, and a tag per kind of step that does something.
 */
export function automationGlance(definition: AutomationDefinition, names: GlanceNames): AutomationGlance {
  const recipe = recipeOf(definition);
  if (recipe) return recipeGlance(recipe, names);
  const [first, ...others] = definition.triggers;
  const source: AutomationSource = first ? SOURCES[first.kind] : 'manual';
  const github = definition.triggers.find((t): t is GitHubTrigger => t.kind === 'github');
  const words =
    first?.kind === 'schedule'
      ? scheduleWords(first.schedule, first.timeZone)
      : first?.kind === 'reaction_added'
        ? `Reaction ${first.value} in ${names.conversationTitle(first.conversationId) ?? 'a private room'}`
        : first
          ? triggerSummary([first], names.conversationTitle, names.connectionLabel)
          : 'Started by hand';
  const agentStep = definition.steps.some((s) => s.kind === 'dispatch_agent');
  const room = clip(names.conversationTitle(definition.conversationId) ?? 'a private room', 120);
  // “Message in #bugs” when it answers in #bugs too: the room is the next chip.
  const inRoom = ` in ${room}`;
  const trigger = words.endsWith(inRoom) && words !== inRoom ? words.slice(0, -inRoom.length) : words;
  return {
    source,
    repo: source === 'github' && github ? github.repo : null,
    trigger: clip(others.length ? `${trigger} and ${others.length} more` : trigger, 160),
    agentStep,
    room,
    does: tags(definition.steps.map(stepDoes).filter((d): d is AutomationDoes => d !== null)),
  };
}
