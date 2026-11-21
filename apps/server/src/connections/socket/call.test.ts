/**
 * The `call` tool's rules (docs/decisions/connections-more.md CM-14, CM-16, CM-17): its definition, its arguments, reads
 * and writes, the tiers and sensitive rules it goes through, Look only, the answer's text and its cut, and the version
 * a check line says.
 */
import {
  type CatalogEntry,
  CONNECTION_OUTPUT_MAX,
  catalogEntry,
  SOCKET_TOOL_NAME,
  socketToolDef,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { callTier } from '../call';
import { connectionCallAccess } from '../call-access';
import { ConnectionArgumentError } from '../request';
import { ownDefinitions, toolHash } from '../sync';
import { cutAnswer, normaliseSocketArgs, socketAnswerText } from './call';
import { checkVersion, versionText } from './check';

const truenas = catalogEntry('truenas') as CatalogEntry;
const esphome = catalogEntry('esphome') as CatalogEntry;

const tool = (tier: 'can' | 'ask' | 'off') => ({
  name: SOCKET_TOOL_NAME,
  tier,
  access: 'write' as const,
  origin: 'socket',
});

describe('the call tool (CM-14)', () => {
  it('is the one tool of a socket connection, with core’s definition, hashed like any tool', () => {
    const defs = ownDefinitions(truenas, { baseUrl: 'https://nas.home.lan', fields: {}, signIn: 'token' });
    expect(defs.map((d) => [d.name, d.origin, d.access])).toEqual([['call', 'socket', 'write']]);
    expect(defs[0]?.description).toBe(socketToolDef(truenas, 'https://nas.home.lan').description);
    expect(toolHash(defs[0] as (typeof defs)[number])).toMatch(/^[0-9a-f]{64}$/);
    // ESPHome without a sign-in has it too.
    expect(
      ownDefinitions(esphome, { baseUrl: 'http://esphome.lan:6052', fields: {}, signIn: 'none' }),
    ).toHaveLength(1);
  });

  it('takes a method, its params and a stream’s seconds; never the sign-in or a refused method', () => {
    expect(
      normaliseSocketArgs(truenas, { method: ' pool.query ', params: [[['name', '=', 'tank']]] }),
    ).toEqual({
      method: 'pool.query',
      params: [[['name', '=', 'tank']]],
    });
    expect(normaliseSocketArgs(esphome, { method: 'devices/logs', seconds: 90 })).toEqual({
      method: 'devices/logs',
      seconds: 25,
    });
    for (const bad of [
      { method: 'auth.login_with_api_key', params: ['k'] },
      { method: 'core.subscribe' },
      { method: 'pool.query', params: 'tank' },
      { method: 'pool query' },
      { method: 'pool.query', seconds: 1.5 },
      { method: 'pool.query', extra: 1 },
    ])
      expect(() => normaliseSocketArgs(truenas, bad)).toThrow(ConnectionArgumentError);
    expect(() => normaliseSocketArgs(esphome, { method: 'auth/login' }, 'ESPHome · porch')).toThrow(
      /ESPHome · porch/,
    );
  });

  it('runs reads at once and writes at the tool’s tier; sensitive methods ask; Look only refuses writes', () => {
    const can = () => 'can' as const;
    expect(connectionCallAccess(truenas, tool('can'), { method: 'pool.dataset.query' })).toBe('read');
    expect(connectionCallAccess(truenas, tool('can'), { method: 'pool.dataset.create' })).toBe('write');
    expect(callTier(truenas, tool('ask'), { method: 'pool.query' }, can)).toMatchObject({
      access: 'read',
      tier: 'can',
    });
    expect(callTier(truenas, tool('ask'), { method: 'pool.scrub.run' }, can)).toMatchObject({
      access: 'write',
      tier: 'ask',
    });
    expect(callTier(truenas, tool('can'), { method: 'pool.scrub.run' }, can).tier).toBe('can');
    expect(callTier(truenas, tool('can'), { method: 'pool.export', params: [1] }, can)).toMatchObject({
      sensitive: true,
      tier: 'ask',
    });
    expect(callTier(esphome, tool('can'), { method: 'firmware/install', params: {} }, can).tier).toBe('ask');
    expect(callTier(truenas, tool('off'), { method: 'pool.query' }, can).tier).toBe('off');
    expect(callTier(truenas, tool('can'), { method: 'pool.scrub.run' }, can, 'read')).toMatchObject({
      lookOnly: true,
      tier: 'off',
    });
    expect(callTier(truenas, tool('can'), { method: 'pool.query' }, can, 'read').tier).toBe('can');
  });
});

describe('the answer (CM-14)', () => {
  it('is the result’s JSON, a stream’s output then its result, or the error', () => {
    expect(socketAnswerText({ ok: true, result: { a: 1 }, output: [], stopped: false })).toEqual({
      text: '{"a":1}',
      isError: false,
    });
    expect(
      socketAnswerText({ ok: true, result: { success: true }, output: ['one\n', 'two'], stopped: false })
        .text,
    ).toBe('one\ntwo\n{"success":true}');
    expect(socketAnswerText({ ok: true, result: null, output: ['log'], stopped: true }, 5).text).toMatch(
      /^log\n\[still going after 5 s/,
    );
    expect(socketAnswerText({ ok: false, error: { code: -32601 }, code: '-32601', output: [] })).toEqual({
      text: '{"error":{"code":-32601}}',
      isError: true,
    });
  });

  it('is cut at 64 KiB and says so', () => {
    const long = 'x'.repeat(CONNECTION_OUTPUT_MAX + 10);
    const cut = cutAnswer(long);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toContain(`[answer cut at ${CONNECTION_OUTPUT_MAX} bytes]`);
    expect(cutAnswer('short')).toEqual({ text: 'short', truncated: false });
  });
});

describe('the check line’s version (CM-17)', () => {
  it('reads the version where the check says, from the result, or from the greeting', () => {
    expect(versionText('TrueNAS-25.10.1')).toBe('25.10.1');
    expect(versionText('2026.6.5')).toBe('2026.6.5');
    const check = { kind: 'socket' as const, method: 'system.info' };
    expect(checkVersion({ ...check, version: 'version' }, { version: 'TrueNAS-25.04.2' }, null)).toBe(
      '25.04.2',
    );
    expect(checkVersion(check, { version: '2026.6.5' }, null)).toBe('2026.6.5');
    expect(checkVersion(check, '25.10.0', null)).toBe('25.10.0');
    expect(checkVersion(check, { ok: true }, '2026.6.1')).toBe('2026.6.1');
    expect(checkVersion(check, {}, null)).toBeNull();
  });
});
