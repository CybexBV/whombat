/** Acme Desk feature requests put to the person (3.12, CT-1636…CT-1638; Whombat report-trackers.md TA-41…TA-48). */
import { describe, expect, it } from 'vitest';
import {
  AutomationDefinition,
  type AutomationRecipeInput,
  ReportAssessmentInput,
} from '../domain/automation.js';
import {
  FeatureRequestCard,
  featureDecisionStatus,
  featureRequestFrom,
  featureRequestOutcome,
  featureValueText,
  TrackerDecideBody,
} from '../domain/feature-request.js';
import { evaluateCondition } from './expr.js';
import { automationFlow, planSections } from './plan.js';
import {
  buildsFeatures,
  decidesFeatures,
  recipeConditionStory,
  recipeDefinition,
  recipeInstructions,
  recipeIsCurrent,
  recipeOf,
  recipeProblem,
  recipeSentence,
  refreshRecipe,
  unassessed,
} from './recipes.js';
import { stepReads } from './rooms.js';
import { validateDefinition } from './validate.js';

const CON = 'con_trackerdev';
const ROOM = 'cnv_reports';
const names = { agent: 'Dusty', room: 'Chat', connection: 'Acme Desk dev' };
const when = {
  kind: 'tracker' as const,
  connectionId: CON,
  itemKinds: ['bug', 'feature'] as ('bug' | 'feature')[],
  words: {
    product: 'Acme Desk',
    team: 'Acme Desk team',
    source: 'A signed-in Acme Desk customer sent the report below through Acme Desk’s own Feedback',
    access: 'its devices, deployments and audit',
  },
};
const FIX = { mode: 'auto' as const, minImportance: 'medium' as const, maxPerDay: 5 };

const tracker = (over: Partial<AutomationRecipeInput> = {}): AutomationRecipeInput => ({
  when,
  job: 'assess',
  instructions: recipeInstructions('assess', when),
  conversationId: ROOM,
  repo: 'lumio/tracker',
  replyToCustomer: true,
  decideFeatures: true,
  ...over,
});
const def = (r: AutomationRecipeInput) => AutomationDefinition.parse(recipeDefinition(r));
const step = (d: AutomationDefinition, id: string) => d.steps.find((s) => s.id === id);
const cond = (d: AutomationDefinition, id: string) => {
  const s = step(d, id);
  if (s?.kind !== 'condition') throw new Error(`${id} isn’t a condition`);
  return s.if;
};

/** A run's scope after the assessment and the decision. */
const scope = (assessment: Record<string, unknown>, decide: Record<string, unknown>) => ({
  trigger: { kind: 'tracker', item: 'report' },
  steps: { ask: { assessment: { ...unassessed(), ...assessment } }, decide },
  run: { test: false, today: { fix: 0 } },
});

describe('a recipe that decides feature requests (TA-41, TA-44)', () => {
  it('puts the card after the reply, words the person’s own text and tells the customer', () => {
    const v = validateDefinition(recipeDefinition(tracker()));
    expect(v.problems).toEqual([]);
    const d = v.definition as AutomationDefinition;
    expect(d.steps.map((s) => s.id)).toEqual([
      'ask',
      'write_back',
      'reply',
      'decide',
      'needs_words',
      'words',
      'tell',
    ]);
    expect(step(d, 'decide')).toMatchObject({
      kind: 'tracker_decision',
      connectionId: CON,
      from: 'ask',
      build: false,
    });
    expect(step(d, 'needs_words')).toMatchObject({ else: { skipTo: 'tell' } });
    expect(step(d, 'words')).toMatchObject({ kind: 'dispatch_agent', assessment: true });
    expect(step(d, 'tell')).toMatchObject({ kind: 'tracker_reply', from: 'words', decision: 'decide' });
    // It may wait a month for the person.
    expect(d.limits.runTimeoutMinutes).toBe(30 * 24 * 60);
    expect(recipeOf(d)).toEqual(d.recipe);
    expect(recipeIsCurrent(d)).toBe(true);
    expect(stepReads(step(d, 'tell') as never).steps).toEqual(expect.arrayContaining(['words', 'decide']));
  });

  it('asks the agent for a value and both drafts, within a step’s prompt', () => {
    const d = def(tracker({ t3: 't3code', fix: { ...FIX, merge: 'checks' } }));
    const ask = step(d, 'ask');
    if (ask?.kind !== 'dispatch_agent') throw new Error('no ask');
    for (const field of ['value', 'valueWhy', 'approvedReply', 'declineReason', 'declinedReply', 'replyAsks'])
      expect(ask.prompt).toContain(field);
    // The whole prompt fits (a step's prompt is cut at 4 000 characters): its last line is still there.
    expect(ask.prompt).toContain('The customer reads only the reply in your report_assessment');
    // The rubric is in the tool's field description.
    expect(ReportAssessmentInput.shape.value.description).toContain('1 to 10');
    const words = step(d, 'words');
    if (words?.kind !== 'dispatch_agent') throw new Error('no words');
    expect(words.prompt).toContain('{{steps.decide.instruction}}');
    expect(words.prompt).toContain('{{steps.ask.assessment.summary}}');
  });

  it('builds only what the person approved to build, with no second card (TA-45)', () => {
    const d = def(tracker({ fix: FIX }));
    expect(buildsFeatures(recipeOf(d) as never)).toBe(true);
    expect(step(d, 'decide')).toMatchObject({ build: true });
    const worth = cond(d, 'worth_fixing');
    const yes = cond(d, 'needs_yes');
    const feature = { kind: 'feature', importance: 'high', confidence: 'high', recommends: 'change' };
    // Approved and built: past both gates to the fix, without the approval card.
    expect(evaluateCondition(worth, scope(feature, { decided: true, build: true }))).toBe(true);
    expect(evaluateCondition(yes, scope(feature, { decided: true, build: true }))).toBe(false);
    // Approved only, declined, asked or not decided: nothing is built, and no “Make this change?” card.
    for (const decide of [{ decided: true, build: false }, { decided: false }])
      expect(evaluateCondition(worth, scope(feature, decide))).toBe(false);
    // A bug keeps its own path.
    const bug = { kind: 'bug', importance: 'high', confidence: 'high', recommends: 'change' };
    expect(evaluateCondition(worth, scope(bug, { decided: false }))).toBe(true);
    expect(evaluateCondition(yes, scope(bug, { decided: false }))).toBe(false);
    // With “Ask me before fixing” the gate before the card still lets an approved build through.
    const asking = def(tracker({ fix: { ...FIX, mode: 'ask' } }));
    expect(evaluateCondition(cond(asking, 'needs_yes'), scope(feature, { decided: true, build: true }))).toBe(
      false,
    );
    expect(evaluateCondition(cond(asking, 'needs_yes'), scope(bug, { decided: false }))).toBe(true);
    // Without fixing there is nothing to build with.
    expect(step(def(tracker()), 'decide')).toMatchObject({ build: false });
  });

  it('says what its checks decided in plain words', () => {
    const recipe = recipeOf(def(tracker({ fix: FIX }))) as never;
    const feature = { kind: 'feature', importance: 'high' };
    const s = (id: string, holds: boolean, decide: Record<string, unknown>) =>
      recipeConditionStory(recipe, id, holds, scope(feature, decide), { agent: 'Dusty' });
    expect(s('worth_fixing', true, { decided: true, build: true })).toBe('Yes: you approved building it.');
    expect(s('worth_fixing', false, { decided: true, build: false })).toContain('feature request');
    expect(s('needs_yes', false, { decided: true, build: true })).toBe('No: you approved building it.');
    expect(s('needs_words', true, { decided: true, needsWords: true })).toContain('Dusty');
    expect(s('needs_words', false, { decided: false })).toContain('no decision');
  });

  it('is part of what the automation says it does', () => {
    const d = def(tracker({ fix: FIX }));
    expect(recipeSentence(recipeOf(d) as never, names)).toContain(
      'replies to the customer and asks you about feature requests',
    );
    const asks = planSections(d, [], {
      ...names,
      conversationTitle: () => 'Chat',
      connectionLabel: () => 'Acme Desk dev',
    })
      .find((x) => x.id === 'asks')
      ?.lines.map((l) => l.text);
    expect(asks).toContain('About each feature request, with its value from 1 to 10');
    const flow = automationFlow(d, [], {
      ...names,
      conversationTitle: () => 'Chat',
      connectionLabel: () => 'Acme Desk dev',
    });
    expect(flow.some((i) => i.kind === 'step' && i.id === 'decide' && i.icon === 'ask')).toBe(true);
  });

  it('needs replies and feature requests, and an update turns it on (TA-41)', () => {
    expect(recipeProblem(tracker({ replyToCustomer: false }))).toContain('replyToCustomer');
    expect(recipeProblem(tracker({ when: { ...when, itemKinds: ['bug'] } }))).toContain('feature requests');
    expect(
      recipeProblem({
        when: { kind: 'manual' },
        job: 'custom',
        instructions: 'Do it.',
        conversationId: ROOM,
        decideFeatures: true,
      }),
    ).toContain('tracker');
    // An automation from before 3.12 keeps its recipe until it is updated, which turns it on.
    const old = def(tracker({ decideFeatures: undefined }));
    expect(old.steps.map((s) => s.id)).toEqual(['ask', 'write_back', 'reply']);
    expect(recipeOf(old)).toEqual(old.recipe);
    expect(recipeIsCurrent(old)).toBe(false);
    const updated = refreshRecipe(recipeOf(old) as never);
    expect(decidesFeatures(updated)).toBe(true);
    // Said off, or only bug reports: it stays off.
    expect(decidesFeatures(refreshRecipe(recipeOf(def(tracker({ decideFeatures: false }))) as never))).toBe(
      false,
    );
    const bugsOnly = def(tracker({ decideFeatures: undefined, when: { ...when, itemKinds: ['bug'] } }));
    expect(decidesFeatures(refreshRecipe(recipeOf(bugsOnly) as never))).toBe(false);
  });

  it('refuses a reply that tells something that isn’t a decision', () => {
    const d = recipeDefinition(tracker());
    const steps = d.steps.map((s) => (s.id === 'tell' ? { ...s, decision: 'reply' } : s));
    expect(validateDefinition({ ...d, steps }).problems.join(' ')).toContain('feature request');
  });
});

describe('the card and its answers (TA-45)', () => {
  it('says what was decided, by whom', () => {
    const base = { note: null, declineReason: 'It only helps one customer.' };
    expect(featureRequestOutcome({ ...base, state: 'waiting', choice: null }, null)).toBeNull();
    expect(featureRequestOutcome({ ...base, state: 'decided', choice: 'approve' }, 'John')).toMatchObject({
      lead: 'Approved by John',
      detail: 'Planned',
    });
    expect(featureRequestOutcome({ ...base, state: 'decided', choice: 'build' }, 'John')?.detail).toBe(
      'Being built',
    );
    expect(featureRequestOutcome({ ...base, state: 'decided', choice: 'decline' }, 'John')?.detail).toBe(
      '“It only helps one customer.”',
    );
    expect(
      featureRequestOutcome({ ...base, state: 'decided', choice: 'ask', note: 'Which format?' }, 'John'),
    ).toMatchObject({ lead: 'John asked the customer', detail: '“Which format?”' });
    expect(featureRequestOutcome({ ...base, state: 'replaced', choice: null }, null)?.lead).toContain(
      'newer',
    );
    // Ended undecided: why, when the server says (a report closed in Acme Desk).
    expect(featureRequestOutcome({ ...base, state: 'stopped', choice: null }, null)?.detail).toBeNull();
    expect(
      featureRequestOutcome(
        { ...base, state: 'stopped', choice: null, note: 'The report was closed.' },
        null,
      ),
    ).toMatchObject({ lead: 'No longer waiting', detail: 'The report was closed.' });
    expect(featureValueText(7)).toBe('7 of 10');
    expect(
      featureRequestFrom({ organization: 'HollowMere College', connection: 'Acme Desk dev', number: 21 }),
    ).toBe('From HollowMere College · Acme Desk dev #21');
  });

  it('sets the status that goes with each answer, and a question needs words', () => {
    expect(['approve', 'build', 'decline', 'ask'].map((c) => featureDecisionStatus(c as never))).toEqual([
      'planned',
      'in_progress',
      'not_planned',
      'needs_information',
    ]);
    expect(TrackerDecideBody.safeParse({ choice: 'ask' }).success).toBe(false);
    expect(TrackerDecideBody.safeParse({ choice: 'ask', note: 'Which format?' }).success).toBe(true);
    expect(TrackerDecideBody.safeParse({ choice: 'decline' }).success).toBe(true);
    expect(FeatureRequestCard.parse({ kind: 'feature_request', requestId: 'tfr_abc' }).request).toBeNull();
  });

  it('keeps the value and drafts on an assessment, absent on an older one', () => {
    expect(unassessed()).toMatchObject({
      value: null,
      approvedReply: '',
      declinedReply: '',
      declineReason: '',
    });
    const reported = ReportAssessmentInput.parse({
      kind: 'feature',
      importance: 'medium',
      confidence: 'high',
      size: 'small',
      summary: 'Export devices to CSV.',
      recommends: 'change',
      value: 7,
      valueWhy: 'Several schools asked.',
      approvedReply: 'We will build it.',
      declinedReply: 'We won’t build it.',
      declineReason: 'Few customers need it.',
    });
    expect(reported.value).toBe(7);
    expect(ReportAssessmentInput.safeParse({ ...reported, value: 11 }).success).toBe(false);
  });
});
