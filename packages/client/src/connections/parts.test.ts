import { describe, expect, it } from 'vitest';
import {
  minutesLeftText,
  NEXTCLOUD_WAIT_TEXT,
  nextcloudEnds,
  nextcloudPollStep,
  probedSignIn,
  probeNote,
  SERVICE_LOGIN_WAIT_TEXT,
  serviceLoginCode,
  serviceLoginEnds,
  serviceLoginPollStep,
} from './parts';

describe('a Custom MCP server’s probe (CX-61)', () => {
  it('names what answers and picks the sign-in it needs; unreachable picks none', () => {
    const open = probeNote({ needs: 'open', serverName: 'Linear', issuer: null, message: null });
    expect(open.tone).toBe('ok');
    expect(open.text).toContain('Linear');
    expect(probedSignIn({ needs: 'open' })).toBe('none');
    expect(probedSignIn({ needs: 'oauth' })).toBe('mcp_oauth');
    expect(probedSignIn({ needs: 'token' })).toBe('token');
    expect(probedSignIn({ needs: 'unreachable' })).toBeNull();
    const down = probeNote({ needs: 'unreachable', serverName: null, issuer: null, message: 'timed out' });
    expect(down.tone).toBe('bad');
    expect(down.text).toContain('timed out');
    expect(
      probeNote({ needs: 'oauth', serverName: null, issuer: 'https://auth.example', message: null }).text,
    ).toContain('https://auth.example');
  });
});

describe('waiting for Nextcloud (CX-11)', () => {
  const now = Date.parse('2026-10-19T10:00:00Z');

  it('waits until the flow expires, at most ten minutes, and says the minutes left', () => {
    expect(nextcloudEnds({ expiresAt: '2026-10-19T10:05:00Z' }, now)).toBe(now + 5 * 60_000);
    expect(nextcloudEnds({ expiresAt: '2026-10-19T11:00:00Z' }, now)).toBe(now + 10 * 60_000);
    expect(minutesLeftText(now + 61_000, now)).toBe('2 minutes left');
    expect(minutesLeftText(now + 10_000, now)).toBe('1 minute left');
    expect(minutesLeftText(now - 10_000, now)).toBe('1 minute left');
  });

  it('reads a poll: connected with the connection, expired or failed with why, else ask again', () => {
    const connection = { id: 'con_1', label: 'Nextcloud' } as never;
    expect(nextcloudPollStep({ state: 'connected', connection } as never)).toEqual({
      kind: 'connected',
      connection,
    });
    expect(nextcloudPollStep({ state: 'expired' } as never)).toEqual({
      kind: 'failed',
      message: NEXTCLOUD_WAIT_TEXT.tooLong,
    });
    expect(nextcloudPollStep({ state: 'failed', message: '' } as never)).toEqual({
      kind: 'failed',
      message: NEXTCLOUD_WAIT_TEXT.failed,
    });
    expect(nextcloudPollStep({ state: 'pending' } as never)).toEqual({ kind: 'wait' });
  });
});

describe('waiting for the service’s own page (SG-01, SG-05, AP-3908)', () => {
  const now = Date.parse('2026-10-21T10:00:00Z');

  it('waits until the flow expires, at most ten minutes, and shows a code only when there is one', () => {
    expect(serviceLoginEnds({ expiresAt: '2026-10-21T10:04:00Z' }, now)).toBe(now + 4 * 60_000);
    expect(serviceLoginEnds({ expiresAt: '2026-10-21T12:00:00Z' }, now)).toBe(now + 10 * 60_000);
    expect(serviceLoginCode({ userCode: null })).toBeNull();
    expect(serviceLoginCode({ userCode: ' WDJB-MJHT ' })).toBe('WDJB-MJHT');
  });

  it('reads a poll as Nextcloud’s, failing in the service’s name', () => {
    expect(SERVICE_LOGIN_WAIT_TEXT.title('Plex')).toContain('Plex');
    expect(serviceLoginPollStep({ state: 'pending' }, 'Plex')).toEqual({ kind: 'wait' });
    expect(serviceLoginPollStep({ state: 'expired' }, 'Plex')).toEqual({
      kind: 'failed',
      message: SERVICE_LOGIN_WAIT_TEXT.tooLong,
    });
    const failed = serviceLoginPollStep({ state: 'failed', message: '' }, 'Plex');
    expect(failed.kind === 'failed' && failed.message).toContain('Plex');
    const owner =
      'Plex let Whombat in, but this server didn’t accept your account. Is it the server’s owner?';
    expect(serviceLoginPollStep({ state: 'failed', message: owner }, 'Plex')).toEqual({
      kind: 'failed',
      message: owner,
    });
    const connection = { id: 'con_1', label: 'Plex' } as never;
    expect(serviceLoginPollStep({ state: 'connected', connection } as never, 'Plex')).toEqual({
      kind: 'connected',
      connection,
    });
  });
});
