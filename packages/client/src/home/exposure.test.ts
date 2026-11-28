import type { ExposureOpening, ExposureView } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { exposureAskSubject, exposureText, withMeant } from './exposure';

const opening = (id: string, extra: Partial<ExposureOpening> = {}): ExposureOpening => ({
  id,
  source: 'nginx_proxy_manager',
  sourceThing: 'connection:con_npm',
  sourceName: 'Nginx Proxy Manager',
  how: 'proxy',
  address: `${id}.example.com`,
  title: `${id}.example.com → pve-02`,
  via: 'Through Nginx Proxy Manager',
  protection: { https: 'yes', guard: 'none', words: 'HTTPS · nothing in front of it' },
  meant: false,
  isNew: false,
  ask: 'Is it safe?',
  watch: {
    thing: 'connection:con_npm',
    check: 'exposure.new',
    subject: { id: `open:${id}`, name: `${id}.example.com` },
  },
  ...extra,
});

const view = (openings: ExposureOpening[]): ExposureView => ({
  openings,
  sources: [],
  summary: '',
  note: '',
  readAt: '2026-11-28T10:00:00.000Z',
});

describe('withMeant', () => {
  it('takes New and Worth a look away from the one meant and leaves the rest', () => {
    const before = view([
      opening('a', { isNew: true, risk: { kind: 'admin_open', words: 'Open' } }),
      opening('b', { isNew: true }),
    ]);
    const after = withMeant(before, 'a', true);
    expect(after.openings[0]).toMatchObject({ meant: true, isNew: false });
    expect(after.openings[0]?.risk).toBeUndefined();
    expect(after.openings[1]).toBe(before.openings[1]);
  });

  it('pointing out again only drops Meant, and an unchanged page stays the same object', () => {
    const before = view([opening('a', { meant: true })]);
    expect(withMeant(before, 'a', false).openings[0]?.meant).toBe(false);
    expect(withMeant(before, 'a', true)).toBe(before);
    expect(withMeant(before, 'missing', true)).toBe(before);
  });
});

describe('exposureAskSubject', () => {
  it('asks about the place whose settings opened it', () => {
    expect(exposureAskSubject(opening('a'))).toEqual({
      kind: 'connection',
      id: 'con_npm',
      name: 'Nginx Proxy Manager',
    });
    expect(exposureAskSubject({ sourceThing: 'server:pve-02', sourceName: 'pve-02' })).toBeNull();
  });
});

describe('exposureText', () => {
  it('says the same things in English and Dutch, with the names filled in', () => {
    const en = exposureText('en');
    const nl = exposureText('nl');
    expect(en.meantDone('photos.example.com')).toContain('photos.example.com');
    expect(nl.meantDone('photos.example.com')).toContain('photos.example.com');
    expect(nl.title).not.toBe(en.title);
    expect(en.open('pve-02')).toContain('pve-02');
  });
});
