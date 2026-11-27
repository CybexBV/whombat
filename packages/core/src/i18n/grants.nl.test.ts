import { describe, expect, it } from 'vitest';
import { alwaysAllowConfirm } from '../approvals/display.js';
import { type CatalogField, fieldProblem } from '../domain/connections-catalog.js';
import { councilSeatsProblem } from '../domain/council.js';
import {
  HOST_SELF_GUEST_LABEL,
  HOST_SELF_SERVER_POWER_TEXT,
  hostInstallErrorText,
  hostScreenProblemText,
  hostSelfWords,
  hostsAddressChangeText,
} from '../domain/hosts.js';
import { describeGrantChange, formatKeysSummary } from '../keys/grants.js';

const field = { id: 'url', label: 'Address', kind: 'url', required: true } as CatalogField;

describe('grants track in Dutch', () => {
  it('keeps English by default', () => {
    expect(alwaysAllowConfirm('Neo', 'deploy', 'Always allow Neo to deploy').title).toBe(
      'Let Neo deploy without asking?',
    );
    expect(
      describeGrantChange('Neo', { keyId: 'tests.run', kind: 'added', from: null, to: 'can' }),
    ).toContain('Gave Neo a new key');
    expect(formatKeysSummary({ keys: 1, askFirst: 0 })).toBe('1 key · 0 ask first');
    expect(councilSeatsProblem([])).toContain('two seats');
    expect(fieldProblem(field, '')).toBe('Address is needed.');
    expect(hostInstallErrorText('sign_in_failed', { address: '10.100.0.9', withKey: true })).toContain(
      'user name or key',
    );
    expect(hostsAddressChangeText({ from: 'a', to: 'b', waiting: [{ name: 'x' }, { name: 'y' }] })).toContain(
      '2 servers',
    );
    expect(hostSelfWords('en')).toEqual({
      guestLabel: HOST_SELF_GUEST_LABEL,
      serverPower: HOST_SELF_SERVER_POWER_TEXT,
    });
  });

  it('speaks Dutch when asked', () => {
    expect(alwaysAllowConfirm('Neo', 'deploy', 'x', 'nl').title).toContain('laten uitrollen');
    expect(alwaysAllowConfirm('Neo', 'deploy', 'x', 'nl').keep).toBe('Blijven vragen');
    expect(
      describeGrantChange('Neo', { keyId: 'tests.run', kind: 'removed', from: 'can', to: null }, 'nl'),
    ).toContain('afgenomen');
    expect(formatKeysSummary({ keys: 3, askFirst: 1 }, 'nl')).toBe('3 sleutels · 1 eerst vragen');
    expect(councilSeatsProblem([], 'nl')).toContain('zetels');
    expect(fieldProblem(field, '', 'nl')).toBe('Address is nodig.');
    expect(fieldProblem(field, 'ftp://x', 'nl')).toContain('https://');
    expect(hostInstallErrorText('unreachable', { address: '10.100.0.9' }, 'nl')).toContain('10.100.0.9');
    expect(hostInstallErrorText('unreachable', { address: '10.100.0.9' }, 'nl')).toContain('antwoordt');
    expect(hostScreenProblemText('locked', 'The Titan', null, 'nl')).toContain('vergrendeld');
    expect(hostScreenProblemText('locked', 'The Titan', 'Its own words', 'nl')).toBe('Its own words');
    expect(hostsAddressChangeText({ from: 'a', to: 'b', waiting: [{ name: 'x' }] }, 'nl')).toContain(
      'nog niet gevonden',
    );
    expect(hostSelfWords('nl').guestLabel).toBe('Deze Whombat');
  });
});
