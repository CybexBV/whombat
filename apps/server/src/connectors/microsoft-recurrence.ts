import type { CalendarEventPatch } from '@whombat/core';
import { badRequest } from '../lib/errors';

const DAYS: Record<string, string> = {
  MO: 'monday',
  TU: 'tuesday',
  WE: 'wednesday',
  TH: 'thursday',
  FR: 'friday',
  SA: 'saturday',
  SU: 'sunday',
};
/** Translate the shared RFC 5545 subset explicitly; never silently discard an unsupported recurrence part. */
export function graphRecurrence(input: CalendarEventPatch) {
  if (!input.recurrence?.length) return null;
  if (!input.start || input.recurrence.length !== 1 || !input.recurrence[0]?.startsWith('RRULE:'))
    throw badRequest('Microsoft recurrence needs start and one RRULE. RDATE and EXDATE are not supported.');
  if (input.start.length > 10 && !input.timeZone)
    throw badRequest(
      'Timed recurrence needs an explicit IANA timeZone so daylight-saving changes preserve the intended local time.',
    );
  const parts = input.recurrence[0]
    .slice(6)
    .split(';')
    .map((part) => part.split('='));
  if (
    parts.some((part) => part.length !== 2 || !part[1]) ||
    new Set(parts.map((part) => part[0])).size !== parts.length
  )
    throw badRequest('Invalid or duplicate recurrence rule part.');
  const rule: Record<string, string> = Object.fromEntries(parts);
  if (
    Object.keys(rule).some(
      (key) =>
        !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'].includes(key),
    )
  )
    throw badRequest('This recurrence uses an unsupported Microsoft rule part.');
  if (rule.COUNT && rule.UNTIL) throw badRequest('Use COUNT or UNTIL, not both.');
  const interval = Number(rule.INTERVAL ?? 1);
  const number = (value: string | undefined, fallback: number, max: number) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest('Invalid recurrence number.');
    return n;
  };
  number(String(interval), 1, 999);
  let startDate = input.start.slice(0, 10);
  if (input.start.length > 10) {
    try {
      startDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: input.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(input.start));
    } catch {
      throw badRequest('Use a valid IANA calendar time zone.');
    }
  }
  const [year, month, day] = startDate.split('-').map(Number);
  const pattern: Record<string, unknown> = { interval };
  switch (rule.FREQ) {
    case 'DAILY':
      pattern.type = 'daily';
      if (rule.BYDAY || rule.BYMONTH || rule.BYMONTHDAY)
        throw badRequest('Daily recurrence does not accept BYDAY, BYMONTH or BYMONTHDAY.');
      break;
    case 'WEEKLY': {
      if (rule.BYMONTH || rule.BYMONTHDAY)
        throw badRequest('Weekly recurrence does not accept BYMONTH or BYMONTHDAY.');
      pattern.type = 'weekly';
      const days = (
        rule.BYDAY ??
        Object.keys(DAYS)[(new Date(`${startDate}T12:00:00Z`).getUTCDay() + 6) % 7] ??
        ''
      ).split(',');
      if (days.some((d) => !DAYS[d]) || (rule.WKST && !DAYS[rule.WKST]))
        throw badRequest('Use ordinary weekdays such as MO,WE for Microsoft weekly recurrence.');
      pattern.daysOfWeek = days.map((d) => DAYS[d]);
      pattern.firstDayOfWeek = DAYS[rule.WKST ?? 'MO'];
      break;
    }
    case 'MONTHLY':
    case 'YEARLY':
      if (rule.BYDAY || (rule.FREQ === 'MONTHLY' && rule.BYMONTH))
        throw badRequest('Use BYMONTHDAY for Microsoft monthly or yearly recurrence.');
      pattern.type = rule.FREQ === 'MONTHLY' ? 'absoluteMonthly' : 'absoluteYearly';
      pattern.dayOfMonth = number(rule.BYMONTHDAY, day ?? 1, 31);
      if (rule.FREQ === 'YEARLY') pattern.month = number(rule.BYMONTH, month ?? 1, 12);
      break;
    default:
      throw badRequest('Microsoft supports DAILY, WEEKLY, MONTHLY and YEARLY recurrence.');
  }
  if (!year) throw badRequest('Invalid recurrence start.');
  const range: Record<string, unknown> = {
    type: 'noEnd',
    startDate,
    recurrenceTimeZone: input.timeZone ?? 'UTC',
  };
  if (rule.COUNT) {
    range.type = 'numbered';
    range.numberOfOccurrences = number(rule.COUNT, 1, 999);
  }
  if (rule.UNTIL) {
    if (!/^\d{8}$/.test(rule.UNTIL))
      throw badRequest('Microsoft UNTIL must be a date (YYYYMMDD); use COUNT for a timed cutoff.');
    range.type = 'endDate';
    range.endDate = `${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}`;
    if (String(range.endDate) < startDate) throw badRequest('Recurrence ends before it starts.');
  }
  return { pattern, range };
}
