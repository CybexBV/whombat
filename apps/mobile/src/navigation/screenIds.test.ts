import { StackRouter } from '@react-navigation/routers';
import { describe, expect, it } from 'vitest';
import { SCREEN_IDS } from './routes';

const options = {
  routeNames: ['Tabs', 'Thread', 'Conversation', 'Approval'],
  routeParamList: {},
  routeGetIdList: SCREEN_IDS as never,
};

const router = StackRouter({});

function open(state: ReturnType<typeof router.getInitialState>, name: string, params: object) {
  return router.getStateForAction(
    state,
    { type: 'NAVIGATE', payload: { name, params } },
    options,
  ) as typeof state;
}

const shown = (state: { routes: { name: string; params?: object }[] }) =>
  state.routes.map((r) => [r.name, r.params ?? null]);

describe('a thread or conversation opened from another', () => {
  it('is a screen of its own, not the first one with new params', () => {
    let state = router.getInitialState(options);
    state = open(state, 'Thread', { messageId: 'msg_a' });
    const first = state.routes[1]?.key;
    state = open(state, 'Thread', { messageId: 'msg_b' });
    expect(shown(state)).toEqual([
      ['Tabs', null],
      ['Thread', { messageId: 'msg_a' }],
      ['Thread', { messageId: 'msg_b' }],
    ]);
    expect(state.routes[1]?.key).toBe(first);
  });

  it('keeps one screen when the same thread opens at a reply', () => {
    let state = router.getInitialState(options);
    state = open(state, 'Thread', { messageId: 'msg_a' });
    state = open(state, 'Thread', { messageId: 'msg_a', anchor: 'msg_r' });
    expect(shown(state)).toEqual([
      ['Tabs', null],
      ['Thread', { messageId: 'msg_a', anchor: 'msg_r' }],
    ]);
  });

  it('does the same for conversations, by id or by pull request', () => {
    let state = router.getInitialState(options);
    state = open(state, 'Conversation', { conversationId: 'cnv_a' });
    state = open(state, 'Conversation', { conversationId: 'cnv_b' });
    state = open(state, 'Conversation', { prNumber: 7 });
    expect(state.routes.map((r) => r.name)).toEqual(['Tabs', 'Conversation', 'Conversation', 'Conversation']);
  });

  it('does the same for approvals', () => {
    let state = router.getInitialState(options);
    state = open(state, 'Approval', { number: 12 });
    state = open(state, 'Approval', { number: 13 });
    expect(shown(state)).toEqual([
      ['Tabs', null],
      ['Approval', { number: 12 }],
      ['Approval', { number: 13 }],
    ]);
  });
});
