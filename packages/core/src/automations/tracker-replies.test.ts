/** Replying to a Acme Desk report's customer (0.75, CT-331; Whombat report-trackers.md TA-25…TA-35). */
import { describe, expect, it } from 'vitest';
import {
  AutomationAssessment,
  AutomationDefinition,
  type AutomationRecipeInput,
  AutomationRunStep,
  AutomationStep,
  ReportAssessmentInput,
  STEP_KIND_LABELS,
} from '../domain/automation.js';
import {
  customerReplyProblem,
  customerSignature,
  guessLanguage,
  noticeLanguage,
  signedReply,
  TRACKER_CUSTOMER_REPLY_MAX,
  TrackerItemView,
  trackerEnvironmentOf,
  trackerFixNotice,
  trackerReplyStatus,
} from '../domain/tracker.js';
import { KEY_CATALOG } from '../keys/catalog.js';
import { automationGlance } from './glance.js';
import { type TriggerFacts, triggerMatches } from './match.js';
import {
  recipeDefinition,
  recipeInstructions,
  recipeIsCurrent,
  recipeOf,
  recipeProblem,
  recipeReplyCopy,
  recipeSentence,
  refreshRecipe,
  repliesToCustomer,
  unassessed,
} from './recipes.js';
import { stepReads } from './rooms.js';
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
  repo: 'lumio/tracker',
  replyToCustomer: true,
  ...over,
});
const def = (r: AutomationRecipeInput) => AutomationDefinition.parse(recipeDefinition(r));

describe('a Acme Desk recipe that replies to the customer (TA-25, TA-31)', () => {
  it('sends the reply after the write-back and listens to the customer’s answers', () => {
    const v = validateDefinition(recipeDefinition(tracker()));
    expect(v.problems).toEqual([]);
    const d = v.definition as AutomationDefinition;
    expect(d.steps.map((s) => s.id)).toEqual(['ask', 'write_back', 'reply']);
    expect(d.steps[2]).toEqual({
      id: 'reply',
      name: 'Reply to the customer',
      kind: 'tracker_reply',
      connectionId: CON,
      report: '{{trigger.reportId}}',
      from: 'ask',
      otherwise: 'skip',
      retries: 2,
    });
    expect(d.triggers.map((t) => (t.kind === 'tracker' ? t.event : t.kind))).toEqual([
      'item_opened',
      'reporter_replied',
    ]);
    expect(stepReads(d.steps[2] as never).steps).toEqual(['ask']);
    expect(STEP_KIND_LABELS.tracker_reply).toBe('Reply to the customer');
    expect(triggerSummary(d.triggers, undefined, () => 'Acme Desk dev')).toBe(
      'New reports in Acme Desk dev · Customer replies in Acme Desk dev',
    );
    expect(repliesToCustomer(AutomationDefinition.parse(d).recipe as never)).toBe(true);
  });

  it('tells the agent what the customer reads, and that the thread stays inside', () => {
    const prompt = (def(tracker()).steps[0] as { prompt: string }).prompt;
    expect(prompt).toContain('in report_assessment’s reply, write what they read');
    expect(prompt).toContain('When the report below says the customer wrote back');
    expect(prompt).toContain('The customer reads only the reply in your report_assessment');
    expect(prompt).not.toContain('what the customer hears comes from a person');
    const quiet = (def(tracker({ replyToCustomer: false })).steps[0] as { prompt: string }).prompt;
    expect(quiet).toContain('what the customer hears comes from a person');
    expect(quiet).not.toContain('report_assessment’s reply');
  });

  it('fixes with the report’s line in the pull request and promises the customer hears', () => {
    const d = def(tracker({ fix: { mode: 'ask' } }));
    expect(d.steps.map((s) => s.id)).toEqual([
      'ask',
      'write_back',
      'reply',
      'worth_fixing',
      'approve',
      'fix',
      'review',
      'approved',
      'pr',
    ]);
    const approve = d.steps.find((s) => s.id === 'approve') as { details: string };
    expect(approve.details).toContain('Once the fix is live, the customer hears it’s fixed.');
    const pr = d.steps.find((s) => s.id === 'pr') as { body: string };
    expect(pr.body).toMatch(
      /^Fixes \{\{trigger\.connection\}\} report #\{\{trigger\.number\}\}: \{\{steps\.ask\.assessment\.summary\}\}\n\n<!-- whombat-tracker:\{\{trigger\.connectionId\}\}:\{\{trigger\.number\}\} -->\n\n/,
    );
    const quiet = def(tracker({ replyToCustomer: false, fix: { mode: 'ask' } }));
    expect((quiet.steps.find((s) => s.id === 'approve') as { details: string }).details).toContain(
      'nothing is sent to the customer',
    );
  });

  it('says so in its sentence and its list tags', () => {
    expect(recipeSentence(def(tracker()).recipe as never, names)).toBe(
      'When a new report arrives in Acme Desk dev, Dusty assesses it in #tracker-reports, writes the assessment back to Acme Desk and replies to the customer.',
    );
    expect(recipeSentence(def(tracker({ writeBack: false })).recipe as never, names)).toBe(
      'When a new report arrives in Acme Desk dev, Dusty assesses it in #tracker-reports and replies to the customer.',
    );
    const glance = automationGlance(def(tracker()), {
      conversationTitle: () => '#tracker-reports',
      connectionLabel: () => 'Acme Desk dev',
    } as never);
    expect(glance.does.find((t) => t.id === 'reply')).toEqual({
      id: 'reply',
      label: 'Replies to customers',
      tone: 'changes',
    });
  });

  it('refuses replies without an assessment or outside Acme Desk', () => {
    expect(recipeProblem(tracker())).toBeNull();
    expect(recipeProblem(tracker({ job: 'answer', instructions: 'Answer it.' }))).toBe(
      'Replying to the customer needs the agent to assess the report: choose Assess it.',
    );
    expect(
      recipeProblem({
        when: { kind: 'manual' },
        job: 'custom',
        instructions: 'Do it.',
        conversationId: ROOM,
        replyToCustomer: true,
      }),
    ).toBe('Only a tracker’s trigger replies to its customers.');
  });

  it('turns replies on for a recipe made before 0.75 when it is updated (TA-34)', () => {
    const old = def(tracker({ replyToCustomer: undefined }));
    expect(old.steps.map((s) => s.id)).toEqual(['ask', 'write_back']);
    expect(recipeOf(old)).toEqual(old.recipe);
    expect(recipeIsCurrent(old)).toBe(false);
    const updated = def(refreshRecipe(recipeOf(old) as never));
    expect(updated.recipe?.replyToCustomer).toBe(true);
    // It also puts feature requests to the person now (3.12, TA-41).
    expect(updated.steps.map((s) => s.id)).toEqual([
      'ask',
      'write_back',
      'reply',
      'decide',
      'needs_words',
      'words',
      'tell',
    ]);
    expect(recipeIsCurrent(updated)).toBe(true);
    // Said off: it stays off and current.
    expect(recipeIsCurrent(def(tracker({ replyToCustomer: false })))).toBe(true);
    const copy = recipeReplyCopy('Dusty', 'Dusty - AI Assistant', 'Acme Desk');
    expect(copy.label).toBe('Reply to the customer');
    expect(copy.hint).toMatch(/^After assessing, Dusty answers the customer in Acme Desk/);
    expect(copy.hint).toContain('Signed “Dusty - AI Assistant”');
  });

  it('starts a run for the customer’s answers only where it listens to them', () => {
    const [opened, replied] = def(tracker()).triggers;
    const facts = (event: 'item_opened' | 'reporter_replied'): TriggerFacts => ({
      kind: 'tracker',
      event,
      connectionId: CON,
      itemKind: 'bug',
    });
    expect(triggerMatches(replied as never, facts('reporter_replied'))).toBe(true);
    expect(triggerMatches(opened as never, facts('reporter_replied'))).toBe(false);
    expect(triggerMatches(replied as never, facts('item_opened'))).toBe(false);
  });
});

describe('the reply step and the key (TA-25, TA-27)', () => {
  it('needs an agent step that reports an assessment', () => {
    const d = recipeDefinition(tracker({ writeBack: false }));
    const steps = d.steps.map((s) => (s.id === 'ask' ? { ...s, assessment: false } : s));
    expect(validateDefinition({ ...d, steps }).problems).toContain(
      'steps[1].from: “ask” isn’t an agent step that reports an assessment.',
    );
  });

  it('shows in a run, as every step kind does (0.75.1)', () => {
    const kinds = AutomationStep.options.map((o) => o.shape.kind.value);
    expect(
      AutomationRunStep.shape.kind
        .unwrap()
        .options.filter((k) => k !== 'unknown')
        .sort(),
    ).toEqual(kinds.slice().sort());
  });

  it('is an automation-only key, scoped to connections', () => {
    expect(KEY_CATALOG['report.reply']).toMatchObject({
      label: 'Reply to customers',
      automationsOnly: true,
      group: 'support',
    });
  });
});

describe('the assessment’s reply (TA-25)', () => {
  it('defaults to nothing and keeps older assessments parsing', () => {
    const a = AutomationAssessment.parse({
      kind: 'bug',
      importance: 'high',
      confidence: 'high',
      size: 'small',
      summary: 'The rollout waits for a computer that is switched off.',
    });
    expect(a).toMatchObject({ reply: '', replyAsks: false, language: '' });
    expect(unassessed()).toMatchObject({ reply: '', replyAsks: false, language: '' });
  });

  it('takes the reply, whether it asks and the language', () => {
    const a = ReportAssessmentInput.parse({
      kind: 'unclear',
      importance: 'medium',
      confidence: 'low',
      size: 'large',
      summary: 'Not enough to go on.',
      recommends: 'nothing',
      reply: '  Welke computer was het?  ',
      replyAsks: true,
      language: 'NL',
    });
    expect(a).toMatchObject({ reply: 'Welke computer was het?', replyAsks: true, language: 'nl' });
    expect(
      ReportAssessmentInput.safeParse({ ...a, reply: 'x'.repeat(TRACKER_CUSTOMER_REPLY_MAX + 1) }).success,
    ).toBe(false);
    expect(ReportAssessmentInput.safeParse({ ...a, language: 'dutch' }).success).toBe(false);
  });
});

describe('what the customer reads (TA-26…TA-28)', () => {
  it('is signed with the agent’s name', () => {
    expect(customerSignature('Dusty')).toBe('Dusty - AI Assistant');
    expect(customerSignature(' Hazel ')).toBe('Hazel - AI Assistant');
    expect(signedReply('  Thanks for reporting this.  ', 'Dusty - AI Assistant')).toBe(
      'Thanks for reporting this.\n\nDusty - AI Assistant',
    );
  });

  it('sets “Needs information” when it asks, else “Investigating” for a new report', () => {
    expect(trackerReplyStatus({ replyAsks: true }, 'new')).toBe('needs_information');
    expect(trackerReplyStatus({ replyAsks: true }, 'needs_information')).toBeNull();
    expect(trackerReplyStatus({ replyAsks: false }, 'new')).toBe('investigating');
    expect(trackerReplyStatus({ replyAsks: false }, 'needs_information')).toBe('investigating');
    expect(trackerReplyStatus({ replyAsks: false }, 'in_progress')).toBeNull();
    expect(trackerReplyStatus({ replyAsks: false }, 'awaiting_release')).toBeNull();
  });

  it('closes a report waiting for its release or released only when the customer calls it solved (TA-157)', () => {
    const answered = { replyAsks: false, closes: true };
    expect(trackerReplyStatus(answered, 'investigating')).toBe('closed');
    expect(trackerReplyStatus(answered, 'awaiting_release')).toBeNull();
    expect(trackerReplyStatus({ ...answered, solved: true }, 'awaiting_release')).toBe('closed');
    expect(trackerReplyStatus({ ...answered, solved: true }, 'available')).toBe('closed');
    // Never a person's decision, nor what is closed already.
    expect(trackerReplyStatus({ ...answered, solved: true }, 'planned')).toBeNull();
    expect(trackerReplyStatus({ ...answered, solved: true }, 'closed')).toBeNull();
  });

  it('finds what a customer mustn’t read', () => {
    const context = { origin: 'https://dev.tracker.example', organizations: ['HollowMere College', 'Lumio'] };
    const ok =
      'Thanks for reporting this. We found the cause: when a computer is switched off during a rollout, Acme Desk keeps waiting for it. We’ll let you know here when it’s fixed.';
    expect(customerReplyProblem(ok, context)).toBeNull();
    expect(
      customerReplyProblem('See https://dev.tracker.example/help/rollouts for the steps.', context),
    ).toBeNull();
    expect(customerReplyProblem('See https://github.com/LumioHQ/development/pull/52.', context)).toBe(
      'It links to github.com, outside the tracker.',
    );
    expect(customerReplyProblem('Fixed in a5155146 already.', context)).toBe(
      'It contains what looks like a commit hash.',
    );
    expect(customerReplyProblem('The bug is in src/rollouts/mod.rs.', context)).toBe(
      'It names a file in the code.',
    );
    expect(customerReplyProblem('The problem is in rollouts.rs.', context)).toBe(
      'It names a file in the code.',
    );
    expect(customerReplyProblem('PR #52 fixes it.', context)).toBe('It mentions a pull request.');
    expect(customerReplyProblem('A pull request is open for it.', context)).toBe(
      'It mentions a pull request.',
    );
    expect(customerReplyProblem('Run `tracker sync` again.', context)).toBe('It contains code.');
    expect(customerReplyProblem('@Toffee will look at it.', context)).toBe('It @mentions someone.');
    expect(customerReplyProblem('Mail support@example.com if it happens again.', context)).toBeNull();
    expect(customerReplyProblem('Lumio had the same problem.', context)).toBe(
      'It names another customer, Lumio.',
    );
    expect(customerReplyProblem('Lumioia had the same problem.', context)).toBeNull();
    expect(customerReplyProblem('x'.repeat(TRACKER_CUSTOMER_REPLY_MAX + 1))).toBe(
      'It is longer than 1500 characters.',
    );
    expect(customerReplyProblem('In 2026 and on 0.1.176 it works.')).toBeNull();
  });
});

describe('where the fix is (TA-29, TA-30, TA-32)', () => {
  it('knows a development installation from its health, else from its address', () => {
    expect(trackerEnvironmentOf('development', 'https://manage.lumio.example.net')).toBe('development');
    expect(trackerEnvironmentOf('production', 'https://dev.tracker.example')).toBe('production');
    expect(trackerEnvironmentOf(undefined, 'https://dev.tracker.example')).toBe('development');
    expect(trackerEnvironmentOf(null, 'https://staging.example.com:8443/')).toBe('development');
    expect(trackerEnvironmentOf('qa', 'https://manage.lumio.example.net')).toBe('production');
    expect(trackerEnvironmentOf(undefined, 'https://tracker-dev.example.com')).toBe('development');
  });

  it('guesses Dutch or English when the agent didn’t say', () => {
    expect(guessLanguage('De uitrol wordt niet afgemaakt als een computer uit staat.')).toBe('nl');
    expect(guessLanguage('The rollout never finishes when a computer is off.')).toBe('en');
    expect(guessLanguage('🙂')).toBe('');
    expect(noticeLanguage('nl')).toBe('nl');
    expect(noticeLanguage('de')).toBe('en');
    expect(noticeLanguage(null)).toBe('en');
  });

  it('tells a development report it is live, with the release’s evidence', () => {
    const at = new Date('2026-10-12T08:00:00Z');
    expect(
      trackerFixNotice({
        product: 'Acme Desk',
        report: 'development',
        live: 'development',
        kind: 'bug',
        language: 'en',
        host: 'dev.tracker.example',
        at,
        // The fix said it fixed it (TA-55).
        outcome: { partly: false, note: '' },
      }),
    ).toEqual({
      text: 'Good news: we’ve fixed this, and the fix is live now. Could you try again and let us know whether it works?',
      status: 'available',
      evidence: 'Live on dev.tracker.example since 12 October 2026.',
    });
    expect(
      trackerFixNotice({
        product: 'Acme Desk',
        report: 'development',
        live: 'development',
        kind: 'feature',
        language: 'nl',
        host: 'dev.tracker.example',
        at,
      }),
    ).toEqual({
      text: 'Goed nieuws: wat je vroeg is klaar en staat nu live. Wil je het eens proberen en laten weten wat je ervan vindt?',
      status: 'available',
      evidence: 'Live op dev.tracker.example sinds 12 oktober 2026.',
    });
  });

  it('tells a production report twice: fixed, then live', () => {
    const at = new Date('2026-10-20T08:00:00Z');
    expect(
      trackerFixNotice({
        product: 'Acme Desk',
        report: 'production',
        live: 'development',
        kind: 'bug',
        language: 'en',
        host: 'dev.tracker.example',
        at,
        outcome: { partly: false, note: '' },
      }),
    ).toEqual({
      text: 'Good news: we’ve fixed this. The fix will reach you with the next Acme Desk update, and we’ll let you know here as soon as it’s there.',
      status: 'awaiting_release',
      evidence: null,
    });
    expect(
      trackerFixNotice({
        product: 'Acme Desk',
        report: 'production',
        live: 'production',
        kind: 'bug',
        language: 'nl',
        host: 'manage.lumio.example.net',
        at,
        outcome: { partly: false, note: '' },
      }),
    ).toEqual({
      text: 'De oplossing staat nu live. Wil je het nog eens proberen en laten weten of het werkt?',
      status: 'available',
      evidence: 'Live op manage.lumio.example.net sinds 20 oktober 2026.',
    });
  });

  it('says a fix to the separately released part is ready for their computers, with the tracker’s words (TA-155)', () => {
    const at = new Date('2026-10-20T08:00:00Z');
    const how = 'Press ‘Update now’ on your hub to get it right away.';
    const prod = trackerFixNotice({
      product: 'Acme Desk',
      report: 'production',
      live: 'production',
      kind: 'bug',
      language: 'en',
      host: 'manage.lumio.example.net',
      at,
      outcome: { partly: false, note: 'Saving works again.' },
      separate: { how },
    });
    expect(prod.status).toBe('available');
    expect(prod.evidence).toContain('manage.lumio.example.net');
    expect(prod.text).toContain('ready for your computers');
    expect(prod.text).toContain(how);
    // The words to get it come before the question, and a production report heard the fix's note already.
    expect(prod.text.indexOf(how)).toBeLessThan(prod.text.indexOf('Could you'));
    expect(prod.text).not.toContain('Saving works again.');
    expect(prod.text).not.toContain(' live ');
    // A development report hears it once: with the note, and “fixed” only with the fix's word.
    const dev = trackerFixNotice({
      product: 'Acme Desk',
      report: 'development',
      live: 'development',
      kind: 'bug',
      language: 'nl',
      host: 'dev.tracker.example',
      at,
      outcome: { partly: true, note: 'Opslaan werkt weer.' },
      separate: { how: null },
    });
    expect(dev.text).toContain('klaar voor je computers');
    expect(dev.text).toContain('Opslaan werkt weer.');
    expect(dev.text).not.toContain('opgelost');
    // Without the tracker's words it still reads as one message.
    expect(dev.text).not.toContain('  ');
  });

  it('shows the fix on the run page, null from older runtimes', () => {
    const view = {
      connectionId: CON,
      connection: 'Acme Desk dev',
      reportId: '6f1c2a0e-4d5b-4c3a-9e8f-1a2b3c4d5e6f',
      number: 16,
      title: 'The rollout never finishes',
      type: 'bug',
      organization: 'HollowMere College',
      environment: null,
      status: 'investigating',
      priority: 'high',
      assessment: 'likely_bug',
      createdAt: '2026-10-10T08:00:00.000Z',
      reporter: { name: null, email: null },
      description: '',
      expected: '',
      screenshot: null,
      messages: [],
      release: null,
    };
    expect(TrackerItemView.parse(view).fix).toBeNull();
    const fix = {
      state: 'development',
      repo: 'LumioHQ/development',
      prNumber: 52,
      prUrl: 'https://github.com/LumioHQ/development/pull/52',
      mergedAt: '2026-10-11T08:00:00.000Z',
      development: { host: 'dev.tracker.example', version: '0.1.176', at: '2026-10-11T09:00:00.000Z' },
      production: null,
      note: null,
    };
    expect(TrackerItemView.parse({ ...view, fix }).fix).toEqual(fix);
  });
});
