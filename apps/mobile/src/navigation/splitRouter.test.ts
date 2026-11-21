import { StackRouter } from '@react-navigation/routers';
import { describe, expect, it } from 'vitest';
import { besideBase, splitRouter } from './splitRouter';

const routeNames = ['Tabs', 'Thread', 'Approval', 'Thing'];
const options = {
  routeNames,
  routeParamList: {},
  routeGetIdList: {},
};

function router(two: boolean) {
  const original = StackRouter({});
  return { ...original, ...splitRouter(original, () => two) };
}

function stack(...names: string[]) {
  const r = router(false);
  let state = r.getInitialState(options);
  for (const name of names)
    state = r.getStateForAction(state, { type: 'PUSH', payload: { name } }, options) as never;
  return state;
}

const names = (state: { routes: { name: string }[] } | null) => state?.routes.map((r) => r.name);

describe('the stack with two pages', () => {
  it('replaces what the right page shows when the list opens something', () => {
    const state = stack('Thread', 'Approval');
    const next = router(true).getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name: 'Thing', params: { thingId: 'pve-02' } }, source: 'ChatRoom-1' },
      options,
    );
    expect(names(next as never)).toEqual(['Tabs', 'Thing']);
  });

  it('opens on top in the right page when the right page opens something', () => {
    const state = stack('Thread');
    const source = state.routes[1]?.key;
    const next = router(true).getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name: 'Approval' }, source },
      options,
    );
    expect(names(next as never)).toEqual(['Tabs', 'Thread', 'Approval']);
  });

  it('treats a link or a tapped notification (no source) as the list’s', () => {
    const state = stack('Thread', 'Approval');
    const next = router(true).getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name: 'Thread' } },
      options,
    );
    expect(names(next as never)).toEqual(['Tabs', 'Thread']);
  });

  it('leaves the state alone when the list asks for what is already shown', () => {
    const state = stack();
    const opened = router(true).getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name: 'Thread', params: { messageId: 'm1' } } },
      options,
    );
    expect(
      besideBase(opened as never, {
        type: 'NAVIGATE',
        payload: { name: 'Thread', params: { messageId: 'm1' } },
      }),
    ).toBe('same');
    const again = router(true).getStateForAction(
      opened as never,
      { type: 'NAVIGATE', payload: { name: 'Thread', params: { messageId: 'm1' } } },
      options,
    );
    expect(again).toBe(opened);
  });

  it('goes back to the list’s own route when the right page goes to the tabs', () => {
    const state = stack('Thread', 'Approval');
    const next = router(true).getStateForAction(
      state,
      {
        type: 'NAVIGATE',
        payload: { name: 'Tabs', params: { screen: 'Watch' } },
        source: state.routes[2]?.key,
      },
      options,
    );
    expect(names(next as never)).toEqual(['Tabs']);
  });

  it('keeps the stack’s own rules with one page', () => {
    const state = stack('Thread');
    const next = router(false).getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name: 'Approval' }, source: 'ChatRoom-1' },
      options,
    );
    expect(names(next as never)).toEqual(['Tabs', 'Thread', 'Approval']);
  });
});
