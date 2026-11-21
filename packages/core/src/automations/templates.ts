/**
 * The two shipped automation templates (docs/decisions/bp-automations.md BP-C14). Pure data: a template is filled
 * in with the burrow's own conversation and repo and becomes an ordinary draft definition, so it is validated, edited,
 * exported and published like any other. Every agent step is the one agent's (Whombat one-agent.md OA-15).
 */
import { z } from 'zod';
import {
  AUTOMATION_DEFINITION_VERSION,
  type AutomationExport,
  type AutomationTemplateId,
  VERDICT_APPROVE,
  VERDICT_CHANGES,
} from '../domain/automation.js';
import { ConversationId } from '../ids.js';

export const SuspectedBugParams = z
  .object({
    /** Where bugs are reported (and where the run talks). */
    conversationId: ConversationId,
    repo: z.string().min(3).max(255),
    keywords: z.array(z.string().trim().min(1).max(40)).max(10).default(['bug', 'broken', 'crash']),
    reaction: z.string().min(1).max(32).default('🐛'),
  })
  .strict();
export type SuspectedBugParams = z.input<typeof SuspectedBugParams>;

export const RepoCheckParams = z
  .object({
    /** Where the report goes (only when there is something to act on). */
    conversationId: ConversationId,
    /** Where the agent is asked (defaults to where the report goes). */
    agentConversationId: ConversationId.optional(),
    repo: z.string().min(3).max(255),
    cron: z.string().min(9).max(120).default('0 9 * * 1-5'),
    timeZone: z.string().min(1).max(64).default('Europe/Amsterdam'),
  })
  .strict();
export type RepoCheckParams = z.input<typeof RepoCheckParams>;

export const TemplateParams = z.discriminatedUnion('template', [
  SuspectedBugParams.extend({ template: z.literal('suspected_bug') }),
  RepoCheckParams.extend({ template: z.literal('repo_check') }),
]);
export type TemplateParams = z.input<typeof TemplateParams>;

export interface TemplateField {
  key: string;
  label: string;
  kind: 'conversation' | 'repo' | 'text' | 'list' | 'timezone' | 'cron' | 'reaction';
  optional?: boolean;
}

export interface AutomationTemplateInfo {
  id: AutomationTemplateId;
  name: string;
  description: string;
  fields: TemplateField[];
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplateInfo[] = [
  {
    id: 'suspected_bug',
    name: 'Suspected bug',
    description:
      'When someone reports a bug (or adds 🐛), the agent reads the code and posts the evidence. After a person approves, it fixes the bug on its own feat/bug-N branch, reviews the fix in a fresh turn and a pull request is opened. Keys: the agent needs “Read and write feat/* branches”; the automation needs “Open pull requests” for the repo (without it, the prepared pull request is posted for a person).',
    fields: [
      { key: 'conversationId', label: 'Where bugs are reported', kind: 'conversation' },
      { key: 'keywords', label: 'Words that start it', kind: 'list' },
      { key: 'reaction', label: 'Reaction that starts it', kind: 'reaction' },
      { key: 'repo', label: 'Repository', kind: 'repo' },
    ],
  },
  {
    id: 'repo_check',
    name: 'Scheduled repository check',
    description:
      'On a schedule, the agent checks a repository. A report is posted only when there is something to act on.',
    fields: [
      { key: 'repo', label: 'Repository', kind: 'repo' },
      { key: 'conversationId', label: 'Where the report goes', kind: 'conversation' },
      {
        key: 'agentConversationId',
        label: 'Where the agent is asked',
        kind: 'conversation',
        optional: true,
      },
      { key: 'cron', label: 'Schedule', kind: 'cron' },
      { key: 'timeZone', label: 'Time zone', kind: 'timezone' },
    ],
  },
];

/** The marker the repository check's agent starts its reply with when there is something to act on. */
export const REPO_CHECK_ACTIONABLE = 'ACTIONABLE:';
export const REPO_CHECK_NOTHING = 'NOTHING TO REPORT';

/** Fills in a template: an ordinary automation file (name, description, definition). */
export function buildTemplate(params: TemplateParams): AutomationExport {
  const input = TemplateParams.parse(params);
  if (input.template === 'suspected_bug') {
    const p = input;
    // `feat/*`: the branches the agent's “Read and write feat/* branches” key covers (bp-automations BP-C26).
    const branch = 'feat/bug-{{run.number}}';
    return {
      whombat: 'automation',
      name: 'Suspected bug',
      description: AUTOMATION_TEMPLATES[0]?.description ?? '',
      definition: {
        version: AUTOMATION_DEFINITION_VERSION,
        conversationId: p.conversationId,
        triggers: [
          {
            kind: 'message_posted',
            conversationId: p.conversationId,
            contains: p.keywords,
            includeAgents: false,
            // A report in a thread counts too; the automation's own posts never trigger it (BP-C08).
            includeReplies: true,
          },
          { kind: 'reaction_added', conversationId: p.conversationId, value: p.reaction },
        ],
        steps: [
          {
            id: 'investigate',
            name: 'Investigate',
            kind: 'dispatch_agent',
            conversation: 'run',
            thread: 'run',
            retries: 0,
            workspace: { repo: p.repo, access: 'read' },
            prompt: `This may be a bug in ${p.repo}. Your working directory is a read-only checkout of it: read the code there. Find out what happens and where, and how sure you are. Reply in this thread with the evidence: the steps to reproduce, the code involved (files and lines) and what you think the fix is. Use only this thread and the code. This automation carries on after a person says yes.\n\nThe report: “{{trigger.text}}”`,
          },
          {
            id: 'evidence',
            name: 'Post the evidence',
            kind: 'post_message',
            conversation: 'run',
            thread: 'run',
            attachFrom: ['investigate'],
            retries: 0,
            text: 'Here’s what the investigation found:\n\n{{steps.investigate.text}}',
          },
          {
            id: 'approve',
            name: 'Approve the fix',
            kind: 'request_approval',
            title: `Fix the suspected bug in ${p.repo}`,
            details: `The agent fixes it on ${branch} in its own workspace, reviews the fix in a fresh turn, and a pull request is opened. Nothing is merged: that stays with a person.`,
            approverIds: [],
            onDecline: 'stop',
            retries: 0,
          },
          {
            id: 'implement',
            name: 'Implement the fix',
            kind: 'dispatch_agent',
            conversation: 'run',
            thread: 'run',
            retries: 0,
            workspace: { repo: p.repo, branch, access: 'write' },
            prompt: `A person approved fixing this bug in ${p.repo}. Your working directory is a checkout of ${p.repo} on ${branch}. Write a test that reproduces the bug, fix it and commit both there; the runner pushes your commits. Reply here with what you changed and how you tested it. If you can’t fix it, say why and commit nothing. This automation asks for the review.\n\nThe evidence:\n{{steps.investigate.text}}`,
          },
          {
            id: 'review',
            name: 'Review the fix',
            kind: 'dispatch_agent',
            conversation: 'run',
            thread: 'run',
            retries: 0,
            workspace: { repo: p.repo, branch, access: 'read' },
            verdict: true,
            prompt: `Review the fix on ${branch} in ${p.repo} with fresh eyes: you didn’t write it in this turn. Your working directory is a read-only checkout of the branch, and the change against its base is below. Check that it fixes the bug and has a test. Start your reply with “${VERDICT_APPROVE}” when it is ready for a pull request, or with “${VERDICT_CHANGES}” and what has to change.\n\nWhat the fix turn said:\n{{steps.implement.text}}`,
          },
          {
            id: 'approved',
            name: 'Did the review approve it?',
            kind: 'condition',
            if: 'steps.review.verdict == "approve"',
            else: 'stop',
            retries: 0,
          },
          {
            id: 'pr',
            name: 'Open the pull request',
            kind: 'open_pull_request',
            repo: p.repo,
            branch,
            title: `Fix the bug reported in automation run #{{run.number}}`,
            body: 'The report: “{{trigger.text}}”\n\nWhat changed:\n{{steps.implement.text}}\n\nReview:\n{{steps.review.text}}',
            otherwise: 'post_payload',
            retries: 0,
          },
          {
            id: 'report',
            name: 'Report back',
            kind: 'post_message',
            conversation: 'run',
            thread: 'run',
            attachFrom: [],
            retries: 0,
            text: 'Done: {{steps.pr.text}}',
          },
        ],
        limits: { runTimeoutMinutes: 7 * 24 * 60, maxConcurrentRuns: 2, maxRunsPerDay: 20 },
      },
    };
  }
  const p = input;
  return {
    whombat: 'automation',
    name: `Check ${p.repo}`,
    description: AUTOMATION_TEMPLATES[1]?.description ?? '',
    definition: {
      version: AUTOMATION_DEFINITION_VERSION,
      conversationId: p.agentConversationId ?? p.conversationId,
      triggers: [
        {
          kind: 'schedule',
          schedule: { kind: 'cron', expr: p.cron },
          timeZone: p.timeZone,
          dst: { skipped: 'shift', repeated: 'once' },
          overlap: 'skip',
          missed: 'run_once',
          maxCatchUp: 1,
        },
      ],
      steps: [
        {
          id: 'check',
          name: 'Check the repository',
          kind: 'dispatch_agent',
          conversation: 'run',
          thread: 'top',
          retries: 0,
          prompt: `Check ${p.repo} for anything someone should act on: failing checks on the default branch, pull requests waiting on someone, new commits that look risky. When the repository is checked out in your working directory, read it there (its recent commits and files); add what Whombat knows about its pull requests. Reply in this thread. Start your reply with “${REPO_CHECK_ACTIONABLE}” and a short list when there is something to act on, or with “${REPO_CHECK_NOTHING}” when there isn’t.`,
        },
        {
          id: 'actionable',
          name: 'Anything to act on?',
          kind: 'condition',
          if: `contains(steps.check.text, "${REPO_CHECK_ACTIONABLE}")`,
          else: 'stop',
          retries: 0,
        },
        {
          id: 'report',
          name: 'Post the report',
          kind: 'post_message',
          conversation: p.conversationId,
          thread: 'top',
          attachFrom: ['check'],
          retries: 0,
          text: `Repository check for ${p.repo}:\n\n{{steps.check.text}}`,
        },
      ],
      limits: { runTimeoutMinutes: 180, maxConcurrentRuns: 1, maxRunsPerDay: 24 },
    },
  };
}
