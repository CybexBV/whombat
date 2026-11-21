import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOperationAllowlist } from '../operations.js';
import {
  ASSISTANT_SETTINGS,
  type AssistantSetting,
  assistantAccessFor,
  assistantSetting,
  peopleOnlyOp,
  SETTINGS_PAGES,
  settingsOps,
} from './index.js';

const allowlist = createOperationAllowlist();
const table: Record<string, AssistantSetting> = ASSISTANT_SETTINGS;

/** Every property path of an op's input (`body.fields`, `body.fields.*`, `body.seats.[].model`). */
function inputPaths(op: string): string[] {
  const spec = allowlist.get(op);
  if (!spec) return [];
  const paths = new Set<string>();
  const walk = (node: unknown, at: string) => {
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (o.properties && typeof o.properties === 'object')
      for (const [k, v] of Object.entries(o.properties)) {
        paths.add(`${at}${k}`);
        walk(v, `${at}${k}.`);
      }
    for (const many of ['anyOf', 'oneOf', 'allOf'])
      if (Array.isArray(o[many])) for (const x of o[many]) walk(x, at);
    if (o.items) walk(o.items, `${at}[].`);
    if (o.additionalProperties && typeof o.additionalProperties === 'object')
      walk(o.additionalProperties, `${at}*.`);
  };
  walk(z.toJSONSchema(spec.input, { io: 'input', unrepresentable: 'any' }), '');
  return [...paths];
}

/**
 * A part of an input that is an address something is sent to, an access level or a secret, by its name: a connection's
 * `fields` hold its address.
 */
const SENSITIVE =
  /^(.*url|address|target|endpoint|host(name)?|origin|fields|.*access|tiers?|scopes|permissions?)$|secret|token|password|passphrase|apikey|privatekey|credential/i;

/** Parts that match `SENSITIVE` by name but are none of those, and why. */
const NOT_SENSITIVE: Record<string, Record<string, string>> = {
  'connections.hideFound': { 'body.url': 'which found service to hide: nothing is sent there' },
  'councils.saveSetup': { 'body.target': 'the score a council works towards' },
  'diagnostics.create': { scopes: 'which parts of the box a support bundle holds; it stays on the box' },
  'feedback.createIntegration': { 'body.privacyUrl': 'a link the widget shows: nothing is sent there' },
  'feedback.updateIntegration': {
    'body.settings.privacyUrl': 'a link the widget shows: nothing is sent there',
  },
  'host.bluetooth.connect': { address: 'a Bluetooth device’s own address, next to the box' },
  'host.bluetooth.pair': { address: 'a Bluetooth device’s own address, next to the box' },
  'hosts.createMaintenance': { 'body.target': 'a server or group by its name, whose alerts are muted' },
};

describe('the assistant settings map', () => {
  it('has exactly one entry per operation', () => {
    expect(Object.keys(table).sort()).toEqual(allowlist.ops);
  });

  it('names the page and the words of every setting, and of nothing else', () => {
    for (const [op, e] of Object.entries(table)) {
      if (e.access === 'none') {
        expect([op, e.page, e.words]).toEqual([op, undefined, undefined]);
        continue;
      }
      expect(e.page && Object.hasOwn(SETTINGS_PAGES, e.page), `${op}: page`).toBe(true);
      // A short imperative phrase in sentence case, without a full stop or an id.
      expect(e.words, `${op}: words`).toMatch(/^[A-Z][^.\n]{2,79}$/);
    }
  });

  it('reads only what doesn’t change and changes only what does', () => {
    for (const op of allowlist.ops) {
      const spec = allowlist.get(op);
      const { access } = table[op] ?? { access: 'none' };
      if (access === 'read') expect(spec?.mutating, `${op} is a read`).toBe(false);
      if (access === 'change' || access === 'ask') expect(spec?.mutating, `${op} changes`).toBe(true);
    }
  });

  it('always asks before a destructive change', () => {
    for (const op of allowlist.ops)
      if (allowlist.get(op)?.destructive) expect(table[op]?.access, op).not.toBe('change');
  });

  it('never passes a secret, an export or another channel through the assistant', () => {
    for (const op of allowlist.ops) {
      const spec = allowlist.get(op);
      if (!spec) continue;
      const out =
        spec.secret ||
        spec.ephemeral ||
        spec.exportOp ||
        spec.transfer === 'export' ||
        spec.channel !== 'app';
      if (out) expect(['none', 'never'], op).toContain(table[op]?.access);
    }
  });

  it('keeps the people-only places the person’s', () => {
    for (const op of allowlist.ops)
      if (peopleOnlyOp(op)) expect(['none', 'never'], op).toContain(table[op]?.access);
  });

  it('never lets the assistant move an address, an access level or a secret on its own', () => {
    const loose: string[] = [];
    for (const op of allowlist.ops) {
      const e = table[op] ?? assistantSetting(op);
      if (e.access !== 'change') continue;
      for (const path of inputPaths(op)) {
        const name = path.split('.').at(-1) ?? path;
        if (!SENSITIVE.test(name) || NOT_SENSITIVE[op]?.[path]) continue;
        // A guarded part (or the part it is in) raises the change to Ask or the person's.
        const held = Object.keys(e.guard ?? {}).some((g) => path === g || path.startsWith(`${g}.`));
        if (!held) loose.push(`${op}: ${path}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it('guards only parts a change takes, and only to Ask or the person’s', () => {
    for (const [op, e] of Object.entries(table)) {
      if (!e.guard) continue;
      expect(e.access, `${op} is a change`).toBe('change');
      const paths = inputPaths(op);
      for (const [path, raised] of Object.entries(e.guard)) {
        expect(paths, `${op}: ${path}`).toContain(path);
        expect(['ask', 'never'], `${op}: ${path}`).toContain(raised);
      }
    }
    for (const [op, parts] of Object.entries(NOT_SENSITIVE))
      for (const path of Object.keys(parts)) expect(inputPaths(op), `${op}: ${path}`).toContain(path);
  });

  it('renames a connection, and leaves its address and access to the person', () => {
    const at = (body: Record<string, unknown>) =>
      assistantAccessFor('connections.update', { params: { connectionId: 'con_1' }, body });
    expect(at({ label: 'Plex at home' })).toBe('change');
    expect(at({ fields: { url: 'https://example.com' } })).toBe('never');
    expect(at({ label: 'Plex', access: 'manage' })).toBe('never');
    expect(at({ access: 'look' })).toBe('never');
  });

  it('asks before a check looks somewhere else or is switched off', () => {
    const at = (body: Record<string, unknown>) =>
      assistantAccessFor('hosts.updateCheck', { params: { checkId: 'chk_1' }, body });
    expect(at({ name: 'Website' })).toBe('change');
    expect(at({ enabled: false })).toBe('ask');
    expect(at({ target: 'https://example.com' })).toBe('ask');
  });

  it('lists the settings, and calls an unknown op none', () => {
    expect(settingsOps()).toContain('host.cable.set');
    expect(settingsOps()).not.toContain('messages.send');
    expect(assistantSetting('no.such')).toEqual({ access: 'none' });
  });

  it('knows how to move the box to Wi-Fi only, asking first', () => {
    expect(table['host.cable.set']).toMatchObject({ access: 'ask', page: 'appliance.overview' });
    expect(table['host.network']).toMatchObject({ access: 'read', page: 'appliance.overview' });
  });
});
