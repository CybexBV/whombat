/**
 * GitHub issues and pull requests in automation runs (docs/decisions/automation-recipes.md): `trigger.text`, the scope,
 * item keys, which trigger a sample stands in for, and the branch of a pull request's checkout.
 */
import { AutomationDefinition, renderTemplate } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { GhPullRequest } from '../github/adapter';
import { FakeGitHub } from '../github/fake';
import {
  closesIssue,
  fixBranchOf,
  type GitHubItem,
  gateFacts,
  githubHeadline,
  githubItemScope,
  githubTriggerText,
  isTrustedAssociation,
  itemKeyOf,
  linkedByAny,
  linksIssue,
  readsGateFacts,
  sampleTrigger,
  TEXT_BODY_MAX,
  UNREADABLE_FACTS,
} from './github-items';
import { pullRequestBranch } from './workspace';

const issue: GitHubItem = {
  item: 'issue',
  repo: 'acme/web',
  number: 142,
  title: 'Login button does nothing',
  body: 'Clicking it on Safari does nothing.',
  author: 'jdoe',
  bot: false,
  url: 'https://github.com/acme/web/issues/142',
  labels: [],
  draft: false,
  branch: null,
  base: null,
  sha: null,
  fork: false,
  authorAssociation: 'CONTRIBUTOR',
  assignees: [],
  linkedPr: false,
};

const pr: GitHubItem = {
  ...issue,
  item: 'pull_request',
  number: 57,
  title: 'Add login',
  body: '',
  url: 'https://github.com/acme/web/pull/57',
  branch: 'feat/login',
  base: 'main',
  sha: 'a'.repeat(40),
};

describe('trigger.text', () => {
  it('says what happened, links it and carries the description', () => {
    expect(githubTriggerText('issue_opened', issue)).toBe(
      'New issue #142 on acme/web by @jdoe: “Login button does nothing”\nhttps://github.com/acme/web/issues/142\n\nClicking it on Safari does nothing.',
    );
    expect(githubHeadline('pr_opened', pr)).toBe(
      'New pull request #57 on acme/web by @jdoe: “Add login” (feat/login → main)',
    );
    expect(githubHeadline('pr_opened', pr, { readied: true })).toBe(
      'Pull request #57 on acme/web by @jdoe is ready for review: “Add login” (feat/login → main)',
    );
    expect(githubHeadline('pr_updated', pr)).toBe(
      'New commits on pull request #57 on acme/web by @jdoe: “Add login” (feat/login → main)',
    );
    expect(githubHeadline('checks_completed', pr, { checksState: 'failed' })).toBe(
      'Checks failed on pull request #57 on acme/web by @jdoe: “Add login” (feat/login → main)',
    );
    expect(githubHeadline('issue_opened', { ...issue, author: null })).toBe(
      'New issue #142 on acme/web: “Login button does nothing”',
    );
  });

  it('warns about forks and drafts, lists labels, and cuts a long description', () => {
    const text = githubTriggerText('pr_opened', {
      ...pr,
      fork: true,
      draft: true,
      branch: 'stranger:patch-1',
      labels: ['bug', 'ui'],
      body: 'x'.repeat(5000),
    });
    const lines = text.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      'New pull request #57 on acme/web by @jdoe: “Add login” (stranger:patch-1 → main)',
      'https://github.com/acme/web/pull/57',
      'Labels: bug, ui',
      'It is still a draft.',
      'This pull request comes from a fork: read its code, don’t run it.',
    ]);
    expect(lines.at(-1)).toHaveLength(TEXT_BODY_MAX);
    expect(lines.at(-1)?.endsWith('…')).toBe(true);
  });
});

describe('the scope', () => {
  it('has prNumber only for a pull request, so an issue’s checkout reads the base', () => {
    const forIssue = githubItemScope('issue_opened', issue);
    expect(forIssue).toMatchObject({
      kind: 'github',
      event: 'issue_opened',
      item: 'issue',
      repo: 'acme/web',
      number: 142,
      title: 'Login button does nothing',
      author: 'jdoe',
      url: 'https://github.com/acme/web/issues/142',
    });
    expect(forIssue).not.toHaveProperty('prNumber');
    expect(renderTemplate('{{trigger.prNumber}}', { trigger: forIssue })).toBe('');
    const forPr = githubItemScope('pr_updated', pr);
    expect(renderTemplate('{{trigger.prNumber}}', { trigger: forPr })).toBe('57');
    expect(forPr).toMatchObject({ branch: 'feat/login', base: 'main', sha: 'a'.repeat(40) });
  });

  it('says whether the author has access to the repo, someone is assigned and a pull request links it', () => {
    expect(githubItemScope('issue_opened', issue)).toMatchObject({
      trusted: false,
      assigned: false,
      linkedPr: false,
    });
    expect(
      githubItemScope('issue_opened', {
        ...issue,
        authorAssociation: 'MEMBER',
        assignees: ['mara'],
        linkedPr: true,
      }),
    ).toMatchObject({ trusted: true, assigned: true, linkedPr: true });
  });

  it('keys an item by repo and number, whatever the case', () => {
    expect(itemKeyOf('Acme/Web', 57)).toBe('github:acme/web#57');
  });
});

describe('a sample’s trigger', () => {
  const def = AutomationDefinition.parse({
    version: 1,
    conversationId: 'cnv_web',
    triggers: [
      { kind: 'github', event: 'checks_completed', checksState: 'failed', repo: 'acme/web' },
      { kind: 'github', event: 'issue_opened', repo: 'acme/web' },
    ],
    steps: [{ id: 'hi', kind: 'post_message', text: 'Hi' }],
  });

  it('is the issue trigger for an issue, else a pull request trigger', () => {
    expect(sampleTrigger(def, 'issue')?.event).toBe('issue_opened');
    expect(sampleTrigger(def, 'pull_request')?.event).toBe('checks_completed');
    const issuesOnly = { ...def, triggers: [def.triggers[1]] } as AutomationDefinition;
    expect(sampleTrigger(issuesOnly, 'pull_request')).toBeNull();
  });
});

describe('a pull request’s checkout', () => {
  it('is its own branch while open in the repo, else GitHub’s pull/<n>/head', () => {
    expect(pullRequestBranch({ number: 57, branch: 'feat/login', open: true, fork: false })).toBe(
      'feat/login',
    );
    expect(pullRequestBranch({ number: 58, branch: 'stranger:patch-1', open: true, fork: true })).toBe(
      'pull/58/head',
    );
    expect(pullRequestBranch({ number: 59, branch: 'feat/old', open: false, fork: false })).toBe(
      'pull/59/head',
    );
  });
});

describe('who opened it (trigger.trusted)', () => {
  it('trusts the repo’s owner, members and collaborators only; unknown is not trusted', () => {
    for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR', 'member']) expect(isTrustedAssociation(a)).toBe(true);
    for (const a of [
      'CONTRIBUTOR',
      'FIRST_TIME_CONTRIBUTOR',
      'FIRST_TIMER',
      'NONE',
      'MANNEQUIN',
      '',
      null,
      undefined,
    ])
      expect(isTrustedAssociation(a)).toBe(false);
  });
});

describe('a pull request that links an issue (trigger.linkedPr)', () => {
  it('reads GitHub’s closing keywords before #n, in any case, with an optional colon', () => {
    for (const word of [
      'close',
      'closes',
      'closed',
      'fix',
      'fixes',
      'fixed',
      'resolve',
      'resolves',
      'resolved',
    ])
      expect(closesIssue(`This ${word} #142.`, 'acme/web', 142)).toBe(true);
    expect(closesIssue('FIXES #142', 'acme/web', 142)).toBe(true);
    expect(closesIssue('Fixes: #142', 'acme/web', 142)).toBe(true);
    expect(closesIssue('Resolves acme/web#142', 'acme/web', 142)).toBe(true);
    expect(closesIssue('Resolves Acme/Web#142', 'acme/web', 142)).toBe(true);
    expect(closesIssue('Closes https://github.com/acme/web/issues/142', 'acme/web', 142)).toBe(true);
    expect(closesIssue('Line one\nfixed #142', 'acme/web', 142)).toBe(true);
  });

  it('leaves out mentions, other numbers, other repos and words that only end in a keyword', () => {
    expect(closesIssue('See #142', 'acme/web', 142)).toBe(false);
    expect(closesIssue('Fixes #1420', 'acme/web', 142)).toBe(false);
    expect(closesIssue('Fixes #14', 'acme/web', 142)).toBe(false);
    expect(closesIssue('Fixes other/repo#142', 'acme/web', 142)).toBe(false);
    expect(closesIssue('hotfixes #142', 'acme/web', 142)).toBe(false);
    expect(closesIssue('Fixes the bug in #142', 'acme/web', 142)).toBe(false);
    expect(closesIssue('', 'acme/web', 142)).toBe(false);
  });

  it('also counts the issue’s fix branch, in the title or the description', () => {
    expect(fixBranchOf(142)).toBe('feat/issue-142');
    const open = { title: 'Round totals once', body: null, headRef: 'feat/rounding' };
    expect(linksIssue(open, 'acme/web', 142)).toBe(false);
    expect(linksIssue({ ...open, headRef: 'feat/issue-142' }, 'acme/web', 142)).toBe(true);
    expect(linksIssue({ ...open, title: 'Round totals once (fixes #142)' }, 'acme/web', 142)).toBe(true);
    expect(linksIssue({ ...open, body: 'Closes #142' }, 'acme/web', 142)).toBe(true);
    const gh = { ...open, number: 9, state: 'closed', body: 'Closes #142' } as unknown as GhPullRequest;
    expect(linkedByAny([gh], 'acme/web', 142)).toBe(false);
    expect(linkedByAny([{ ...gh, state: 'open' }], 'acme/web', 142)).toBe(true);
  });
});

describe('the auto-fix gate’s facts', () => {
  it('are read for a condition that reads trigger.trusted, assigned or linkedPr', () => {
    expect(readsGateFacts('!(trigger.trusted == true && run.test == false)')).toBe(true);
    expect(readsGateFacts('trigger.assigned == false')).toBe(true);
    expect(readsGateFacts('isEmpty(trigger.linkedPr)')).toBe(true);
    expect(readsGateFacts('steps.ask.assessment.kind == "bug" && trigger.item == "issue"')).toBe(false);
    expect(readsGateFacts('steps.trusted.state == "succeeded"')).toBe(false);
    expect(readsGateFacts('((')).toBe(false);
  });

  it('reads GitHub now, and counts against fixing alone when GitHub can’t be read', async () => {
    const github = new FakeGitHub({ load: async () => ({ repos: [{ fullName: 'acme/web' }] }) });
    const n = await github.simulateOpenIssue({
      repo: 'acme/web',
      title: 'Totals are off',
      login: 'jdoe',
      association: 'MEMBER',
    });
    const item = { item: 'issue' as const, repo: 'acme/web', number: n };
    expect(await gateFacts(github, 'brw_x', item)).toEqual({
      trusted: true,
      assigned: false,
      linkedPr: false,
    });
    await github.simulateAssign({ repo: 'acme/web', number: n, logins: ['mara'] });
    await github.simulateOpenPullRequest({
      repo: 'acme/web',
      head: 'feat/totals',
      title: 'Round once',
      body: `Fixes #${n}`,
      login: 'jdoe',
    });
    expect(await gateFacts(github, 'brw_x', item)).toEqual({ trusted: true, assigned: true, linkedPr: true });
    github.loggedOut = true;
    const unreadable = await gateFacts(github, 'brw_x', item);
    expect(unreadable).toMatchObject(UNREADABLE_FACTS);
    expect(unreadable.unreadable).toMatch(/^GitHub couldn’t be read/);
    expect(await gateFacts(null, 'brw_x', item)).toEqual({
      ...UNREADABLE_FACTS,
      unreadable: 'GitHub isn’t connected.',
    });
  });
});
