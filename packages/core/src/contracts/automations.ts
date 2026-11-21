/**
 * Supervised automations: versioned definitions, triggers, runs and steps (Workstream C,
 * docs/decisions/bp-automations.md). Owned by the automations workstream: other workstreams import from
 * here and request changes instead of editing it.
 */
import { z } from 'zod';
import {
  Automation,
  AutomationExport,
  AutomationGrant,
  AutomationId,
  AutomationRecipe,
  AutomationRun,
  AutomationRunStatus,
  AutomationStepId,
  AutomationTemplateId,
} from '../domain/automation.js';
import { JsonObject, Timestamp } from '../domain/common.js';
import { TrackerItemId, TrackerItemKind } from '../domain/tracker.js';
import { AutomationPlanId, ConnectionId, ConversationId, PrincipalId } from '../ids.js';
import { BurrowParam, endpoint, limitQuery, NumberParam } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });
const A = B.extend({ id: AutomationId });
const R = B.extend({ number: NumberParam });
const P = B.extend({ planId: AutomationPlanId });

export const AutomationVersionSummary = z.object({
  n: z.number().int().positive(),
  definitionHash: z.string(),
  publishedById: PrincipalId,
  publishedAt: Timestamp,
});
export type AutomationVersionSummary = z.infer<typeof AutomationVersionSummary>;

export const AutomationTemplateField = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['conversation', 'repo', 'text', 'list', 'timezone', 'cron', 'reaction']),
  optional: z.boolean().optional(),
});

export const AutomationTemplateSummary = z.object({
  id: AutomationTemplateId,
  name: z.string(),
  description: z.string(),
  fields: z.array(AutomationTemplateField),
});
export type AutomationTemplateSummary = z.infer<typeof AutomationTemplateSummary>;

/** How a new automation starts: empty, from a template, from an exported file, or described to an agent. */
export const NewAutomationSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('blank'), conversationId: ConversationId }),
  z.object({
    kind: z.literal('template'),
    template: AutomationTemplateId,
    /** The template's fields (automations/templates.ts); validated by the template. */
    params: JsonObject,
  }),
  z.object({ kind: z.literal('import'), file: JsonObject }),
  /**
   * The simple form's answers (0.66, CT-322, feature `automations.recipes`): `recipeDefinition` makes the definition,
   * `recipeName` the name. With `replyOnGitHub` the automation also gets “Comment on pull requests” (Can) for the repo.
   */
  z.object({ kind: z.literal('recipe'), recipe: AutomationRecipe }),
  z.object({
    kind: z.literal('describe'),
    /** What it should do, in the person's words. */
    text: z.string().trim().min(1).max(2000),
    /** Where the agent is asked to draft it (with `draft_automation`). */
    conversationId: ConversationId,
  }),
]);
export type NewAutomationSource = z.infer<typeof NewAutomationSource>;

export const AutomationDetail = z.object({
  automation: Automation,
  versions: z.array(AutomationVersionSummary),
  /** The full URL a webhook sender posts to (PUBLIC_URL + path), when a public URL is configured. */
  webhookUrl: z.string().nullable(),
});
export type AutomationDetail = z.infer<typeof AutomationDetail>;

/** A recent issue or pull request of an automation's repo, to try the automation on (0.66, `automations.samples`). */
export const AutomationGitHubSample = z.object({
  kind: z.enum(['issue', 'pull_request']),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string().nullable(),
  url: z.string(),
  draft: z.boolean(),
  openedAt: Timestamp,
});
export type AutomationGitHubSample = z.infer<typeof AutomationGitHubSample>;

/**
 * A recent open report of an automation's tracker connection, to try it on (0.69, CT-325, TA-19): `new`,
 * `investigating`, `needs_information`, `in_progress` or `planned`, at most 10, newest first. Never the reporter.
 */
export const AutomationReportSample = z.object({
  kind: z.literal('report'),
  connectionId: ConnectionId,
  reportId: TrackerItemId,
  number: z.number().int().positive(),
  title: z.string(),
  type: TrackerItemKind,
  organization: z.string().nullable(),
  openedAt: Timestamp,
});
export type AutomationReportSample = z.infer<typeof AutomationReportSample>;

/** What “Try it on …” offers (`automations.samples`): an issue or pull request, or (0.69) a tracker report. */
export const AutomationSample = z.discriminatedUnion('kind', [
  AutomationGitHubSample,
  AutomationReportSample,
]);
export type AutomationSample = z.infer<typeof AutomationSample>;

export const AutomationRunDetail = z.object({
  run: AutomationRun,
  automation: Automation,
});
export type AutomationRunDetail = z.infer<typeof AutomationRunDetail>;

export const automationEndpoints = {
  list: endpoint({
    id: 'automations.list',
    method: 'GET',
    path: '/burrows/:burrow/automations',
    summary: 'Automations in the burrow, with their live trigger and last run.',
    params: B,
    response: z.object({ automations: z.array(Automation) }),
  }),
  templates: endpoint({
    id: 'automations.templates',
    method: 'GET',
    path: '/burrows/:burrow/automation-templates',
    summary: 'The shipped templates and the fields they ask for.',
    params: B,
    response: z.object({ templates: z.array(AutomationTemplateSummary) }),
  }),
  create: endpoint({
    id: 'automations.create',
    method: 'POST',
    path: '/burrows/:burrow/automations',
    summary: 'A new automation, as a draft: blank, from a template, imported, or described to the agent.',
    params: B,
    body: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().max(500).optional(),
      source: NewAutomationSource,
      /**
       * Publish it and switch it on at once (0.66): the person saw what it does (the recipe's sentence, the template's
       * fields). People who may publish only; an invalid draft is refused instead of saved. Not for `describe`.
       */
      publish: z.boolean().default(false),
    }),
    response: AutomationDetail,
    status: 201,
  }),
  delete: endpoint({
    id: 'automations.delete',
    method: 'DELETE',
    path: '/burrows/:burrow/automations/:id',
    summary:
      'Delete the automation (0.66, feature `automations.delete`): it stops at once — runs in progress are cancelled, its webhook and keys go — and it leaves every list. Its past runs and what it signed stay. People who may publish, or whoever started a draft that was never published.',
    params: A,
    response: z.object({ id: AutomationId, cancelledRuns: z.number().int().nonnegative() }),
  }),
  samples: endpoint({
    id: 'automations.samples',
    method: 'GET',
    path: '/burrows/:burrow/automations/:id/samples',
    summary:
      'Recent open issues and pull requests of the repo its GitHub triggers watch (the draft’s, else the live version’s), newest first, of the kinds they fire on: what “Try it on …” offers (0.66). Since 0.69 (CT-325) also the open reports of the connection its tracker triggers watch (`kind: report`).',
    params: A,
    response: z.object({ samples: z.array(AutomationSample) }),
  }),
  get: endpoint({
    id: 'automations.get',
    method: 'GET',
    path: '/burrows/:burrow/automations/:id',
    summary: 'An automation with its draft, live definition and versions.',
    params: A,
    response: AutomationDetail,
  }),
  saveDraft: endpoint({
    id: 'automations.saveDraft',
    method: 'PUT',
    path: '/burrows/:burrow/automations/:id/draft',
    summary:
      'Save the draft (form or JSON). Invalid drafts are kept with their problems; only valid ones publish.',
    params: A,
    body: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().max(500).optional(),
      definition: JsonObject,
    }),
    response: AutomationDetail,
  }),
  discardDraft: endpoint({
    id: 'automations.discardDraft',
    method: 'DELETE',
    path: '/burrows/:burrow/automations/:id/draft',
    summary: 'Throw the draft away (the live version stays).',
    params: A,
    response: AutomationDetail,
  }),
  publish: endpoint({
    id: 'automations.publish',
    method: 'POST',
    path: '/burrows/:burrow/automations/:id/publish',
    summary:
      'Publish the draft as a new immutable version and switch it on. People who may change the agent only. `definitionHash` is the hash of the draft the person reviewed (`automation.draftHash`); a draft changed since is refused.',
    params: A,
    body: z.object({
      enable: z.boolean().default(true),
      definitionHash: z.string().regex(/^[0-9a-f]{64}$/, { message: 'Expected the draft’s hash' }),
    }),
    response: AutomationDetail,
  }),
  setEnabled: endpoint({
    id: 'automations.setEnabled',
    method: 'POST',
    path: '/burrows/:burrow/automations/:id/enabled',
    summary: 'Switch a published automation on or off.',
    params: A,
    body: z.object({ enabled: z.boolean() }),
    response: AutomationDetail,
  }),
  setKeys: endpoint({
    id: 'automations.setKeys',
    method: 'PUT',
    path: '/burrows/:burrow/automations/:id/keys',
    summary: 'The keys the automation holds (its steps can never do more than its publisher may).',
    params: A,
    body: z.object({ grants: z.array(AutomationGrant).max(10) }),
    response: AutomationDetail,
  }),
  webhook: endpoint({
    id: 'automations.webhook',
    method: 'POST',
    path: '/burrows/:burrow/automations/:id/webhook',
    summary: 'Turn the inbound webhook on or off, or make a new secret (shown once).',
    params: A,
    body: z.object({ enabled: z.boolean(), rotateSecret: z.boolean().default(false) }),
    response: AutomationDetail.extend({ secret: z.string().nullable() }),
  }),
  export: endpoint({
    id: 'automations.export',
    method: 'GET',
    path: '/burrows/:burrow/automations/:id/export',
    summary: 'The live version (or the draft) as a file anyone can import.',
    params: A,
    query: z.object({ draft: z.enum(['true', 'false']).optional() }),
    response: AutomationExport,
  }),
  runNow: endpoint({
    id: 'automations.runNow',
    method: 'POST',
    path: '/burrows/:burrow/automations/:id/runs',
    summary:
      'Start a run by hand. Run now needs a “started by hand” trigger; a test run (`test`) runs the draft (or the live version) with the caller’s own authority. Either way the caller must be in every room the automation uses.',
    params: A,
    body: z.object({
      test: z.boolean().default(false),
      /** Stands in for the trigger's text (`{{trigger.text}}`). */
      text: z.string().max(2000).optional(),
      /**
       * A test run as if this issue or pull request of the GitHub trigger's repo had just arrived (0.66): `trigger.*`
       * is filled in from GitHub as a real event would (`automations.samples` lists them). Since 0.69 (CT-325) also a
       * report of the tracker trigger's connection (`reportId`), read live; it writes back like a real run. Test runs
       * only.
       */
      sample: z
        .union([z.object({ number: z.number().int().positive() }), z.object({ reportId: TrackerItemId })])
        .optional(),
    }),
    response: AutomationRunDetail,
    status: 201,
  }),
  runs: endpoint({
    id: 'automations.runs',
    method: 'GET',
    path: '/burrows/:burrow/automation-runs',
    summary: 'Runs the viewer can see, newest first.',
    params: B,
    query: z.object({
      automation: AutomationId.optional(),
      status: AutomationRunStatus.optional(),
      limit: limitQuery(30),
    }),
    response: z.object({ runs: z.array(AutomationRun) }),
  }),
  run: endpoint({
    id: 'automations.run',
    method: 'GET',
    path: '/burrows/:burrow/automation-runs/:number',
    summary: 'A run: its steps with their states, inputs and outputs.',
    params: R,
    response: AutomationRunDetail,
  }),
  pauseRun: endpoint({
    id: 'automations.pauseRun',
    method: 'POST',
    path: '/burrows/:burrow/automation-runs/:number/pause',
    summary: 'Hold the run after the step in progress.',
    params: R,
    response: AutomationRunDetail,
  }),
  resumeRun: endpoint({
    id: 'automations.resumeRun',
    method: 'POST',
    path: '/burrows/:burrow/automation-runs/:number/resume',
    summary: 'Carry on with a paused run.',
    params: R,
    response: AutomationRunDetail,
  }),
  cancelRun: endpoint({
    id: 'automations.cancelRun',
    method: 'POST',
    path: '/burrows/:burrow/automation-runs/:number/cancel',
    summary: 'Stop the run; the agent’s turn for it stops too.',
    params: R,
    response: AutomationRunDetail,
  }),
  acceptPlan: endpoint({
    id: 'automations.acceptPlan',
    method: 'POST',
    path: '/burrows/:burrow/automation-plans/:planId/accept',
    summary:
      'Turn on the plan the agent proposed (3.9, Whombat automation-chat.md): exactly its definition becomes the automation’s next version, switched on, with the keys the card lists. The person only. Refused when the plan is no longer the one waiting (replaced, decided) or the automation changed since it was made.',
    params: P,
    response: AutomationDetail,
  }),
  declinePlan: endpoint({
    id: 'automations.declinePlan',
    method: 'POST',
    path: '/burrows/:burrow/automation-plans/:planId/decline',
    summary:
      'Not now (3.9): the plan is set aside and nothing changes; an automation that was never turned on goes with it. The agent isn’t asked anything. The person only.',
    params: P,
    response: z.object({ planId: AutomationPlanId, automationId: AutomationId, deleted: z.boolean() }),
  }),
  reviewStep: endpoint({
    id: 'automations.reviewStep',
    method: 'POST',
    path: '/burrows/:burrow/automation-runs/:number/steps/:stepId/review',
    summary: 'A person settles a step whose outcome is uncertain: it happened, it didn’t, or try it again.',
    params: R.extend({ stepId: AutomationStepId }),
    body: z.object({ resolution: z.enum(['done', 'failed', 'retry']) }),
    response: AutomationRunDetail,
  }),
};
