import { describe, expect, it } from 'vitest';
import { customDndUntil, dndStateText, localInputValue, notificationsWords } from './notificationsModel';

const Z = 'Europe/Amsterdam';
/** Wednesday 23 September 2026, 11:22 in Amsterdam. */
const NOW = '2026-09-23T09:22:00.000Z';

describe('Settings → Notifications (essentials item 12, CT-175)', () => {
  it('says Do not disturb is on until when, in the person’s zone', () => {
    expect(dndStateText({ dndUntil: '2026-09-23T10:22:00.000Z' }, NOW, Z)).toBe(
      'Do not disturb is on until 12:22.',
    );
    // Over, or never set: off.
    expect(dndStateText({ dndUntil: '2026-09-23T09:00:00.000Z' }, NOW, Z)).toBeNull();
    expect(dndStateText({ dndUntil: null }, NOW, Z)).toBeNull();
  });

  it('reads a custom end in the person’s zone, not the browser’s, and only in the future', () => {
    expect(localInputValue(NOW, Z)).toBe('2026-09-23T11:22');
    expect(customDndUntil('2026-09-23T18:30', NOW, Z)).toEqual({
      ok: true,
      until: '2026-09-23T16:30:00.000Z',
    });
    expect(customDndUntil('2026-09-23T10:00', NOW, Z)).toEqual({
      ok: false,
      error: 'Pick a time that’s still to come.',
    });
    expect(customDndUntil('', NOW, Z)).toEqual({ ok: false, error: 'Pick a day and a time.' });
  });

  it('speaks of the chats with the agent: no bell, no mentions, no inbox, no THREADS (AP-1790)', () => {
    const words = notificationsWords('Burrow HQ', 'Neo');
    expect(words.intro).toBe('These are yours alone, for every chat in Burrow HQ.');
    expect(words.threads).toBe(false);
    expect(words.email.daily).toBe(
      'One email at 08:00 about messages from Neo and things that need you that stayed unread.',
    );
    const all = [
      words.intro,
      ...Object.values(words.dndMeta),
      words.pushOff,
      words.pushUnsupported,
      ...Object.values(words.email),
    ];
    for (const text of all) expect(text).not.toMatch(/bell|mention|inbox|direct message/i);
  });
});
