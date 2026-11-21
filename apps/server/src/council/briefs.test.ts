import { describe, expect, it } from 'vitest';
import { lateBrief, leadBrief, leadTitle, memberTitle, roundOfTitle, tellBrief } from './briefs';

const SEATS = [
  {
    provider: 'codex',
    providerName: 'Codex',
    model: 'gpt-6.1-sol',
    label: 'GPT 6.1 Sol',
    options: [{ id: 'reasoningEffort', value: 'xhigh' }],
  },
  {
    provider: 'claudeAgent',
    providerName: 'Claude',
    model: 'claude-fable-5-2',
    label: 'Claude Fable 5.2',
    options: [{ id: 'effort', value: 'high' }],
  },
];

const base = {
  lead: 'Dusty',
  question: 'Is the Settings page easy to use on a phone?',
  seats: SEATS,
  project: true,
  rounds: 3,
  target: 9,
  goAllTheWay: false,
};

describe('the lead thread’s brief', () => {
  it('carries what was asked as written, and every seat as delegate_task takes it', () => {
    const brief = leadBrief({ ...base, kind: 'review' });
    expect(brief).toContain('Is the Settings page easy to use on a phone?');
    expect(brief).toContain(
      '{"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"xhigh"}}',
    );
    expect(brief).toContain(
      '{"providerInstanceId":"claudeAgent","model":"claude-fable-5-2","options":{"effort":"high"}}',
    );
    // What Whombat reads: the reviewers' titles, their closing lines, and how they are started.
    expect(brief).toContain('<look|plan|check> <round number>');
    expect(brief).toContain('Score: <0 to 10>/10');
    expect(brief).toContain('isolation "shared"');
    expect(brief).toContain('council skill');
  });

  it('sits the council skill’s members in T3 Code’s own council, and exactly the seats otherwise', () => {
    expect(leadBrief({ ...base, kind: 'review', t3Council: true })).toContain('skill’s members');
    expect(leadBrief({ ...base, kind: 'review' })).not.toContain('skill’s members');
    expect(leadBrief({ ...base, kind: 'review' })).toContain('exactly this target');
  });

  it('carries what the person wrote, word for word, after what the agent asks', () => {
    const brief = leadBrief({
      ...base,
      kind: 'review',
      personWords: 'can the council look at settings on my phone',
    });
    expect(brief).toContain(
      'What the person wrote, word for word:\n<<<\ncan the council look at settings on my phone\n>>>',
    );
    expect(brief.indexOf('Is the Settings page easy')).toBeLessThan(brief.indexOf('can the council look'));
    expect(leadBrief({ ...base, kind: 'review' })).not.toContain('word for word');
  });

  it('keeps a review to one round that changes nothing, in the person’s own checkout', () => {
    const brief = leadBrief({ ...base, kind: 'review' });
    expect(brief).toContain('one round of reviews');
    expect(brief).toContain('Change nothing yourself');
    expect(brief).toContain('uncommitted changes included');
    expect(brief).not.toContain('pull request’s description');
  });

  it('asks research for no score, in a scratch folder without a project', () => {
    const brief = leadBrief({ ...base, kind: 'research', project: false });
    expect(brief).toContain('scratch folder');
    expect(brief).toContain('No score');
    expect(brief).not.toContain('Score: <0 to 10>/10');
  });

  it('stops an improving council at the agreed plan unless the person said to go all the way', () => {
    const asks = leadBrief({ ...base, kind: 'improve' });
    expect(asks).toContain('Then stop');
    expect(asks).toContain('at most 3 rounds');
    expect(asks).toContain('9/10 from every one');
    expect(asks).toContain('pull request’s description');
    expect(asks).toContain('Never production');
    const goes = leadBrief({ ...base, kind: 'improve', goAllTheWay: true });
    expect(goes).not.toContain('Then stop');
  });
});

describe('what Whombat tells the lead later', () => {
  it('fences the agent’s words, and says to build on a go-ahead', () => {
    const go = tellBrief('Dusty', 'Go ahead, but keep the buttons blue.', 'go');
    expect(go).toContain('go ahead');
    expect(go).toContain('<<<\nGo ahead, but keep the buttons blue.\n>>>');
    expect(tellBrief('Dusty', 'Look at the footer too.', 'tell')).not.toContain('build the agreed plan');
    // A change to a plan that waits is no go-ahead.
    const revise = tellBrief('Dusty', 'Drop the search box.', 'revise');
    expect(revise).toContain('not the go-ahead');
    expect(revise).not.toContain('build the agreed plan');
    // The person's own words go with it, once.
    const theirs = tellBrief(
      'Dusty',
      'They say go, with blue buttons.',
      'go',
      'yes go ahead but blue buttons please',
    );
    expect(theirs).toContain('<<<\nyes go ahead but blue buttons please\n>>>');
  });

  it('names the reviewers that ran out of time', () => {
    expect(lateBrief(['Muse Wonder Full 1.0'])).toContain('Muse Wonder Full 1.0 ran out of time');
    expect(lateBrief(['A', 'B'])).toContain('A and B ran out of time');
  });
});

describe('titles', () => {
  it('names the lead thread after what the council is about', () => {
    expect(leadTitle('Improve the Settings page')).toBe('Council · Improve the Settings page');
  });

  it('reads a reviewer’s round back from the title Whombat asks for', () => {
    expect(roundOfTitle(memberTitle('Claude Fable 5.2', 'agree', 2))).toEqual({
      stage: 'agree',
      round: 2,
      label: 'Claude Fable 5.2',
    });
    expect(roundOfTitle('Dusty - Council · GPT 6.1 Sol · look 1')).toMatchObject({
      stage: 'research',
      round: 1,
    });
    expect(roundOfTitle('Council · Muse · check 3')).toMatchObject({
      stage: 'check',
      round: 3,
      label: 'Muse',
    });
  });

  it('reads nothing from a title the lead made up', () => {
    expect(roundOfTitle('Council R1 review (Muse)')).toBeNull();
    expect(roundOfTitle('Design review')).toBeNull();
  });
});
