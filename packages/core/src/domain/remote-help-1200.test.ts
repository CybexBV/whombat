/**
 * Contracts 0.120.0, remote help (Whombat remote-help.md RH-01…RH-13; CT-930…CT-937): the levels and durations, the
 * help code, the bounds and the words every surface shares.
 */
import { describe, expect, it } from 'vitest';
import { FEEDBACK_REFERENCE_ALPHABET } from '../feedback/install.js';
import {
  formatHelpCode,
  HELP_CODE_ALPHABET,
  HELP_CODE_LENGTH,
  HelpCode,
  helpCodeFromBytes,
  normalizeHelpCode,
  REMOTE_HELP_DURATION_S,
  REMOTE_HELP_DURATIONS,
  REMOTE_HELP_LEVELS,
  REMOTE_HELP_LIMITS,
  REMOTE_HELP_LOOK_COMMANDS,
  REMOTE_HELP_STEP_KINDS,
  REMOTE_HELP_WORDS,
  type RemoteHelpStepView,
  remoteHelpConfirmText,
  remoteHelpDeskLine,
  remoteHelpDurationSeconds,
  remoteHelpLevelLabel,
  remoteHelpPanelLine,
  remoteHelpRefusalText,
  remoteHelpStateLine,
  remoteHelpStepText,
  remoteHelpTurnedOnText,
  remoteHelpUnitName,
  remoteHelpUntilText,
  remoteHelpVisitText,
  remoteHelpWho,
} from './remote-help.js';

/** Tuesday 21 October 2026, 12:00 in Amsterdam (CEST, UTC+2). */
const now = new Date('2026-10-21T10:00:00Z');
const ams = 'Europe/Amsterdam';

describe('levels, durations and bounds (CT-930)', () => {
  it('has two levels and four durations, Forever without seconds', () => {
    expect(REMOTE_HELP_LEVELS).toEqual(['look', 'fix']);
    expect(REMOTE_HELP_DURATIONS).toEqual(['hour', 'day', 'week', 'forever']);
    expect(REMOTE_HELP_DURATION_S).toEqual({ hour: 3_600, day: 86_400, week: 604_800 });
    expect(remoteHelpDurationSeconds('day')).toBe(86_400);
    expect(remoteHelpDurationSeconds('forever')).toBeNull();
  });

  it('keeps the brief’s bounds', () => {
    expect(REMOTE_HELP_LIMITS).toMatchObject({
      visitIdleS: 900,
      keepDays: 90,
      wrongCodes: 5,
      stepsShown: 200,
      commandLineChars: 500,
      nameChars: 40,
      connectedMax: 8,
    });
    expect(REMOTE_HELP_LIMITS.stepsShown).toBeLessThan(REMOTE_HELP_LIMITS.stepsPerVisit);
    expect(REMOTE_HELP_LOOK_COMMANDS).toHaveLength(12);
    expect(REMOTE_HELP_LOOK_COMMANDS).toContain('report');
    expect(REMOTE_HELP_STEP_KINDS).toContain('wrong_code');
  });
});

describe('the help code (CT-930)', () => {
  it('is six characters of the feedback reference’s alphabet', () => {
    expect(HELP_CODE_LENGTH).toBe(6);
    expect(HELP_CODE_ALPHABET).toBe(FEEDBACK_REFERENCE_ALPHABET);
    for (const c of 'ILOU') expect(HELP_CODE_ALPHABET).not.toContain(c);
    expect(HelpCode.safeParse('KQ72MX').success).toBe(true);
    expect(HelpCode.safeParse('KQ7·2MX').success).toBe(false);
  });

  it('reads what people type: separators, lower case and look-alikes', () => {
    for (const typed of ['KQ72MX', 'kq72mx', 'KQ7·2MX', ' kq7 2mx ', 'KQ7-2MX', 'KQ7–2MX', 'KQ7.2MX'])
      expect(normalizeHelpCode(typed), typed).toBe('KQ72MX');
    expect(normalizeHelpCode('kq7o2m')).toBe('KQ702M');
    expect(normalizeHelpCode('KQ7I2L')).toBe('KQ7121');
    for (const bad of ['KQ72M', 'KQ72MXX', 'KQ72MU', 'KQ7_2MX', 'ſQ72MX', ''])
      expect(normalizeHelpCode(bad), bad).toBeNull();
  });

  it('shows it in two halves, and makes it from random bytes', () => {
    expect(formatHelpCode('KQ72MX')).toBe('KQ7·2MX');
    expect(formatHelpCode('KQ72M')).toBe('KQ72M');
    expect(normalizeHelpCode(formatHelpCode('ABWHJ3'))).toBe('ABWHJ3');
    expect(helpCodeFromBytes(Uint8Array.from([0, 1, 2, 3, 4, 5]))).toBe('012345');
    expect(helpCodeFromBytes(Uint8Array.from([31, 32, 63, 64, 224, 255]))).toBe('Z0Z00Z');
    expect(() => helpCodeFromBytes(new Uint8Array(5))).toThrow();
  });
});

describe('the words (§4)', () => {
  it('uses the brief’s typography', () => {
    expect(REMOTE_HELP_WORDS.title).toBe('Remote help');
    expect(REMOTE_HELP_WORDS.off).toContain('what’s wrong');
    expect(REMOTE_HELP_WORDS.levels.look.hint).toContain('can’t change anything');
    expect(REMOTE_HELP_WORDS.passkeyHint).toBe('You’ll confirm with your passkey.');
    expect(REMOTE_HELP_WORDS.notAvailable).toContain('isn’t available');
    expect(REMOTE_HELP_WORDS.messages.visit).toContain('Settings → This Whombat → About');
    const strings = (v: unknown): string[] =>
      typeof v === 'string'
        ? [v]
        : typeof v === 'object' && v !== null
          ? Object.values(v).flatMap(strings)
          : [];
    for (const text of strings(REMOTE_HELP_WORDS)) expect(text, text).not.toMatch(/['"]/);
  });

  it('labels the levels and the durations', () => {
    expect(remoteHelpLevelLabel('look')).toBe('Look');
    expect(remoteHelpLevelLabel('fix')).toBe('Look and fix');
    expect(Object.values(REMOTE_HELP_WORDS.durations)).toEqual(['1 hour', '1 day', '1 week', 'Forever']);
  });

  it('confirms the choice without a passkey', () => {
    expect(remoteHelpConfirmText('look', 'hour')).toBe('Whombat support can look for 1 hour.');
    expect(remoteHelpConfirmText('fix', 'forever')).toBe(
      'Whombat support can look and fix until you stop it.',
    );
  });

  it('says until when in the reader’s zone: the clock today, “tomorrow”, else the weekday and date', () => {
    expect(remoteHelpUntilText('2026-10-21T12:00:00Z', now, ams)).toBe('14:00');
    expect(remoteHelpUntilText('2026-10-22T12:00:00Z', now, ams)).toBe('tomorrow 14:00');
    expect(remoteHelpUntilText('2026-10-23T12:00:00Z', now, ams)).toBe('Fri 23 Oct, 14:00');
    // Late in the evening UTC is already tomorrow in Amsterdam.
    expect(remoteHelpUntilText('2026-10-21T22:30:00Z', now, ams)).toBe('tomorrow 00:30');
    expect(remoteHelpUntilText('2026-10-21T22:30:00Z', now, 'UTC')).toBe('22:30');
    // A week over the clocks going back (25 October), and a year boundary.
    expect(remoteHelpUntilText('2026-10-28T11:00:00Z', now, ams)).toBe('Wed 28 Oct, 12:00');
    expect(remoteHelpUntilText('2027-01-01T09:00:00Z', new Date('2026-12-30T09:00:00Z'), 'UTC')).toBe(
      'Fri 1 Jan 2027, 09:00',
    );
  });

  it('makes the card’s state line', () => {
    const line = (level: 'look' | 'fix', until: string | null, timeZone?: string) =>
      remoteHelpStateLine({ level, until, now, timeZone });
    expect(line('fix', '2026-10-22T12:00:00Z', ams)).toBe('On · Look and fix · until tomorrow 14:00');
    expect(line('look', '2026-10-23T12:00:00Z', ams)).toBe('On · Look · until Fri 23 Oct, 14:00');
    expect(line('fix', null)).toBe('On · Look and fix · forever');
    expect(line('look', '2026-10-21T11:00:00Z')).toBe('On · Look · until 11:00');
  });

  it('makes the desk’s line and the admin panel’s', () => {
    expect(remoteHelpDeskLine({ until: '2026-10-21T13:30:00Z', now, timeZone: ams })).toBe(
      'Remote help is on · until 15:30',
    );
    expect(remoteHelpDeskLine({ until: null, now })).toBe('Remote help is on · forever');
    expect(remoteHelpPanelLine({ state: 'off', untilS: null })).toBe('Remote help: off');
    expect(remoteHelpPanelLine({ state: 'look', untilS: 3 * 3_600 - 20 })).toBe(
      'Remote help: Look · 3 h left',
    );
    expect(remoteHelpPanelLine({ state: 'look', untilS: 30 })).toBe('Remote help: Look · 1 h left');
    expect(remoteHelpPanelLine({ state: 'fix', untilS: null })).toBe('Remote help: Look and fix · forever');
  });

  it('makes the assistant’s messages and the refusals', () => {
    // The name stands alone: “Support”, or a person's (no “Support from Whombat support”).
    expect(remoteHelpVisitText('Support')).toMatch(
      /^Support is looking at this Whombat now through remote help\./,
    );
    expect(remoteHelpTurnedOnText('fix', 'day')).toMatch(/Look and fix, for 1 day\.$/);
    expect(remoteHelpTurnedOnText('look', 'forever')).toMatch(/Look, forever\.$/);
    expect(remoteHelpRefusalText('forever_not_allowed')).toBe('Forever is only for test Whombats.');
    expect(remoteHelpRefusalText('remote_help_busy')).toContain('didn’t answer');
    expect(remoteHelpRefusalText('passkey_failed')).toContain('passkey');
    expect(remoteHelpRefusalText('not_owner')).toBeNull();
    expect(remoteHelpRefusalText('toString')).toBeNull();
  });
});

describe('what support did (CT-932)', () => {
  const step = (s: Omit<RemoteHelpStepView, 'kind'> & { kind: RemoteHelpStepView['kind'] }) =>
    remoteHelpStepText(s, 'Claude');

  it('says each step in plain words', () => {
    expect(step({ kind: 'connected' })).toBe('Claude connected');
    expect(step({ kind: 'left' })).toBe('Claude left');
    expect(step({ kind: 'look', command: 'status' })).toBe('Looked at the status');
    expect(step({ kind: 'look', command: 'processes' })).toBe('Looked at running programs');
    expect(step({ kind: 'look', command: 'logs' })).toBe('Read the logs');
    expect(step({ kind: 'look', command: 'logs', units: ['whombat-voice.service'] })).toBe(
      'Read the logs of voice',
    );
    expect(
      step({
        kind: 'look',
        command: 'logs',
        units: ['whombat-voice.service', 'nginx.service', 'whombat-server'],
      }),
    ).toBe('Read the logs of voice, nginx and server');
    expect(step({ kind: 'exec', line: 'systemctl status' })).toBe('Ran systemctl status');
    expect(step({ kind: 'restart', units: ['whombat-voice.service'] })).toBe('Restarted voice');
    expect(step({ kind: 'forward', target: '127.0.0.1:8123' })).toBe('Opened a connection to 127.0.0.1:8123');
    expect(step({ kind: 'wrong_code' })).toBe('Typed a wrong help code');
  });

  it('says how long a command line was used', () => {
    expect(step({ kind: 'shell', seconds: 12 })).toBe('Used a command line for less than a minute');
    expect(step({ kind: 'shell' })).toBe('Used a command line for less than a minute');
    expect(step({ kind: 'shell', seconds: 60 })).toBe('Used a command line for 1 minute');
    expect(step({ kind: 'shell', seconds: 185 })).toBe('Used a command line for 3 minutes');
  });

  it('says why something was stopped', () => {
    expect(step({ kind: 'refused', reason: 'level' })).toBe('Was stopped: that needs Look and fix');
    expect(step({ kind: 'refused', reason: 'code' })).toBe('Was stopped: wrong help code');
    for (const reason of ['certificate', 'limit', 'unknown_command', 'bad_arguments'] as const)
      expect(step({ kind: 'refused', reason }), reason).toBe('Was stopped: not allowed');
  });

  it('names the box’s parts and who visits', () => {
    expect(remoteHelpUnitName('whombat-voice.service')).toBe('voice');
    expect(remoteHelpUnitName('nginx.service')).toBe('nginx');
    expect(remoteHelpUnitName('whombat-presence.socket')).toBe('presence.socket');
    expect(remoteHelpUnitName('whombat-.service')).toBe('whombat-');
    expect(remoteHelpWho('Claude (op_7Hq2 via john)')).toBe('Claude');
    expect(remoteHelpWho('Bob (night shift) (op_1)')).toBe('Bob (night shift)');
    expect(remoteHelpWho(' (op_1)')).toBe('Someone');
    expect([...remoteHelpWho(`${'x'.repeat(60)} (op_1)`)]).toHaveLength(REMOTE_HELP_LIMITS.nameChars);
    expect(remoteHelpWho('Claude\n‮(op')).toBe('Claude (op');
  });
});
