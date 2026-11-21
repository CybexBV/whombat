import { describe, expect, it } from 'vitest';
import { definitionRepos, oneRepo, repoFullName, repoShortName, threadRepoOf } from './thread-repo';

describe('a thread’s repository', () => {
  it('reads the repositories an automation works in from its definition', () => {
    expect(
      definitionRepos({
        recipe: { when: { kind: 'github', repo: 'acme/web' } },
        triggers: [{ kind: 'github', repo: 'acme/web' }],
        steps: [
          { kind: 'dispatch_agent', workspace: { repo: 'acme/web' } },
          { kind: 'github_comment', repo: '{{trigger.repo}}' },
        ],
      }),
    ).toEqual(['acme/web', 'acme/web', 'acme/web']);
    expect(definitionRepos({ recipe: { when: { kind: 'schedule' }, repo: 'acme/shop' } })).toEqual([
      'acme/shop',
    ]);
    expect(definitionRepos(null)).toEqual([]);
  });

  it('is one repository or none', () => {
    expect(oneRepo(['Acme/Web', 'acme/web'])).toBe('Acme/Web');
    expect(oneRepo(['acme/web', 'acme/api'])).toBeNull();
    expect(oneRepo([])).toBeNull();
  });

  it('takes the automation’s repository before the jobs’, and none when the automation names several', () => {
    expect(threadRepoOf(['acme/web'], ['acme/api'])).toBe('acme/web');
    expect(threadRepoOf([], ['acme/api', 'acme/api'])).toBe('acme/api');
    expect(threadRepoOf(['acme/web', 'acme/api'], ['acme/web'])).toBeNull();
    expect(threadRepoOf([], [])).toBeNull();
  });

  it('accepts only owner/name, and shows the name', () => {
    expect(repoFullName('acme/web')).toBe('acme/web');
    expect(repoFullName('{{trigger.repo}}')).toBeNull();
    expect(repoFullName('acme')).toBeNull();
    expect(repoShortName('LumioHQ/fusebox')).toBe('fusebox');
  });
});
