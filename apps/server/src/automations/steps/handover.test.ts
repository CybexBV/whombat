import type { JsonObject } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { AutomationRunRow } from '../store';
import { handoverOf } from './dispatch-agent';

const run = {
  definition: {
    steps: [
      { id: 'note', kind: 'post_message' },
      { id: 'ask', kind: 'dispatch_agent' },
      { id: 'again', kind: 'dispatch_agent' },
    ],
  },
} as unknown as Pick<AutomationRunRow, 'definition'>;

const row = (idx: number, promptMessageId: string | null, output: JsonObject = {}) => ({
  idx,
  promptMessageId,
  output,
});

describe('which agent turn gets the files of what started the run', () => {
  it('is the first agent turn, whatever step came before it', () => {
    expect(handoverOf(run, [row(0, null, { messageId: 'msg_1' }), row(1, null), row(2, null)], 1)).toEqual({
      first: true,
    });
  });

  it('is never a later agent step, and a step tried again keeps the ids it was given', () => {
    const steps = [row(0, null), row(1, 'msg_prompt', { triggerFileIds: ['att_a', 7] }), row(2, null)];
    expect(handoverOf(run, steps, 2)).toEqual({ first: false, kept: null });
    expect(handoverOf(run, steps, 1)).toEqual({ first: false, kept: ['att_a'] });
  });

  it('counts only agent steps’ prompts', () => {
    const other = {
      definition: {
        steps: [
          { id: 'x', kind: 'request_approval' },
          { id: 'ask', kind: 'dispatch_agent' },
        ],
      },
    };
    expect(
      handoverOf(
        other as unknown as Pick<AutomationRunRow, 'definition'>,
        [row(0, 'msg_x'), row(1, null)],
        1,
      ),
    ).toEqual({ first: true });
  });
});
