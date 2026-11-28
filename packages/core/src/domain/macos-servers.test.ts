/**
 * Macs as servers (Whombat macos-servers.md): the platform and OS family, a Mac's own facts on its
 * page, `hosts.screen`'s body and answer, the four hints that start off, and the Mac words of a failed install.
 */
import { describe, expect, it } from 'vitest';
import { api } from '../contracts/index.js';
import { hostCheckStartsOn, hostHintCheck } from './host-watch.js';
import {
  HOST_MACOS_MIN_MAJOR,
  HOST_SCREEN_CODES,
  HOST_SCREEN_LIMITS,
  HOST_SCREEN_OPS,
  HOST_SCREEN_READ_OPS,
  HostMacosDetail,
  HostOsFamily,
  HostScreenBody,
  HostScreenLookQuery,
  HostScreenResult,
  HostServerDetail,
  HostServerPlatform,
  hostInstallErrorText,
  hostScreenProblemText,
  screenMessageText,
} from './hosts.js';

const mac = (over: Record<string, unknown> = {}) => ({
  version: '27.2.1',
  build: '26B131',
  model: 'Mac14,14',
  modelName: 'Mac Studio',
  chip: 'Apple M2 Ultra',
  sip: true,
  filevault: false,
  autoLogin: 'john',
  consoleUser: 'john',
  screen: { sharing: true, account: 'john', signIn: 'ok', signInAt: null, locked: false, w: 3840, h: 2160 },
  helper: { installed: true, version: '1.0.0', running: true, ax: true, user: 'john' },
  ...over,
});

describe('the platform and the OS family', () => {
  it('appends macos to the server kinds, after the Linux ones (Windows after it)', () => {
    expect(HostServerPlatform.options.slice(0, 6)).toEqual([
      'proxmox',
      'standard',
      'incus',
      'unraid',
      'libvirt',
      'macos',
    ]);
    expect(HostOsFamily.options.slice(0, 2)).toEqual(['linux', 'macos']);
  });
});

describe('a Mac’s page', () => {
  it('parses its facts, the screen and the helper', () => {
    const d = HostMacosDetail.parse(mac());
    expect(d.screen.w).toBe(3840);
    expect(d.helper.ax).toBe(true);
  });

  it('takes unknowns as null: no account, the login window, a helper that isn’t running', () => {
    const d = HostMacosDetail.parse(
      mac({
        consoleUser: null,
        autoLogin: null,
        screen: {
          sharing: false,
          account: null,
          signIn: null,
          signInAt: null,
          locked: null,
          w: null,
          h: null,
        },
        helper: { installed: false, version: null, running: false, ax: null, user: null },
      }),
    );
    expect(d.screen.account).toBeNull();
  });

  it('is optional on a server’s detail', () => {
    expect(HostServerDetail.shape.macos.safeParse(undefined).success).toBe(true);
  });
});

describe('hosts.screen', () => {
  it('has the hub’s ops and codes, and only status reads: a look and the UI lists show the whole desktop', () => {
    expect(HOST_SCREEN_OPS).toHaveLength(23);
    expect(HOST_SCREEN_OPS).toEqual(
      expect.arrayContaining(['ui.action', 'ui.quit', 'map.geocode', 'map.snapshot']),
    );
    expect(HOST_SCREEN_OPS).toContain('password');
    expect(HOST_SCREEN_READ_OPS).toEqual(['status']);
    expect(HOST_SCREEN_CODES).toEqual(
      expect.arrayContaining([
        'no_screen',
        'no_account',
        'no_helper',
        'no_access',
        'locked',
        'not_found',
        'no_prompt',
        'not_admin',
      ]),
    );
  });

  it('keeps to the hosts service’s limits', () => {
    const ok = (b: Record<string, unknown>) => HostScreenBody.safeParse(b).success;
    expect(HOST_SCREEN_LIMITS).toMatchObject({
      text: 10_000,
      keys: 500,
      name: 200,
      role: 64,
      target: 2048,
      path: 8,
      position: 16_384,
      scroll: 50,
      width: 8192,
      list: 1000,
      accountBytes: 63,
    });
    const long = (n: number) => 'a'.repeat(n);
    expect(ok({ op: 'type', text: long(2000) })).toBe(true);
    expect(ok({ op: 'type', text: long(2001) })).toBe(false);
    expect(ok({ op: 'ui.set', text: long(10_000) })).toBe(true);
    expect(ok({ op: 'ui.set', text: long(10_001) })).toBe(false);
    expect(ok({ op: 'keys', keys: long(500) })).toBe(true);
    expect(ok({ op: 'keys', keys: long(501) })).toBe(false);
    for (const f of ['app', 'window', 'name']) {
      expect(ok({ op: 'ui.list', [f]: long(200) })).toBe(true);
      expect(ok({ op: 'ui.list', [f]: long(201) })).toBe(false);
    }
    expect(ok({ op: 'ui.press', name: 'OK', role: 'button,checkbox,switch' })).toBe(true);
    expect(ok({ op: 'ui.press', name: 'OK', role: long(65) })).toBe(false);
    expect(ok({ op: 'ui.open', target: long(2048) })).toBe(true);
    expect(ok({ op: 'ui.open', target: long(2049) })).toBe(false);
    expect(ok({ op: 'ui.menu', path: Array(8).fill(long(200)) })).toBe(true);
    expect(ok({ op: 'ui.menu', path: Array(9).fill('File') })).toBe(false);
    expect(ok({ op: 'ui.menu', path: [long(201)] })).toBe(false);
    expect(ok({ op: 'click', x: 0, y: 16_384 })).toBe(true);
    expect(ok({ op: 'click', x: -1, y: 0 })).toBe(false);
    expect(ok({ op: 'drag', x: 0, y: 0, toX: 16_385, toY: 0 })).toBe(false);
    expect(ok({ op: 'scroll', dy: -50 })).toBe(true);
    expect(ok({ op: 'scroll', dy: 51 })).toBe(false);
    expect(ok({ op: 'look', maxW: 8192 })).toBe(true);
    expect(ok({ op: 'look', maxW: 8193 })).toBe(false);
    expect(ok({ op: 'ui.list', limit: 1000 })).toBe(true);
    expect(ok({ op: 'ui.list', limit: 0 })).toBe(false);
    expect(HostScreenLookQuery.safeParse({ maxW: '8193' }).success).toBe(false);
  });

  it('takes the Mac’s user and password up to 63 bytes each, as Apple’s sign-in does', () => {
    const set = (user: string, password: string) =>
      HostScreenBody.safeParse({ op: 'account.set', account: { user, password } }).success;
    expect(set('a'.repeat(63), 'p'.repeat(63))).toBe(true);
    expect(set('a'.repeat(64), 'p')).toBe(false);
    expect(set('john', 'p'.repeat(64))).toBe(false);
    // Bytes, not characters: 32 × “é” is 64 bytes.
    expect(set('john', 'é'.repeat(31))).toBe(true);
    expect(set('john', 'é'.repeat(32))).toBe(false);
  });

  it('asks each op for what it needs', () => {
    expect(HostScreenBody.safeParse({ op: 'click', x: 10, y: 20 }).success).toBe(true);
    expect(HostScreenBody.safeParse({ op: 'click', x: 10 }).success).toBe(false);
    expect(HostScreenBody.safeParse({ op: 'drag', x: 1, y: 2, toX: 3, toY: 4 }).success).toBe(true);
    expect(HostScreenBody.safeParse({ op: 'scroll', dx: 3 }).success).toBe(true);
    expect(HostScreenBody.safeParse({ op: 'scroll' }).success).toBe(false);
    expect(HostScreenBody.safeParse({ op: 'keys', keys: 'cmd+q' }).success).toBe(true);
    // The Mac types its own password into a macOS prompt: the body never carries one.
    expect(HostScreenBody.safeParse({ op: 'password' }).success).toBe(true);
    expect(HostScreenBody.safeParse({ op: 'password', text: 'x' }).success).toBe(false);
    expect(HostScreenBody.safeParse({ op: 'ui.press', name: 'Allow', role: 'button' }).success).toBe(true);
    expect(HostScreenBody.safeParse({ op: 'ui.press' }).success).toBe(false);
    expect(HostScreenBody.safeParse({ op: 'ui.menu', path: ['File', 'Save…'] }).success).toBe(true);
    expect(HostScreenBody.safeParse({ op: 'ui.open', target: 'accessibility' }).success).toBe(true);
  });

  it('takes the account only with account.set, and nothing it doesn’t know', () => {
    const account = { user: 'john', password: 'p' };
    expect(HostScreenBody.safeParse({ op: 'account.set', account }).success).toBe(true);
    expect(HostScreenBody.safeParse({ op: 'account.set' }).success).toBe(false);
    expect(HostScreenBody.safeParse({ op: 'unlock', account }).success).toBe(false);
    expect(HostScreenBody.safeParse({ op: 'status', password: 'p' }).success).toBe(false);
  });

  it('answers a look’s picture with its size and the screen’s, or the Mac’s reason', () => {
    const look = HostScreenResult.parse({
      server: 'studio',
      op: 'look',
      ok: true,
      imageB64: 'aGVsbG8=',
      format: 'jpeg',
      w: 1280,
      h: 720,
      screenW: 3840,
      screenH: 2160,
    });
    expect(look.screenW).toBe(3840);
    const refused = HostScreenResult.parse({
      server: 'studio',
      op: 'ui.press',
      ok: false,
      code: 'not_found',
    });
    expect(refused.code).toBe('not_found');
  });

  it('reads the screenshot’s size from a query string', () => {
    expect(HostScreenLookQuery.parse({ maxW: '1280', format: 'jpeg' })).toEqual({
      maxW: 1280,
      format: 'jpeg',
    });
  });

  it('is a POST and a GET on the server’s screen', () => {
    expect(api.hosts.screen.method).toBe('POST');
    expect(api.hosts.screenLook.method).toBe('GET');
    expect(api.hosts.screen.path).toBe(api.hosts.screenLook.path);
  });

  it('words every reason with the Mac’s name, the close names of not_found too', () => {
    for (const code of HOST_SCREEN_CODES) expect(hostScreenProblemText(code, 'Studio')).toMatch(/\S/);
    expect(hostScreenProblemText('no_screen', 'Studio')).toContain('Studio');
    expect(hostScreenProblemText('not_found', 'Studio', 'Close: Allow, Always Allow.')).toContain(
      'Always Allow',
    );
    // An account that isn't an administrator: the person switches Whombat Helper on themselves.
    const notAdmin = hostScreenProblemText('not_admin', 'Studio');
    expect(notAdmin).toContain('administrator');
    expect(notAdmin).toContain('Accessibility');
  });

  it('passes the Mac’s own reason for a step that failed, plain and bounded', () => {
    expect(hostScreenProblemText('failed', 'Studio')).toContain('Studio');
    const said = hostScreenProblemText(
      'failed',
      'Studio',
      "  The Mac's screen is still locked\nafter typing the password twice.  ",
    );
    expect(said).toContain('still locked');
    expect(said).not.toMatch(/\n|^\s|\s$/);
    expect(said).toContain('Mac’s');
    expect(hostScreenProblemText('failed', 'Studio', '   ')).toContain('Studio');
    const long = screenMessageText(`The field isn't a password field. ${'And more words. '.repeat(40)}`);
    expect(long?.length).toBeLessThanOrEqual(300);
    expect(long?.endsWith('…')).toBe(true);
    expect(screenMessageText('\u0007')).toBeNull();
  });
});

describe('what Whombat watches on a Mac', () => {
  it('starts the Mac’s screen hints off and the agent-folder hint on', () => {
    expect(hostHintCheck('macos.agent_folder').startsOn).toBe(true);
    for (const kind of [
      'macos.helper_off',
      'macos.helper_no_access',
      'macos.screen_sign_in',
      'macos.screen_sharing_off',
    ]) {
      expect(hostHintCheck(kind).startsOn, kind).toBe(false);
      expect(hostCheckStartsOn(`host.hint.${kind}`), kind).toBe(false);
    }
  });
});

describe('Sign in once on a Mac', () => {
  it('says which macOS it needs and which the Mac has', () => {
    const old = hostInstallErrorText('unsupported', { address: '10.100.0.9', mac: { version: '12.7.6' } });
    expect(old).toContain(`macOS ${HOST_MACOS_MIN_MAJOR}`);
    expect(old).toContain('12.7.6');
    expect(hostInstallErrorText('unsupported', { address: '10.100.0.9' })).toContain('Linux');
    expect(hostInstallErrorText('sudo_refused', { address: '10.100.0.9', mac: { version: null } })).toContain(
      'administrator',
    );
  });
});
