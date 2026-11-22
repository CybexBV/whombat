import { describe, expect, it } from 'vitest';
import {
  type CallTargetRow,
  ConnectionChangedError,
  callTarget,
  keepTarget,
  undoGoesWhereChangeWent,
} from './call-target';

const row: CallTargetRow = {
  id: 'con_1',
  catalogId: 'homeassistant',
  baseUrl: 'http://ha.example.com:8123',
  fields: { url: 'http://ha.example.com:8123' },
  signIn: 'token',
  transport: 'mcp',
  auth: null,
  secretEnc: 'sealed-1',
  clientSecretEnc: null,
  clientId: null,
  issuer: null,
  resource: null,
  credentialVersion: 1,
} as CallTargetRow;

describe('where a connection’s calls go and as whom', () => {
  const others: Partial<CallTargetRow>[] = [
    { secretEnc: 'sealed-2' },
    { credentialVersion: 2 },
    { baseUrl: 'http://ha2.example.com:8123' },
    { fields: { url: 'http://ha2.example.com:8123' } },
  ];

  it('a replaced token, account or address is another target', () => {
    for (const other of others) expect(callTarget({ ...row, ...other })).not.toBe(callTarget(row));
  });

  it('signs only while the stored connection is the one checked', () => {
    expect(() => keepTarget(row, callTarget(row))).not.toThrow();
    for (const other of others)
      expect(() => keepTarget({ ...row, ...other }, callTarget(row))).toThrow(ConnectionChangedError);
    expect(() => keepTarget(null, callTarget(row))).toThrow(ConnectionChangedError);
  });

  it('undoes only where a change went, and as before for a change that kept nowhere', () => {
    expect(undoGoesWhereChangeWent(row, callTarget(row))).toBe(true);
    for (const other of others)
      expect(undoGoesWhereChangeWent({ ...row, ...other }, callTarget(row))).toBe(false);
    expect(undoGoesWhereChangeWent({ ...row, secretEnc: 'sealed-2' }, undefined)).toBe(true);
  });
});
