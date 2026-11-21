import { describe, expect, it } from 'vitest';
import { ReposResponse } from '../contracts/burrows.js';
import { LocalRepoName, Repo, repoDisplayName, repoSourceOf } from './repo.js';

const base = {
  id: 'rep_1',
  burrowId: 'bur_1',
  fullName: 'whombat/billing',
  description: '',
  language: null,
  defaultBranch: 'main',
  enabled: true,
  pushedAt: null,
};

describe('local repos (CT-192)', () => {
  it('accepts folder-like names', () => {
    for (const name of ['Whombat_Website', 'site', 'a', 'my-app.v2', '_scratch', '2026-plans'])
      expect(LocalRepoName.safeParse(name).success).toBe(true);
  });

  it('refuses names that aren’t a plain folder', () => {
    for (const name of [
      '',
      '.',
      '..',
      '.hidden',
      '-flag',
      'a/b',
      'a b',
      'app.git',
      'APP.GIT',
      'é',
      'x'.repeat(101),
    ])
      expect(LocalRepoName.safeParse(name).success).toBe(false);
  });

  it('reads a repo without a source as a GitHub repo (runtimes before 0.27)', () => {
    const repo = Repo.parse(base);
    expect(repoSourceOf(repo)).toBe('github');
    expect(repoDisplayName(repo)).toBe('whombat/billing');
  });

  it('shows a local repo by its folder name', () => {
    const repo = Repo.parse({
      ...base,
      fullName: 'local/Whombat_Website',
      source: 'local',
      path: '~/.whombat/workspaces/.origins/bur_1/Whombat_Website.git',
      createdAt: '2026-09-30T12:00:00.000Z',
    });
    expect(repoDisplayName(repo)).toBe('Whombat_Website');
    expect(repo.path).toMatch(/Whombat_Website\.git$/);
  });

  it('keeps the repos list readable without the create info', () => {
    expect(ReposResponse.parse({ repos: [base], githubConnected: false }).create).toBeUndefined();
    const withCreate = ReposResponse.parse({
      repos: [],
      githubConnected: true,
      create: {
        allowed: true,
        reason: null,
        author: { name: 'Mara Okafor', email: 'mara@example.com' },
      },
    });
    expect(withCreate.create?.author?.name).toBe('Mara Okafor');
  });
});
