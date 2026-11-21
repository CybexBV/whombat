import { afterEach, describe, expect, it } from 'vitest';
import { ports } from '../lib/paths.ts';
import type { EnvState } from './env.ts';
import { ownAddressControlEnv, ownAddressManagerEnv, relayDoorArgs } from './own-address.ts';
import { accountSitePage, accountSiteUrl, controlEnv } from './services.ts';

const doorHelp =
  'Usage of relay:\n  -door-listen string\n  -door-zone string\n  -door-proxy-protocol-from value\n';

describe('the own address on the dev stack (plan §4, MG-161)', () => {
  it('passes the door to a relay that has one, and none otherwise', () => {
    expect(relayDoorArgs({}, doorHelp)).toEqual({ args: [] });
    expect(
      relayDoorArgs(
        {
          WB_MGD_DOOR_LISTEN: '100.64.0.5:4712',
          WB_MGD_DOOR_ZONE: 'dev.whombat.app',
          WB_MGD_DOOR_PROXY_FROM: '100.64.0.9/32',
        },
        doorHelp,
      ),
    ).toEqual({
      args: [
        '-door-listen',
        '100.64.0.5:4712',
        '-door-zone',
        'dev.whombat.app',
        '-door-proxy-protocol-from',
        '100.64.0.9/32',
      ],
    });
    // The zone defaults to DEV's; a relay from before the door gets nothing and says so.
    expect(relayDoorArgs({ WB_MGD_DOOR_LISTEN: '127.0.0.1:4712' }, doorHelp).args).toEqual([
      '-door-listen',
      '127.0.0.1:4712',
      '-door-zone',
      'dev.whombat.app',
    ]);
    const old = relayDoorArgs(
      { WB_MGD_DOOR_LISTEN: '127.0.0.1:4712' },
      'Usage of relay:\n  -listen string\n',
    );
    expect(old.args).toEqual([]);
    expect(old.skipped).toMatch(/no door/);
  });

  it('gives control its zone and switch only when set', () => {
    expect(ownAddressControlEnv({})).toEqual({});
    expect(
      ownAddressControlEnv({ WB_MGD_OWN_ADDRESS_ZONE: 'dev.whombat.app', WB_MGD_OWN_ADDRESS_LBL: 'off' }),
    ).toEqual({
      OWN_ADDRESS_ZONE: 'dev.whombat.app',
      OWN_ADDRESS_LBL: 'off',
    });
    expect(() => ownAddressControlEnv({ WB_MGD_OWN_ADDRESS_LBL: 'yes' })).toThrow(/on or off/);
  });

  it('gives control Link’s daily label cap when set (DEV runs with 2)', () => {
    expect(ownAddressControlEnv({ WB_MGD_LINK_LABELS_PER_DAY: '2' })).toEqual({ LINK_LABELS_PER_DAY: '2' });
    expect(() => ownAddressControlEnv({ WB_MGD_LINK_LABELS_PER_DAY: 'two' })).toThrow(/whole number/);
  });

  it('gives control the address of its weekly Link report when set', () => {
    expect(ownAddressControlEnv({ WB_MGD_LINK_REPORT_TO: 'ops@example.com' })).toEqual({
      LINK_REPORT_TO: 'ops@example.com',
    });
    expect(() => ownAddressControlEnv({ WB_MGD_LINK_REPORT_TO: 'ops' })).toThrow(/e-mail/);
  });

  it('keeps the stack appliance’s own address off unless switched on (D3)', () => {
    expect(ownAddressManagerEnv({})).toEqual({ WHOMBAT_OWN_ADDRESS: 'off' });
    for (const mode of ['staging', 'on', 'off', 'pebble:https://127.0.0.1:14000/dir'])
      expect(ownAddressManagerEnv({ WB_MGD_OWN_ADDRESS: mode })).toEqual({ WHOMBAT_OWN_ADDRESS: mode });
    expect(() => ownAddressManagerEnv({ WB_MGD_OWN_ADDRESS: 'yes' })).toThrow(/want off, on/);
  });

  describe('control’s environment', () => {
    const saved = { zone: process.env.WB_MGD_OWN_ADDRESS_ZONE, lbl: process.env.WB_MGD_OWN_ADDRESS_LBL };
    afterEach(() => {
      for (const [k, val] of [
        ['WB_MGD_OWN_ADDRESS_ZONE', saved.zone],
        ['WB_MGD_OWN_ADDRESS_LBL', saved.lbl],
      ] as const) {
        if (val === undefined) delete process.env[k];
        else process.env[k] = val;
      }
    });

    it('carries the stack’s settings through', () => {
      process.env.WB_MGD_OWN_ADDRESS_ZONE = 'dev.whombat.app';
      process.env.WB_MGD_OWN_ADDRESS_LBL = 'on';
      const e = controlEnv({} as EnvState, '/nonexistent');
      expect(e.OWN_ADDRESS_ZONE).toBe('dev.whombat.app');
      expect(e.OWN_ADDRESS_LBL).toBe('on');
      delete process.env.WB_MGD_OWN_ADDRESS_ZONE;
      delete process.env.WB_MGD_OWN_ADDRESS_LBL;
      const off = controlEnv({} as EnvState, '/nonexistent');
      expect('OWN_ADDRESS_ZONE' in off || 'OWN_ADDRESS_LBL' in off).toBe(false);
    });
  });
});

describe('the account site’s address (control’s UI_URL)', () => {
  it('is https, so Whombat Link has a page to name, and its pages answer here over plain HTTP', () => {
    const before = process.env.WB_MGD_UI_URL;
    delete process.env.WB_MGD_UI_URL;
    try {
      const site = accountSiteUrl();
      expect(site).toBe(`https://localhost:${ports.web}`);
      const e = controlEnv({} as EnvState, '/nonexistent');
      expect(e.UI_URL).toBe(site);
      expect(String(e.UI_ORIGINS).split(',')).toEqual(
        expect.arrayContaining([site, `http://localhost:${ports.web}`]),
      );
      expect(accountSitePage(`${site}/link`)).toBe(`http://localhost:${ports.web}/link`);
      expect(accountSitePage(`${site}/auth/verify#token=abc`)).toBe(
        `http://localhost:${ports.web}/auth/verify#token=abc`,
      );
      // Another site's address, and another port's, are left alone.
      expect(accountSitePage('https://app.whombat.com/link')).toBe('https://app.whombat.com/link');
      expect(accountSitePage(`https://localhost:${ports.web}0/link`)).toBe(
        `https://localhost:${ports.web}0/link`,
      );
      process.env.WB_MGD_UI_URL = 'https://app.example.com';
      expect(controlEnv({} as EnvState, '/nonexistent').UI_URL).toBe('https://app.example.com');
    } finally {
      if (before === undefined) delete process.env.WB_MGD_UI_URL;
      else process.env.WB_MGD_UI_URL = before;
    }
  });
});
