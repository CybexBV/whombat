import type { ThreadRow } from '@whombat/client';
import { type ThingSummary, thingHref } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { advancedRowsOnPhone } from '../settings/groups';
import {
  chatLine,
  type SearchEntry,
  searchEntries,
  searchMatches,
  searchSettings,
  searchSuggestions,
  searchView,
} from './search';

const thread = (rootId: string, text: string, extra: Partial<ThreadRow> = {}): ThreadRow => ({
  rootId,
  room: 'chat',
  href: `/chat?thread=${rootId}`,
  authorId: 'prn_mara',
  text,
  subject: null,
  replies: null,
  when: '13:52',
  working: false,
  waiting: false,
  settled: null,
  ...extra,
});

const things: ThingSummary[] = [
  {
    id: 'server:pve-02',
    kind: 'server',
    name: 'pve-02',
    icon: 'proxmox',
    status: 'warn',
    reason: 'Running warm',
    facts: [],
    href: thingHref('server', 'pve-02'),
  },
  {
    id: 'connection:con_ha',
    kind: 'connection',
    catalogId: 'homeassistant',
    name: 'Home Assistant',
    icon: 'home',
    status: 'ok',
    facts: [],
    href: thingHref('connection', 'con_ha'),
  },
];

const settings = searchSettings({
  assistant: 'Neo',
  managed: true,
  you: 'Your photo, notifications and devices',
  screen: null,
  advanced: advancedRowsOnPhone('Neo', { mode: 'managed' }),
});

const entries = searchEntries({
  threads: [
    thread('msg_1', 'Why is pve-02 using so much memory?', { waiting: true, replies: '3 replies' }),
    thread('msg_2', 'Is there new firmware for the access points?', { working: true }),
    thread('msg_3', 'The site is slow', { room: 'feedback', replies: '1 reply' }),
  ],
  things,
  settings,
  assistant: 'Neo',
});

const keys = (rows: readonly SearchEntry[]) => rows.map((r) => r.key);

describe('Search (phone-shell-final.md)', () => {
  it('says what a thread waits on in plain words: waiting, working, its replies', () => {
    expect(chatLine(thread('a', 'x', { waiting: true, working: true }), 'Neo')).toBe('Waiting for you');
    expect(chatLine(thread('a', 'x', { working: true }), 'Neo')).toBe('Neo is working');
    expect(chatLine(thread('a', 'x', { replies: '2 replies' }), 'Neo')).toBe('2 replies');
    expect(chatLine(thread('a', 'x'), 'Neo')).toBe('No replies yet');
    expect(chatLine(thread('a', 'x', { room: 'feedback' }), 'Neo')).toContain('Feedback');
  });

  it('finds a chat and the things by any part of a name, grouped Chats then Things', () => {
    const groups = searchMatches(entries, 'PVE');
    expect(groups.map((g) => g.title)).toEqual(['Chats', 'Things']);
    expect(keys(groups[0]?.rows ?? [])).toEqual(['chat:msg_1']);
    expect(keys(groups[1]?.rows ?? [])).toEqual(['thing:server:pve-02']);
    // The server's line says how it is, its logo comes along.
    expect(groups[1]?.rows[0]?.line).toContain('Running warm');
    expect(groups[1]?.rows[0]?.mark).not.toBeNull();
  });

  it('needs every word, and finds a thing by its kind', () => {
    expect(searchMatches(entries, 'pve memory').flatMap((g) => keys(g.rows))).toEqual(['chat:msg_1']);
    expect(searchMatches(entries, 'homeassistant').flatMap((g) => keys(g.rows))).toEqual([
      'thing:connection:con_ha',
    ]);
  });

  it('finds settings and places, in that order, with Usage an Advanced row and no place of its own', () => {
    const groups = searchMatches(entries, 'notifications');
    expect(groups.map((g) => g.group)).toEqual(['settings']);
    // You holds notifications too; Notifications itself opens its page.
    expect(keys(groups[0]?.rows ?? [])).toEqual(['setting:you', 'setting:notifications']);
    expect(groups[0]?.rows[1]?.open).toEqual({
      kind: 'setting',
      target: { kind: 'page', name: 'SettingsNotifications' },
    });
    const usage = searchMatches(entries, 'usage').flatMap((g) => keys(g.rows));
    expect(usage).toContain('setting:advanced:spend');
    expect(usage.filter((k) => k.startsWith('place:'))).toEqual([]);
    // Search itself and the Overview are no places to find.
    const placeKeys = entries.filter((e) => e.group === 'places').map((e) => e.key);
    expect(placeKeys).not.toContain('place:search');
    expect(placeKeys).not.toContain('place:overview');
    expect(placeKeys).toContain('place:connections');
    expect(searchMatches(entries, 'theme')[0]?.rows[0]?.open).toEqual({
      kind: 'setting',
      target: { kind: 'tab' },
    });
    expect(searchMatches(entries, 'files').map((g) => g.group)).toContain('places');
  });

  it('names the assistant by its name and leaves Notifications out where the phone has none', () => {
    expect(searchMatches(entries, 'Neo').some((g) => g.group === 'settings')).toBe(true);
    const demo = searchSettings({
      assistant: 'Neo',
      managed: false,
      you: 'Your photo',
      screen: 'Screen',
      advanced: [],
    });
    expect(demo.map((s) => s.key)).not.toContain('notifications');
    expect(demo.map((s) => s.key)).toContain('screen');
    expect(demo.map((s) => s.key)).not.toContain('news');
    const withNews = searchSettings({
      assistant: 'Neo',
      managed: true,
      you: 'You',
      screen: null,
      advanced: [],
      news: true,
    });
    expect(withNews.find((s) => s.key === 'news')?.target).toEqual({ kind: 'page', name: 'SettingsNews' });
    const found = searchEntries({ threads: [], things: [], settings: withNews, assistant: 'Neo' });
    expect(searchMatches(found, 'weather').some((g) => g.group === 'settings')).toBe(true);
    expect(demo.find((s) => s.key === 'appliance')?.target).toEqual({
      kind: 'page',
      name: 'SettingsWhombat',
    });
  });

  it('has an empty, a loading, a failed, a no-results and a results state', () => {
    const base = { entries, loading: false, failed: false };
    expect(searchView({ ...base, query: '  ' })).toEqual({ kind: 'empty' });
    expect(searchView({ ...base, query: 'pve', loading: true })).toEqual({ kind: 'loading', query: 'pve' });
    expect(searchView({ ...base, query: 'pve', failed: true })).toEqual({ kind: 'failed' });
    expect(searchView({ ...base, query: 'garden shed' })).toEqual({ kind: 'none', query: 'garden shed' });
    const found = searchView({ ...base, query: 'pve' });
    expect(found.kind === 'results' && found.count).toBe(2);
  });

  it('suggests real names: a thing first, then a setting and a place', () => {
    expect(searchSuggestions(entries)).toEqual(['pve-02', 'Notifications', 'Theme']);
    // Only what finds something: without things or a Notifications setting, the theme and Files.
    const bare = searchEntries({ threads: [], things: [], settings: settings.slice(2, 3), assistant: 'Neo' });
    expect(searchSuggestions(bare)).toEqual(['Theme', 'Files']);
  });

  it('lists a thread once when both rooms’ lists hold it', () => {
    const twice = searchEntries({
      threads: [thread('msg_1', 'pve'), thread('msg_1', 'pve')],
      things: [],
      settings: [],
      assistant: 'Neo',
    });
    expect(twice.filter((e) => e.group === 'chats')).toHaveLength(1);
  });
});
