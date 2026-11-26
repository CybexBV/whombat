/** The support socket and remote help on the desk (0.120, CT-938…CT-943; Whombat remote-help.md RH-02…RH-12). */
import { REMOTE_HELP_DURATIONS } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  DESK_PATHS,
  DESK_SOCKET_ERRORS,
  DeskRemoteHelp,
  DeskRequest,
  DeskState,
  deskStateValid,
  MANAGER_PATHS,
  SUPPORT_ERROR_STATUS,
  SUPPORT_ERRORS,
  SUPPORT_EVENTS_MAX,
  SUPPORT_EVENTS_WAIT_MAX_S,
  SUPPORT_PATHS,
  SUPPORT_REQUEST_MAX_BYTES,
  SUPPORT_SOCKET_DEFAULT,
  SUPPORT_SOCKET_ENV,
  type SupportEvent,
  SupportEventsAnswer,
  SupportGrantRequest,
  SupportState,
  SupportStopRequest,
  SupportVisitsAnswer,
  supportEventValid,
  supportStateValid,
  supportTranscriptPath,
} from './index.js';

const at = '2026-10-21T14:00:00Z';
const owner = { accountId: 'acc_mara0001', name: 'Mara Jansen' };
const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINW5nEYpnLC/ggxoMZMtKIrMTB3zH3cpPnngDIgx6CrR';
const local: SupportState = {
  v: 1,
  available: true,
  foreverAllowed: true,
  helpCodeRequired: false,
  environment: 'local',
  hostKey,
  grant: { level: 'fix', since: at, until: null, grantedBy: owner, helpCode: null, wrongCodes: 0 },
  connected: [{ visitId: '12345', who: 'Claude', since: at }],
};
const prod: SupportState = {
  ...local,
  environment: 'prod',
  foreverAllowed: false,
  helpCodeRequired: true,
  grant: {
    level: 'look',
    since: at,
    until: '2026-10-21T15:00:00Z',
    grantedBy: owner,
    helpCode: 'KQ72MX',
    wrongCodes: 4,
  },
};

describe('the support socket (CT-938)', () => {
  it('lives in the service’s own directory, with the brief’s paths', () => {
    expect(SUPPORT_SOCKET_ENV).toBe('WHOMBAT_SUPPORT_SOCKET');
    expect(SUPPORT_SOCKET_DEFAULT).toBe('/run/whombat-support/api.sock');
    expect(SUPPORT_PATHS).toEqual({
      state: '/v1/state',
      grant: '/v1/grant',
      stop: '/v1/stop',
      visits: '/v1/visits',
      transcript: '/v1/visits/{id}/transcript',
      events: '/v1/events',
    });
    expect(supportTranscriptPath('12345')).toBe('/v1/visits/12345/transcript');
    for (const bad of ['../state', '12 34', '', 'a/b'])
      expect(() => supportTranscriptPath(bad), bad).toThrow();
    expect(SUPPORT_REQUEST_MAX_BYTES).toBe(1_024);
    expect([SUPPORT_EVENTS_WAIT_MAX_S, SUPPORT_EVENTS_MAX]).toEqual([25, 100]);
  });

  it('answers errors with a status per code', () => {
    expect(Object.keys(SUPPORT_ERROR_STATUS).sort()).toEqual([...SUPPORT_ERRORS].sort());
    expect(SUPPORT_ERROR_STATUS.forever_not_allowed).toBe(403);
    expect(SUPPORT_ERROR_STATUS.unavailable).toBe(503);
    expect(SUPPORT_ERROR_STATUS.forbidden).toBe(403);
  });

  it('gets the support ticket from the manager', () => {
    expect(MANAGER_PATHS.supportTicket).toBe('/v1/support/ticket');
  });
});

describe('the state (CT-939)', () => {
  it('reads a test box’s and a customer’s, ignoring what a newer service adds', () => {
    expect(SupportState.parse({ ...local, port: 22 })).toEqual(local);
    expect(SupportState.parse(prod)).toEqual(prod);
    expect(supportStateValid(local)).toBe(true);
    expect(supportStateValid(prod)).toBe(true);
    expect(supportStateValid({ ...local, grant: null, connected: [] })).toBe(true);
  });

  it('keeps the help code on for every prod box, Forever only on a marked one', () => {
    // A maintainer's test Whombat on the prod image (RH-17): Forever, and still the help code.
    const forever = { ...(prod.grant as NonNullable<SupportState['grant']>), until: null };
    expect(supportStateValid({ ...prod, foreverAllowed: true, grant: forever })).toBe(true);
    expect(supportStateValid({ ...prod, foreverAllowed: true })).toBe(true);
    expect(supportStateValid({ ...prod, grant: forever })).toBe(false);
    expect(supportStateValid({ ...prod, helpCodeRequired: false })).toBe(false);
    expect(supportStateValid({ ...local, helpCodeRequired: true })).toBe(false);
    expect(supportStateValid({ ...local, environment: 'dev' })).toBe(true);
    expect(supportStateValid({ ...local, foreverAllowed: false })).toBe(false);
  });

  it('turns on with a duration, never seconds and never a code of the caller’s', () => {
    for (const duration of REMOTE_HELP_DURATIONS)
      expect(SupportGrantRequest.safeParse({ v: 1, level: 'look', duration, grantedBy: owner }).success).toBe(
        true,
      );
    for (const bad of [
      { v: 1, level: 'look', durationS: 3_600, grantedBy: owner },
      { v: 1, level: 'look', duration: 'hour', grantedBy: owner, helpCode: 'KQ72MX' },
      { v: 1, level: 'look', duration: 'hour' },
    ])
      expect(SupportGrantRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('stops for an owner or at the desk', () => {
    expect(SupportStopRequest.safeParse({ v: 1, reason: 'owner', by: owner }).success).toBe(true);
    expect(SupportStopRequest.safeParse({ v: 1, reason: 'desk' }).success).toBe(true);
    expect(SupportStopRequest.safeParse({ v: 1, reason: 'expired' }).success).toBe(false);
  });

  it('lists at most 20 visits', () => {
    expect(SupportVisitsAnswer.safeParse({ v: 1, visits: [] }).success).toBe(true);
  });
});

describe('the events (CT-941)', () => {
  const grant: SupportEvent = { seq: 1, at, kind: 'grant', level: 'fix', duration: 'day', by: owner };
  const start: SupportEvent = {
    seq: 2,
    at,
    kind: 'visit_start',
    visitId: '12345',
    who: 'Claude',
    level: 'fix',
  };
  const end: SupportEvent = { ...start, seq: 3, kind: 'visit_end', startedAt: at, steps: 12 };

  it('long-polls from a seq, `next` the service’s newest', () => {
    const answer = SupportEventsAnswer.parse({ v: 1, events: [grant, start, end], next: 3 });
    expect(answer.next).toBe(3);
    expect(SupportEventsAnswer.safeParse({ v: 1, events: [], next: 0 }).success).toBe(true);
  });

  it('carries exactly the members of its kind', () => {
    for (const e of [
      grant,
      start,
      end,
      { seq: 4, at, kind: 'stop', reason: 'desk' },
      { seq: 5, at, kind: 'stop', reason: 'owner', by: owner },
      { seq: 6, at, kind: 'expired' },
      { seq: 7, at, kind: 'locked_out' },
    ] satisfies SupportEvent[])
      expect(supportEventValid(e), e.kind).toBe(true);
    for (const e of [
      { ...grant, by: undefined },
      { ...start, steps: 3 },
      { ...end, startedAt: undefined },
      { seq: 8, at, kind: 'stop', reason: 'wrong_codes' },
      { seq: 9, at, kind: 'stop', reason: 'desk', by: owner },
      { seq: 10, at, kind: 'expired', duration: 'day' },
    ] satisfies SupportEvent[])
      expect(supportEventValid(e), JSON.stringify(e)).toBe(false);
  });
});

describe('remote help on the desk (CT-943)', () => {
  const base: DeskState = {
    v: 1,
    now: at,
    paired: null,
    pairing: null,
    lock: { state: 'locked' },
    glance: null,
    power: null,
    talk: null,
  };

  it('shows the line whether the screen is locked or paired, and stops without unlocking', () => {
    const on = {
      ...base,
      remoteHelp: { level: 'fix', until: null, connected: 'Claude' },
    } satisfies DeskState;
    expect(DeskState.parse(on)).toEqual(on);
    expect(deskStateValid(on)).toBe(true);
    expect(DESK_PATHS.remoteHelpStop).toBe('/v1/desk/remote-help/stop');
    expect(DeskRequest.safeParse({ v: 1 }).success).toBe(true);
    expect(DESK_SOCKET_ERRORS).toContain('unavailable');
  });

  it('an older console strips the line', () => {
    const older = DeskState.omit({ remoteHelp: true });
    expect(
      older.parse({ ...base, remoteHelp: { level: 'look', until: at, connected: null } }),
    ).not.toHaveProperty('remoteHelp');
    expect(DeskRemoteHelp.safeParse({ level: 'look', until: at, connected: 'x'.repeat(41) }).success).toBe(
      false,
    );
  });
});
