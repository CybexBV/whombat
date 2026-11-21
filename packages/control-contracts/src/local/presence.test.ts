/** The presence socket (0.103, CT-597…CT-599; Whombat desk-display.md DK-28…DK-33). */
import { DESK_PRESENCE_CHECK_S, DESK_PRESENCE_GONE_S } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  PRESENCE_ERRORS,
  PRESENCE_KEEP_S,
  PRESENCE_PATHS,
  PRESENCE_REQUEST_MAX_BYTES,
  PRESENCE_SOCKET_DEFAULT,
  PRESENCE_SOCKET_ENV,
  PRESENCE_STATES,
  PresenceAck,
  PresenceHealth,
  PresenceStopRequest,
  PresenceWatch,
  PresenceWatchRequest,
} from './index.js';

describe('the presence socket (CT-597)', () => {
  it('lives in its own service’s directory, its paths under /v1/presence', () => {
    expect(PRESENCE_SOCKET_ENV).toBe('WHOMBAT_PRESENCE_SOCKET');
    expect(PRESENCE_SOCKET_DEFAULT).toBe('/run/whombat-presence/presence.sock');
    for (const path of Object.values(PRESENCE_PATHS)) expect(path).toMatch(/^\/v1\/presence\//);
    expect(Object.keys(PRESENCE_PATHS)).toEqual(['health', 'watch', 'stop']);
    expect(PRESENCE_REQUEST_MAX_BYTES).toBe(1_024);
    expect(PRESENCE_ERRORS).toEqual(['bad_request', 'too_large', 'unavailable']);
  });

  it('keeps the camera on between the runtime’s watches, and closes it soon after the last', () => {
    expect(PRESENCE_KEEP_S).toBe(6);
    // Two watches can go missing before the camera closes by itself, well before someone counts as gone.
    expect(DESK_PRESENCE_CHECK_S * 2).toBeLessThan(PRESENCE_KEEP_S);
    expect(PRESENCE_KEEP_S).toBeLessThan(DESK_PRESENCE_GONE_S);
  });
});

describe('what the camera service says (CT-598)', () => {
  it('reads its health, ignoring what a newer service adds', () => {
    expect(PresenceHealth.parse({ v: 1, camera: true, detector: true, infrared: true })).toEqual({
      v: 1,
      camera: true,
      detector: true,
    });
    expect(PresenceHealth.safeParse({ v: 1, camera: true }).success).toBe(false);
  });

  it('reads a watch in each state, with when it last saw a face', () => {
    const seen = {
      v: 1,
      state: 'watching',
      face: true,
      seenAt: '2026-10-20T12:34:00Z',
      frameAt: '2026-10-20T12:34:00Z',
    };
    expect(PresenceWatch.parse(seen)).toEqual(seen);
    for (const state of PRESENCE_STATES)
      expect(PresenceWatch.safeParse({ v: 1, state, face: false }).success, state).toBe(true);
    expect(PRESENCE_STATES).toEqual(['starting', 'watching', 'dark', 'failed', 'no_camera']);
    expect(PresenceWatch.safeParse({ v: 1, state: 'asleep', face: false }).success).toBe(false);
    expect(PresenceWatch.safeParse({ v: 1, state: 'watching', face: 0.91 }).success).toBe(false);
    expect(PresenceWatch.safeParse({ ...seen, seenAt: 1_790_000_000 }).success).toBe(false);
    // A newer service's score or picture never reaches the runtime.
    expect(PresenceWatch.parse({ ...seen, score: 91, picture: 'AAAA' })).toEqual(seen);
  });

  it('takes nothing but the version, strictly', () => {
    for (const request of [PresenceWatchRequest, PresenceStopRequest]) {
      expect(request.safeParse({ v: 1 }).success).toBe(true);
      expect(request.safeParse({ v: 1, camera: '/dev/video0' }).success).toBe(false);
      expect(request.safeParse({ v: 2 }).success).toBe(false);
    }
    expect(PresenceAck.parse({ v: 1, ok: true })).toEqual({ v: 1 });
  });
});
