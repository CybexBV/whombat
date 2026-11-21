import { describe, expect, it } from 'vitest';
import type { Check } from '../../api/types';
import {
  durationOptions,
  emptyForm,
  formatSeconds,
  formatUptime,
  formOf,
  pingExamples,
  sortChecks,
  splitHostPort,
  targetText,
  toInput,
  validate,
  validHost,
  validStatusRanges,
} from './checkForm';

const form = (over: Partial<ReturnType<typeof emptyForm>>) => ({ ...emptyForm(over.kind), name: 'x', ...over });

describe('hosts and ports', () => {
  it('accepts names and addresses like the hub', () => {
    expect(validHost('db.lan')).toBe(true);
    expect(validHost('10.0.0.7')).toBe(true);
    expect(validHost('2001:db8::1')).toBe(true);
    expect(validHost('my_host')).toBe(true);
    expect(validHost('-bad.lan')).toBe(false);
    expect(validHost('a..b')).toBe(false);
    expect(validHost('has space')).toBe(false);
    expect(validHost('300.1.1.1')).toBe(false);
  });
  it('splits host:port and [v6]:port', () => {
    expect(splitHostPort('db.lan:5432')).toEqual({ host: 'db.lan', port: 5432 });
    expect(splitHostPort('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 });
    expect(splitHostPort('db.lan')).toBeNull();
    expect(splitHostPort('db.lan:70000')).toBeNull();
    expect(splitHostPort('db.lan:0')).toBeNull();
  });
  it('checks status ranges', () => {
    expect(validStatusRanges('')).toBe(true);
    expect(validStatusRanges('200-299, 301')).toBe(true);
    expect(validStatusRanges('299-200')).toBe(false);
    expect(validStatusRanges('99')).toBe(false);
    expect(validStatusRanges('2xx')).toBe(false);
  });
});

describe('validate', () => {
  it('needs a name and a target that fits the kind', () => {
    expect(validate(form({ name: ' ', target: 'https://x.lan' })).name).toBeTruthy();
    expect(validate(form({ kind: 'http', target: 'x.lan' })).target).toBeTruthy();
    expect(validate(form({ kind: 'http', target: 'ftp://x.lan' })).target).toBeTruthy();
    expect(validate(form({ kind: 'http', target: 'https://x.lan/health' }))).toEqual({});
    expect(validate(form({ kind: 'tcp', target: 'db.lan' })).target).toBeTruthy();
    expect(validate(form({ kind: 'tcp', target: 'db.lan:5432' }))).toEqual({});
    expect(validate(form({ kind: 'ping', target: '10.0.0.1' }))).toEqual({});
    expect(validate(form({ kind: 'dns', target: 'example.com.', dns_server: '1.1.1.1:53' }))).toEqual({});
    expect(validate(form({ kind: 'dns', target: 'example.com', dns_server: 'not a server' })).dns_server).toBeTruthy();
  });
  it('checks options', () => {
    expect(validate(form({ kind: 'http', target: 'https://x.lan', expect_status: '2xx' })).expect_status).toBeTruthy();
    expect(validate(form({ kind: 'http', target: 'https://x.lan', cert_warn_days: '400' })).cert_warn_days).toBeTruthy();
    expect(validate(form({ kind: 'http', target: 'https://x.lan', cert_warn_days: '21' }))).toEqual({});
  });
  it('checks heartbeat periods without a target', () => {
    expect(validate(form({ kind: 'heartbeat', period_s: 3600, grace_s: 600 }))).toEqual({});
    expect(validate(form({ kind: 'heartbeat', period_s: 30 })).period_s).toBeTruthy();
    expect(validate(form({ kind: 'heartbeat', grace_s: 8 * 86400 })).grace_s).toBeTruthy();
  });
});

describe('toInput', () => {
  it('sends only the fields of the kind', () => {
    expect(toInput(form({ kind: 'tcp', target: ' db.lan:5432 ', keyword: 'stale', tls: false }))).toEqual({
      name: 'x',
      kind: 'tcp',
      target: 'db.lan:5432',
      runner: 'hub',
      interval_s: 60,
      options: {},
    });
    expect(toInput(form({ kind: 'http', target: 'https://x', expect_status: '200 - 299', insecure: true, cert_warn_days: '7' })).options).toEqual({
      expect_status: '200-299',
      insecure: true,
      cert_warn_days: 7,
    });
    expect(toInput(form({ kind: 'heartbeat', period_s: 86400, grace_s: 3600, target: 'ignored' }))).toEqual({
      name: 'x',
      kind: 'heartbeat',
      interval_s: 86400,
      grace_s: 3600,
      options: {},
    });
  });
  it('round-trips an existing check', () => {
    const c = {
      id: 'ck_1',
      name: 'DNS',
      kind: 'dns',
      target: 'example.com',
      runner: 'basalt',
      interval_s: 300,
      timeout_s: 10,
      grace_s: 0,
      options: { dns_type: 'MX', dns_server: '1.1.1.1' },
      enabled: true,
    } as unknown as Check;
    expect(toInput(formOf(c))).toEqual({
      name: 'DNS',
      kind: 'dns',
      target: 'example.com',
      runner: 'basalt',
      interval_s: 300,
      options: { dns_type: 'MX', dns_server: '1.1.1.1' },
    });
  });
});

describe('wording', () => {
  it('formats durations', () => {
    expect([30, 60, 300, 3600, 86400, 172800, 604800, 0].map(formatSeconds)).toEqual(['30 s', '1 min', '5 min', '1 h', '1 day', '2 days', '1 week', 'none']);
    expect(durationOptions([60, 3600], 600)).toEqual([60, 600, 3600]);
    expect(durationOptions([60, 3600], 60)).toEqual([60, 3600]);
  });
  it('describes the target per kind', () => {
    const base = { target: 'db.lan:5432', interval_s: 86400, grace_s: 3600, options: {} };
    expect(targetText({ ...base, kind: 'tcp', options: { tls: true } })).toBe('db.lan:5432 · TLS');
    expect(targetText({ ...base, kind: 'dns', target: 'example.com', options: { dns_type: 'MX', dns_server: '1.1.1.1' } })).toBe('MX example.com @1.1.1.1');
    expect(targetText({ ...base, kind: 'heartbeat', target: '' })).toBe('every 1 day, 1 h grace');
  });
  it('sorts down first and formats uptime', () => {
    const c = (name: string, status: Check['status']) => ({ name, status }) as Check;
    expect(sortChecks([c('b', 'up'), c('a', 'disabled'), c('c', 'down'), c('d', 'pending')]).map((x) => x.name)).toEqual(['c', 'd', 'b', 'a']);
    expect([100, 99.94, null].map(formatUptime)).toEqual(['100%', '99.9%', '—']);
  });
  it('writes the ping examples', () => {
    expect(pingExamples('https://hub/ping/t').split('\n')).toEqual([
      'curl -fsS -m 10 --retry 3 https://hub/ping/t',
      'curl -fsS -m 10 --retry 3 https://hub/ping/t/start',
      'curl -fsS -m 10 --retry 3 https://hub/ping/t/$?',
    ]);
  });
});
