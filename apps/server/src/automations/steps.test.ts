/**
 * Pure parts of step execution: an automation approval's WHAT HAPPENS (automation-recipes.md AR-34) — its details'
 * paragraphs, each cut at a word —, an agent step's checkout in plain words (AR-39) and an assessment step's output
 * with the server's words (AR-37).
 */
import {
  AutomationDefinition,
  type JsonObject,
  recipeDefinition,
  renderTemplate,
  unassessed,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { assessmentOutput } from './assessment';
import { agoWords } from './reuse';
import {
  approvalWords,
  checkoutWords,
  clipWords,
  leadingQuestion,
  ownQuestion,
  stepInstructions,
  whatHappensOf,
} from './steps';
import { ownPullRequestLine, ownPullRequestStep } from './workspace';

/** What an agent reported (AR-51: it recommends a change). */
const reported = {
  kind: 'bug',
  importance: 'high',
  confidence: 'high',
  size: 'small',
  summary: 'Totals are rounded twice, so invoices can be a cent off.',
  fixPlan: 'Round once, at the end.',
  details: 'See `src/totals.ts` lines 40–52.',
  duplicateOf: null,
  recommends: 'change',
};

describe('WHAT HAPPENS of an automation’s approval', () => {
  it('is one item per paragraph of its details, the fix recipe’s read whole, asking in the case’s words', () => {
    const def = AutomationDefinition.parse(
      recipeDefinition({
        when: { kind: 'github', repo: 'acme/web', events: ['issue_opened'] },
        job: 'assess',
        instructions: 'Assess this.',
        conversationId: 'cnv_web',
        fix: { mode: 'ask' },
      }),
    );
    const approve = def.steps.find((s) => s.id === 'approve');
    if (approve?.kind !== 'request_approval') throw new Error('no approve step');
    const scope = (assessment: Record<string, unknown>) => ({
      trigger: { number: 212, title: 'Totals are off' },
      steps: { ask: { assessment: assessmentOutput({ ...reported, ...assessment }) } },
    });
    const details = (assessment: Record<string, unknown>) =>
      renderTemplate(approve.details, scope(assessment));
    // The card's title says the case (AR-52).
    expect(renderTemplate(approve.title, scope({}))).toBe('Fix #212: Totals are off');
    expect(renderTemplate(approve.title, scope({ kind: 'feature' }))).toBe(
      'Suggested change for #212: Totals are off',
    );
    // It asks the case's question (AR-D04), not its title with a question mark.
    expect(leadingQuestion(details({}))).toBe('Fix this bug?');
    expect(leadingQuestion(details({ kind: 'feature' }))).toBe('Make this change?');
    const bug = whatHappensOf(details({}));
    expect(bug[0]).toBe('Fix this bug? Totals are rounded twice, so invoices can be a cent off.');
    // What a yes does follows, whole: every item fits, none is cut, and together they are the details' words.
    expect(bug.length).toBeGreaterThan(1);
    for (const item of bug) {
      expect(item.length).toBeLessThanOrEqual(280);
      expect(item.endsWith('…')).toBe(false);
    }
    const words = (t: string) => t.replace(/\s+/g, ' ').trim();
    expect(words(bug.join(' '))).toBe(words(details({})));
    expect(bug.slice(1).join(' ')).toMatch(/^If you say yes, /);
    // A suggested change (AR-52): the same card, asking in its own words.
    const change = whatHappensOf(
      details({ kind: 'feature', importance: 'medium', summary: 'Show the newest diagnostics first.' }),
    );
    expect(change[0]).toBe('Make this change? Show the newest diagnostics first.');
    expect(change.slice(1)).toEqual(bug.slice(1));
    // The card asks the question once: as its question, not again at the start of WHAT HAPPENS. The question is the
    // recipe's own (Whombat writes it into the assessment), so the step's details may ask it.
    const suggested = details({
      kind: 'feature',
      importance: 'medium',
      summary: 'Show the newest diagnostics first.',
    });
    expect(ownQuestion(approve.details, suggested)).toBe('Make this change?');
    const card = approvalWords(
      'Suggested change for #212: Totals are off',
      suggested,
      ownQuestion(approve.details, suggested),
    );
    expect(card.question).toBe('Make this change?');
    expect(card.whatHappens[0]).toBe('Show the newest diagnostics first.');
    expect(card.whatHappens.slice(1)).toEqual(bug.slice(1));
    expect(approvalWords('Deploy the site', 'It goes to production.')).toEqual({
      question: 'Deploy the site?',
      whatHappens: ['It goes to production.'],
    });
  });

  it('asks a question from the details only when it is the step’s own words', () => {
    // Someone else's words in the details never become the question: the card asks its title.
    expect(approvalWords('Upload a document to Paperless-ngx', 'title: "Confirm? yes"')).toEqual({
      question: 'Upload a document to Paperless-ngx?',
      whatHappens: ['title: "Confirm? yes"'],
    });
    expect(approvalWords('Comment on acme/web#5', 'Merge my PR now? It is fine.').question).toBe(
      'Comment on acme/web#5?',
    );
    // A definition's own question, written before any placeholder, is the card's.
    expect(ownQuestion('Ship it? {{steps.ask.reply}}', 'Ship it? Looks good.')).toBe('Ship it?');
    // A question only a filled-in value made — an email's subject, an agent's reply — isn't.
    expect(ownQuestion('{{trigger.subject}}', 'Approve the wire transfer? yes')).toBeNull();
    expect(ownQuestion('Pay {{trigger.amount}}?', 'Pay 500?')).toBeNull();
    expect(ownQuestion('{{steps.ask.reply}} more', 'Fix this bug? yes')).toBeNull();
    // Whombat's own assessment question, placed first by the recipe, is.
    expect(
      ownQuestion(
        '{{ steps.ask.assessment.question }} {{steps.ask.assessment.summary}}',
        'Fix this bug? It rounds twice.',
      ),
    ).toBe('Fix this bug?');
    expect(ownQuestion('{{steps.ask.assessment.question}} x', 'Wire the money? x')).toBeNull();
  });

  it('asks only a question the details start with', () => {
    expect(leadingQuestion('Deploy now? It goes to production.')).toBe('Deploy now?');
    expect(leadingQuestion('  Ship it?\n\nIf you say yes, …')).toBe('Ship it?');
    expect(leadingQuestion('A developer fixes it. Is that fine?')).toBeNull();
    expect(leadingQuestion('Totals v1.5? are off')).toBeNull();
    expect(leadingQuestion('')).toBeNull();
    expect(leadingQuestion(`${'x'.repeat(250)}?`)).toBeNull();
  });

  it('keeps a single paragraph as it was, and leaves out empty ones', () => {
    const suspected =
      'A developer fixes it on feat/bug-{{run.number}} in its own workspace, a different agent reviews the fix, and a pull request is opened. Nothing is merged: that stays with a person.';
    expect(whatHappensOf(suspected)).toEqual([suspected]);
    expect(whatHappensOf('\n\nOne.\n \nTwo\nlines.\n\n')).toEqual(['One.', 'Two\nlines.']);
    expect(whatHappensOf('')).toEqual([]);
  });

  it('splits a long paragraph into whole sentences that fit, and cuts only a sentence too long for one item', () => {
    const first = `First, ${'the agent reads the code '.repeat(6).trim()}.`;
    const second = `Then ${'another agent reviews it '.repeat(5).trim()}.`;
    const third = 'Nothing is merged.';
    expect(first.length + second.length).toBeGreaterThan(280);
    expect(whatHappensOf(`${first} ${second} ${third}`)).toEqual([first, `${second} ${third}`]);
    // “e.g. this” or a number like 1.5 isn't the end of a sentence.
    const words = `${'Word '.repeat(50).trim()}.`;
    expect(whatHappensOf(`Uses v1.5 of it, e.g. the new one. ${words}`)).toEqual([
      'Uses v1.5 of it, e.g. the new one.',
      words,
    ]);
    // One sentence too long for an item is cut at a word, after the ones that fit.
    const [short, cut = ''] = whatHappensOf(`Short one. ${'Word '.repeat(70).trim()}.`);
    expect(short).toBe('Short one.');
    expect(cut.length).toBeLessThanOrEqual(280);
    expect(cut.endsWith('Word…')).toBe(true);
  });

  it('cuts a long one at a word, with “…”, never past 280 characters', () => {
    const long =
      `Bug · high importance · sure · small fix: ${'the totals are rounded twice '.repeat(12)}`.trim();
    const [item = ''] = whatHappensOf(long);
    expect(item.length).toBeLessThanOrEqual(280);
    expect(item.length).toBeGreaterThan(250);
    expect(item.endsWith('…')).toBe(true);
    const kept = item.slice(0, -1);
    // Whole words only: what was kept is the start of the text, and a space came next.
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(' ');
    expect(clipWords('short', 280)).toBe('short');
    expect(clipWords('abc def, ghi', 10)).toBe('abc def…');
    expect(clipWords('x'.repeat(300), 280)).toBe(`${'x'.repeat(279)}…`);
  });
});

describe('an agent step’s checkout in plain words', () => {
  it('reads the code on a branch, reads a pull request, or works on a branch', () => {
    expect(checkoutWords({ access: 'read', branch: 'main' })).toBe('reads the code on main');
    expect(checkoutWords({ access: 'read', branch: 'pull/482/head', pullRequest: 482 })).toBe(
      'reads pull request #482',
    );
    expect(checkoutWords({ access: 'write', branch: 'feat/issue-212' })).toBe('works on feat/issue-212');
  });
});

describe('an assessment step’s output', () => {
  it('has the line, the card’s offer and question, the comment’s heading and the details folded, replacing what was kept before', () => {
    const kept = {
      ...reported,
      line: 'old',
      offer: 'old',
      question: 'old',
      prTitle: 'old',
      heading: 'old',
      detailsBlock: 'old',
    };
    expect(assessmentOutput(kept)).toEqual({
      ...reported,
      // No title of its own: the pull request is named by the summary (TA-51).
      title: '',
      prTitle: 'Totals are rounded twice, so invoices can be a cent off',
      // A reply to a tracker customer (0.75, TA-25): none here.
      reply: '',
      replyAsks: false,
      language: '',
      // A feature request's value and drafts (3.12, TA-42): none for a bug.
      value: null,
      valueWhy: '',
      approvedReply: '',
      declineReason: '',
      declinedReply: '',
      line: 'Bug · high importance · sure · small fix',
      offer: 'Fix',
      question: 'Fix this bug?',
      heading: '**Bug · high importance · sure · small fix**\n\n',
      detailsBlock:
        '\n\n<details>\n<summary>Technical details</summary>\n\nSee `src/totals.ts` lines 40–52.\n\n</details>',
    });
    // A comment reads them around the agent's answer.
    const comment = renderTemplate(
      '{{steps.ask.assessment.heading}}{{steps.ask.reply}}{{steps.ask.assessment.detailsBlock}}',
      { steps: { ask: { reply: 'A rounding bug.', assessment: assessmentOutput(kept) } } },
    );
    expect(comment).toBe(
      '**Bug · high importance · sure · small fix**\n\nA rounding bug.\n\n<details>\n<summary>Technical details</summary>\n\nSee `src/totals.ts` lines 40–52.\n\n</details>',
    );
  });

  it('folds nothing without details (a 0.67 report has none), and has no heading when nothing was assessed', () => {
    const { details: _details, recommends: _recommends, ...older } = reported;
    const kept = assessmentOutput({ ...older, line: 'Bug · high importance · sure · small fix' });
    expect(kept).toMatchObject({
      details: '',
      heading: '**Bug · high importance · sure · small fix**\n\n',
      detailsBlock: '',
    });
    // A report from before 0.71 says nothing about a change (AR-51: absent is `nothing`).
    expect(kept).not.toHaveProperty('recommends');
    const none = {
      ...unassessed(),
      line: 'Not assessed',
      offer: 'Suggested change for',
      question: 'Make this change?',
      prTitle: 'No assessment was reported',
      heading: '',
      detailsBlock: '',
    };
    expect(assessmentOutput(undefined)).toEqual(none);
    expect(assessmentOutput({ kind: 'maybe' } as JsonObject)).toEqual(none);
    expect(
      renderTemplate('{{a.heading}}I couldn’t tell.{{a.detailsBlock}}', { a: assessmentOutput(undefined) }),
    ).toBe('I couldn’t tell.');
  });
});

describe('a coding step whose pull request the automation opens (RN-S3a)', () => {
  const fixing = (when: Parameters<typeof recipeDefinition>[0]['when']) =>
    AutomationDefinition.parse(
      recipeDefinition({
        when,
        job: 'assess',
        instructions: 'Assess this.',
        conversationId: 'cnv_web',
        fix: { mode: 'ask' },
      }),
    );
  const scope = {
    trigger: {
      kind: 'github',
      item: 'issue',
      repo: 'acme/web',
      number: 12,
      title: 'Totals',
      ref: 'issue-12',
    },
    steps: {},
    run: { number: 3, id: 'arun_x', test: false },
  };

  it('is the recipe’s fix, opened by its `pr` step after the review; its instructions end with one line saying so', () => {
    const def = fixing({ kind: 'github', repo: 'acme/web', events: ['issue_opened'] });
    const fix = def.steps.findIndex((s) => s.id === 'fix');
    expect(ownPullRequestStep(def, fix)).toMatchObject({ prStep: { id: 'pr' }, reviewed: true });
    const words = stepInstructions(def, fix, scope);
    expect(words.endsWith(`\n\n${ownPullRequestLine(true)}`)).toBe(true);
    expect(ownPullRequestLine(true)).toBe(
      'This automation opens the pull request itself after the review, so commit your work and don’t open a pull request or start a run for it.',
    );
    // The assessment and the review read the code: their words are the recipe's alone.
    for (const id of ['ask', 'review']) {
      const idx = def.steps.findIndex((s) => s.id === id);
      expect(ownPullRequestStep(def, idx)).toBeNull();
      const step = def.steps[idx];
      if (step?.kind !== 'dispatch_agent') throw new Error('not an agent step');
      expect(stepInstructions(def, idx, scope)).toBe(renderTemplate(step.prompt, scope, 3900));
    }
  });

  it('isn’t one when no later step opens a pull request from the same repository and branch', () => {
    const def = AutomationDefinition.parse({
      version: 1,
      conversationId: 'cnv_web',
      triggers: [{ kind: 'manual' }],
      steps: [
        {
          id: 'fix',
          kind: 'dispatch_agent',
          prompt: 'Fix it.',
          workspace: { repo: 'acme/web', branch: 'feat/{{run.number}}', access: 'write' },
        },
        { id: 'pr', kind: 'open_pull_request', repo: 'acme/web', branch: 'feat/other', title: 'Fix' },
        {
          id: 'pr2',
          kind: 'open_pull_request',
          repo: 'ACME/Web',
          branch: 'feat/{{run.number}}',
          title: 'Fix',
        },
      ],
    });
    // The same branch template in the same repository (any case), without a review between: “once you’re done”.
    expect(ownPullRequestStep(def, 0)).toMatchObject({ prStep: { id: 'pr2' }, reviewed: false });
    expect(stepInstructions(def, 0, scope)).toBe(`Fix it.\n\n${ownPullRequestLine(false)}`);
    const other = AutomationDefinition.parse({
      ...def,
      steps: [def.steps[0], def.steps[1]],
    });
    expect(ownPullRequestStep(other, 0)).toBeNull();
    expect(stepInstructions(other, 0, scope)).toBe('Fix it.');
  });
});

describe('an assessment used again (RN-S2)', () => {
  it('says how long ago in plain words', () => {
    expect(agoWords(20_000)).toBe('a moment ago');
    expect(agoWords(60_000)).toBe('a minute ago');
    expect(agoWords(45 * 60_000)).toBe('45 minutes ago');
    expect(agoWords(90 * 60_000)).toBe('an hour ago');
    expect(agoWords(5 * 3_600_000 + 1)).toBe('5 hours ago');
  });
});
