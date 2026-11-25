/**
 * Looks ahead (Whombat looks-ahead.md): its switch, the calendars it reads and the kinds of finding the person stopped,
 * in Settings under the assistant. Session ops `looksAhead.get` and `looksAhead.update`; the person's own.
 */
import { z } from 'zod';
import { LooksAheadUpdate, LooksAheadView } from '../domain/looks-ahead.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const looksAheadEndpoints = {
  get: endpoint({
    id: 'looksAhead.get',
    method: 'GET',
    path: '/burrows/:burrow/looks-ahead',
    summary:
      'Looks ahead: whether the assistant checks what is on the person’s calendar the afternoon before, which calendars, the kinds of finding they stopped and the last week.',
    params: B,
    response: LooksAheadView,
  }),
  update: endpoint({
    id: 'looksAhead.update',
    method: 'PUT',
    path: '/burrows/:burrow/looks-ahead',
    summary: 'Switch Looks ahead on or off, one calendar, or one kind of finding. The person’s own.',
    params: B,
    body: LooksAheadUpdate,
    response: LooksAheadView,
  }),
};
