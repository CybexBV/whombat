/** Where an outsiders' turn may read and act (docs/decisions/outsiders-turns.md OT-04): its own thread only. */
import { describe, expect, it } from 'vitest';
import type { DispatchRow } from '../runtime/context';
import { outsidersThreadOf, outsideTurnText, type ToolContext, withinTurn } from './tools';

const ROOM = 'cnv_chat';

function turn(over: Partial<DispatchRow>): ToolContext {
  const dispatch = {
    id: 'dsp_1',
    conversationId: ROOM,
    threadRootId: 'msg_root',
    messageId: 'msg_prompt',
    onBehalfOfAccountId: null,
    ...over,
  } as DispatchRow;
  return { dispatch } as ToolContext;
}

describe('an outsiders’ turn’s thread', () => {
  it('is the thread it was asked in, else the one its top-level request opens, else none', () => {
    expect(outsidersThreadOf({ threadRootId: 'msg_root', messageId: 'msg_prompt' })).toBe('msg_root');
    expect(outsidersThreadOf({ threadRootId: null, messageId: 'msg_prompt' })).toBe('msg_prompt');
    expect(outsidersThreadOf({ threadRootId: null, messageId: null })).toBeNull();
  });

  it('keeps it to its own thread: not the top level, another thread or another room', () => {
    const outside = turn({});
    expect(withinTurn(outside, ROOM, 'msg_root')).toBe(true);
    for (const [conversation, thread] of [
      [ROOM, null],
      [ROOM, 'msg_other'],
      ['cnv_other', 'msg_root'],
      ['cnv_other', null],
    ] as const) {
      const said = withinTurn(outside, conversation, thread);
      expect(said, `${conversation} ${thread}`).not.toBe(true);
      // The refusal names where it may go instead.
      expect(said).toContain('msg_root');
      expect(said).toContain(ROOM);
    }
  });

  it('works nowhere without a thread or a request', () => {
    const lost = turn({ threadRootId: null, messageId: null });
    expect(withinTurn(lost, ROOM, null)).not.toBe(true);
    expect(outsideTurnText(lost.dispatch)).not.toContain('threadRootId');
  });

  it('leaves the person’s turn free in every room and thread', () => {
    const person = turn({ onBehalfOfAccountId: 'acc_person' });
    expect(withinTurn(person, 'cnv_other')).toBe(true);
    expect(withinTurn(person, ROOM, 'msg_other')).toBe(true);
  });
});
