import { StackRouter } from '@react-navigation/routers';
import { describe, expect, it } from 'vitest';
import { besideBase, besideOptions, listIndex, promotedList, splitRouter } from './splitRouter';

const routeNames = ['Tabs', 'Thread', 'Approval', 'Thing', 'ServersPlace', 'ConnectionsPlace'];
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

describe('Servers and Connections as the list with two pages (servers-connections-places.md)', () => {
  it('makes a list page right above the tabs the list', () => {
    expect(listIndex(stack('ServersPlace', 'Thing').routes)).toBe(1);
    expect(listIndex(stack('Thing', 'ServersPlace').routes)).toBe(0);
    expect(listIndex(stack('Thread').routes)).toBe(0);
  });

  it('makes a place opened higher in the stack the list when the window unfolds', () => {
    const at = (...names: string[]) => promotedList(stack(...names).routes)?.map((r) => r.name) ?? null;
    expect(at('Thread', 'ServersPlace', 'Thing')).toEqual(['Tabs', 'ServersPlace', 'Thing']);
    expect(at('ServersPlace', 'Thing')).toBeNull();
    expect(at('Thread', 'Thing')).toBeNull();
  });

  it('opens a place as the list from anywhere, what was beside going', () => {
    const state = stack('Thread', 'Approval');
    const source = state.routes[2]?.key;
    const next = router(true).getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name: 'ServersPlace' }, source },
      options,
    );
    expect(names(next as never)).toEqual(['Tabs', 'ServersPlace']);
    const other = router(true).getStateForAction(
      next as never,
      { type: 'NAVIGATE', payload: { name: 'ConnectionsPlace' } },
      options,
    );
    expect(names(other as never)).toEqual(['Tabs', 'ConnectionsPlace']);
  });

  it('shows what the place opens beside it, replacing what was there', () => {
    const state = stack('ServersPlace');
    const source = state.routes[1]?.key;
    const open = (s: unknown, thingId: string) =>
      router(true).getStateForAction(
        s as never,
        { type: 'NAVIGATE', payload: { name: 'Thing', params: { thingId } }, source },
        options,
      );
    const first = open(state, 'server:pve-01');
    expect(names(first as never)).toEqual(['Tabs', 'ServersPlace', 'Thing']);
    const second = open(first, 'server:pve-02');
    expect(names(second as never)).toEqual(['Tabs', 'ServersPlace', 'Thing']);
    expect((second as { routes: { params?: object }[] }).routes[2]?.params).toEqual({
      thingId: 'server:pve-02',
    });
  });

  it('keeps the place when it is asked for again, and opens a link beside the tabs', () => {
    const state = stack('ServersPlace', 'Thing');
    expect(besideBase(state as never, { type: 'NAVIGATE', payload: { name: 'ServersPlace' } })).toBe('same');
    const linked = router(true).getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name: 'Thread', params: { messageId: 'm1' } } },
      options,
    );
    expect(names(linked as never)).toEqual(['Tabs', 'Thread']);
  });

  it('opens on top in the right page what the page beside the place opens', () => {
    const state = stack('ServersPlace', 'Thing');
    const source = state.routes[2]?.key;
    const next = router(true).getStateForAction(
      state,
      { type: 'NAVIGATE', payload: { name: 'Approval' }, source },
      options,
    );
    expect(names(next as never)).toEqual(['Tabs', 'ServersPlace', 'Thing', 'Approval']);
  });
});

describe('screens on the right page', () => {
  it('swaps its first screen without a slide and keeps the slide above it', () => {
    const options = { animation: 'slide_from_right', headerShown: false };
    expect(besideOptions(options, 0)).toEqual({ animation: 'none', headerShown: false });
    expect(besideOptions(options, 1)).toBe(options);
  });
});
