import { bootstrap } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  isGoneError,
  NAV_MAX_AGE_MS,
  NAV_MAX_DEPTH,
  RESTORE_WATCH,
  type RestoreWorld,
  restorableNavigation,
  restorableRoute,
  type SavedNavigation,
  snapshotNavigation,
} from './persist';

const b = bootstrap();
const world: RestoreWorld = { sidebar: b.sidebar, managed: false };
/** PR #482's room, the contracts' world's branch room. */
const room = b.sidebar.branchRooms[0];
/** Mara's Chat. */
const chat = b.sidebar.dms[0];
const NOW = Date.UTC(2026, 9, 7, 12, 0);
const BURROW = b.burrow.slug;

/** A root state as React Navigation keeps it (keys and all). */
const live = {
  key: 'stack-1',
  index: 3,
  routeNames: ['Tabs', 'Conversation', 'Run'],
  routes: [
    {
      key: 'Tabs-1',
      name: 'Tabs',
      state: {
        key: 'tab-1',
        index: 1,
        routes: [
          { key: 'Inbox-1', name: 'Inbox' },
          { key: 'Channels-1', name: 'Channels' },
        ],
      },
    },
    {
      key: 'Conversation-1',
      name: 'Conversation',
      params: { conversationId: room?.id },
    },
    { key: 'Thread-1', name: 'Thread', params: { messageId: 'msg_1', back: 'Back', onDone: () => {} } },
    { key: 'Run-1', name: 'Run', params: { number: 1907 } },
    { key: 'Above-1', name: 'Share' },
  ],
};

const saved = (state = snapshotNavigation(live, BURROW, NOW - 1000)): SavedNavigation => {
  if (!state) throw new Error('nothing saved');
  return state;
};

describe('where the person was, across a killed process (MN-01)', () => {
  it('keeps names, plain params and the open tab, up to the focused screen, without keys', () => {
    const s = saved();
    expect(s.state).toEqual({
      index: 3,
      routes: [
        { name: 'Tabs', state: { index: 1, routes: [{ name: 'Inbox' }, { name: 'Channels' }] } },
        { name: 'Conversation', params: { conversationId: room?.id } },
        { name: 'Thread', params: { messageId: 'msg_1', back: 'Back' } },
        { name: 'Run', params: { number: 1907 } },
      ],
    });
    expect(snapshotNavigation(undefined, BURROW, NOW)).toBeNull();
  });

  it('restores the screens above the tabs, which open on Chat (AP-2645)', () => {
    expect(restorableNavigation(saved(), { now: NOW, burrow: BURROW, world })).toEqual({
      index: 3,
      routes: [
        { name: 'Tabs' },
        { name: 'Conversation', params: { conversationId: room?.id } },
        { name: 'Thread', params: { messageId: 'msg_1', back: 'Back' } },
        { name: 'Run', params: { number: 1907 } },
      ],
    });
  });

  it('nothing after 24 hours, from another burrow, or of another format', () => {
    expect(
      restorableNavigation(saved(), { now: NOW + NAV_MAX_AGE_MS, burrow: BURROW, world }),
    ).toBeUndefined();
    expect(restorableNavigation(saved(), { now: NOW, burrow: 'other-burrow', world })).toBeUndefined();
    expect(
      restorableNavigation({ ...saved(), v: 2 } as unknown as SavedNavigation, {
        now: NOW,
        burrow: BURROW,
        world,
      }),
    ).toBeUndefined();
    expect(restorableNavigation(null, { now: NOW, burrow: BURROW, world })).toBeUndefined();
  });

  it('cuts the stack at the first screen whose data is gone', () => {
    const gone = saved();
    const routes = gone.state.routes.map((r) =>
      r.name === 'Conversation' ? { ...r, params: { conversationId: 'cnv_left_long_ago' } } : r,
    );
    expect(
      restorableNavigation(
        { ...gone, state: { ...gone.state, routes } },
        { now: NOW, burrow: BURROW, world },
      ),
    ).toBeUndefined();
  });

  it('checks conversations and Files places against the sidebar', () => {
    const one = (name: string, params?: Record<string, unknown>) =>
      restorableNavigation(
        {
          v: 1,
          savedAt: NOW,
          burrow: BURROW,
          state: { index: 1, routes: [{ name: 'Tabs' }, params ? { name, params } : { name }] },
        },
        { now: NOW, burrow: BURROW, world },
      )?.routes.length === 2;
    expect(one('Conversation', { prNumber: 482 })).toBe(true);
    expect(one('Conversation', { conversationId: 'cnv_no-such-room' })).toBe(false);
    expect(one('Pins', { conversationId: room?.id, title: 'PR #482' })).toBe(true);
    expect(one('ConversationFiles', { room: 'chat' })).toBe(true);
    expect(one('ConversationFiles', { room: 'general' })).toBe(false);
    expect(one('ConversationFiles', { conversationId: chat?.id })).toBe(true);
    // The agent's page is Settings → Agent; the old screens aren't restored (OA-09).
    expect(one('SettingsAgent', { part: 'keys' })).toBe(true);
    expect(one('Agent', { agent: 'dusty' })).toBe(false);
    expect(one('Dm', { agent: 'dusty' })).toBe(false);
    expect(one('Run', { number: 0 })).toBe(false);
    expect(one('Vault')).toBe(true);
    // Transient screens, managed-only screens outside a managed build, and screens not on the list.
    expect(one('Share')).toBe(false);
    expect(one('NewMessage')).toBe(false);
    expect(one('Whombat')).toBe(false);
    expect(one('SomeNewScreen')).toBe(false);
  });

  it('nothing to restore when the person was on the inbox', () => {
    const inbox = snapshotNavigation({ index: 0, routes: [{ name: 'Tabs' }] }, BURROW, NOW);
    expect(restorableNavigation(inbox, { now: NOW, burrow: BURROW, world })).toBeUndefined();
  });

  it('keeps the top screens of a deep stack, and never an action param', () => {
    const deep = Array.from({ length: 12 }, (_, i) => ({ name: 'Run', params: { number: i + 1 } }));
    const restored = restorableNavigation(
      {
        v: 1,
        savedAt: NOW,
        burrow: BURROW,
        state: {
          index: 13,
          routes: [
            { name: 'Tabs' },
            ...deep,
            { name: 'Approval', params: { number: 12, decide: 'approve' } },
          ],
        },
      },
      { now: NOW, burrow: BURROW, world },
    );
    expect(restored?.routes).toHaveLength(NAV_MAX_DEPTH);
    expect(restored?.routes.at(-1)).toEqual({ name: 'Approval', params: { number: 12 } });
  });

  it('watches the read of each entity screen, and knows a gone answer', () => {
    expect(RESTORE_WATCH.Run).toBe('runs.get');
    expect(RESTORE_WATCH.Thread).toBe('messages.thread');
    expect(isGoneError({ status: 404, code: 'not_found' })).toBe(true);
    expect(isGoneError({ status: 403, code: 'forbidden' })).toBe(true);
    expect(isGoneError({ status: 500, code: 'internal' })).toBe(false);
    expect(isGoneError(new Error('offline'))).toBe(false);
  });
});

describe('the parity screens (MQ) are restored like their neighbours', () => {
  it('restores lists and canvases whose data is known, not the agent’s or channels’ old screens', () => {
    for (const name of ['AgentSchedules', 'AgentNotes', 'CommandAllowances', 'ChannelSettings'])
      expect(
        restorableRoute({ name, params: { agent: 'dusty', conversationId: room?.id } }, world),
        name,
      ).toBe(false);
    expect(restorableRoute({ name: 'Spend' }, world)).toBe(true);
    expect(restorableRoute({ name: 'AuditLog' }, world)).toBe(true);
    expect(restorableRoute({ name: 'Members' }, world)).toBe(false);
    expect(restorableRoute({ name: 'Memory' }, world)).toBe(true);
    expect(restorableRoute({ name: 'Canvas', params: { slug: 'launch-plan' } }, world)).toBe(true);
    expect(RESTORE_WATCH.Canvas).toBe('canvases.content');
    expect(restorableRoute({ name: 'NewChannel' }, world)).toBe(false);
  });
});

describe('a place saved before the Work screen went (work-removal-android.md AP-861)', () => {
  const at = (routes: SavedNavigation['state']['routes']): SavedNavigation => ({
    v: 1,
    savedAt: NOW,
    burrow: BURROW,
    state: { index: routes.length - 1, routes },
  });

  it('opens on the tabs instead of Work, and drops what was opened from it', () => {
    expect(restorableRoute({ name: 'Work' }, world)).toBe(false);
    const fromInbox = at([
      { name: 'Tabs', state: { index: 0, routes: [{ name: 'Inbox' }] } },
      { name: 'Work', params: { section: 'deploys', back: 'Inbox' } },
      { name: 'Run', params: { number: 1907, back: 'Work' } },
    ]);
    // Nothing above the tabs: the app starts on Chat.
    expect(restorableNavigation(fromInbox, { now: NOW, burrow: BURROW, world })).toBeUndefined();
    const fromRoom = at([
      { name: 'Tabs', state: { index: 0, routes: [{ name: 'Inbox' }] } },
      { name: 'Conversation', params: { conversationId: room?.id } },
      { name: 'Work' },
    ]);
    expect(restorableNavigation(fromRoom, { now: NOW, burrow: BURROW, world })?.routes).toEqual([
      { name: 'Tabs' },
      { name: 'Conversation', params: { conversationId: room?.id } },
    ]);
  });

  it('restores Deploys, Plans, and a conversation’s Plans while the conversation is known', () => {
    expect(restorableRoute({ name: 'Deploys', params: { back: 'Connections' } }, world)).toBe(true);
    expect(restorableRoute({ name: 'Plans' }, world)).toBe(true);
    expect(
      restorableRoute({ name: 'Plans', params: { conversationId: room?.id, back: 'PR #482' } }, world),
    ).toBe(true);
    expect(restorableRoute({ name: 'Plans', params: { conversationId: 'cnv_gone' } }, world)).toBe(false);
  });
});

describe('This Whombat’s parts (this-whombat-sections-android.md AP-1250)', () => {
  const managedWorld: RestoreWorld = { ...world, managed: true };
  const parts = ['Whombat', 'WhombatBackups', 'Devices', 'WhombatAbout', 'BackupFile'];

  it('are restored in a managed build only', () => {
    for (const name of parts) {
      expect(restorableRoute({ name }, managedWorld), name).toBe(true);
      expect(restorableRoute({ name }, world), name).toBe(false);
    }
  });

  it('restores the Overview with the part opened from it, and the backup file above Backups', () => {
    const stack: SavedNavigation = {
      v: 1,
      savedAt: NOW,
      burrow: BURROW,
      state: {
        index: 3,
        routes: [{ name: 'Tabs' }, { name: 'Whombat' }, { name: 'WhombatBackups' }, { name: 'BackupFile' }],
      },
    };
    expect(
      restorableNavigation(stack, { now: NOW, burrow: BURROW, world: managedWorld })?.routes.map(
        (r) => r.name,
      ),
    ).toEqual(['Tabs', 'Whombat', 'WhombatBackups', 'BackupFile']);
  });
});
