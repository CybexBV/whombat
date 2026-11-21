import { describe, expect, it } from 'vitest';
import {
  HANDOFF_ENDED_SHOWN_MS,
  type HandoffRow,
  handoffOf,
  mergeSteps,
  programOf,
  shownSteps,
} from './handoff';

const item = (id: string, type: string, text: string, status = 'completed', title: string | null = null) => ({
  itemId: id,
  type,
  text,
  status,
  title,
});
const read = (...items: Record<string, unknown>[]) => ({ thread: { threadId: 'mcp:t' }, items });

describe('steps in plain words', () => {
  it('says what a command, a file change and a tool do, and keeps T3 Code’s words for the details', () => {
    const steps = shownSteps(
      mergeSteps(
        null,
        read(
          item('0', 'user_message', 'Fix it'),
          item(
            '1',
            'command_execution',
            '$ Preparing workspace\nWorkspace preparation completed.',
            'completed',
            'Workspace ready',
          ),
          item('2', 'command_execution', '$ rg settle apps/mobile'),
          item('3', 'file_change', '/home/alex/x/apps/mobile/src/useSettle.tsx'),
          item('4', 'command_execution', '$ pnpm --filter @whombat/mobile test', 'running'),
        ),
      ),
    );
    expect(steps.map((s) => s.text)).toEqual([
      'Getting the workspace ready',
      'Reading the code',
      'Changing useSettle.tsx',
      'Running the tests',
    ]);
    expect(steps.at(-1)).toMatchObject({ detail: 'pnpm --filter @whombat/mobile test', done: false });
  });

  it('says a file written from the shell is changed, and reads through the shell Codex wraps commands in', () => {
    const steps = shownSteps(
      mergeSteps(
        null,
        read(
          item('1', 'command_execution', `$ /bin/bash -lc "rg -n 'settle' apps"`),
          item('2', 'command_execution', "$ cat > apps/web/src/upload.test.ts <<'EOF'\nimport x"),
          item('3', 'command_execution', '$ git apply /tmp/fix.patch'),
        ),
      ),
    );
    expect(steps.map((s) => s.text)).toEqual([
      'Reading the code',
      'Changing upload.test.ts',
      'Changing the code',
    ]);
  });

  it('updates a step it had by its item, adds new ones, and shows the same words in a row once', () => {
    const first = mergeSteps(
      null,
      read(item('a', 'command_execution', '$ ls', 'completed'), item('b', 'reasoning', '', 'running')),
    );
    const next = mergeSteps(
      first,
      read(item('b', 'reasoning', '', 'completed'), item('c', 'command_execution', '$ cat x')),
    );
    expect(next.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(next[1]?.done).toBe(true);
    const reads = mergeSteps(
      null,
      read(item('1', 'command_execution', '$ ls'), item('2', 'command_execution', '$ grep x y')),
    );
    expect(shownSteps(reads).map((s) => s.text)).toEqual(['Reading the code']);
  });

  it('names the program and its model', () => {
    expect(programOf({ thread: { providerInstanceId: 'codex', model: 'gpt-5.5' } })).toBe('Codex · gpt-5.5');
    expect(programOf({ thread: { providerInstanceId: 'claudeAgent' } })).toBe('Claude');
    expect(programOf({ thread: {} })).toBeNull();
  });
});

describe('a watch as the person sees it', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  const row = (over: Partial<HandoffRow> = {}): HandoffRow => ({
    threadId: 'mcp:t',
    title: 'Dusty - Fix Settle',
    conversationId: 'cnv_chat00000001',
    threadRootId: 'msg_root00000001',
    agentId: 'prn_dusty',
    state: 'watching',
    armedAt: new Date('2026-11-03T09:50:00Z'),
    status: 'running',
    pending: null,
    asks: null,
    steps: null,
    program: null,
    url: null,
    prs: null,
    runStartedAt: new Date('2026-11-03T09:51:00Z'),
    runEndedAt: null,
    ...over,
  });

  it('is at work, finishing up, asking, waiting for the person’s OK or for checks', () => {
    expect(handoffOf(row({ status: null, runStartedAt: null }), now)).toMatchObject({
      state: 'working',
      since: '2026-11-03T09:50:00.000Z',
    });
    expect(handoffOf(row(), now)).toMatchObject({ state: 'working', since: '2026-11-03T09:51:00.000Z' });
    expect(handoffOf(row({ status: 'waiting' }), now)?.state).toBe('finishing');
    expect(handoffOf(row({ pending: 'question', asks: 'Which branch?' }), now)).toMatchObject({
      state: 'asked',
      asks: 'Which branch?',
    });
    expect(handoffOf(row({ pending: 'approval', asks: 'hello.txt' }), now)?.state).toBe('needs_ok');
    expect(
      handoffOf(row({ status: 'completed', prs: ['https://github.com/o/r/pull/342'], runEndedAt: now }), now),
    ).toMatchObject({ state: 'checks', pullRequests: ['https://github.com/o/r/pull/342'] });
  });

  it('is still finishing while its end is held back, and names its result message once there is one', () => {
    const ended = new Date(now.getTime() - 60_000);
    const held = { held: { key: 'done:run-1', since: ended.toISOString() } };
    expect(handoffOf(row({ status: 'completed', runEndedAt: ended, progress: held }), now)).toMatchObject({
      state: 'finishing',
      outcome: null,
      receipt: null,
    });
    expect(
      handoffOf(
        row({ state: 'idle', status: 'completed', runEndedAt: ended, resultMessageId: 'msg_r1' }),
        now,
      ),
    ).toMatchObject({ state: 'ended', resultMessageId: 'msg_r1' });
    expect(handoffOf(row(), now)?.resultMessageId).toBeNull();
  });

  it('has ended, how, for a while after the watch went quiet; nothing for a watch stopped or gone quiet', () => {
    const ended = new Date(now.getTime() - 60_000);
    expect(handoffOf(row({ status: 'completed', runEndedAt: ended }), now)).toMatchObject({
      state: 'ended',
      outcome: 'completed',
      endedAt: ended.toISOString(),
    });
    expect(handoffOf(row({ state: 'idle', status: 'failed', runEndedAt: ended }), now)?.outcome).toBe(
      'failed',
    );
    expect(handoffOf(row({ state: 'idle', status: 'interrupted', runEndedAt: ended }), now)?.outcome).toBe(
      'stopped',
    );
    const long = new Date(now.getTime() - HANDOFF_ENDED_SHOWN_MS - 1);
    expect(handoffOf(row({ state: 'idle', status: 'completed', runEndedAt: long }), now)).toBeNull();
    expect(handoffOf(row({ state: 'idle' }), now)).toBeNull();
  });
});
