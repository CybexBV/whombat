import { describe, expect, it } from 'vitest';
import type { DelegationRow, DelegationTaskRow } from '../db/schema/delegations';
import {
  finalBrief,
  itemsOf,
  mergeBrief,
  noteOf,
  saysChecks,
  saysMerged,
  taskBranch,
  taskBrief,
} from './briefs';
import { changedOf, delegationCard, inOrder, itemNumbersOf, ledBy, listChanges, numbersOf } from './card';
import { allOver, busyTasks, leadsWith, mergesWaiting, readyTasks, togetherWith } from './commands';
import { finalDue, onePullRequest } from './state';

const at = new Date('2026-11-05T12:00:00Z');

const delegation = (over: Partial<DelegationRow> = {}): DelegationRow => ({
  id: 'dlg_one',
  burrowId: 'bur_one',
  conversationId: 'cnv_one',
  threadRootId: 'msg_root',
  agentId: 'prn_dusty',
  personId: 'prn_mara',
  connectionId: 'con_t3',
  projectId: 'mcp:project-1',
  projectTitle: 'Demo site',
  projectRoot: '/srv/demo',
  title: 'Polish the Settings page',
  stage: 'working',
  atOnce: 2,
  pullRequests: true,
  merge: false,
  integrationMode: 'legacy',
  councilId: null,
  rules: null,
  baseBranch: null,
  aiProvider: null,
  aiModel: null,
  aiModelLabel: null,
  aiOptions: null,
  note: null,
  delivery: null,
  messageId: 'msg_card',
  handedAt: at,
  outcome: null,
  createdAt: at,
  updatedAt: at,
  endedAt: null,
  ...over,
});

const task = (id: string, position: number, over: Partial<DelegationTaskRow> = {}): DelegationTaskRow => ({
  id,
  delegationId: 'dlg_one',
  burrowId: 'bur_one',
  position,
  title: `Task ${id}`,
  why: null,
  brief: 'Do it.',
  picked: true,
  afterId: null,
  kind: 'task',
  provider: null,
  model: null,
  modelLabel: null,
  options: null,
  areas: [],
  state: 'queued',
  attempt: 0,
  groupId: null,
  item: null,
  mergeClaimedAt: null,
  checkedInputs: null,
  checkedRevision: null,
  checkedBase: null,
  checkGeneration: 0,
  checkedGeneration: null,
  checksStuckAt: null,
  threadId: null,
  url: null,
  worktree: null,
  branch: null,
  pr: null,
  note: null,
  answer: null,
  mergeState: null,
  mergeAnswer: null,
  checks: null,
  sendPending: null,
  uploadHash: null,
  uploadUntil: null,
  dispatchId: null,
  stopPending: false,
  stopTries: 0,
  stopNextAt: null,
  startedAt: null,
  endedAt: null,
  deadline: null,
  createdAt: at,
  ...over,
});

it('does not label a historically incomplete delegation Done', () => {
  const card = delegationCard(delegation({ stage: 'done', outcome: 'incomplete', note: 'Done.' }), [], []);
  expect(card.note).toBe('Some work is still incomplete.');
});

describe('the delegation card from its rows', () => {
  it('shows the AI chosen for a task and for every task, with its effort and fast tier', () => {
    const card = delegationCard(
      delegation({
        stage: 'offer',
        aiProvider: 'codex',
        aiModel: 'gpt-6.1-sol',
        aiModelLabel: 'GPT 6.1 Sol',
        aiOptions: [
          { id: 'reasoningEffort', value: 'high' },
          { id: 'serviceTier', value: 'priority' },
        ],
      }),
      [
        task('dlt_a', 0, { state: 'offered' }),
        task('dlt_b', 1, {
          state: 'offered',
          provider: 'claudeAgent',
          model: 'claude-opus-5-5',
          modelLabel: 'Claude Opus 5.5',
          options: [{ id: 'effort', value: 'xhigh' }],
        }),
      ],
      [],
    );
    expect(card.ai).toEqual({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      label: 'GPT 6.1 Sol',
      effort: 'high',
      fast: true,
    });
    expect(card.tasks[0]?.ai).toBeNull();
    expect(card.tasks[1]?.ai).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', fast: null });
  });

  it('numbers tasks by their place, and shows what one comes after by its number', () => {
    const card = delegationCard(delegation(), [task('dlt_b', 5, { afterId: 'dlt_a' }), task('dlt_a', 2)], []);
    expect(card.tasks.map((t) => [t.id, t.n, t.after])).toEqual([
      ['dlt_a', 1, null],
      ['dlt_b', 2, 1],
    ]);
    expect(card).toMatchObject({ live: true, project: 'Demo site', atOnce: 2 });
  });

  it('shows what a working task does now and waits for, from its watch', () => {
    const card = delegationCard(
      delegation(),
      [task('dlt_a', 0, { state: 'working', threadId: 'mcp:thread-1' })],
      [
        {
          threadId: 'mcp:thread-1',
          pending: 'question',
          steps: [{ id: 'i1', text: 'Running the tests', detail: null, done: false }],
          program: 'Codex',
          state: 'watching',
        },
      ],
    );
    expect(card.tasks[0]).toMatchObject({ pending: 'question', step: 'Running the tests', program: 'Codex' });
  });
});

describe('whose turn it is', () => {
  it('starts queued tasks in order, one that comes after another only once that one is done', () => {
    const tasks = [task('a', 0, { state: 'working' }), task('b', 1, { afterId: 'a' }), task('c', 2)];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(['c']);
    expect(
      readyTasks([{ ...tasks[0], state: 'done' } as DelegationTaskRow, ...tasks.slice(1)]).map((t) => t.id),
    ).toEqual(['b', 'c']);
  });

  it('is over when nothing works and nothing can start', () => {
    expect(allOver([task('a', 0, { state: 'failed' }), task('b', 1, { afterId: 'a' })])).toBe(true);
    expect(allOver([task('a', 0, { state: 'done' }), task('b', 1, { afterId: 'a' })])).toBe(false);
  });

  it('starts a task after another only once that one is merged, when Whombat merges them', () => {
    const after = (mergeState: DelegationTaskRow['mergeState']) =>
      readyTasks([task('a', 0, { state: 'done', mergeState }), task('b', 1, { afterId: 'a' })]).map(
        (t) => t.id,
      );
    expect(after('waiting')).toEqual([]);
    expect(after('not_merged')).toEqual([]);
    expect(after('merged')).toEqual(['b']);
    // Kept by the person, or nothing to merge: it starts from that one's branch.
    expect(after('kept')).toEqual(['b']);
    expect(after(null)).toEqual(['b']);
  });

  it('isn’t over while a pull request waits to be merged, and merges in the card’s order', () => {
    const tasks = [
      task('b', 1, { state: 'done', mergeState: 'waiting' }),
      task('a', 0, { state: 'done', mergeState: 'waiting' }),
      task('c', 2, { state: 'done', mergeState: 'merged' }),
    ];
    expect(allOver(tasks)).toBe(false);
    expect(mergesWaiting(tasks).map((t) => t.id)).toEqual(['a', 'b']);
    expect(allOver([task('a', 0, { state: 'done', mergeState: 'not_merged' })])).toBe(true);
  });

  it('does tasks after one that waits to start in its thread, holding one place', () => {
    const tasks = [
      task('a', 0),
      task('b', 1, { afterId: 'a' }),
      task('c', 2, { afterId: 'b' }),
      task('d', 3),
      task('e', 4, { afterId: 'd', state: 'working' }),
    ];
    // Only the first of a group is ready; the others are done in its thread.
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(['a', 'd']);
    expect(togetherWith(tasks[0] as DelegationTaskRow, tasks).map((t) => t.id)).toEqual(['b', 'c']);
    // One already at work isn't taken along.
    expect(togetherWith(tasks[3] as DelegationTaskRow, tasks)).toEqual([]);
    // A list one thread leads: every task waiting goes to the first one's thread.
    expect(leadsWith(tasks[0] as DelegationTaskRow, tasks).map((t) => t.id)).toEqual(['b', 'c', 'd']);
    const working = [
      task('a', 0, { state: 'working', threadId: 't1' }),
      task('b', 1, { state: 'working', threadId: 't1', afterId: 'a' }),
      task('c', 2, { state: 'working', threadId: null }),
      task('d', 3, { state: 'working', threadId: null, afterId: 'c' }),
      task('e', 4, { state: 'working', threadId: 't3', checks: 'running' }),
    ];
    expect(busyTasks(working).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('counts a lead thread’s items as one place, though none comes after another', () => {
    // At once 3: four items led by one thread and one on another AI hold two places, so the next may start.
    const tasks = [
      task('a', 0, { state: 'working', threadId: 't1', groupId: 'g1' }),
      task('b', 1, { state: 'working', threadId: 't1', groupId: 'g1' }),
      task('c', 2, { state: 'working', threadId: 't1', groupId: 'g1' }),
      task('d', 3, { state: 'working', threadId: null, groupId: 'g2' }),
      task('e', 4, { state: 'working', threadId: null, groupId: 'g2' }),
      task('f', 5, { state: 'queued' }),
    ];
    expect(busyTasks(tasks).map((t) => t.id)).toEqual(['a', 'd']);
  });

  it('numbers a task by what its thread was told, not by the card’s order now', () => {
    const tasks = [task('b', 0, { item: 2 }), task('a', 1, { item: 1 }), task('c', 2)];
    expect([...itemNumbersOf(tasks)]).toEqual([
      ['b', 2],
      ['a', 1],
      ['c', 3],
    ]);
  });

  it('checks everything together last, once the others are over and one was merged', () => {
    const final = task('z', 0, { kind: 'final' });
    expect(inOrder([final, task('a', 1), task('b', 2)]).map((t) => t.id)).toEqual(['a', 'b', 'z']);
    const merging = [task('a', 1, { state: 'working', mergeState: 'merging' }), final];
    expect(finalDue(merging)).toBe(false);
    expect(readyTasks(merging)).toEqual([]);
    const merged = [task('a', 1, { state: 'done', mergeState: 'merged' }), final];
    expect(readyTasks(merged).map((t) => t.id)).toEqual(['z']);
    expect(allOver(merged)).toBe(false);
    // Nothing merged: it isn't needed, and doesn't hold the list open.
    const none = [task('a', 1, { state: 'failed' }), final];
    expect(finalDue(none)).toBe(false);
    expect(allOver(none)).toBe(true);
  });

  it('shows each pull request’s merge on the card, and whether the card merges them', () => {
    const card = delegationCard(
      delegation({ merge: true }),
      [
        task('a', 0, { state: 'done', mergeState: 'merged' }),
        task('b', 1, { state: 'working', mergeState: 'merging' }),
        task('c', 2, { state: 'done', mergeState: 'waiting' }),
        task('d', 3, { state: 'done', mergeState: 'kept' }),
        task('e', 4, { state: 'queued', mergeState: 'waiting' }),
      ],
      [],
    );
    expect(card.merge).toBe(true);
    expect(card.tasks.map((t) => t.merge)).toEqual(['merged', 'merging', 'waiting', null, null]);
  });
});

describe('what a task’s thread is told', () => {
  it('names its branch, the one it starts from, and whether it opens a pull request', () => {
    const brief = taskBrief({
      lead: 'Dusty',
      goal: 'Polish the Settings page',
      items: [{ n: 1, title: 'Taller buttons', brief: 'Make every button 44px tall.' }],
      branch: 'delegate/taller-buttons-abcde',
      base: 'delegate/plainer-names-fghij',
      pullRequest: true,
    });
    expect(brief).toContain('delegate/taller-buttons-abcde');
    expect(brief).toContain('delegate/plainer-names-fghij');
    expect(brief).toContain('pull request');
    expect(brief).toContain('44px');
    expect(
      taskBrief({
        lead: 'Dusty',
        goal: 'g',
        items: [{ n: 1, title: 't', brief: 'b' }],
        branch: 'x',
        base: null,
        pullRequest: false,
      }),
    ).toContain('Don’t push');
  });

  it('brings its branch up to date first and leaves merging to the lead, when the lead merges', () => {
    const brief = taskBrief({
      lead: 'Dusty',
      goal: 'g',
      items: [{ n: 1, title: 't', brief: 'b' }],
      branch: 'delegate/t-abcde',
      base: null,
      pullRequest: true,
      merge: true,
    });
    expect(brief).toMatch(/fetch origin/i);
    expect(brief).toContain('Dusty combines');
  });

  it('gets its pull request’s checks passing, keeps the list’s rules, and ends with a note and a checks line', () => {
    const brief = taskBrief({
      lead: 'Dusty',
      goal: 'g',
      items: [{ n: 1, title: 't', brief: 'b' }],
      branch: 'delegate/t-abcde',
      base: null,
      pullRequest: true,
      merge: true,
      rules: 'Strings go in the en and nl tables.',
      upload: { bases: ['http://10.0.0.5:4480'], token: 'tok_abcdefghijklmnopqrstuvwxyz' },
    });
    expect(brief).toMatch(/watch it in T3 Code/);
    expect(brief).toMatch(/three rounds/);
    // The repository's own list before a push, and a fix that also runs what the failed run never got to.
    expect(brief).toContain('“Before you push”');
    expect(brief).toMatch(/AGENTS\.md, CLAUDE\.md/);
    expect(brief).toMatch(/never reached \(stages skipped, blocked or cancelled/);
    expect(brief).toMatch(/Never weaken or skip tests/);
    expect(brief).toContain('Strings go in the en and nl tables.');
    expect(brief).toMatch(/don’t rename, renumber/);
    expect(brief).toContain('/shots/tok_abcdefghijklmnopqrstuvwxyz/shot?when=before');
    expect(brief).toContain('/shots/tok_abcdefghijklmnopqrstuvwxyz/notes');
    expect(brief).toContain('Note:');
    expect(brief).toContain('Checks: passing');
    const scratch = taskBrief({
      lead: 'Dusty',
      goal: 'g',
      items: [{ n: 1, title: 't', brief: 'b' }],
      branch: null,
      base: null,
      pullRequest: false,
    });
    expect(scratch).not.toContain('Checks:');
    expect(scratch).not.toContain('/shots/');
    const local = taskBrief({
      lead: 'Dusty',
      goal: 'g',
      items: [{ n: 1, title: 't', brief: 'b' }],
      branch: 'delegate/t-abcde',
      base: null,
      pullRequest: false,
    });
    expect(local).toMatch(/Don’t push/);
    expect(local).toContain('“Before you push”');
    expect(local).not.toMatch(/never reached/);
  });

  it('reads a task’s checks and its note for the person', () => {
    expect(saysChecks('Opened #41.\nNote: The buttons are taller.\nChecks: passing')).toBe('passing');
    expect(saysChecks('**Checks:** failing, the e2e suite times out')).toBe('failing');
    expect(saysChecks('Checks: none')).toBe('none');
    expect(saysChecks('The checks are running.')).toBeNull();
    expect(noteOf('Done.\nNote: The buttons are taller.\nChecks: passing', 300)).toBe(
      'The buttons are taller.',
    );
    expect(noteOf('Note: <one short sentence>', 300)).toBeNull();
    expect(noteOf('No note here.', 300)).toBeNull();
    expect(noteOf(`Note: ${'a'.repeat(400)}`, 300)?.length).toBe(300);
  });

  it('tells a task’s thread to merge its pull request, and reads whether it did', () => {
    const brief = mergeBrief({
      lead: 'Dusty',
      pr: 'https://github.com/acme/site/pull/41',
      branch: 'delegate/t-abcde',
    });
    expect(brief).toContain('https://github.com/acme/site/pull/41');
    expect(brief).toContain('delegate/t-abcde');
    expect(brief).toContain('Merged: yes');
    // Its checks passed: merged at once, without being brought up to date or checked again (DLG-40).
    expect(brief).toMatch(/merges without conflicts, merge it now/);
    expect(brief).toMatch(/wait for new checks/);
    expect(brief).toMatch(/Only when it conflicts/);
    expect(brief).toContain('“Before you push”');
    expect(brief).toMatch(/three rounds/);
    expect(brief).toMatch(/never reached \(stages skipped, blocked or cancelled/);
    expect(saysMerged('Updated from main.\n\nMerged: yes')).toBe(true);
    expect(saysMerged('**Merged:** no, it needs a review.')).toBe(false);
    expect(saysMerged('Merged: no at first.\n- **Merged: yes**')).toBe(true);
    expect(saysMerged('I merged main into the branch.')).toBeNull();
    expect(saysMerged(null)).toBeNull();
  });

  it('runs fast tests and leaves the check of everything together to the candidate', () => {
    const brief = taskBrief({
      lead: 'Dusty',
      goal: 'g',
      items: [{ n: 1, title: 't', brief: 'b' }],
      branch: 'delegate/t-abcde',
      base: null,
      pullRequest: true,
      merge: true,
      batch: true,
    });
    expect(brief).toContain('`fast-test`');
    expect(brief).toContain('“Before you push”');
    expect(brief).not.toMatch(/never reached/);
    expect(brief).toMatch(/combined candidate/);
    expect(brief).toMatch(/don’t wait for CI on this branch/);
    expect(brief).toMatch(/review run while its checks run/);
  });

  it('gives one thread every item, numbered as on the card, to lead with subagents and one pull request', () => {
    const brief = taskBrief({
      lead: 'Dusty',
      goal: 'g',
      items: [
        { n: 2, title: 'Keep the hand-in', brief: 'Never delete it before it is stored.' },
        { n: 5, title: 'Survive a power cut', brief: 'Sync the copy.', after: 2 },
      ],
      branch: 'delegate/keep-abcde',
      base: null,
      pullRequest: true,
      merge: true,
      atOnce: 4,
    });
    // Numbered as on the card, each item's own line to end with, one pull request for all.
    expect(brief).toContain('Item 2');
    expect(brief).toContain('Item 5 (builds on item 2)');
    expect(brief.indexOf('Keep the hand-in')).toBeLessThan(brief.indexOf('Survive a power cut'));
    expect(brief).toMatch(/one pull request for all/);
    expect(brief).toContain('“Before you push”');
    expect(brief).toMatch(/never reached/);
    expect(brief).toMatch(/^Item 2: </m);
    expect(brief).toMatch(/^Item 5: </m);
    // It leads, and may start a few subagents for independent parts.
    expect(brief).toContain('You may start subagents.');
    expect(brief).toContain('At most 4 at a time');
    expect(brief).toMatch(/worktree of their own/);
    expect(brief).toMatch(/shared files/);
    expect(brief).not.toMatch(/Other threads change this project/);
  });

  it('requires exact candidate evidence before separate merge authorization', () => {
    const brief = finalBrief({
      lead: 'Dusty',
      goal: 'Raise the grade',
      branch: 'delegate/check-everything-together-abcde',
      merged: ['Keep the hand-in', 'Lock the boot menu'],
      rules: 'Strings in en and nl.',
    });
    expect(brief).toContain('delegate/check-everything-together-abcde');
    expect(brief).toContain('Lock the boot menu');
    expect(brief).toContain('Strings in en and nl.');
    expect(brief).toContain('Checks: passing');
    expect(brief).toContain('Verification:');
    expect(brief).toMatch(/Do not merge/);
    expect(brief).toMatch(/critical database, browser or VM/);
    expect(brief).toMatch(/never reached \(stages skipped, blocked or cancelled/);
    expect(brief).toContain('“Before you push”');
    expect(brief).toContain('Note:');
  });

  it('tells the final check to run fast-test, not wait for CI, when GitHub requires none', () => {
    const base = { lead: 'Dusty', goal: 'Raise the grade', branch: 'delegate/check-abcde', merged: [] };
    const local = finalBrief({ ...base, gate: 'local' });
    expect(local).toMatch(/AGENTS\.md or CLAUDE\.md/);
    expect(local).toContain('local: fast-test');
    expect(local).not.toMatch(/Watch the integration pull request in T3 Code/);
    expect(local).not.toMatch(/never reached/);
    expect(finalBrief({ ...base, gate: 'ci' })).toMatch(/Watch the integration pull request in T3 Code/);
  });

  it('reads what a lead thread says of each item, by its number on the card', () => {
    const answer = [
      'All done.',
      'Item 2: The buttons are taller.',
      '- **Item 5:** not done: the screen it names is gone.',
      'Item 7: <one short sentence>',
      'Note: Settings is easier to use.',
    ].join('\n');
    const items = itemsOf(answer, 300);
    expect(items.get(2)).toEqual({ note: 'The buttons are taller.', done: true });
    expect(items.get(5)).toEqual({ note: 'The screen it names is gone.', done: false });
    expect(items.has(7)).toBe(false);
    expect(itemsOf('Item 3: Not done.', 300).get(3)).toEqual({ note: 'Not done.', done: false });
    expect(itemsOf(null, 300).size).toBe(0);
  });

  it('keeps one item’s brief short, and says when other threads work on the list', () => {
    const one = taskBrief({
      lead: 'Dusty',
      goal: 'g',
      items: [{ n: 3, title: 't', brief: 'b' }],
      branch: 'delegate/t-abcde',
      base: null,
      pullRequest: true,
      others: true,
    });
    expect(one).not.toMatch(/^Item 3: </m);
    expect(one).not.toContain('Item N done:');
    expect(one).toContain('You may start subagents.');
    expect(one).toContain('At most 3 at a time');
    expect(one).toMatch(/Other threads change this project/);
  });

  it('shows the tasks in a lead’s thread as done with its first one', () => {
    const tasks = [
      task('a', 0, { state: 'working', threadId: 't1' }),
      task('b', 1, { state: 'working', threadId: 't1' }),
      task('c', 2, { state: 'working', threadId: 't2' }),
      task('d', 3, { state: 'working', threadId: 't1', afterId: 'b' }),
      task('e', 4, { state: 'done', threadId: 't1' }),
    ];
    const led = ledBy(tasks, numbersOf(tasks));
    expect([...led]).toEqual([
      ['b', 1],
      ['d', 1],
    ]);
    const card = delegationCard(delegation(), tasks, []);
    expect(card.tasks.map((t) => t.after)).toEqual([null, 1, null, 1, null]);
  });

  it('asks a lead thread to say each item it finished, and puts what it said on the card', () => {
    const brief = taskBrief({
      lead: 'Dusty',
      goal: 'g',
      items: [
        { n: 1, title: 'a', brief: 'b' },
        { n: 3, title: 'c', brief: 'd' },
      ],
      branch: 'delegate/t-abcde',
      base: null,
      pullRequest: true,
    });
    expect(brief).toContain('Item N done:');
    const tasks = [
      task('a', 0, { state: 'working', threadId: 't1', note: null }),
      task('b', 1, { state: 'skipped' }),
      task('c', 2, { state: 'working', threadId: 't1' }),
      task('d', 3, { state: 'working', threadId: 't2' }),
    ];
    const progress = {
      said: 'Item 3 is in; the rest follow.',
      reported: { '3': 'Errors keep their cause.' },
    };
    const card = delegationCard(delegation(), tasks, [
      { threadId: 't1', pending: null, steps: [], program: 'Codex', state: 'watching', progress },
      // A thread doing one task says nothing on its row.
      { threadId: 't2', pending: null, steps: [], program: 'Codex', state: 'watching', progress },
    ]);
    expect(card.tasks.map((t) => [t.n, t.said ?? null, t.reported ?? false, t.note])).toEqual([
      [1, 'Item 3 is in; the rest follow.', false, null],
      [2, null, false, null],
      [3, null, true, 'Errors keep their cause.'],
      [4, null, false, null],
    ]);
  });

  it('checks one pull request itself when all the work is in it', () => {
    const brief = finalBrief({
      lead: 'Dusty',
      goal: 'Simplify the Exams page',
      branch: 'delegate/check-everything-together-abcde',
      merged: [],
      single: {
        title: 'Clear names; Calmer cards',
        pr: 'https://github.com/acme/site/pull/57',
        branch: 'delegate/clear-names-fghij',
      },
      inputs: 'fingerprint',
      generation: 2,
    });
    for (const fact of [
      'https://github.com/acme/site/pull/57',
      'origin/delegate/clear-names-fghij',
      'HEAD:delegate/clear-names-fghij',
      'Verification:',
      '"generation":2',
    ])
      expect(brief).toContain(fact);
    expect(brief).toMatch(/don’t open another/);
    expect(brief).not.toMatch(/integration pull request/);
    expect(brief).toContain('“Before you push”');
    expect(brief).toMatch(/never reached/);
    const tasks = [
      task('a', 0, {
        state: 'done',
        mergeState: 'waiting',
        checks: 'passing',
        pr: 'https://x/pull/1',
        branch: 'b1',
      }),
      task('b', 1, {
        state: 'done',
        mergeState: 'waiting',
        checks: 'passing',
        pr: 'https://x/pull/1',
        branch: 'b1',
      }),
    ];
    expect(onePullRequest(tasks)).toEqual({ title: 'Task a; Task b', pr: 'https://x/pull/1', branch: 'b1' });
    const two = [
      ...tasks,
      task('c', 2, {
        state: 'done',
        mergeState: 'waiting',
        checks: 'passing',
        pr: 'https://x/pull/2',
        branch: 'b2',
      }),
    ];
    expect(onePullRequest(two)).toBeNull();
  });

  it('gets a branch from its title, another on its second try', () => {
    expect(taskBranch('Make the Settings buttons taller!', 'dlt_AbCdEfGh', 1)).toBe(
      'delegate/make-the-settings-buttons-taller-defgh',
    );
    expect(taskBranch('Taller', 'dlt_AbCdEfGh', 2)).toMatch(/-2$/);
  });
});

describe('what changed on an offered list', () => {
  const task = (id: string, n: number, title: string, state = 'offered') =>
    ({ id, n, title, state }) as Parameters<typeof listChanges>[0][number];

  it('names the tasks taken off, added, renamed and moved, and nothing for the same list', () => {
    const before = [
      task('a', 1, 'Taller rows'),
      task('b', 2, 'One line per item'),
      task('c', 3, 'A search box'),
    ];
    expect(listChanges(before, before)).toEqual([]);
    const after = [
      task('b', 1, 'One line per item'),
      task('a', 2, 'Taller rows and buttons'),
      task('d', 3, 'Plainer words'),
    ];
    expect(listChanges(before, after)).toEqual([
      'Took off “A search box”',
      'Added “Plainer words”',
      'Renamed “Taller rows” to “Taller rows and buttons”',
      'Moved “One line per item” to the top',
    ]);
    // A task the list leaves out counts as taken off.
    expect(
      listChanges(before, [before[0] as never, before[1] as never, task('c', 3, 'A search box', 'skipped')]),
    ).toEqual(['Took off “A search box”']);
  });

  it('says how many more when there are many', () => {
    const before = [task('a', 1, 'A')];
    const after = ['b', 'c', 'd', 'e', 'f'].map((id, i) => task(id, i + 1, id.toUpperCase()));
    const said = listChanges(before, after);
    expect(said).toHaveLength(4);
    expect(said.at(-1)).toBe('3 more changes');
  });

  it('keeps the last change until the list changes again, and drops it once handed over', () => {
    const card = (tasks: ReturnType<typeof task>[], over: Record<string, unknown> = {}) =>
      ({ kind: 'delegation', delegationId: 'dlg_a', stage: 'offer', tasks, ...over }) as never;
    const at = new Date('2026-11-09T07:37:00Z');
    const one = [task('a', 1, 'A')];
    const two = [task('a', 1, 'A'), task('b', 2, 'B')];
    const changed = changedOf(card(one), card(two), at);
    expect(changed).toEqual({ at: at.toISOString(), said: ['Added “B”'] });
    expect(changedOf(card(two, { changed }), card(two), new Date())).toEqual(changed);
    expect(changedOf(card(two, { changed }), card(two, { stage: 'working' }), new Date())).toBeNull();
  });
});
