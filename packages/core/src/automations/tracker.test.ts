/** Acme Desk reports through automations (0.69, CT-325; Whombat report-trackers.md TA-04…TA-19). */
import { describe, expect, it } from 'vitest';
import {
  AutomationDefinition,
  type AutomationDefinitionInput,
  type AutomationRecipeInput,
  EXTERNAL_STEP_KINDS,
  REPEATABLE_EXTERNAL_STEP_KINDS,
  STEP_KIND_LABELS,
  TRIGGER_KIND_LABELS,
} from '../domain/automation.js';
import { T3_HANDOFFS_HEADING } from '../domain/handoff.js';
import { evaluateCondition } from './expr.js';
import { type TriggerFacts, triggerMatches } from './match.js';
import {
  assessmentPrTitle,
  buildRecipe,
  describeAutomation,
  EARLIER_RECIPE_WORDS,
  RECIPE_TRACKER_FIX_BRANCH,
  recipeConditionStory,
  recipeDefinition,
  recipeHasEarlierWords,
  recipeInstructions,
  recipeIsCurrent,
  recipeJobsFor,
  recipeName,
  recipeOf,
  recipeProblem,
  recipeSentence,
  recipeWithTodaysWords,
  SHOTS_BRANCH_PREFIX,
  unassessed,
} from './recipes.js';
import { stepContentRooms } from './rooms.js';
import { triggerSummary, validateDefinition } from './validate.js';

const CON = 'con_trackerdev';
const ROOM = 'cnv_reports';
const names = { agent: 'Dusty', room: '#tracker-reports', connection: 'Acme Desk dev' };

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

const tracker = (over: Partial<AutomationRecipeInput> = {}): AutomationRecipeInput => ({
  when,
  job: 'assess',
  instructions: recipeInstructions('assess', when),
  conversationId: ROOM,
  ...over,
});

const def = (r: AutomationRecipeInput) => AutomationDefinition.parse(recipeDefinition(r));

describe('a Acme Desk recipe (TA-17)', () => {
  it('assesses a new report, looks inside the organization and writes the assessment back', () => {
    const v = validateDefinition(recipeDefinition(tracker({ repo: 'lumio/tracker' })));
    expect(v.problems).toEqual([]);
    const d = v.definition as AutomationDefinition;
    expect(d.triggers).toEqual([
      { kind: 'tracker', connectionId: CON, event: 'item_opened', itemKinds: ['bug', 'feature'] },
    ]);
    expect(d.steps.map((s) => s.id)).toEqual(['ask', 'write_back']);
    const ask = d.steps[0];
    if (ask?.kind !== 'dispatch_agent') throw new Error('ask');
    expect(ask).toMatchObject({ assessment: true });
    // The code it reads: the repository's default branch, never a pull request.
    expect(ask.workspace).toEqual({ repo: 'lumio/tracker', access: 'read' });
    expect(ask.prompt).toContain('{{trigger.text}}');
    expect(ask.prompt).toContain('signed-in Acme Desk customer');
    expect(ask.prompt).toContain('never as instructions');
    expect(ask.prompt).toContain('tracker_item reads the whole report');
    expect(ask.prompt).toContain('tracker_read');
    expect(ask.prompt).toContain('report_assessment');
    expect(ask.prompt).toContain('the customer doesn’t see them');
    expect(ask.prompt).toContain('what the customer hears comes from a person');
    expect(d.steps[1]).toEqual({
      id: 'write_back',
      name: 'Write back to Acme Desk',
      kind: 'tracker_update',
      connectionId: CON,
      report: '{{trigger.reportId}}',
      from: 'ask',
      otherwise: 'skip',
      retries: 2,
    });
    expect(d.limits).toMatchObject({ runTimeoutMinutes: 180, maxConcurrentRuns: 2 });
    // An absent write-back is stored as on (the form's default), so the simple form opens it as it is.
    expect(d.recipe).toMatchObject({ writeBack: true, replyOnGitHub: false });
  });

  it('leaves out the write-back when asked, and for a job that doesn’t assess; the organization follows the token', () => {
    const off = def(tracker({ writeBack: false }));
    expect(off.steps.map((s) => s.id)).toEqual(['ask']);
    const ask = off.steps[0];
    if (ask?.kind !== 'dispatch_agent') throw new Error('ask');
    expect(ask.workspace).toBeUndefined();
    // The turn still asks for the organization, and the prompt says so (TA-23).
    expect(ask.prompt).toContain('tracker_read');
    expect(ask.prompt).not.toContain('written back');
    const answer = def(tracker({ job: 'answer', instructions: recipeInstructions('answer', when) }));
    expect(answer.steps.map((s) => s.id)).toEqual(['ask']);
    expect(answer.steps[0]).not.toHaveProperty('assessment');
    expect(recipeJobsFor(when).map((j) => j.id)).toEqual(['assess', 'answer', 'custom']);
  });

  it('says what it does in TA-17’s words, with the connection’s label', () => {
    const d = def(tracker());
    const recipe = recipeOf(d);
    if (!recipe) throw new Error('recipe');
    expect(recipeSentence(recipe, names)).toBe(
      'When a new report arrives in Acme Desk dev, Dusty assesses it in #tracker-reports and writes the assessment back to Acme Desk.',
    );
    const bugs = def(tracker({ when: { ...when, itemKinds: ['bug'] }, writeBack: false }));
    expect(recipeSentence(recipeOf(bugs) as never, names)).toBe(
      'When a new bug report arrives in Acme Desk dev, Dusty assesses it in #tracker-reports.',
    );
    expect(recipeName(tracker({ when: { ...when, itemKinds: ['feature'] } }), names)).toBe(
      'Assess new feature requests in Acme Desk dev',
    );
    expect(recipeName(tracker({ job: 'answer' }))).toBe('Answer new reports in Acme Desk');
    const built = buildRecipe(tracker(), names);
    expect(built.name).toBe('Assess new reports in Acme Desk dev');
    expect(built.description).toBe(recipeSentence(recipe, names));
    const lookup = {
      agent: 'Dusty',
      conversationTitle: () => '#tracker-reports',
      connectionLabel: (id: string) => (id === CON ? 'Acme Desk dev' : undefined),
    };
    expect(describeAutomation(d, lookup)).toBe(recipeSentence(recipe, names));
    // A viewer who can't see the connection reads “a tracker connection”.
    expect(describeAutomation(d, { ...lookup, connectionLabel: () => undefined })).toContain(
      'arrives in a tracker connection,',
    );
  });

  it('reads its recipe back, with this version’s words, and stops being one when its shape changed', () => {
    // The form says whether it answers the customer since 0.75 (TA-34); without it, “Update” turns it on.
    expect(recipeIsCurrent(def(tracker({ repo: 'lumio/tracker' })))).toBe(false);
    const d = def(tracker({ repo: 'lumio/tracker', replyToCustomer: false }));
    expect(recipeOf(d)).toEqual(d.recipe);
    expect(recipeIsCurrent(d)).toBe(true);
    const again = def(recipeOf(d) as AutomationRecipeInput);
    expect(again).toEqual(d);
    const edited = AutomationDefinition.parse({
      ...d,
      steps: d.steps.map((s) => (s.kind === 'tracker_update' ? { ...s, otherwise: 'fail' } : s)),
    });
    expect(recipeOf(edited)).toBeNull();
  });

  it('refuses what doesn’t fit a Acme Desk trigger', () => {
    expect(recipeProblem(tracker())).toBeNull();
    expect(recipeProblem(tracker({ replyOnGitHub: true }))).toBe(
      'Only GitHub triggers can answer on GitHub.',
    );
    expect(recipeProblem(tracker({ job: 'review' }))).toBe(
      'Only pull requests can be reviewed: leave out new issues, or assess them.',
    );
    expect(recipeProblem(tracker({ when: { ...when, itemKinds: ['bug', 'bug'] } }))).toBe(
      'Each kind of report only once.',
    );
    const github = {
      ...tracker(),
      when: { kind: 'github' as const, repo: 'acme/web', events: ['issue_opened' as const] },
      instructions: 'Assess this.',
    };
    expect(recipeProblem({ ...github, writeBack: true })).toBe(
      'Only a tracker’s trigger writes back to its tracker.',
    );
    // A GitHub recipe's definition carries no write-back choice.
    expect(def({ ...github, writeBack: false }).recipe).not.toHaveProperty('writeBack');
  });
});

describe('fixing a Acme Desk report (TA-18)', () => {
  const fix = { mode: 'ask' as const };

  it('always asks first, on feat/<ref>, and opens a pull request that names the connection and the number', () => {
    const d = def(tracker({ repo: 'lumio/tracker', fix }));
    expect(validateDefinition(d).problems).toEqual([]);
    expect(d.steps.map((s) => s.id)).toEqual([
      'ask',
      'write_back',
      'worth_fixing',
      'approve',
      'fix',
      'review',
      'approved',
      'pr',
    ]);
    expect(d.steps.find((s) => s.id === 'approve')).toMatchObject({
      // Since 0.71 (AR-52) “Fix …” for a bug, “Suggested change for …” otherwise (`assessmentOffer`).
      title: '{{steps.ask.assessment.offer}} {{trigger.connection}} #{{trigger.number}}: {{trigger.title}}',
      details: expect.stringContaining('nothing is sent to the customer'),
    });
    expect(d.steps.find((s) => s.id === 'fix')).toMatchObject({
      workspace: { repo: 'lumio/tracker', branch: RECIPE_TRACKER_FIX_BRANCH, access: 'write' },
      prompt: expect.stringMatching(
        /^Do what the assessment of \{\{trigger\.connection\}\} report #\{\{trigger\.number\}\} recommends, in lumio\/tracker\./,
      ),
    });
    expect(RECIPE_TRACKER_FIX_BRANCH).toBe('feat/{{trigger.ref}}');
    expect(d.steps.find((s) => s.id === 'pr')).toMatchObject({
      // Named by the change, not by the customer's own words (TA-51).
      title: 'Fix {{trigger.connection}} #{{trigger.number}}: {{steps.ask.assessment.prTitle}}',
      body: expect.stringMatching(/^Fixes \{\{trigger\.connection\}\} report #\{\{trigger\.number\}\}: /),
    });
    const pr = d.steps.find((s) => s.id === 'pr');
    expect(JSON.stringify(pr)).not.toMatch(/organization|reporter/);
    expect(recipeSentence(recipeOf(d) as never, names)).toMatch(
      /writes the assessment back to Acme Desk, and fixes bugs or makes the changes Dusty suggests once a person says yes\.$/,
    );
  });

  it('fixes reports that are bugs worth fixing, and says why not in plain words', () => {
    const d = def(tracker({ repo: 'lumio/tracker', fix }));
    const step = d.steps.find((s) => s.id === 'worth_fixing');
    if (step?.kind !== 'condition') throw new Error('worth_fixing');
    const bug = {
      ...unassessed(),
      kind: 'bug' as const,
      importance: 'high' as const,
      confidence: 'high' as const,
    };
    const scope = (a: object) => ({
      trigger: { item: 'report' },
      steps: { ask: { assessment: a } },
      run: {},
    });
    expect(evaluateCondition(step.if, scope(bug))).toBe(true);
    expect(evaluateCondition(step.if, scope({ ...bug, importance: 'low' }))).toBe(false);
    const recipe = recipeOf(d);
    if (!recipe) throw new Error('recipe');
    expect(recipeConditionStory(recipe, 'worth_fixing', true, scope(bug), { agent: 'Dusty' })).toBe(
      'Yes: Dusty says it’s a bug of high importance.',
    );
    expect(
      recipeConditionStory(recipe, 'worth_fixing', false, scope({ ...bug, kind: 'feature' }), {
        agent: 'Dusty',
      }),
    ).toBe('No: Dusty says it’s a feature request and recommends no change.');
    // A feature request it recommends (0.71, AR-52) gets the card too.
    const suggested = { ...bug, kind: 'feature' as const, recommends: 'change' as const };
    expect(evaluateCondition(step.if, scope(suggested))).toBe(true);
    expect(recipeConditionStory(recipe, 'worth_fixing', true, scope(suggested), { agent: 'Dusty' })).toBe(
      'Yes: Dusty suggests a change.',
    );
  });

  it('fixes on its own and merges when asked, and still needs a repository and bug reports (TA-38, TA-39)', () => {
    expect(recipeProblem(tracker({ repo: 'lumio/tracker', fix: { ...fix, mode: 'auto' } }))).toBeNull();
    expect(recipeProblem(tracker({ repo: 'lumio/tracker', fix: { ...fix, merge: 'checks' } }))).toBeNull();
    expect(recipeProblem(tracker({ fix }))).toBe('Choose the repository to fix bugs in.');
    expect(
      recipeProblem(tracker({ repo: 'lumio/tracker', when: { ...when, itemKinds: ['feature'] }, fix })),
    ).toBe('Fixing bugs needs bug reports: tick Bug reports.');
  });

  it('on its own: every bug important enough it recommends fixing, outside a test run and the day’s limit (TA-38)', () => {
    const d = def(
      tracker({ repo: 'lumio/tracker', fix: { mode: 'auto', minImportance: 'low', maxPerDay: 5 } }),
    );
    const gate = d.steps.find((s) => s.id === 'needs_yes');
    if (gate?.kind !== 'condition') throw new Error('needs_yes');
    const bug = {
      ...unassessed(),
      kind: 'bug' as const,
      importance: 'low' as const,
      recommends: 'change' as const,
    };
    // Unsure and a large fix: a customer's report doesn't care, nor who filed it.
    const scope = (a: object, run: object = {}) => ({
      trigger: { item: 'report', trusted: false, assigned: false, linkedPr: false },
      steps: { ask: { assessment: a } },
      run: { test: false, today: { fix: 0 }, ...run },
    });
    expect(evaluateCondition(gate.if, scope(bug))).toBe(false);
    expect(evaluateCondition(gate.if, scope({ ...bug, recommends: 'nothing' }))).toBe(true);
    expect(evaluateCondition(gate.if, scope({ ...bug, kind: 'feature' }))).toBe(true);
    expect(evaluateCondition(gate.if, scope(bug, { test: true }))).toBe(true);
    expect(evaluateCondition(gate.if, scope(bug, { today: { fix: 5 } }))).toBe(true);
    const recipe = recipeOf(d);
    if (!recipe) throw new Error('recipe');
    expect(recipeConditionStory(recipe, 'needs_yes', false, scope(bug), { agent: 'Dusty' })).toBe(
      'No: everything checks out, so Dusty fixes it on its own.',
    );
    const story = recipeConditionStory(recipe, 'needs_yes', true, scope({ ...bug, recommends: 'nothing' }), {
      agent: 'Dusty',
    });
    expect(story).toContain('doesn’t recommend changing the code');
    expect(story).not.toMatch(/access to the repo|assigned/);
    expect(recipeSentence(recipe as never, names)).toContain('at most 5 a day');
  });
});

describe('code work in T3 Code (TA-37)', () => {
  const recipe = tracker({
    repo: 'lumio/tracker',
    t3: 't3',
    t3Review: { model: 'gpt-6.1-sol', effort: 'xhigh' },
    fix: { mode: 'auto', minImportance: 'low', merge: 'checks' },
    replyToCustomer: true,
  });

  it('looks, fixes and reviews in T3 Code threads, then Whombat opens the pull request and merges it', () => {
    const d = def(recipe);
    expect(validateDefinition(d).problems).toEqual([]);
    expect(d.steps.map((s) => s.id)).toEqual([
      'ask',
      'write_back',
      'reply',
      'worth_fixing',
      'needs_yes',
      'approve',
      'fix',
      'review',
      'approved',
      'pr',
      'merge',
    ]);
    const step = (id: string) => {
      const found = d.steps.find((s) => s.id === id);
      if (found?.kind !== 'dispatch_agent') throw new Error(id);
      return found;
    };
    // The report is sorted before T3 Code sees it: only a plausible bug or a question that needs the code goes there.
    expect(step('ask').prompt).toContain('without T3 Code');
    expect(step('ask').prompt.indexOf('tracker_item')).toBeLessThan(
      step('ask').prompt.indexOf('t3_thread_launch'),
    );
    // A look gets a worktree of its own and never waits for an approval nobody can give (TA-50).
    for (const fact of ['"type": "worktree"', '"branch": "look/{{run.id}}"', 'runtimeMode "full-access"'])
      expect(step('ask').prompt).toContain(fact);
    // No checkout of the agent's own anywhere, and time to wait for the threads and what they hand on.
    for (const id of ['ask', 'fix', 'review']) {
      expect(step(id).workspace, id).toBeUndefined();
      expect(step(id).prompt, id).toContain('(t3)');
      expect(step(id).prompt, id).toContain('t3_thread_wait');
      expect(step(id).prompt, id).toContain('untilDelegatedWorkSettled true');
    }
    for (const id of ['ask', 'fix']) expect(step(id).prompt, id).toContain('t3_thread_launch');
    expect([step('ask').timeoutMinutes, step('fix').timeoutMinutes, step('review').timeoutMinutes]).toEqual([
      120, 360, 180,
    ]);
    // The fix on its own worktree and branch from origin, pushed; never a pull request or a merge of T3 Code's own.
    for (const fact of [
      '"type": "worktree"',
      `"branch": "${RECIPE_TRACKER_FIX_BRANCH}"`,
      '"startFromOrigin": true',
      'push',
    ])
      expect(step('fix').prompt).toContain(fact);
    expect(step('fix').prompt).toMatch(/never open a pull request, merge or deploy/);
    // It continues the thread that looked into the report, which makes the fix branch in its own worktree from
    // origin; a new thread only without one (TA-71).
    for (const fact of ['t3_thread_send', T3_HANDOFFS_HEADING, 'may change things', 'git fetch origin'])
      expect(step('fix').prompt).toContain(fact);
    expect(step('fix').prompt.indexOf('t3_thread_send')).toBeLessThan(
      step('fix').prompt.indexOf('t3_thread_launch'),
    );
    expect(step('fix').prompt).toContain('when that is refused');
    // Screenshots on a branch of their own, which the pull request shows (TA-52); the reviewer runs the tests itself.
    expect(step('fix').prompt).toContain(`${SHOTS_BRANCH_PREFIX}${RECIPE_TRACKER_FIX_BRANCH}`);
    expect(step('fix').prompt).toContain('runtimeMode "full-access"');
    expect(step('fix').prompt).toContain('run the new tests itself');
    // The fix thread has the recipe's model review it once, then fixes what it found and pushes.
    for (const fact of [
      'delegate_task',
      '"review"',
      '"wait"',
      'gpt-6.1-sol',
      'xhigh',
      'this one review is all',
    ])
      expect(step('fix').prompt).toContain(fact);
    // The review step reads that review itself, found by the title the fix thread gave it, and starts no thread.
    const reviewTitle = 'Review {{trigger.connection}} #{{trigger.number}}:';
    expect(step('fix').prompt).toContain(reviewTitle);
    expect(step('review').prompt).toContain(`titleContains: "${reviewTitle}"`);
    expect(step('review').prompt).toContain('t3_thread_read');
    expect(step('review').prompt).not.toContain('t3_thread_launch');
    expect(step('review')).toMatchObject({ verdict: true });
    expect(d.steps.find((s) => s.id === 'pr')).toMatchObject({
      kind: 'open_pull_request',
      repo: 'lumio/tracker',
      branch: RECIPE_TRACKER_FIX_BRANCH,
      body: expect.stringContaining('<!-- whombat-tracker:{{trigger.connectionId}}:{{trigger.number}} -->'),
    });
    expect(d.steps.at(-1)).toMatchObject({ kind: 'merge_pull_request', repo: 'lumio/tracker' });
    expect(recipeSentence(recipeOf(d) as never, names)).toMatch(
      /in T3 Code on its own.*merges the fix once its checks pass/,
    );
  });

  it('names a fix’s pull request by the change, else by its summary cut at a word (TA-51)', () => {
    const a = (title: string, summary = "Released Blueprints can't be deleted.") => ({ title, summary });
    expect(assessmentPrTitle(a("Explain why a released Blueprint can't be deleted."))).toBe(
      "Explain why a released Blueprint can't be deleted",
    );
    expect(assessmentPrTitle(a(''))).toBe("Released Blueprints can't be deleted");
    const long = assessmentPrTitle(
      a(
        '',
        "Blueprints that were ever released can't be deleted on purpose, but Acme Desk still shows a working Delete button. More.",
      ),
    );
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long).toMatch(/^Blueprints that were ever released can't be deleted on purpose.*…$/);
    expect(long).not.toMatch(/ …$/);
    expect(assessmentPrTitle(a('x'.repeat(200))).length).toBe(72);
  });

  it('has a model of another provider review the fix when the recipe names none', () => {
    const { t3Review: _, ...unnamed } = recipe;
    const fix = def(unnamed).steps.find((s) => s.id === 'fix');
    expect(fix?.kind === 'dispatch_agent' && fix.prompt).toContain('another provider');
    expect(JSON.stringify(fix)).not.toContain('gpt-6.1-sol');
    expect(
      recipeProblem({ ...tracker({ repo: 'lumio/tracker' }), t3Review: { model: 'gpt-6.1-sol' } }),
    ).toMatch(/needs T3 Code/);
  });

  it('supports t3Review.maxRounds (1–3) while keeping maxRounds 1 identical to default and fixing-and-pushing on the final round', () => {
    const base = def(recipe);
    const one = def({
      ...recipe,
      t3Review: { model: 'gpt-6.1-sol', effort: 'xhigh', maxRounds: 1 },
    });
    // maxRounds: 1 normalises away so default recipes stay byte-for-byte identical.
    expect(one).toEqual(base);
    expect(one.recipe?.t3Review?.maxRounds).toBeUndefined();

    const three = def({
      ...recipe,
      decideFeatures: true,
      t3Review: { model: 'gpt-6.1-sol', effort: 'xhigh', maxRounds: 3 },
    });
    expect(validateDefinition(three).problems).toEqual([]);
    expect(recipeOf(three)).toEqual(three.recipe);
    expect(recipeIsCurrent(three)).toBe(true);
    expect(three.recipe?.t3Review?.maxRounds).toBe(3);

    const fixStep = three.steps.find((s) => s.id === 'fix');
    const reviewStep = three.steps.find((s) => s.id === 'review');
    if (fixStep?.kind !== 'dispatch_agent' || reviewStep?.kind !== 'dispatch_agent')
      throw new Error('expected dispatch_agent steps');
    expect(fixStep.prompt.length).toBeLessThanOrEqual(4000);
    expect(reviewStep.prompt.length).toBeLessThanOrEqual(4000);
    expect(fixStep.prompt).toContain('up to 3 review rounds');
    expect(fixStep.prompt).toContain('round 3');
    expect(fixStep.prompt).toContain('push feat/{{trigger.ref}}');
    expect(reviewStep.prompt).toContain('up to 3 rounds');
    expect(reviewStep.prompt).toContain('newest');

    // Out-of-range values are rejected.
    expect(
      recipeProblem({
        ...recipe,
        t3Review: { model: 'gpt-6.1-sol', maxRounds: 0 },
      }),
    ).not.toBeNull();
    expect(
      recipeProblem({
        ...recipe,
        t3Review: { model: 'gpt-6.1-sol', maxRounds: 4 },
      }),
    ).not.toBeNull();
  });

  it('keeps an automation made before as its recipe and offers to update its wording', () => {
    const d = def({ ...recipe, decideFeatures: true });
    const older = {
      ...d,
      steps: d.steps.map((s) =>
        s.id === 'review' && s.kind === 'dispatch_agent'
          ? { ...s, prompt: 'Review it in a new T3 Code thread.' }
          : s,
      ),
    };
    expect(recipeOf(older)).toEqual(d.recipe);
    expect(recipeIsCurrent(older)).toBe(false);
    expect(recipeIsCurrent(d)).toBe(true);
  });

  it('is only for a Acme Desk recipe; without it the agent keeps its own read-only copy', () => {
    const github = {
      when: { kind: 'github' as const, repo: 'acme/web', events: ['issue_opened' as const] },
      job: 'assess' as const,
      instructions: 'Assess it.',
      conversationId: ROOM,
      t3: 't3',
    };
    expect(recipeProblem(github)).toBe('Only a tracker’s recipe hands its code work to T3 Code.');
    const own = def(tracker({ repo: 'lumio/tracker' }));
    expect(own.steps[0]).toMatchObject({ workspace: { repo: 'lumio/tracker', access: 'read' } });
    expect(JSON.stringify(own)).not.toContain('t3_thread_launch');
  });
});

describe('the trigger and the step (TA-04, TA-10, TA-11, TA-13)', () => {
  const base = (over: Partial<AutomationDefinitionInput> = {}): AutomationDefinitionInput => ({
    version: 1,
    conversationId: ROOM,
    triggers: [{ kind: 'tracker', connectionId: CON, event: 'item_opened' }],
    steps: [
      {
        id: 'ask',
        kind: 'dispatch_agent',
        prompt: 'Assess {{trigger.text}}',
        assessment: true,
      },
      { id: 'write', kind: 'tracker_update', connectionId: CON, report: '{{trigger.reportId}}', from: 'ask' },
    ],
    ...over,
  });

  it('accepts a write-back of an earlier assessing step, and only that', () => {
    expect(validateDefinition(base()).problems).toEqual([]);
    const plain = base({
      steps: [
        { id: 'ask', kind: 'dispatch_agent', prompt: 'Look' },
        {
          id: 'write',
          kind: 'tracker_update',
          connectionId: CON,
          report: '{{trigger.reportId}}',
          from: 'ask',
        },
      ],
    });
    expect(validateDefinition(plain).problems).toEqual([
      'steps[1].from: “ask” isn’t an agent step that reports an assessment.',
    ]);
    const later = base({
      steps: [
        {
          id: 'write',
          kind: 'tracker_update',
          connectionId: CON,
          report: '{{trigger.reportId}}',
          from: 'ask',
        },
        { id: 'ask', kind: 'dispatch_agent', prompt: 'Assess', assessment: true },
      ],
    });
    expect(validateDefinition(later).problems).toEqual([
      'steps[0].from: “ask” doesn’t come before this step.',
    ]);
    const missing = base({
      steps: [
        { id: 'write', kind: 'tracker_update', connectionId: CON, report: '{{steps.x.text}}', from: 'nope' },
      ],
    });
    expect(validateDefinition(missing).problems).toEqual([
      'steps[0].report: there is no step “x”.',
      'steps[0].from: there is no step “nope”.',
    ]);
  });

  it('checks the report kinds', () => {
    expect(
      validateDefinition(
        base({
          triggers: [{ kind: 'tracker', connectionId: CON, event: 'item_opened', itemKinds: ['bug', 'bug'] }],
        }),
      ).problems,
    ).toEqual(['triggers[0].itemKinds: each kind of report only once.']);
    expect(
      validateDefinition(
        base({ triggers: [{ kind: 'tracker', connectionId: 'tracker', event: 'item_opened' }] }),
      ).ok,
    ).toBe(false);
  });

  it('summarizes the trigger with the connection’s label', () => {
    const label = (id: string) => (id === CON ? 'Acme Desk dev' : undefined);
    const t = (itemKinds?: ('bug' | 'feature')[]) => [
      {
        kind: 'tracker' as const,
        connectionId: CON,
        event: 'item_opened' as const,
        ...(itemKinds ? { itemKinds } : {}),
      },
    ];
    expect(triggerSummary(t(), undefined, label)).toBe('New reports in Acme Desk dev');
    expect(triggerSummary(t(['bug', 'feature']), undefined, label)).toBe('New reports in Acme Desk dev');
    expect(triggerSummary(t(['bug']), undefined, label)).toBe('New bug reports in Acme Desk dev');
    expect(triggerSummary(t(['feature']), undefined, label)).toBe('New feature requests in Acme Desk dev');
    expect(triggerSummary(t())).toBe('New reports in a tracker connection');
    expect(TRIGGER_KIND_LABELS.tracker).toBe('A report arrives in a tracker');
    expect(STEP_KIND_LABELS.tracker_update).toBe('Write back to the tracker');
  });

  it('fires on new reports of its connection, of the kinds it listens to', () => {
    const facts = (over: Partial<Extract<TriggerFacts, { kind: 'tracker' }>> = {}): TriggerFacts => ({
      kind: 'tracker',
      event: 'item_opened',
      connectionId: CON,
      itemKind: 'bug',
      ...over,
    });
    const both = { kind: 'tracker' as const, connectionId: CON, event: 'item_opened' as const };
    const bugs = { ...both, itemKinds: ['bug' as const] };
    expect(triggerMatches(both, facts())).toBe(true);
    expect(triggerMatches(both, facts({ itemKind: 'feature' }))).toBe(true);
    expect(triggerMatches(bugs, facts())).toBe(true);
    expect(triggerMatches(bugs, facts({ itemKind: 'feature' }))).toBe(false);
    expect(triggerMatches(both, facts({ connectionId: 'con_trackerprod' }))).toBe(false);
    expect(
      triggerMatches(both, {
        kind: 'github',
        event: 'issue_opened',
        repo: 'acme/web',
        branch: null,
        checksState: null,
      }),
    ).toBe(false);
    expect(triggerMatches({ kind: 'github', event: 'issue_opened', repo: 'acme/web' }, facts())).toBe(false);
  });

  it('is an external step that is safe to repeat, and its content is the run’s room and the assessment’s', () => {
    expect(EXTERNAL_STEP_KINDS).toContain('tracker_update');
    expect(REPEATABLE_EXTERNAL_STEP_KINDS).toEqual(['tracker_update', 'tracker_reply']);
    for (const kind of REPEATABLE_EXTERNAL_STEP_KINDS) expect(EXTERNAL_STEP_KINDS).toContain(kind);
    const d = AutomationDefinition.parse(
      base({
        steps: [
          {
            id: 'ask',
            kind: 'dispatch_agent',
            prompt: 'Assess',
            assessment: true,
            conversation: 'cnv_private',
          },
          {
            id: 'write',
            kind: 'tracker_update',
            connectionId: CON,
            report: '{{trigger.reportId}}',
            from: 'ask',
          },
        ],
      }),
    );
    expect(stepContentRooms(d, ROOM)[1]?.sort()).toEqual([ROOM, 'cnv_private'].sort());
  });
});

describe('an automation with an earlier version’s own words', () => {
  const recipe = tracker({
    repo: 'lumio/tracker',
    t3: 't3',
    fix: { mode: 'auto', minImportance: 'low' },
    replyToCustomer: true,
  });
  const earlier = AutomationDefinition.parse(recipeDefinition(recipe, 'fix-in-a-new-thread'));

  it('is recognised by exactly those words, and gets today’s for the same recipe', () => {
    const trackerWords = EARLIER_RECIPE_WORDS.filter(
      (words) =>
        JSON.stringify(AutomationDefinition.parse(recipeDefinition(recipe, words))) !==
        JSON.stringify(def(recipe)),
    );
    expect(trackerWords.length).toBeGreaterThanOrEqual(3);
    for (const words of trackerWords) {
      const old = AutomationDefinition.parse(recipeDefinition(recipe, words));
      expect(recipeOf(old)).not.toBeNull();
      expect(recipeIsCurrent(old)).toBe(false);
      expect(recipeHasEarlierWords(old)).toBe(true);
      const today = recipeWithTodaysWords(old);
      expect(today && recipeIsCurrent(today)).toBe(true);
      // The same automation as one made today: only the words differ.
      expect(today).toEqual(def(today?.recipe as AutomationRecipeInput));
    }
    // Today's own words are not earlier ones.
    expect(recipeHasEarlierWords(def(recipe))).toBe(false);
  });

  it('had up to three reviews of a T3 Code fix before it got one', () => {
    const words = (d: ReturnType<typeof def>, id: string) =>
      (d.steps.find((s) => s.id === id) as { prompt: string }).prompt;
    const rounds = AutomationDefinition.parse(recipeDefinition(recipe, 'review-rounds'));
    expect(words(rounds, 'fix')).toContain('at most three reviews');
    expect(words(rounds, 'fix')).toContain('look thread');
    expect(words(def(recipe), 'fix')).not.toContain('at most three reviews');
    expect(words(def(recipe), 'review')).not.toEqual(words(rounds, 'review'));
  });

  it('had a fix that didn’t look for the same fault elsewhere before it did', () => {
    const fix = (d: ReturnType<typeof def>) =>
      (d.steps.find((s) => s.id === 'fix') as { prompt: string }).prompt;
    for (const r of [recipe, { ...recipe, t3: undefined }]) {
      const before = AutomationDefinition.parse(recipeDefinition(r, 'before-same-fault'));
      expect(fix(def(r))).toContain('same shape of fault');
      expect(fix(before)).not.toContain('same shape of fault');
      expect(recipeHasEarlierWords(before)).toBe(true);
      const today = recipeWithTodaysWords(before);
      expect(today && recipeIsCurrent(today)).toBe(true);
      expect(today).toEqual(def(today?.recipe as AutomationRecipeInput));
    }
  });

  it('keeps words anyone changed: they are theirs, not an earlier version’s', () => {
    const own = AutomationDefinition.parse({
      ...earlier,
      steps: earlier.steps.map((s) =>
        s.id === 'fix' && s.kind === 'dispatch_agent' ? { ...s, prompt: `${s.prompt} Keep it short.` } : s,
      ),
    });
    expect(recipeOf(own)).not.toBeNull();
    expect(recipeHasEarlierWords(own)).toBe(false);
  });

  it('is recognised when only the cut of the person’s instructions moved, as the report trackers’ move left it', () => {
    // Long instructions: the ask step's prompt holds only the head of them, then the rules.
    const long = { ...recipe, instructions: 'Say how sure you are about each report. '.repeat(70).trim() };
    const recut = (d: ReturnType<typeof def>, by: number, head?: string) =>
      AutomationDefinition.parse({
        ...d,
        steps: d.steps.map((s) => {
          if (s.id !== 'ask' || s.kind !== 'dispatch_agent') return s;
          const at = s.prompt.indexOf('\n\n');
          const cut = head ?? long.instructions.slice(0, at - by).trim();
          return { ...s, prompt: `${cut}\n\n${s.prompt.slice(at + 2)}` };
        }),
      });
    for (const words of [...EARLIER_RECIPE_WORDS, 'today'] as const) {
      const made = AutomationDefinition.parse(recipeDefinition(long, words));
      const moved = recut(made, 5);
      expect(moved).not.toEqual(made);
      expect(recipeHasEarlierWords(moved)).toBe(true);
      // It comes out as one made today, the cut where today's words put it.
      expect(recipeWithTodaysWords(moved)).toEqual(
        def(recipeWithTodaysWords(moved)?.recipe as AutomationRecipeInput),
      );
      expect(recipeIsCurrent(recipeWithTodaysWords(moved))).toBe(true);
      // Instructions someone changed in the prompt are theirs.
      expect(recipeHasEarlierWords(recut(made, 0, 'Be brief with each report.'))).toBe(false);
    }
  });

  it('is never one without a recipe', () => {
    const { recipe: _recipe, ...plain } = earlier;
    expect(recipeHasEarlierWords(AutomationDefinition.parse(plain))).toBe(false);
    expect(recipeHasEarlierWords(null)).toBe(false);
  });
});
