import { HANDOFF_ANSWER_MAX, Handoff, T3_PERSON_SAID_COUNT } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { GhCheckRun, GhPullRequest } from '../github/adapter';
import { type HandoffRow, handoffOf } from './handoff';
import { checkedAnswers } from './job';
import {
  advance,
  checksOf,
  closeStages,
  EMPTY_PROGRESS,
  githubDue,
  githubProgress,
  jobAnswerOf,
  linkPullRequest,
  planOf,
  progressOf,
  progressParts,
  questionOf,
  readProgress,
  readSaid,
  receiptOf,
  retryVerification,
  saidOf,
  stageOfItem,
  summaryOf,
  type T3Progress,
} from './progress';

const now = new Date('2026-11-07T12:00:00Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
const item = (type: string, text: string, min: number, extra: Record<string, unknown> = {}) => ({
  itemId: `i${min}`,
  type,
  text,
  status: 'completed',
  updatedAt: at(min),
  ...extra,
});
const tool = (name: string, min: number, extra: Record<string, unknown> = {}) =>
  item('dynamic_tool', JSON.stringify({ toolName: name, input: {} }), min, extra);
const read = (items: unknown[], thread: Record<string, unknown> = {}) => ({
  thread: { threadId: 'mcp:t', ...thread },
  items,
});
const fresh = (): T3Progress => progressOf(null);

it('persists verification backoff for one run and starts fresh for a new run', () => {
  const first = retryVerification(fresh(), 'done:run1', now);
  expect(progressOf(first).verificationRetry).toEqual({
    key: 'done:run1',
    attempts: 1,
    nextAt: new Date(now.getTime() + 15_000).toISOString(),
  });
  let repeated = first;
  for (let n = 0; n < 20; n++) repeated = retryVerification(repeated, 'done:run1', now);
  expect(repeated.verificationRetry?.nextAt).toBe(at(15));
  expect(retryVerification(repeated, 'done:run2', now).verificationRetry?.attempts).toBe(1);
});

describe('the stage track', () => {
  it('reads each stage from what T3 Code does', () => {
    expect(stageOfItem(item('command_execution', '$ rg settle apps', 0))).toBe('reading');
    expect(stageOfItem(tool('Read', 0))).toBe('reading');
    expect(stageOfItem(tool('TodoWrite', 0))).toBe('plan');
    expect(stageOfItem(item('plan', '- [ ] Fix it', 0))).toBe('plan');
    expect(stageOfItem(item('file_change', '/x/useSettle.tsx', 0))).toBe('editing');
    expect(stageOfItem(tool('Edit', 0))).toBe('editing');
    expect(stageOfItem(item('command_execution', '$ pnpm vitest run', 0))).toBe('tests');
    expect(stageOfItem(item('subagent', 'Review the diff', 0, { title: 'Code review' }))).toBe('review');
    expect(stageOfItem(item('subagent', 'Find the files', 0))).toBeNull();
    expect(stageOfItem(item('command_execution', '$ gh pr create --fill', 0))).toBe('pull_request');
    expect(stageOfItem(item('user_message', 'Fix it', 0))).toBeNull();
  });

  it('moves only forward, with each stage’s start and end', () => {
    let p = readProgress(
      fresh(),
      read([
        item('user_message', 'Fix it', 0),
        item('reasoning', '', 1),
        tool('TodoWrite', 2),
        item('file_change', '/x/a.ts', 4),
        item('command_execution', '$ pnpm test', 9),
      ]),
      now,
    );
    expect(p.stage).toBe('tests');
    expect(p.stages.map((s) => [s.stage, s.startedAt, s.endedAt])).toEqual([
      ['reading', at(1), at(2)],
      ['plan', at(2), at(4)],
      ['editing', at(4), at(9)],
      ['tests', at(9), null],
    ]);
    expect(p.tests).toBe('passed');
    // A fix after the tests stays at the tests; a failed test run says so.
    p = readProgress(
      p,
      read([
        item('file_change', '/x/a.ts', 11),
        item('command_execution', '$ pnpm test', 12, { status: 'failed' }),
      ]),
      now,
    );
    expect(p.stage).toBe('tests');
    expect(p.stages).toHaveLength(4);
    expect(p.tests).toBe('failed');
  });

  it('marks the job asked when the thread gets a message, and keeps it until it is told', () => {
    let p = readProgress(fresh(), read([item('command_execution', '$ pnpm test', 3)]), now);
    expect(p.asked).toBe(false);
    p = readProgress(p, read([item('user_message', 'Also remove the old page.', 7)]), now);
    expect(p.asked).toBe(true);
    expect(progressOf(JSON.parse(JSON.stringify(p))).asked).toBe(true);
    expect(progressOf({ ...p, asked: 'yes' }).asked).toBe(false);
    // Told, then the last items read again: the message read before isn't new.
    p = { ...p, asked: false, readTo: 7 };
    const said = (text: string, position: number) => item('user_message', text, position, { position });
    expect(readProgress(p, read([said('Also remove the old page.', 7)]), now).asked).toBe(false);
    expect(readProgress(p, read([said('And the logout.', 8)]), now).asked).toBe(true);
  });

  it('keeps what the person wrote in T3 Code themselves, not what an agent sent it', () => {
    const person = (text: string, position: number, extra: Record<string, unknown> = {}) =>
      item('user_message', text, position, {
        position,
        createdBy: 'user',
        creationSource: 'mobile',
        ...extra,
      });
    const agent = (text: string, position: number) =>
      item('user_message', text, position, { position, createdBy: 'agent', creationSource: 'mcp' });
    let p = readProgress(
      fresh(),
      read([agent('Remove needless complexity.', 0), person('Remove the endpoints, then deploy.', 4)]),
      now,
    );
    expect(p.personSaid).toEqual(['Remove the endpoints, then deploy.']);
    // The pass reads the last items again: the same message isn't kept twice.
    p = readProgress({ ...p, readTo: 4 }, read([person('Remove the endpoints, then deploy.', 4)]), now);
    expect(p.personSaid).toHaveLength(1);
    // A message the read cut short says so; only the latest few are kept.
    p = readProgress(p, read([person('Long', 5, { textTruncated: true })]), now);
    expect(p.personSaid.at(-1)).toBe('Long…');
    for (let n = 6; n < 12; n++) p = readProgress(p, read([person(`Message ${n}`, n)]), now);
    expect(p.personSaid).toHaveLength(T3_PERSON_SAID_COUNT);
    expect(p.personSaid.at(-1)).toBe('Message 11');
    expect(progressOf(JSON.parse(JSON.stringify(p))).personSaid).toEqual(p.personSaid);
    expect(progressOf({ ...p, personSaid: 'deploy' }).personSaid).toEqual([]);
    // New work on an idle thread reads its last items again: what they wrote before it was handed over isn't new.
    const handedOver = new Date(at(5));
    expect(readProgress(fresh(), read([person('Old words', 3)]), now, handedOver).personSaid).toEqual([]);
    expect(readProgress(fresh(), read([person('New words', 6)]), now, handedOver).personSaid).toEqual([
      'New words',
    ]);
  });

  it('reaches the pull request when T3 Code links one, and merged when it merged', () => {
    const pr = {
      url: 'https://github.com/acme/web/pull/48',
      number: 48,
      repository: 'acme/web',
      state: 'open',
    };
    let p = readProgress(fresh(), read([item('file_change', '/x/a.ts', 1)], { pullRequests: [pr] }), now);
    expect(p.stage).toBe('pull_request');
    expect(p.pullRequest).toEqual({ number: 48, url: pr.url, repo: 'acme/web', state: 'open' });
    p = readProgress(p, read([], { pullRequests: [{ ...pr, state: 'merged' }] }), now);
    expect(p.stage).toBe('merged');
    expect(p.stages.every((s) => s.endedAt)).toBe(true);
  });

  it('skips stages it never saw, without times', () => {
    const p = advance(advance(fresh(), 'reading', at(0)), 'tests', at(5));
    expect(p.stages.map((s) => s.stage)).toEqual(['reading', 'tests']);
  });

  it('counts a file written from the shell as editing, whoever runs the shell', () => {
    const command = (text: string) => stageOfItem(item('command_execution', text, 0));
    // Claude runs its commands bare; Codex wraps each in `/bin/bash -lc '…'`, its heredoc's lines after the first.
    expect(command("$ cat > src/upload.test.ts <<'EOF'\nimport { it } from 'vitest';")).toBe('editing');
    expect(command(`$ /bin/bash -lc "cat > web/src/x.ts <<'EOF'\nexport const x = 1;\nEOF"`)).toBe('editing');
    expect(command("$ cat <<'EOF' > docs/notes.md\n# Notes")).toBe('editing');
    expect(command("$ cat <<'EOF' | tee -a CHANGELOG.md\n- Fixed it")).toBe('editing');
    expect(command('$ printf "%s\\n" fixed >> NOTES.md')).toBe('editing');
    expect(command("$ cd web && sed -i 's/old/new/' src/app.ts")).toBe('editing');
    expect(command('$ git apply fix.patch')).toBe('editing');
    // Reading, a test's log or a temporary file is no edit.
    expect(command('$ cat README.md')).toBe('reading');
    expect(command(`$ /bin/bash -lc "rg -n 'KIWI_MOCK' web/mock"`)).toBe('reading');
    expect(command('$ pnpm test > /tmp/test.log 2>&1')).toBe('tests');
    expect(command('$ pnpm test 2>&1 | tee test.log')).toBe('tests');
    expect(command("$ cat > /tmp/script.sh <<'EOF'")).not.toBe('editing');
    expect(command('$ echo done')).toBeNull();
    expect(command('$ echo hi > /dev/null')).toBeNull();
  });

  it('keeps the branch T3 Code says the thread works on', () => {
    const p = readProgress(fresh(), read([], { branch: 'tracker/fix-22' }), now);
    expect(p.branch).toBe('tracker/fix-22');
    expect(readProgress(p, read([]), now).branch).toBe('tracker/fix-22');
    expect(progressOf(JSON.parse(JSON.stringify({ ...p, readTo: 41 })))).toMatchObject({
      branch: 'tracker/fix-22',
      readTo: 41,
    });
  });

  it('takes a pull request opened from its branch as its own, unless it has one', () => {
    const pr = { repo: 'acme/web', number: 52, url: 'https://github.com/acme/web/pull/52' };
    const ended = closeStages(readProgress(fresh(), read([item('file_change', '/x/a.ts', 1)]), now), at(5));
    const linked = linkPullRequest(ended, pr, new Date(at(8)));
    expect(linked.pullRequest).toEqual({ ...pr, state: 'open' });
    expect(linked.stage).toBe('pull_request');
    // The run's end closed the stage it was on; the pull request opened after it goes on.
    const closed = closeStages(linked, at(5));
    expect(closed.stages.map((s) => [s.stage, s.endedAt])).toEqual([
      ['reading', at(1)],
      ['editing', at(5)],
      ['pull_request', null],
    ]);
    expect(linkPullRequest(linked, { ...pr, number: 53 }, now)).toBe(linked);
  });
});

describe('the plan', () => {
  it('reads a to-do call, a plan’s steps and a checklist', () => {
    const todos = JSON.stringify({
      toolName: 'TodoWrite',
      input: {
        todos: [
          { content: 'Find where Settle is decided', status: 'completed' },
          { content: 'Fix the empty list', status: 'in_progress' },
          { content: 'Add a test', status: 'pending' },
        ],
      },
    });
    expect(planOf({ type: 'dynamic_tool', text: todos })).toEqual([
      { text: 'Find where Settle is decided', state: 'done' },
      { text: 'Fix the empty list', state: 'now' },
      { text: 'Add a test', state: 'next' },
    ]);
    expect(
      planOf({ type: 'plan', text: JSON.stringify({ plan: [{ step: 'Read it', status: 'inProgress' }] }) }),
    ).toEqual([{ text: 'Read it', state: 'now' }]);
    expect(planOf({ type: 'plan', text: '- [x] Read it\n- [ ] Fix it\nNot a step' })).toEqual([
      { text: 'Read it', state: 'done' },
      { text: 'Fix it', state: 'next' },
    ]);
  });

  it('reads a cut-off call’s steps, and nothing it can’t read', () => {
    const cut =
      '{"toolName":"TodoWrite","input":{"todos":[{"content":"Read \\"it\\"","status":"completed"},{"cont';
    expect(planOf({ type: 'dynamic_tool', text: cut })).toEqual([{ text: 'Read "it"', state: 'done' }]);
    expect(planOf({ type: 'plan', text: 'I will look into it.' })).toEqual([]);
  });
});

describe('GitHub’s side', () => {
  const pr = (over: Partial<GhPullRequest> = {}): GhPullRequest =>
    ({
      number: 48,
      url: 'https://github.com/acme/web/pull/48',
      title: 'Fix the empty backup list',
      headSha: 'a'.repeat(40),
      state: 'open',
      merged: false,
      draft: false,
      additions: 340,
      deletions: 58,
      changedFiles: 12,
      ...over,
    }) as GhPullRequest;
  const run = (id: number, name: string, status: string, conclusion: string | null): GhCheckRun => ({
    id,
    name,
    headSha: 'a'.repeat(40),
    status,
    conclusion,
    startedAt: null,
    completedAt: null,
    url: `https://github.com/acme/web/runs/${id}`,
    outputTitle: null,
    outputSummary: null,
  });
  const withPr: T3Progress = {
    ...fresh(),
    stage: 'pull_request',
    pullRequest: { number: 48, url: 'https://github.com/acme/web/pull/48', repo: 'acme/web', state: 'open' },
  };

  it('lists the latest run of each check and the statuses beside them', () => {
    const checks = checksOf(
      [
        run(1, 'test', 'completed', 'failure'),
        run(2, 'test', 'in_progress', null),
        run(3, 'lint', 'completed', 'success'),
      ],
      [{ id: 1, context: 'deploy', state: 'pending', createdAt: null, updatedAt: null, url: null }],
    );
    expect(checks.map((c) => [c.name, c.state])).toEqual([
      ['test', 'running'],
      ['lint', 'passed'],
      ['deploy', 'running'],
    ]);
  });

  it('keeps the changes and checks, reaches checks, and counts a pushed fix after a failure', () => {
    const failed = [{ name: 'test', state: 'failed' as const, url: null }];
    let p = githubProgress(
      withPr,
      {
        pr: pr(),
        files: [
          { path: 'src/a.ts', add: 300, del: 50 },
          { path: 'b.ts', add: 40, del: 8 },
        ],
        checks: failed,
      },
      now,
    );
    expect(p.stage).toBe('checks');
    expect(p.github?.changes).toMatchObject({
      fileCount: 12,
      additions: 340,
      deletions: 58,
      summary: 'Fix the empty backup list',
      url: 'https://github.com/acme/web/pull/48/files',
    });
    expect(p.failing).toEqual({ name: 'test', head: 'a'.repeat(40) });
    expect(progressParts(p, null).checks).toEqual({ runs: failed, failing: 'test', attempts: 0 });
    // A new commit: one fix attempt; its checks still run.
    p = githubProgress(
      p,
      {
        pr: pr({ headSha: 'b'.repeat(40) }),
        files: null,
        checks: [{ name: 'test', state: 'running', url: null }],
      },
      new Date(now.getTime() + 60_000),
    );
    expect(p.attempts).toBe(1);
    expect(p.failing).toBeNull();
    expect(p.github?.changes?.fileCount).toBe(12);
    // Merged: the end of the track.
    p = githubProgress(p, { pr: pr({ merged: true, state: 'closed' }), files: null, checks: [] }, now);
    expect(p.stage).toBe('merged');
    expect(p.pullRequest?.state).toBe('merged');
  });

  it('reads GitHub at most once a minute, and only for an open pull request', () => {
    expect(githubDue(fresh(), now)).toBe(false);
    expect(githubDue(withPr, now)).toBe(true);
    const read = { ...withPr, github: { at: now.toISOString(), head: null, changes: null, checks: null } };
    expect(githubDue(read, new Date(now.getTime() + 30_000))).toBe(false);
    expect(githubDue(read, new Date(now.getTime() + 60_000))).toBe(true);
  });
});

describe('the question and the receipt', () => {
  const request = {
    threadId: 'mcp:t',
    requestId: 'req-1',
    questions: [
      {
        id: 'q1',
        question: 'Keep the old list as a fallback?',
        options: [
          { label: 'Yes', description: null },
          { label: 'No', description: 'Remove it' },
        ],
        multiSelect: false,
      },
    ],
  };

  it('shows the first question with its options', () => {
    expect(questionOf(request)).toEqual({
      requestId: 'req-1',
      questionId: 'q1',
      text: 'Keep the old list as a fallback?',
      options: [
        { label: 'Yes', description: null },
        { label: 'No', description: 'Remove it' },
      ],
      multiSelect: false,
    });
    expect(questionOf(null)).toBeNull();
  });

  it('answers only with the question’s own options', () => {
    expect(checkedAnswers(request, { q1: 'Yes' })).toEqual({ q1: 'Yes' });
    expect(checkedAnswers(request, { q1: 'Maybe' })).toBeNull();
    expect(checkedAnswers(request, { q1: ['Yes', 'No'] })).toBeNull();
    expect(checkedAnswers(request, { q9: 'Yes' })).toBeNull();
    const open = {
      ...request,
      questions: [{ ...request.questions[0], options: [] } as (typeof request.questions)[0]],
    };
    expect(checkedAnswers(open, { q1: 'Keep it for a week' })).toEqual({ q1: 'Keep it for a week' });
  });

  it('sums the job up in its answer’s first sentence, its tests and its time', () => {
    expect(summaryOf('**Fixed** the empty [backup list](x). Tests pass.\n\n- more')).toBe(
      'Fixed the empty backup list.',
    );
    expect(summaryOf(null)).toBeNull();
    const p = { ...advance(fresh(), 'reading', at(0)), tests: 'passed' as const };
    expect(receiptOf(p, 'Done. All good.', null, new Date(at(14)))).toEqual({
      summary: 'Done.',
      tests: 'passed',
      durationMs: 14 * 60_000,
      screenshot: null,
    });
  });

  it('keeps the whole answer as written, its start when it is longer than the thread keeps', () => {
    const answer = '**Fixed** the empty [backup list](x).\n\n- `list.ts` reads every backup\n';
    expect(jobAnswerOf(answer)).toBe(answer.trim());
    expect(jobAnswerOf('  \n')).toBeNull();
    expect(jobAnswerOf(null)).toBeNull();
    const long = `Start. ${'x'.repeat(HANDOFF_ANSWER_MAX * 2)}`;
    const kept = jobAnswerOf(long) as string;
    expect(kept.length).toBe(HANDOFF_ANSWER_MAX);
    expect(kept.startsWith('Start. ')).toBe(true);
    // Kept with the progress, and read back the same.
    expect(progressOf({ ...EMPTY_PROGRESS, answer }).answer).toBe(answer.trim());
    expect(progressOf({ ...EMPTY_PROGRESS, answer: 7 }).answer).toBeNull();
  });
});

describe('a hand-over carries its progress', () => {
  const row = (over: Partial<HandoffRow> = {}): HandoffRow => ({
    threadId: 'mcp:t',
    title: 'Dusty - Fix Settle',
    conversationId: 'cnv_chat00000001',
    threadRootId: 'msg_root00000001',
    agentId: 'agt_dusty0000001',
    state: 'watching',
    armedAt: new Date(at(-10)),
    status: 'running',
    pending: null,
    asks: null,
    steps: [],
    program: 'Claude · claude-opus-5-5',
    url: null,
    prs: null,
    runStartedAt: new Date(at(-10)),
    runEndedAt: null,
    progress: {
      ...EMPTY_PROGRESS,
      ...advance(fresh(), 'editing', at(-5)),
      receipt: { summary: 'x', tests: null, durationMs: 1, screenshot: null },
      answer: 'x. And **how** it was done.',
    },
    ...over,
  });

  it('shows the stage at work, its receipt only once ended, and failed off the track', () => {
    const working = handoffOf(row(), now);
    expect(working).toMatchObject({ state: 'working', stage: 'editing', receipt: null, question: null });
    const ended = handoffOf(row({ status: 'completed', runEndedAt: new Date(at(-1)) }), now);
    expect(ended).toMatchObject({ state: 'ended', stage: 'editing', receipt: { summary: 'x' } });
    const failed = handoffOf(row({ status: 'failed', runEndedAt: new Date(at(-1)) }), now);
    expect(failed?.stage).toBe('failed');
  });

  it('carries the whole answer once ended, and none while a run works or waits for its checks', () => {
    const ended = handoffOf(
      row({ agentId: 'prn_dusty', status: 'completed', runEndedAt: new Date(at(-1)) }),
      now,
    );
    expect(ended?.answer).toBe('x. And **how** it was done.');
    expect(Handoff.parse(ended).answer).toBe(ended?.answer);
    // A follow-up run at work on the same thread: the last run's answer isn't this one's.
    expect(handoffOf(row(), now)?.answer).toBeNull();
    const checks = handoffOf(row({ status: 'completed', prs: ['#48'], runEndedAt: new Date(at(-1)) }), now);
    expect(checks).toMatchObject({ state: 'checks', answer: null });
    // A failed run's last words are there to read too; a job from before the answer has none.
    expect(handoffOf(row({ status: 'failed', runEndedAt: new Date(at(-1)) }), now)?.answer).toContain('how');
    const old = {
      ...EMPTY_PROGRESS,
      receipt: { summary: 'x', tests: null, durationMs: 1, screenshot: null },
    };
    const { answer: _, ...before } = old;
    expect(handoffOf(row({ status: 'completed', progress: before }), now)?.answer).toBeNull();
    // An older app's contract still reads a hand-over without the field.
    const { answer: __, ...without } = ended as Handoff;
    expect(Handoff.parse(without).answer).toBeUndefined();
  });

  it('keeps an ended job with a receipt listed for days, one without for half an hour', () => {
    const idle = { state: 'idle' as const, status: 'completed', runEndedAt: new Date(at(-120)) };
    expect(handoffOf(row(idle), now)?.state).toBe('ended');
    expect(handoffOf(row({ ...idle, progress: null }), now)).toBeNull();
  });

  it('shows a question only while T3 Code waits on it', () => {
    const q = questionOf({
      threadId: 'mcp:t',
      requestId: 'r',
      questions: [{ id: 'q', question: 'Which?', options: [], multiSelect: false }],
    });
    const progress = { ...fresh(), question: q };
    expect(handoffOf(row({ pending: 'question', progress }), now)?.question?.text).toBe('Which?');
    expect(handoffOf(row({ pending: null, progress }), now)?.question).toBeNull();
  });
});

describe('what a lead thread says while it works', () => {
  const message = (position: number, type: string, text: string) => ({ position, type, text });

  it('keeps its latest words and the items it said it finished, from where it was read to', () => {
    const p = readSaid(EMPTY_PROGRESS, {
      items: [
        message(0, 'user_message', 'Item 1: …'),
        message(2, 'assistant_message', 'I’ll read the code first.'),
        message(17, 'assistant_message', 'Item 1 done: Removed the empty crates.\nThe route test is next.'),
        message(48, 'assistant_message', '**Item 3 done:** Errors keep their cause. `Item 4 done`'),
      ],
    });
    expect(p.saidAt).toBe(48);
    expect(p.reported).toEqual({
      '1': 'Removed the empty crates.',
      '3': 'Errors keep their cause. `Item 4 done',
    });
    expect(p.said).toBe('Item 3 done: Errors keep their cause. Item 4 done');
    // Read on from there: the next message moves the words; a message to it starts again.
    const next = readSaid(p, { items: [message(60, 'user_message', 'Also do item 5.')] });
    expect(next).toMatchObject({ said: null, reported: {}, saidAt: 60 });
    expect(progressOf(JSON.parse(JSON.stringify(p)))).toMatchObject({
      said: p.said,
      reported: p.reported,
      saidAt: 48,
    });
  });

  it('shows whole sentences in plain text, short', () => {
    expect(saidOf('The **route** test found `four` places. They now refuse strangers first.')).toBe(
      'The route test found four places. They now refuse strangers first.',
    );
    const long = saidOf(`${'word '.repeat(60)}end.`);
    expect(long?.length).toBeLessThanOrEqual(200);
    expect(saidOf('   ')).toBeNull();
  });
});
