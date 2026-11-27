import { splitPairs } from './pairs.js';

/** When an automation runs (`automations/schedule.ts`). */
export const SCHEDULE = splitPairs({
  'schedule.everyMinute': ['Every minute', 'Elke minuut'],
  'schedule.everyMinutes': ['Every {n} minutes', 'Elke {n} minuten'],
  'schedule.everyHour': ['Every hour', 'Elk uur'],
  'schedule.everyHours': ['Every {n} hours', 'Elke {n} uur'],
  'schedule.everyDay': ['Every day', 'Elke dag'],
  'schedule.everyDays': ['Every {n} days', 'Elke {n} dagen'],
  'schedule.monthly': ['On the {nth} of every month at {time}', 'Op de {nth} van elke maand om {time}'],
  'schedule.everyAt': ['Every {days} at {time}', 'Elke {days} om {time}'],
  'schedule.day': ['day', 'dag'],
  'schedule.weekday': ['weekday', 'werkdag'],
  'schedule.range': ['{from} to {to}', '{from} tot en met {to}'],
  'schedule.and': ['{items} and {last}', '{items} en {last}'],
  'schedule.own': ['On its own schedule', 'Volgens een eigen schema'],
  'schedule.nth.1': ['{n}st', '{n}e'],
  'schedule.nth.2': ['{n}nd', '{n}e'],
  'schedule.nth.3': ['{n}rd', '{n}e'],
  'schedule.nth.other': ['{n}th', '{n}e'],
});
