import {
  type Automation,
  AutomationDefinition,
  AutomationGlance,
  AutomationRecipe,
  type AutomationRun,
  AutomationRun as AutomationRunSchema,
  AutomationRunStep,
  Automation as AutomationSchema,
  AutomationStep,
  AutomationTrigger,
  AutomationTriggerInfo,
  RecipeWhen,
  recipeDefinition,
} from '@whombat/core';
import { decodeTolerant } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { answerFor, eventFor, FIND_MY_AUTOMATIONS_MINOR, MAIL_AUTOMATIONS_MINOR } from './older-apps';

/* The contracts an app below minor 3 decodes with: the release before mail triggers had none of these. */
type Member = z.ZodObject<{ kind: z.ZodLiteral<string> }>;
const kindOf = (o: unknown) => (o as Member).shape.kind.value;
const union = (members: unknown[]) =>
  z.discriminatedUnion('kind', members as unknown as [Member, ...Member[]]);
const OlderDefinition = AutomationDefinition.extend({
  triggers: z.array(union(AutomationTrigger.options.filter((o) => kindOf(o) !== 'mail'))).min(1),
  steps: z
    .array(
      union(
        AutomationStep.options
          .filter((o) => kindOf(o) !== 'connection_actions')
          .map((o) =>
            kindOf(o) === 'dispatch_agent' ? (o as Member).omit({ proposeActions: true } as never) : o,
          ),
      ),
    )
    .min(1),
  recipe: AutomationRecipe.extend({
    when: union(RecipeWhen.options.filter((o) => kindOf(o) !== 'mail')),
  }).optional(),
});
const OlderAutomation = AutomationSchema.extend({
  draft: OlderDefinition.nullable(),
  definition: OlderDefinition.nullable(),
  glance: AutomationGlance.extend({
    source: z.enum(['github', 'tracker', 'schedule', 'message', 'reaction', 'webhook', 'manual']),
  }).nullable(),
});
const OlderRun = AutomationRunSchema.extend({
  trigger: AutomationTriggerInfo.extend({
    kind: z.enum(['message_posted', 'reaction_added', 'schedule', 'github', 'webhook', 'manual', 'tracker']),
  }),
  steps: z.array(
    AutomationRunStep.extend({
      kind: z
        .enum([
          'dispatch_agent',
          'post_message',
          'request_approval',
          'wait',
          'condition',
          'open_pull_request',
          'http_callback',
          'github_comment',
          'tracker_update',
          'merge_pull_request',
          'tracker_reply',
          'tracker_decision',
          'unknown',
        ])
        .catch('unknown'),
    }),
  ),
});
const OlderEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('automation.updated'), automation: OlderAutomation }),
  z.object({ type: z.literal('automation.run.updated'), run: OlderRun }),
]);

const at = '2026-11-22T10:00:00.000Z';
const definition = AutomationDefinition.parse(
  recipeDefinition({
    when: { kind: 'mail', connectionId: 'con_mail', from: 'example.com' },
    job: 'custom',
    instructions: 'File the invoice.',
    conversationId: 'cnv_chat',
  }),
);
const automation: Automation = AutomationSchema.parse({
  id: 'aut_1',
  burrowId: 'bur_hq',
  name: 'Handle mail from example.com',
  description: '',
  status: 'published',
  currentVersion: 1,
  draft: definition,
  draftJson: null,
  draftProblems: [],
  draftHash: null,
  definition,
  principalId: 'prn_auto',
  createdById: 'prn_mara',
  createdAt: at,
  updatedAt: at,
  publishedById: 'prn_mara',
  triggerSummary: 'When mail from example.com arrives in your inbox',
  summary: '',
  deletedAt: null,
  grants: [],
  webhook: { enabled: false, hasSecret: false, path: '/webhooks/automations/aut_1' },
  nextRunAt: null,
  lastRun: null,
  recentRuns: [],
  glance: {
    source: 'mail',
    repo: null,
    trigger: 'When mail from example.com arrives in your inbox',
    agentStep: true,
    room: 'Chat',
    does: [],
  },
  waitingPlanId: null,
  talk: null,
});
const step = (stepId: string, index: number, kind: string) => ({
  stepId,
  index,
  kind,
  name: stepId,
  state: 'pending',
  attempt: 0,
  startedAt: null,
  finishedAt: null,
  wakeAt: null,
  inputSummary: '',
  output: {},
  error: null,
  dispatchId: null,
  approvalId: null,
  approvalNumber: null,
  messageIds: [],
  prNumber: null,
  runNumbers: [],
});
const run: AutomationRun = AutomationRunSchema.parse({
  id: 'arn_1',
  number: 1,
  burrowId: 'bur_hq',
  automationId: 'aut_1',
  automationName: 'Handle mail from example.com',
  version: 1,
  status: 'waiting',
  trigger: {
    kind: 'mail',
    summary: 'Mail from billing@example.com: “Invoice”',
    actorId: 'prn_mail',
    eventId: 'evt_1',
    messageId: null,
    scheduledFor: null,
  },
  conversationId: 'cnv_chat',
  threadRootId: null,
  causalDepth: 0,
  startedById: null,
  test: false,
  createdAt: at,
  startedAt: at,
  finishedAt: null,
  error: null,
  tokens: null,
  steps: [step('ask', 0, 'dispatch_agent'), step('act', 1, 'connection_actions')],
});

describe('what an older app gets of mail automations', () => {
  it('can’t read them as they are: a mail run drops out of the history and its live update is refused', () => {
    expect(decodeTolerant(z.object({ runs: z.array(OlderRun) }), { runs: [run] })).toMatchObject({
      ok: true,
      data: { runs: [] },
    });
    expect(decodeTolerant(OlderEvent, { type: 'automation.run.updated', run }).ok).toBe(false);
    expect(decodeTolerant(OlderEvent, { type: 'automation.updated', automation }).ok).toBe(false);
  });

  it('gets a form it reads whole, below minor 3; a newer app gets everything', () => {
    const minor = MAIL_AUTOMATIONS_MINOR - 1;
    const runs = answerFor('automations.runs', { runs: [run] }, minor) as { runs: AutomationRun[] };
    const listed = decodeTolerant(z.object({ runs: z.array(OlderRun) }), runs);
    expect(listed).toMatchObject({ ok: true, skipped: [] });
    expect(runs.runs[0]?.trigger).toMatchObject({ kind: 'message_posted', summary: run.trigger.summary });
    expect(runs.runs[0]?.steps.map((s) => s.kind)).toEqual(['dispatch_agent', 'unknown']);

    const list = answerFor('automations.list', { automations: [automation] }, minor);
    expect(decodeTolerant(z.object({ automations: z.array(OlderAutomation) }), list)).toMatchObject({
      ok: true,
      skipped: [],
    });
    const detail = answerFor('automations.run', { run, automation }, minor) as {
      run: AutomationRun;
      automation: Automation;
    };
    expect(decodeTolerant(z.object({ run: OlderRun, automation: OlderAutomation }), detail)).toMatchObject({
      ok: true,
      skipped: [],
    });
    expect(detail.automation).toMatchObject({ definition: null, draft: null, glance: { source: 'message' } });
    for (const event of [
      { type: 'automation.run.updated' as const, run },
      { type: 'automation.updated' as const, automation },
    ])
      expect(decodeTolerant(OlderEvent, eventFor(event, minor))).toMatchObject({ ok: true, skipped: [] });
    expect(() => answerFor('automations.export', { definition }, minor)).toThrow(/Update the app/);

    // An automation without any of it stays whole for an older app too.
    const plain = { ...automation, glance: null, definition: null, draft: null };
    expect(answerFor('automations.get', { automation: plain }, minor)).toEqual({ automation: plain });

    // A newer app, and a caller outside a session, get everything.
    for (const newer of [MAIL_AUTOMATIONS_MINOR, undefined]) {
      expect(answerFor('automations.runs', { runs: [run] }, newer)).toEqual({ runs: [run] });
      expect(eventFor({ type: 'automation.updated', automation }, newer)).toEqual({
        type: 'automation.updated',
        automation,
      });
    }
  });
});

describe('what an app below minor 4 gets of Find My automations', () => {
  const findmy = AutomationDefinition.parse({
    version: 1,
    conversationId: 'cnv_chat',
    triggers: [
      {
        kind: 'findmy',
        connectionId: 'con_findmy01',
        person: '0123456789ab',
        name: 'Mara Visser',
        change: 'arrives',
        place: 'Home',
      },
    ],
    steps: [{ id: 'tell', kind: 'post_message', text: '{{trigger.text}}' }],
  });
  const arrives: Automation = {
    ...automation,
    definition: findmy,
    draft: findmy,
    glance: automation.glance ? { ...automation.glance, source: 'findmy' } : null,
  };
  const ran: AutomationRun = {
    ...run,
    trigger: { ...run.trigger, kind: 'findmy', summary: 'Mara Visser is now at Home' },
    steps: [step('tell', 0, 'post_message')] as AutomationRun['steps'],
  };
  const MINOR_3 = FIND_MY_AUTOMATIONS_MINOR - 1;

  it('a form it reads: no definition, a message’s source and trigger; mail automations stay whole', () => {
    const got = answerFor('automations.get', { automation: arrives }, MINOR_3) as { automation: Automation };
    expect(got.automation).toMatchObject({ definition: null, draft: null, glance: { source: 'message' } });
    const runs = answerFor('automations.runs', { runs: [ran] }, MINOR_3) as { runs: AutomationRun[] };
    expect(runs.runs[0]?.trigger).toMatchObject({ kind: 'message_posted', summary: ran.trigger.summary });
    expect(() => answerFor('automations.export', { definition: findmy }, MINOR_3)).toThrow(/Update the app/);
    // At minor 3 a mail automation is read as it is.
    const mail = answerFor('automations.get', { automation }, MINOR_3) as { automation: Automation };
    expect(mail.automation).toMatchObject({ glance: { source: 'mail' } });
    expect(mail.automation.definition).not.toBeNull();
    expect(answerFor('automations.runs', { runs: [run] }, MINOR_3)).toEqual({ runs: [run] });
  });

  it('everything from minor 4 on', () => {
    for (const newer of [FIND_MY_AUTOMATIONS_MINOR, undefined]) {
      expect(answerFor('automations.get', { automation: arrives }, newer)).toEqual({ automation: arrives });
      expect(eventFor({ type: 'automation.run.updated', run: ran }, newer)).toEqual({
        type: 'automation.run.updated',
        run: ran,
      });
    }
  });
});
