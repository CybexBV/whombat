/**
 * What the media kinds say is going on, for the desk's calm glance (desk-display-server.md DK-S141), from the recorded
 * answers: Plex's viewers, SABnzbd's queue, Seerr's new requests, what Sonarr and Radarr download.
 */
import { describe, expect, it } from 'vitest';
import { kindOf } from '../index';
import { arrActivity, parseQueue as parseArrQueue } from './arr';
import { parseSessions, plexActivity } from './plex';
import { parseQueue as parseSabQueue, sabActivity } from './sabnzbd';
import { parseRequests, parseTitle, type SeerrTitle, seerrActivity, titleKey } from './seerr';
import { fixture } from './testing';

const now = new Date('2026-10-21T19:50:00Z');

describe('Plex', () => {
  const sessions = parseSessions(fixture('plex-sessions.json'));

  it('says how many watch and what, going on while anyone does', () => {
    const a = plexActivity({ sessions, activities: [] });
    expect(a).toMatchObject({ active: true, value: '1 watching' });
    expect(a?.detail).toContain('Dune');
  });

  it('is quiet with nobody watching, and unknown when the live part wasn’t read', () => {
    expect(plexActivity({ sessions: [], activities: [] })).toEqual({
      active: false,
      value: 'Nobody watching',
    });
    expect(plexActivity(null)).toBeUndefined();
  });
});

describe('SABnzbd', () => {
  const queue = parseSabQueue(fixture('sab-queue.json'));

  it('counts what is left, the time left and how far the queue is', () => {
    const a = sabActivity({ ...queue, leftMs: 20 * 60_000, leftBytes: queue.sizeBytes / 4 });
    expect(a).toMatchObject({ active: true, value: '3 left · 20 min', progress: 75 });
    expect(a.detail).toContain('Show.Name');
  });

  it('leaves out a time under a minute', () => {
    expect(sabActivity({ ...queue, leftMs: 0 }).value).toBe('3 left');
  });

  it('says a paused queue is paused, and isn’t going on', () => {
    const a = sabActivity(parseSabQueue(fixture('sab-queue-paused.json')));
    expect(a.active).toBe(false);
    expect(a.value).toMatch(/^Paused · \d+ left$/);
  });

  it('says an empty queue has nothing to download', () => {
    expect(sabActivity({ ...queue, slots: [], slotsTotal: 0 })).toEqual({
      active: false,
      value: 'Nothing to download',
    });
  });
});

describe('Seerr', () => {
  const pending = parseRequests(fixture('seerr-pending.json'), now).items;
  const titles = new Map<string, SeerrTitle>();
  const movie = parseTitle(fixture('seerr-movie.json'));
  if (movie) titles.set(titleKey('movie', 969681), movie);
  const counts = { total: 4, pending: 2, processing: 1, available: 0 };

  it('counts the new requests and names the ones it knows', () => {
    const a = seerrActivity({ counts, pending, titles });
    expect(a).toMatchObject({ active: true, value: '2 new requests' });
    expect(a?.detail).toContain('Spider-Man');
  });

  it('says one request, none, or nothing when the count is unknown', () => {
    expect(seerrActivity({ counts: { ...counts, pending: 1 }, pending, titles })?.value).toBe(
      '1 new request',
    );
    expect(seerrActivity({ counts: { ...counts, pending: 0 }, pending: [], titles })).toEqual({
      active: false,
      value: 'No new requests',
    });
    expect(seerrActivity({ counts: { ...counts, pending: null }, pending, titles })).toBeUndefined();
  });
});

describe('Sonarr and Radarr', () => {
  it('count what downloads now and say what the first is for', () => {
    const a = arrActivity(parseArrQueue(fixture('sonarr-queue.json'), 'sonarr'));
    expect(a).toMatchObject({ active: true, value: '2 downloading', progress: 0 });
    expect(a?.detail).toContain('NCIS');
    expect(arrActivity(parseArrQueue(fixture('radarr-queue.json'), 'radarr'))?.value).toBe('1 downloading');
  });

  it('say how many wait when none downloads, and nothing for an empty or unread queue', () => {
    const q = parseArrQueue(fixture('sonarr-queue.json'), 'sonarr');
    const waiting = { ...q, items: q.items.map((i) => ({ ...i, status: 'queued' })) };
    expect(arrActivity(waiting)).toEqual({ active: false, value: '2 in the queue' });
    expect(arrActivity({ items: [], total: 0 })).toEqual({ active: false, value: 'Nothing downloading' });
    expect(arrActivity(null)).toBeUndefined();
  });
});

describe('Settings’ line for each kind', () => {
  it('names what each kind shows', () => {
    expect(kindOf('plex')?.activityLine).toBe('Who’s watching');
    expect(kindOf('sabnzbd')?.activityLine).toBe('The queue and time left');
    expect(kindOf('overseerr')?.activityLine).toBe('New requests');
    expect(kindOf('sonarr')?.activityLine).toBe('What’s downloading');
    expect(kindOf('radarr')?.activityLine).toBe('What’s downloading');
    expect(kindOf('nzbhydra')?.activityLine).toBeUndefined();
  });
});
