/**
 * Own names on the box, the pure parts (own-address.md): the certificate judgement over the current and the leaving
 * host with Cloudflare's known certificates, what an older app reads, how control's refusals of a rename reach the
 * session, and the notices of a changed address.
 */
import { OWN_ADDRESS_ZONE_CERTIFICATES } from '@whombat/protocol/own-address';
import type { OwnAddressSummary } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors';
import { ManagerCallError } from '../ports';
import { coversAny, coversHost, foreignCertificates } from './ct';
import { dayMonthText, LEAVING_WARN_MS, OWN_ADDRESS_WORDS, ownAddressItems } from './notices';
import { olderAppReads, ownAddressFor, readsOlderHostsOnly, whombatsFor } from './older-apps';
import { renameRefusal } from './ops';
import type { OwnAddressService } from './state';

const HOST = 'home.whombat.app';
const OLD = 'maple-otter-river.box.whombat.app';
const NOW = Date.parse('2026-12-01T12:00:00Z');
const key = (c: string) => c.repeat(64);
const cert = (spkiSha256: string, dnsNames: string[], notAfter = '2099-01-01T00:00:00Z') => ({
  id: '1',
  spkiSha256,
  dnsNames,
  notBefore: '2026-11-01T00:00:00Z',
  notAfter,
  issuer: 'R11',
});
const [GTS, LE] = OWN_ADDRESS_ZONE_CERTIFICATES.map((c) => c.spkiSha256) as [string, string];

describe('the certificate judgement over two hosts', () => {
  it('lets *.whombat.app cover a name under whombat.app, never one under box.whombat.app', () => {
    expect(coversHost('*.whombat.app', HOST)).toBe(true);
    expect(coversHost('*.whombat.app', OLD)).toBe(false);
    expect(coversHost('*.box.whombat.app', OLD)).toBe(true);
    expect(coversHost('whombat.app', HOST)).toBe(false);
    expect(coversAny(['example.com', OLD], [HOST, OLD])).toBe(true);
    expect(coversAny(['example.com'], [HOST, OLD])).toBe(false);
  });

  it('finds what is foreign for either host, and never Cloudflare’s two within their dates', () => {
    const found = foreignCertificates({
      hosts: [HOST, OLD],
      own: new Set([key('a')]),
      at: NOW,
      certs: [
        cert(key('a'), [HOST]),
        cert(GTS, ['*.whombat.app', 'whombat.app'], '2027-02-16T08:09:15Z'),
        cert(LE, ['*.whombat.app', 'whombat.app'], '2027-02-16T07:16:19Z'),
        cert(key('b'), ['*.whombat.app']),
        cert(key('c'), [OLD]),
        cert(key('d'), ['other.whombat.app']),
      ],
    });
    expect(found.map((f) => f.spkiSha256)).toEqual([key('b'), key('c')]);
  });

  it('judges Cloudflare’s keys like any other once their date passed', () => {
    const after = Date.parse('2027-02-17T00:00:00Z');
    const found = foreignCertificates({
      hosts: [HOST],
      own: new Set(),
      at: after,
      certs: [cert(GTS, ['*.whombat.app'])],
    });
    expect(found.map((f) => f.spkiSha256)).toEqual([GTS]);
  });
});

const summary = (host: string, leaving?: string): OwnAddressSummary => ({
  host,
  url: `https://${host}/`,
  state: 'ready',
  reachable: true,
  certificateEndsAt: null,
  watch: { lastCheckAt: null, missed: [], foreign: [] },
  ...(leaving
    ? { leaving: { host: leaving, url: `https://${leaving}/`, until: '2026-12-23T00:00:00.000Z' } }
    : {}),
});

describe('what an older app reads', () => {
  it('is only the three-word host under box. or dev., from apps before session minor 6', () => {
    expect(readsOlderHostsOnly(5)).toBe(true);
    expect(readsOlderHostsOnly(6)).toBe(false);
    expect(readsOlderHostsOnly(undefined)).toBe(false);
    expect(olderAppReads(OLD)).toBe(true);
    expect(olderAppReads('maple-otter-river.dev.whombat.app')).toBe(true);
    expect(olderAppReads('maple-otter-river.whombat.app')).toBe(false);
    expect(olderAppReads('home.box.whombat.app')).toBe(false);
  });

  it('leaves the address out when its host is new, and the leaving one out always', () => {
    expect(ownAddressFor(summary(HOST, OLD), 5)).toBeNull();
    expect(ownAddressFor(summary(HOST, OLD), 6)?.leaving?.host).toBe(OLD);
    const older = ownAddressFor(summary(OLD, 'cedar-fox-lake.box.whombat.app'), 5);
    expect(older?.host).toBe(OLD);
    expect(older && 'leaving' in older).toBe(false);
    expect(ownAddressFor(null, 5)).toBeNull();
  });

  it('drops boxes whose host it can’t read from the person’s list', () => {
    const list = [
      { device: 'a', host: OLD },
      { device: 'b', host: HOST },
      { device: 'c', host: null },
    ];
    expect(whombatsFor(list, 5).map((w) => w.device)).toEqual(['a', 'c']);
    expect(whombatsFor(list, 6)).toHaveLength(3);
  });
});

describe('a refused rename or check', () => {
  const codeOf = (err: unknown) => {
    const e = renameRefusal(err);
    return { code: e.code, reason: (e.extra.details as { code?: string } | undefined)?.code };
  };
  const manager = (status: number, code: string, message = '') =>
    new ManagerCallError('/v1/own-address/rename', status, code, message);

  it('carries the manager’s and control’s reasons as the session’s codes', () => {
    expect(codeOf(manager(409, 'own_address.label_taken'))).toEqual({
      code: 'conflict',
      reason: 'label_taken',
    });
    expect(codeOf(manager(409, 'own_address.label_reserved'))).toEqual({
      code: 'not_allowed',
      reason: 'label_reserved',
    });
    expect(codeOf(manager(409, 'own_address.rename_limit'))).toEqual({
      code: 'rate_limited',
      reason: 'rename_limit',
    });
    expect(codeOf(manager(409, 'own_address.link_off'))).toEqual({ code: 'not_allowed', reason: 'link_off' });
    expect(codeOf(manager(404, 'own_address.off'))).toEqual({
      code: 'unavailable',
      reason: 'own_address_off',
    });
    expect(codeOf(manager(502, 'control_refused', 'label_invalid: bad'))).toEqual({
      code: 'validation_failed',
      reason: 'label_invalid',
    });
  });

  it('reads an older manager and an unreachable control as such', () => {
    expect(codeOf(manager(404, 'not_found'))).toEqual({
      code: 'unavailable',
      reason: 'own_address_unavailable',
    });
    expect(codeOf(manager(503, 'control_unreachable'))).toEqual({
      code: 'unavailable',
      reason: 'control_unreachable',
    });
    expect(codeOf(new Error('socket'))).toEqual({ code: 'unavailable', reason: 'control_unreachable' });
    const own = new ApiError('forbidden', 'no');
    expect(renameRefusal(own)).toBe(own);
  });
});

describe('the notices of a changed address', () => {
  const until = new Date(Date.parse('2026-12-23T00:00:00Z'));
  const service = (leaving: { host: string; until: Date } | null) =>
    ({
      host: () => HOST,
      leaving: () => (leaving ? { label: 'maple-otter-river', ...leaving } : null),
      validForeign: async () => [],
      watch: () => null,
      servedUntil: () => null,
      ready: () => true,
    }) as unknown as OwnAddressService;
  const only = (answer: boolean) => ({ onlyAt: async () => answer });

  it('say calmly that the address changed while the old one works, with its date', async () => {
    const items = await ownAddressItems(service({ host: OLD, until }), new Date(NOW), only(false));
    expect(items.map((i) => i.ref.id)).toEqual([`own_address.moved:${HOST}`]);
    expect(items[0]).toMatchObject({ severity: 'info', nature: 'fyi' });
    expect(items[0]?.body).toContain(HOST);
    expect(items[0]?.body).toContain('23 December');
    expect(await ownAddressItems(service(null), new Date(NOW), only(true))).toEqual([]);
  });

  it('warn 3 days before the old one stops, only while a device has passkeys only for it', async () => {
    const before = new Date(until.getTime() - LEAVING_WARN_MS - 60_000);
    const within = new Date(until.getTime() - LEAVING_WARN_MS + 60_000);
    const ids = async (now: Date, answer: boolean) =>
      (await ownAddressItems(service({ host: OLD, until }), now, only(answer))).map((i) => i.ref.id);
    expect(await ids(before, true)).not.toContain(`own_address.leaving:${OLD}`);
    expect(await ids(within, false)).not.toContain(`own_address.leaving:${OLD}`);
    expect(await ids(within, true)).toContain(`own_address.leaving:${OLD}`);
    expect(OWN_ADDRESS_WORDS.leavingBody(OLD, dayMonthText(until.toISOString()), HOST)).toContain(HOST);
  });
});
