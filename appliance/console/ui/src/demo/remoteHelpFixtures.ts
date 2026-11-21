/**
 * Remote help on the desk (CG-290…CG-292, CG-295…CG-297): the desk fixtures with Whombat support let in (the “Remote”
 * chip in the top bar), its sheet open, and the claimed screen of a box nobody paired a screen of. Stop works in the demo
 * (the chip goes).
 */
import type { ConsoleState, ServerState } from '../lib/api';
import type { RemoteHelp } from '../lib/remoteHelp';
import { DESK_FIXTURES } from './deskFixtures';
import type { Fixture } from './fixtures';

const later = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

/** A desk fixture with remote help in each of its states, `until` hours after each state's clock (null: forever). */
function withHelp(name: string, note: string, help: (now: string) => RemoteHelp): Fixture {
  const f = DESK_FIXTURES[name];
  if (!f) throw new Error(`no desk fixture ${name}`);
  return {
    ...f,
    note,
    timeline: f.timeline.map(({ at, state }) => ({
      at,
      state:
        state.mode === 'console' && state.desk
          ? { ...state, desk: { ...state.desk, remoteHelp: help(state.now) } }
          : state,
    })),
  };
}

/** The claimed screen with a desk state nobody paired (`paired` null) that carries remote help. */
function claimedWithHelp(help: RemoteHelp): ServerState {
  const now = '2026-10-21T12:34:20Z';
  const s: ConsoleState = {
    mode: 'console',
    now,
    claim: {
      state: 'claimed',
      code: '',
      claimUrl: 'app.whombat.com/claim',
      appUrl: 'app.whombat.com',
      retryAt: null,
      burrows: { first: 'Lumio BV', more: 0 },
    },
    footer: '',
    desk: {
      now,
      paired: null,
      pairing: null,
      lock: { state: 'locked', until: null, retryAt: null, expiresAt: null },
      glance: null,
      power: null,
      talk: null,
      remoteHelp: help,
    },
  };
  return s;
}

export const REMOTE_HELP_FIXTURES: Record<string, Fixture> = {
  'desk-remote-help': {
    ...withHelp(
      'desk-looks',
      'Remote help on, Look and fix until 17:34, Support connected: the “Remote” chip in the top bar, locked (RH-12)',
      (now) => ({ level: 'fix', until: later(now, 3), connected: 'Support' }),
    ),
  },
  'desk-remote-help-forever': withHelp(
    'desk-looks-many',
    'Remote help on forever (a test Whombat), nobody connected, unlocked',
    () => ({ level: 'look', until: null, connected: null }),
  ),
  'desk-remote-help-tomorrow': withHelp(
    'desk-servers',
    'Remote help until tomorrow, with the servers below',
    (now) => ({ level: 'look', until: later(now, 22), connected: null }),
  ),
  'desk-remote-help-time': withHelp(
    'desk-glance-time',
    'Only the time, locked: the chip in the top bar',
    (now) => ({ level: 'fix', until: later(now, 30), connected: 'Ann-Marie O’Neil' }),
  ),
  'desk-remote-help-sheet': {
    ...withHelp(
      'desk-looks',
      'The chip touched while locked: the sheet with the line, who is connected, the level and Stop (CG-296)',
      (now) => ({ level: 'fix', until: later(now, 3), connected: 'Support' }),
    ),
    remoteHelpSheet: { open: true },
  },
  'desk-remote-help-sheet-look': {
    ...withHelp('desk-looks-many', 'The sheet of a Look grant, forever, nobody connected', () => ({
      level: 'look',
      until: null,
      connected: null,
    })),
    remoteHelpSheet: { open: true },
  },
  'console-remote-help': {
    note: 'Nobody paired the screen: the chip in the claimed screen’s header (CG-292)',
    timeline: [
      {
        at: 0,
        state: claimedWithHelp({ level: 'fix', until: '2026-10-28T12:34:20Z', connected: 'Support' }),
      },
    ],
  },
  'console-remote-help-sheet': {
    note: 'Nobody paired the screen: the chip touched, its sheet over the claimed screen',
    timeline: [
      {
        at: 0,
        state: claimedWithHelp({ level: 'fix', until: '2026-10-28T12:34:20Z', connected: 'Support' }),
      },
    ],
    remoteHelpSheet: { open: true },
  },
};
