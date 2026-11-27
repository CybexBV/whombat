import { beforeAll, describe, expect, it } from 'vitest';
import { backupWhen, dayMonth } from '../features/settings/backupOptionsModel';
import { dayLongMonth, dayShortMonth, longMonthName, weekdayName } from './dates';
import { loadDutch } from './provider';

const ENGLISH_MONTH =
  /January|February|March|April|May|June|July|August|September|October|November|December|\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;
const at = new Date(2026, 10, 3, 3, 0);

beforeAll(async () => {
  await loadDutch();
});

describe('dates in the page’s language', () => {
  it('keeps English as it was', () => {
    expect(dayShortMonth(at)).toBe('3 Nov');
    expect(dayLongMonth(at)).toBe('3 November');
    expect(weekdayName(0)).toBe('Sunday');
    expect(dayLongMonth(at, 'pseudo')).toBe('3 November');
    expect(dayLongMonth(at, 'en-XA')).toBe('3 November');
    expect(dayLongMonth(at, 'nl-XA')).toBe('3 November');
    expect(dayShortMonth(at, 'en-US')).toBe('3 Nov');
  });

  it('gives Dutch names without an English month or a dot', () => {
    expect(dayShortMonth(at, 'nl-NL')).toBe('3 nov');
    expect(dayLongMonth(at, 'nl-NL')).toBe('3 november');
    expect(longMonthName(9, 'nl-NL')).toBe('oktober');
    expect(weekdayName(0, 'nl-NL')).toBe('zondag');
    expect(dayLongMonth(at, 'nl-BE')).toBe('3 november');
    expect(dayLongMonth(at, 'nl')).toBe('3 november');
  });

  it('writes a backup’s title and range in Dutch', () => {
    const now = new Date(2026, 10, 20, 12, 0);
    const title = backupWhen(at.toISOString(), now, 'nl-NL');
    expect(title).toBe('3 november, 03:00');
    expect(title).not.toMatch(ENGLISH_MONTH);
    expect(backupWhen(new Date(2026, 10, 20, 3, 0).toISOString(), now, 'nl-NL')).toBe('Vandaag, 03:00');
    expect(dayMonth(at.toISOString(), 'nl-NL')).toBe('3 nov');
  });
});
