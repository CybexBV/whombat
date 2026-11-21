import { type ChatThread, HANDOFF_ANSWER_MAX, type Handoff } from '@whombat/core';
import { type JobFixtureState, jobFixture, jobSteps } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { handoffLine, threadHandoffs } from './handoff';
import {
  JOB_WORDS,
  jobAnswer,
  jobCanMessage,
  jobChanges,
  jobChecks,
  jobNotice,
  jobPartsAfter,
  jobPlan,
  jobPullRequest,
  jobQuestion,
  jobReceipt,
  jobTitle,
  stageTime,
} from './job';
import { threadWorkLine } from './workLine';

const NOW = Date.parse('2026-11-07T12:00:00Z');

const job = (state: JobFixtureState, over: Partial<Handoff> = {}): Handoff => ({
  id: `mcp:${state}`,
  to: 't3code',
  conversationId: 'cnv_chat' as never,
  rootId: 'msg_root' as never,
  agentId: 'prn_dusty' as never,
  title: 'Dusty - Fix the empty backup list',
  steps: jobSteps(state),
  program: 'Claude · claude-opus-5-5',
  url: 'http://thetitan:3773/env/mcp%3At',
  ...jobFixture(state, NOW),
  ...over,
});

const thread = (over: Partial<ChatThread> = {}): ChatThread => ({
  conversationId: 'cnv_chat' as never,
  room: 'chat',
  rootId: 'msg_root' as never,
  authorId: 'prn_mara' as never,
  text: 'The backup page is empty',
  createdAt: new Date(NOW - 30 * 60_000).toISOString(),
  replyCount: 2,
  lastAt: new Date(NOW - 20 * 60_000).toISOString(),
  working: false,
  ...over,
});

describe('the pull request', () => {
  it('says its number and whether it is merged, until the receipt says it', () => {
    expect(jobPullRequest(job('fixing'))).toEqual({
      text: '#48 · open',
      state: 'open',
      url: 'https://github.com/burrow-hq/whombat/pull/48',
      spoken: 'Pull request #48, open',
    });
    expect(
      jobPullRequest(job('fixing', { pullRequest: { number: 48, url: 'u', state: 'merged' } }))?.text,
    ).toBe('#48 · merged');
    // Before it has one, nothing; once it ended, the receipt's line says it.
    expect(jobPullRequest(job('editing'))).toBeNull();
    expect(jobPullRequest(job('merged'))).toBeNull();
  });
});

describe('the receipt’s time', () => {
  it('says a stage’s time in seconds, minutes or hours', () => {
    expect(stageTime(40_000)).toBe('40s');
    expect(stageTime(6 * 60_000)).toBe('6m');
    expect(stageTime(65 * 60_000)).toBe('1h 05m');
  });
});

describe('the plan, the changes and the checks', () => {
  it('lists T3 Code’s plan, open while it works', () => {
    const plan = jobPlan(job('editing'));
    expect(plan?.rows.map((r) => r.state)).toEqual(['done', 'now', 'next', 'next']);
    expect(plan?.count).toBe('1 of 4 done');
    expect(plan?.open).toBe(true);
    expect(jobPlan(job('merged'))?.open).toBe(false);
    expect(jobPlan(job('reading'))).toBeNull();
  });

  it('sums the changes up and splits each file’s name from its folder', () => {
    const changes = jobChanges(job('checks'));
    expect(changes?.summary).toBe('12 files · +340 −58');
    expect(changes?.files[0]).toMatchObject({
      name: 'BackupList.tsx',
      dir: 'apps/web/src/features/backups/',
      plus: '+142',
      minus: '−31',
    });
    expect(changes?.more).toBe('7 more files');
    expect(changes?.url).toContain('/pull/48/files');
    expect(jobChanges(job('checks'), 3)).toMatchObject({ more: '9 more files' });
    expect(jobChanges(job('editing'))).toBeNull();
    expect(JOB_WORDS.changes.summary(1, 3, 0)).toBe('1 file · +3 −0');
  });

  it('says T3 Code is fixing a failed check with its attempt, and which failed once it stopped', () => {
    const fixing = jobChecks(job('fixing'));
    expect(fixing?.failure).toBe('T3 Code is fixing it · attempt 2');
    expect(fixing?.tone).toBe('bad');
    expect(fixing?.rows.find((r) => r.name === 'Unit tests')).toMatchObject({ word: 'Failed', tone: 'bad' });
    expect(jobChecks(job('fixing', { state: 'ended', outcome: 'failed' }))?.failure).toBe(
      'Unit tests failed',
    );
    expect(jobChecks(job('checks'))).toMatchObject({ count: '2 of 4 passed', failure: null, tone: 'live' });
    expect(jobChecks(job('merged'))?.tone).toBe('ok');
    expect(jobChecks(job('tests'))).toBeNull();
  });
});

describe('the question, the permission and the steer box', () => {
  it('turns each option into the answer it sends', () => {
    const q = jobQuestion(job('question'));
    expect(q?.text).toBe('Keep the old list as a fallback?');
    expect(q?.options.map((o) => o.answers)).toEqual([
      { fallback: 'Yes, keep it' },
      { fallback: 'No, remove it' },
    ]);
    expect(q?.requestId).toBe('req-fixture-1');
    expect(jobQuestion(job('tests'))).toBeNull();
  });

  it('leaves a permission to T3 Code’s line, which says it once with what it asks', () => {
    const line = handoffLine(job('needs_ok'), 'Neo');
    expect(line).toMatchObject({ tone: 'warn' });
    expect(line.now).toContain('git push origin fix/backup-list');
  });

  it('offers the steer box while a job of a newer box goes on', () => {
    expect(jobCanMessage(job('tests'))).toBe(true);
    expect(jobCanMessage(job('merged'))).toBe(false);
    expect(jobCanMessage(job('tests', { stage: undefined }))).toBe(false);
  });
});

describe('the receipt', () => {
  it('says how it went once ended', () => {
    const r = jobReceipt(job('merged'));
    expect(r?.title).toBe('Merged');
    expect(r?.lines.map((l) => [l.key, l.text])).toEqual([
      ['tests', 'Tests passed'],
      ['pullRequest', 'Pull request #48 merged'],
      ['model', 'Claude · claude-opus-5-5'],
      ['time', 'Took 20m'],
    ]);
    expect(jobReceipt(job('checks'))).toBeNull();
    expect(jobReceipt(job('merged', { outcome: 'failed' }))?.tone).toBe('bad');
  });
});

describe("where an ended job's parts go", () => {
  const rows = [
    { id: 'msg_root', at: '2026-11-13T12:26:00Z' },
    { id: 'msg_fixing', at: '2026-11-13T12:34:00Z' },
    { id: 'msg_test_it', at: '2026-11-13T12:45:00Z' },
    { id: 'msg_it_works', at: '2026-11-13T12:46:10Z' },
    { id: 'msg_next', at: '2026-11-13T12:50:00Z' },
  ];
  const ended = { state: 'ended' as const, endedAt: '2026-11-13T12:47:02Z' };

  it('stays under the last message from before it ended once the chat went on', () => {
    expect(jobPartsAfter(ended, rows)).toBe('msg_it_works');
  });

  it("is the thread's last while nobody wrote after it ended", () => {
    expect(jobPartsAfter(ended, rows.slice(0, 4))).toBeNull();
  });

  it("is the thread's last while the job works", () => {
    expect(jobPartsAfter({ state: 'working', endedAt: null }, rows)).toBeNull();
    expect(jobPartsAfter({ state: 'checks', endedAt: null }, rows)).toBeNull();
  });

  it("is the thread's last when the box gave no end time", () => {
    expect(jobPartsAfter({ state: 'ended', endedAt: null }, rows)).toBeNull();
  });
});

describe('the answer', () => {
  it('is the ended job’s whole answer, folded under its receipt', () => {
    const a = jobAnswer(job('merged'));
    expect(a?.text).toContain('**What changed**');
    expect(a?.cut).toBe(false);
    // Only once the job ended, and only when the box gave one.
    expect(jobAnswer(job('checks', { answer: 'Waiting for the checks.' }))).toBeNull();
    expect(jobAnswer(job('merged', { answer: null }))).toBeNull();
    expect(jobAnswer(job('merged', { answer: undefined }))).toBeNull();
  });

  it('isn’t offered when the receipt’s line already says all of it', () => {
    const said = job('merged').receipt?.summary as string;
    expect(jobAnswer(job('merged', { answer: `${said}\n` }))).toBeNull();
    expect(jobAnswer(job('merged', { answer: `${said} And more.` }))?.text).toContain('And more.');
  });

  it('says when the rest is in T3 Code', () => {
    const long = job('merged', { answer: 'x'.repeat(HANDOFF_ANSWER_MAX), url: 'http://t3.test/env/thread' });
    expect(jobAnswer(long)).toMatchObject({ cut: true, url: 'http://t3.test/env/thread' });
  });
});

describe('notifications', () => {
  it('only for needing the person, done and failed', () => {
    expect(jobNotice(job('editing'), job('needs_ok'))).toEqual({
      kind: 'needsYou',
      text: 'Fix the empty backup list needs your OK in T3 Code',
    });
    expect(jobNotice(job('needs_ok'), job('needs_ok'))).toBeNull();
    expect(jobNotice(job('checks'), job('merged'))?.kind).toBe('done');
    expect(
      jobNotice(job('tests'), job('tests', { state: 'ended', outcome: 'failed', stage: 'failed' }))?.kind,
    ).toBe('failed');
    expect(jobNotice(job('tests'), job('tests', { state: 'ended', outcome: 'stopped' }))).toBeNull();
    // A new stage or a question for the assistant is never one.
    expect(jobNotice(job('reading'), job('editing'))).toBeNull();
    expect(jobNotice(job('editing'), job('question'))).toBeNull();
    expect(jobNotice(job('merged'), job('merged'))).toBeNull();
  });

  it('names the job without the assistant in front', () => {
    expect(jobTitle({ title: 'Dusty - Fix it' })).toBe('Fix it');
    expect(jobTitle({ title: 'Fix it - now' })).toBe('Fix it - now');
  });
});

describe('the work line says the step T3 Code is on', () => {
  it('says its latest step, never the furthest stage it reached', () => {
    const line = threadWorkLine(thread(), [job('tests')], NOW);
    expect(line).toMatchObject({ who: 'T3 Code', text: 'running the tests', tone: 'live' });
    expect(line?.progress).toEqual({ kind: 'sweep' });
    // Back at changing the code after the tests: the step says so, whatever stage the box reached.
    const back = threadWorkLine(
      thread(),
      [job('tests', { steps: [{ text: 'Changing the code', detail: null, done: false }] })],
      NOW,
    );
    expect(back?.text).toBe('changing the code');
    expect(threadWorkLine(thread(), [job('fixing')], NOW)?.text).toBe('fixing a failed check');
    const checks = threadWorkLine(thread(), [job('checks')], NOW);
    expect(checks).toMatchObject({ text: 'waiting for the checks on #48', tone: 'calm', progress: null });
    expect(threadWorkLine(thread(), [job('needs_ok')], NOW)).toMatchObject({
      text: 'needs your OK',
      tone: 'warn',
    });
    // No step yet: working on it.
    expect(threadWorkLine(thread(), [job('reading', { steps: [] })], NOW)?.text).toBe('working on it');
  });

  it('keeps an ended job out of a thread’s rows after half an hour', () => {
    const ended = job('merged', { endedAt: new Date(NOW - 40 * 60_000).toISOString() });
    expect(threadHandoffs([ended], 'msg_root', null)).toHaveLength(1);
    expect(threadHandoffs([ended], 'msg_root', null, NOW)).toHaveLength(0);
  });
});
