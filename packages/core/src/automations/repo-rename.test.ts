import { describe, expect, it } from 'vitest';
import { AutomationDefinition, type AutomationRecipeInput } from '../domain/automation.js';
import { recipeDefinition, recipeHasEarlierWords, recipeInstructions, recipeIsCurrent } from './recipes.js';
import { renameRepoInJson, renameRepoInText } from './repo-rename.js';

const FROM = 'acme/development';
const TO = 'acme/desk';

describe('renameRepoInText', () => {
  it('renames the whole name in any case, in prose, URLs and clone addresses', () => {
    expect(renameRepoInText('the project of acme/development with t3_project_list', FROM, TO)).toBe(
      'the project of acme/desk with t3_project_list',
    );
    expect(renameRepoInText('Fixed in Acme/Development.', FROM, TO)).toBe('Fixed in acme/desk.');
    expect(renameRepoInText('https://github.com/acme/development/pull/12', FROM, TO)).toBe(
      'https://github.com/acme/desk/pull/12',
    );
    expect(renameRepoInText('git clone https://github.com/acme/development.git', FROM, TO)).toBe(
      'git clone https://github.com/acme/desk.git',
    );
    expect(renameRepoInText('acme/development, acme/manage', FROM, TO)).toBe('acme/desk, acme/manage');
    expect(renameRepoInText('acme/development#12', FROM, TO)).toBe('acme/desk#12');
  });

  it('leaves other repositories that only start or end the same way', () => {
    for (const other of [
      'acme/development-2',
      'acme/development.js',
      'xacme/development',
      'my.acme/development',
    ])
      expect(renameRepoInText(`in ${other} today`, FROM, TO)).toBe(`in ${other} today`);
  });

  it('returns the same text when the names differ only in case or nothing names it', () => {
    expect(renameRepoInText('acme/development', FROM, 'Acme/Development')).toBe('acme/development');
    expect(renameRepoInText('nothing here', FROM, TO)).toBe('nothing here');
  });
});

describe('renameRepoInJson', () => {
  it('renames strings at any depth and keeps keys, numbers and untouched branches by identity', () => {
    const untouched = { branch: 'main', n: 3 };
    const value = { repo: FROM, list: [FROM, 'acme/manage'], untouched, [FROM]: 1 };
    const out = renameRepoInJson(value, FROM, TO);
    expect(out).toEqual({ repo: TO, list: [TO, 'acme/manage'], untouched, [FROM]: 1 });
    expect(out.untouched).toBe(untouched);
  });

  it('returns the value itself when nothing names the repository', () => {
    const value = { repo: 'acme/manage', steps: [{ prompt: 'hello' }] };
    expect(renameRepoInJson(value, FROM, TO)).toBe(value);
  });
});

describe('an automation made for the old name', () => {
  const when = {
    kind: 'tracker' as const,
    connectionId: 'con_trackerdev',
    itemKinds: ['bug', 'feature'] as ('bug' | 'feature')[],
  };
  const recipe = (repo: string): AutomationRecipeInput => ({
    when,
    job: 'assess',
    instructions: recipeInstructions('assess', when),
    conversationId: 'cnv_reports',
    repo,
    t3: 't3',
    fix: { mode: 'auto', minImportance: 'low', maxPerDay: 5, merge: 'checks' },
    replyToCustomer: true,
    decideFeatures: true,
  });
  const def = (repo: string) => AutomationDefinition.parse(recipeDefinition(recipe(repo)));

  it('comes out equal to one made today for the new name, so it still takes later wording by itself', () => {
    const renamed = renameRepoInJson(def(FROM), FROM, TO);
    expect(renamed).toEqual(def(TO));
    expect(JSON.stringify(renamed)).not.toContain(FROM);
    expect(recipeIsCurrent(renamed)).toBe(true);
    expect(recipeHasEarlierWords(renamed)).toBe(false);
  });

  it('a GitHub-triggered one follows the rename in its trigger too', () => {
    const github = (repo: string) =>
      AutomationDefinition.parse(
        recipeDefinition({
          when: { kind: 'github', repo, events: ['issue_opened'] },
          job: 'assess',
          instructions: recipeInstructions('assess', { kind: 'github', repo, events: ['issue_opened'] }),
          conversationId: 'cnv_web',
          replyOnGitHub: true,
        }),
      );
    expect(renameRepoInJson(github(FROM), FROM, TO)).toEqual(github(TO));
  });
});
