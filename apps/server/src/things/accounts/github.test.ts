/**
 * GitHub's page from a recorded mirror: what waits for the viewer first (reviews asked of them, their failing pull
 * requests, then others'), the counts, merged per day and who opens most. Pure.
 */
import type { ThingPageItem, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../kinds/slots';
import { type GithubInput, type GithubPull, githubView } from './github';

const NOW = new Date('2026-11-23T10:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const pull = (over: Partial<GithubPull> & Pick<GithubPull, 'repo' | 'number'>): GithubPull => ({
  title: `Change ${over.number}`,
  draft: false,
  openedAt: ago(10 * DAY),
  url: `https://github.com/burrowhq/${over.repo}/pull/${over.number}`,
  author: 'Sam Okafor',
  mine: false,
  checks: 'passing',
  asksYou: false,
  waiting: false,
  ...over,
});

function input(over: Partial<GithubInput> = {}): GithubInput {
  return {
    login: 'burrowhq',
    reposOn: 6,
    open: [
      pull({ repo: 'infra', number: 88, checks: 'failing', openedAt: ago(DAY) }),
      pull({
        repo: 'billing',
        number: 409,
        checks: 'failing',
        mine: true,
        author: 'Mara',
        openedAt: ago(5 * HOUR),
      }),
      pull({
        repo: 'desk',
        number: 412,
        author: 'Noor Haddad',
        asksYou: true,
        waiting: true,
        openedAt: ago(2 * HOUR),
      }),
      pull({ repo: 'desk', number: 400, waiting: true, draft: true, asksYou: true }),
      pull({ repo: 'web', number: 12, waiting: true }),
    ],
    merged: [ago(HOUR), ago(2 * DAY), ago(2 * DAY), ago(9 * DAY)],
    openers: [
      { name: 'Noor Haddad', n: 9 },
      { name: 'Mara', n: 6 },
      { name: 'Sam Okafor', n: 4 },
    ],
    now: NOW,
    timeZone: 'Europe/Amsterdam',
    ...over,
  };
}

const panel = (panels: readonly ThingPagePanel[], id: string) => panels.find((p) => p.id === id);
const items = (p: ThingPagePanel | undefined): ThingPageItem[] => (p && p.kind === 'list' ? p.items : []);

describe('GitHub’s page', () => {
  it('puts reviews asked of you first, then your failing pull requests, then others’', () => {
    const view = githubView(input());
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['waiting', 'github', 'merged', 'people']);
    expect(items(panel(view.panels, 'waiting')).map((i) => [i.title, i.detail, i.tone])).toEqual([
      ['#412 Change 412', 'desk · Noor Haddad asks your review', undefined],
      ['#409 Change 409', 'billing · Yours · Checks failing', 'bad'],
      ['#88 Change 88', 'infra · Sam Okafor · Checks failing', 'bad'],
    ]);
    expect(items(panel(view.panels, 'waiting'))[0]?.url).toBe('https://github.com/burrowhq/desk/pull/412');
  });

  it('counts repositories, open and new this week, failing checks and what waits on review', () => {
    const view = githubView(input());
    expect(items(panel(view.panels, 'github')).map((i) => [i.id, i.figure?.value, i.figure?.note])).toEqual([
      ['repos', '6', undefined],
      ['open', '5', '+3 this week'],
      ['failing', '2', undefined],
      ['review', '2', undefined],
    ]);
    const merged = panel(view.panels, 'merged');
    expect(merged?.kind === 'chart' && merged.figure).toEqual({ value: '3', rest: 'this week' });
    expect(merged?.kind === 'chart' && merged.series[0]?.values.at(-1)).toBe(1);
    const people = panel(view.panels, 'people');
    expect(people?.kind === 'bars' && people.items.map((p) => [p.label, p.value])).toEqual([
      ['Noor Haddad', '9 pull requests'],
      ['Mara', '6 pull requests'],
      ['Sam Okafor', '4 pull requests'],
    ]);
    expect(view.verdict).toBe('1 review waits for you, and 2 pull requests have failing checks.');
    expect(view.open).toEqual({ label: 'Open GitHub', url: 'https://github.com/burrowhq' });
  });

  it('leaves out the Trend with nothing merged and People with fewer than two people', () => {
    const view = githubView(input({ open: [], merged: [], openers: [{ name: 'Mara', n: 2 }] }));
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['waiting', 'github']);
    expect(view.verdict).toBe('No open pull requests.');
  });
});
