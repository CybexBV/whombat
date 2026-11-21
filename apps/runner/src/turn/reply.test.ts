import type { TurnEvent, WhombatMcp } from '@whombat/agent-runtime';
import { describe, expect, it } from 'vitest';
import { commandsTurnContext, testContext } from '../test-context';
import { TurnReply } from './reply';

const root = 'msg_disk';
const progress: Extract<TurnEvent, { type: 'tool_call' }> = {
  type: 'tool_call',
  name: 'reply_in_thread',
  id: 'post',
  input: { messageId: root, text: 'On it. I’m checking the disk.' },
};
const worked: Extract<TurnEvent, { type: 'tool_call' }> = {
  type: 'tool_call',
  name: 'terminal',
  id: 'scan',
  input: { command: 'df -h' },
};
function setup(workspace: ReturnType<typeof testContext>['workspace'] = null) {
  const ctx = testContext();
  const reply = new TurnReply({
    ...ctx,
    conversation: { ...ctx.conversation, kind: 'dm' },
    dispatch: { ...ctx.dispatch, trigger: 'dm', threadRootId: root },
    workspace,
  });
  const calls: unknown[] = [];
  const mcp: WhombatMcp = {
    async call(name, args) {
      calls.push({ name, args });
      return { ok: true, isError: false, body: { status: 'ok' } };
    },
    async close() {},
  };
  const deps = { serverUrl: 'http://whombat.test', connectMcp: async () => mcp, log: () => {} };
  return { reply, calls, deps };
}
function posted(reply: TurnReply, text?: string) {
  reply.toolCall(text ? { ...progress, input: { messageId: root, text } } : progress);
  reply.toolResult({ type: 'tool_result', name: progress.name, id: progress.id, ok: true });
}

describe('delivering the answer after a progress message', () => {
  it('posts the final result and its detail hint, exactly once including post-answer upkeep', async () => {
    const { reply, calls, deps } = setup();
    posted(reply);
    reply.toolCall(worked);
    reply.final({ type: 'final', text: 'Old build files are filling the disk.\nMORE: what can be removed' });
    await reply.answered(deps);
    await reply.postFinal(deps);
    expect(calls).toEqual([
      {
        name: 'reply_in_thread',
        args: {
          messageId: root,
          text: 'Old build files are filling the disk.',
          more: 'what can be removed',
        },
      },
    ]);
  });

  it('does not repeat an answer already delivered through a tool', async () => {
    const { reply, calls, deps } = setup();
    posted(reply, 'Old builds are using 78 GB.');
    reply.final({ type: 'final', text: 'Old builds are using 78 GB.' });
    await reply.postFinal(deps);
    expect(calls).toEqual([]);
    expect(reply.needsCompletion).toBe(false);
  });

  // What each card tool answers when it went through, as Whombat's MCP server returns it (its contract).
  const cards: [string, Record<string, unknown>][] = [
    ['council_start', { status: 'started', councilId: 'cnl_1', members: [], message: 'Started.' }],
    ['council_note', { status: 'ok', message: 'Noted.' }],
    ['council_tell', { status: 'told', message: 'The lead has it.' }],
    ['council_finish', { status: 'finished', messageId: 'msg_end', message: 'Finished.' }],
    ['delegate_offer', { status: 'offered', delegationId: 'dlg_1', message: 'Offered.' }],
    ['delegate_offer', { status: 'started', delegationId: 'dlg_1', message: 'Started.' }],
    ['delegate_finish', { status: 'finished', messageId: 'msg_end', message: 'Finished.' }],
  ];

  it.each(cards)('a %s card (%o) is the answer: nothing else goes under it', async (name, structured) => {
    const { reply, calls, deps } = setup();
    reply.toolCall({ type: 'tool_call', name, id: 'card', input: { intro: 'I asked the council.' } });
    reply.toolResult({ type: 'tool_result', name, id: 'card', ok: true, outcome: { structured } });
    reply.final({ type: 'final', text: 'The council is now reviewing it. None of them has answered yet.' });
    await reply.postFinal(deps);
    expect(calls).toEqual([]);
    expect(reply.needsCompletion).toBe(false);
  });

  it.each(cards)('a %s card lets the turn end with NO_REPLY', (name, structured) => {
    const { reply } = setup();
    reply.toolCall({ type: 'tool_call', name, id: 'card', input: {} });
    reply.toolResult({ type: 'tool_result', name, id: 'card', ok: true, outcome: { structured } });
    reply.final({ type: 'final', text: 'NO_REPLY' });
    expect(reply.needsCompletion).toBe(false);
  });

  it.each([
    [
      'refused',
      { ok: true, outcome: { structured: { status: 'refused', reason: 'no_t3', message: 'No.' } } },
    ],
    ['failed', { ok: false }],
    ['without its outcome', { ok: true }],
    ['with another tool’s outcome', { ok: true, outcome: { structured: { status: 'ok' } } }],
  ])('a council card %s is no answer', async (_, result) => {
    const { reply, calls, deps } = setup();
    reply.toolCall({ type: 'tool_call', name: 'council_start', id: 'card', input: {} });
    reply.toolResult({ type: 'tool_result', name: 'council_start', id: 'card', ...result });
    reply.final({ type: 'final', text: 'T3 Code isn’t connected, so I can’t start the council.' });
    await reply.postFinal(deps);
    expect(calls).toHaveLength(1);
  });

  it.each([false, true])(
    'does not count a failed or refused post as delivery (transport ok: %s)',
    async (ok) => {
      const { reply, calls, deps } = setup();
      reply.toolCall(progress);
      reply.toolResult({
        type: 'tool_result',
        name: progress.name,
        id: progress.id,
        ok,
        outcome: { structured: { status: 'blocked' } },
      });
      expect(reply.posted).toBe(false);
      reply.final({ type: 'final', text: 'The disk check is complete.' });
      await reply.postFinal(deps);
      expect(calls).toHaveLength(1);
    },
  );

  it.each(['', 'MORE: what can be removed', 'NO_REPLY'])('requires an answer after work, not %j', (text) => {
    const { reply } = setup();
    posted(reply);
    reply.toolCall(worked);
    reply.toolCall({ type: 'tool_call', name: 'report_done', input: { summary: 'Checked the disk' } });
    reply.final({ type: 'final', text });
    expect(reply.needsCompletion).toBe(true);
  });

  it('allows silence after a delivered answer and its bookkeeping', () => {
    const { reply } = setup();
    posted(reply, 'Old builds are using 78 GB.');
    reply.toolCall({ type: 'tool_call', name: 'report_done', input: { summary: 'Checked the disk' } });
    reply.final({ type: 'final', text: 'NO_REPLY' });
    expect(reply.needsCompletion).toBe(false);
  });

  it('lets a turn without a checkout end with NO_REPLY after it started a run', async () => {
    const { reply, calls, deps } = setup();
    reply.toolCall({ type: 'tool_call', name: 'start_run', id: 'run', input: { title: 'Prune old copies' } });
    reply.toolResult({ type: 'tool_result', name: 'start_run', id: 'run', ok: true });
    reply.final({ type: 'final', text: 'NO_REPLY' });
    expect(reply.needsCompletion).toBe(false);
    await reply.postFinal(deps);
    expect(calls).toEqual([]);
  });

  it('still wants an answer when the run did not start, or the turn reports on it itself', () => {
    const refused = setup().reply;
    refused.toolCall({ type: 'tool_call', name: 'start_run', id: 'run', input: {} });
    refused.toolResult({
      type: 'tool_result',
      name: 'start_run',
      id: 'run',
      ok: true,
      outcome: { structured: { status: 'blocked' } },
    });
    refused.final({ type: 'final', text: 'NO_REPLY' });
    expect(refused.needsCompletion).toBe(true);

    const own = setup(commandsTurnContext().workspace).reply;
    own.toolCall({ type: 'tool_call', name: 'start_run', id: 'run', input: {} });
    own.toolResult({ type: 'tool_result', name: 'start_run', id: 'run', ok: true });
    own.final({ type: 'final', text: 'NO_REPLY' });
    expect(own.needsCompletion).toBe(true);
  });
});
