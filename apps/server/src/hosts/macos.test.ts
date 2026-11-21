/**
 * Macs as servers without Postgres (docs/decisions/macos-servers.md): the hub's Mac shapes mapped to the contract, a
 * screen step's body, role and words, the assistant's tools' arguments and the picture they attach, the Darwin facts
 * Sign in once reads, and the desk's and care plan's words for a Mac.
 */
import {
  HostFleet,
  HostScreenBody,
  HostScreenResult,
  HostServerDetail,
  hostScreenProblemText,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { ConnectionArgumentError } from '../connections/request';
import { serverLine } from '../desk/options';
import { imageOf, withImage } from '../mcp/image';
import { installFailureText, macMajor, parseMacFacts, systemLine } from './install-words';
import { osFamily, serverPlatform, toHostFleet, toHostScreenResult, toHostServerDetail } from './map';
import { screenBody, screenChangeText, screenRole, screenStepIsEveryday } from './screen';
import {
  LOOK_NOTE,
  lookFacts,
  MAC_LOOK,
  MAC_NEXT,
  macSays,
  macScreenBody,
  macUiBody,
  refusal,
} from './tools-macos';

const NOW = new Date('2026-11-17T10:00:00Z');

const macBlock = {
  version: '27.2.1',
  build: '26B131',
  model: 'Mac14,14',
  model_name: 'Mac Studio',
  chip: 'Apple M2 Ultra',
  sip: true,
  auto_login: '',
  console_user: 'john',
  screen: {
    sharing: true,
    account: '',
    sign_in: '',
    sign_in_at: '0001-01-01T00:00:00Z',
    w: 3840,
    h: 2160,
  },
  helper: { installed: true, version: '1.0.0', running: false, user: '' },
};

describe('a Mac from the hosts service', () => {
  it('is its own kind of page and OS family; anything else stays Linux', () => {
    expect(serverPlatform('macos')).toBe('macos');
    expect(osFamily('macos')).toBe('macos');
    expect(osFamily(undefined, 'macos')).toBe('macos');
    expect(osFamily('linux')).toBe('linux');
    expect(osFamily(undefined, 'standard')).toBeUndefined();
  });

  it('maps a Mac’s card and its detail, unknowns as null', () => {
    const fleet = toHostFleet(
      {
        fleet: {
          as_of: NOW.toISOString(),
          servers: [
            {
              id: 'studio',
              status: 'online',
              os: 'macOS 27.2.1',
              os_family: 'macos',
              detail_view: 'macos',
              agent_connected: true,
            },
          ],
          alerts: [],
          kpis: {},
        },
      },
      NOW,
    );
    expect(HostFleet.parse(fleet).servers[0]).toMatchObject({ platform: 'macos', osFamily: 'macos' });
    const d = toHostServerDetail(
      {
        as_of: NOW.toISOString(),
        server: { id: 'studio', detail_view: 'macos', os_family: 'macos', agent: {} },
        sensors: [],
        disks: [],
        hints: [],
        macos: macBlock,
      },
      [],
      null,
      NOW,
    );
    const parsed = HostServerDetail.parse(d);
    expect(parsed.server).toMatchObject({ platform: 'macos', osFamily: 'macos' });
    expect(parsed.macos).toMatchObject({
      modelName: 'Mac Studio',
      sip: true,
      filevault: null,
      autoLogin: null,
      consoleUser: 'john',
      screen: { sharing: true, account: null, signIn: null, signInAt: null, locked: null, w: 3840 },
      helper: { installed: true, running: false, ax: null, user: null },
    });
  });

  it('maps a screen step’s answer: the picture as sent, elements by the helper’s names, an unknown code as failed', () => {
    const look = toHostScreenResult(
      {
        server: 'studio',
        ok: true,
        image_b64: 'AAAA',
        format: 'jpeg',
        w: 1280,
        h: 720,
        screen_w: 3840,
        screen_h: 2160,
      },
      'studio',
      'look',
    );
    expect(HostScreenResult.parse(look)).toMatchObject({ imageB64: 'AAAA', screenW: 3840, w: 1280 });
    const list = toHostScreenResult(
      {
        ok: true,
        elements: [
          {
            id: 'w0.2',
            role: 'AXButton',
            title: 'Allow',
            desc: 'Allow it',
            ident: 'allow',
            x: 1,
            y: 2,
            w: 3,
            h: 4,
          },
        ],
        truncated: true,
      },
      'studio',
      'ui.list',
    );
    expect(HostScreenResult.parse(list).elements?.[0]).toMatchObject({
      title: 'Allow',
      description: 'Allow it',
      identifier: 'allow',
      enabled: true,
    });
    expect(toHostScreenResult({ ok: false, code: 'gremlins' }, 'studio', 'click').code).toBe('failed');
    expect(toHostScreenResult({ ok: false, code: 'locked' }, 'studio', 'ui.press').code).toBe('locked');
  });
});

describe('a screen step', () => {
  it('goes to the hub in its words, only what is given', () => {
    const body = HostScreenBody.parse({ op: 'drag', x: 1, y: 2, toX: 3, toY: 4 });
    expect(screenBody(body)).toEqual({ op: 'drag', x: 1, y: 2, to_x: 3, to_y: 4 });
    const account = HostScreenBody.parse({ op: 'account.set', account: { user: 'john', password: 'p' } });
    expect(screenBody(account).account).toEqual({ user: 'john', password: 'p' });
  });

  it('reads the Mac’s state at operator; a look, the UI lists and every change at admin', () => {
    expect(screenRole('status')).toBe('operator');
    expect(screenRole('look')).toBe('admin');
    expect(screenRole('ui.list')).toBe('admin');
    expect(screenRole('ui.apps')).toBe('admin');
    expect(screenRole('click')).toBe('admin');
    expect(screenRole('account.set')).toBe('admin');
  });

  it('signs what changed in words, never what was typed, and keeps clicks out of Done recently', () => {
    const typed = screenChangeText(HostScreenBody.parse({ op: 'type', text: 'hunter2' }), 'Studio');
    expect(typed).toContain('Studio');
    expect(typed).not.toContain('hunter2');
    const set = screenChangeText(
      HostScreenBody.parse({ op: 'ui.set', name: 'Password', text: 'hunter2' }),
      'Studio',
    );
    expect(set).not.toContain('hunter2');
    expect(screenChangeText(HostScreenBody.parse({ op: 'ui.press', name: 'Allow' }), 'Studio')).toContain(
      'Allow',
    );
    expect(screenChangeText(HostScreenBody.parse({ op: 'look' }), 'Studio')).toBeNull();
    expect(screenChangeText(HostScreenBody.parse({ op: 'account.check' }), 'Studio')).toBeNull();
    expect(screenStepIsEveryday('click')).toBe(true);
    expect(screenStepIsEveryday('ui.press')).toBe(false);
  });
});

describe('mac_screen and mac_ui', () => {
  it('turn the assistant’s actions into screen steps', () => {
    expect(macScreenBody({ server: 'studio', action: 'look' })).toEqual({ op: 'look', ...MAC_LOOK });
    // The Mac types its own password into a macOS prompt; the assistant can't hand it any text.
    expect(macScreenBody({ server: 'studio', action: 'password' })).toEqual({ op: 'password' });
    // Typing goes key by key through Screen Sharing: the Mac takes 2000 characters at a time.
    expect(() => macScreenBody({ server: 'studio', action: 'type', text: 'a'.repeat(2001) })).toThrow(/2000/);
    expect(() => macScreenBody({ server: 'studio', action: 'password', text: 'x' })).toThrow(/text/);
    expect(macScreenBody({ server: 'studio', action: 'double_click', x: 10, y: 20 })).toMatchObject({
      op: 'click',
      clicks: 2,
    });
    expect(macScreenBody({ server: 'studio', action: 'right_click', x: 10, y: 20 })).toMatchObject({
      op: 'click',
      button: 'right',
    });
    expect(macScreenBody({ server: 'studio', action: 'keys', keys: 'cmd+q' })).toEqual({
      op: 'keys',
      keys: 'cmd+q',
    });
    expect(macUiBody({ server: 'studio', action: 'set', name: 'Name', value: 'Studio' })).toMatchObject({
      op: 'ui.set',
      name: 'Name',
      text: 'Studio',
    });
    expect(macUiBody({ server: 'studio', action: 'menu', path: ['File', 'Save…'] })).toMatchObject({
      op: 'ui.menu',
      path: ['File', 'Save…'],
    });
    expect(macUiBody({ server: 'studio', action: 'open', target: 'accessibility' })).toMatchObject({
      op: 'ui.open',
      target: 'accessibility',
    });
  });

  it('refuse what an action doesn’t take or misses, by name', () => {
    expect(() => macScreenBody({ server: 'studio', action: 'click', x: 10 })).toThrow(/^y:/);
    expect(() => macScreenBody({ server: 'studio', action: 'look', text: 'x' })).toThrow(
      ConnectionArgumentError,
    );
    expect(() => macScreenBody({ server: 'studio', action: 'wave' })).toThrow(/^action:/);
    expect(() => macUiBody({ server: 'studio', action: 'press' })).toThrow(/^name:/);
    expect(() => macUiBody({ server: 'studio', action: 'set', name: 'Name' })).toThrow(/^value:/);
    expect(() => macUiBody({ server: 'studio', action: 'menu', path: 'File' })).toThrow(/^path:/);
  });

  it('keep to the hosts service’s limits, and say them', () => {
    expect(() => macScreenBody({ server: 'studio', action: 'click', x: -1, y: 0 })).toThrow(
      /^x:.*0 to 16384/,
    );
    expect(macScreenBody({ server: 'studio', action: 'click', x: 16_384, y: 0 })).toMatchObject({
      x: 16_384,
    });
    expect(() => macScreenBody({ server: 'studio', action: 'scroll', dy: 51 })).toThrow(/^dy:.*-50 to 50/);
    expect(() => macScreenBody({ server: 'studio', action: 'keys', keys: 'a'.repeat(501) })).toThrow(
      /^keys: at most 500/,
    );
    expect(() => macUiBody({ server: 'studio', action: 'press', name: 'a'.repeat(201) })).toThrow(
      /^name: at most 200/,
    );
    expect(
      macUiBody({ server: 'studio', action: 'press', name: 'OK', role: 'button,checkbox' }),
    ).toMatchObject({
      role: 'button,checkbox',
    });
    expect(() => macUiBody({ server: 'studio', action: 'menu', path: Array(9).fill('File') })).toThrow(
      /^path: at most 8/,
    );
    expect(() => macUiBody({ server: 'studio', action: 'open', target: 'a'.repeat(2049) })).toThrow(
      /^target: at most 2048/,
    );
  });

  it('say the screen’s size and the scale beside a picture', () => {
    const look = HostScreenResult.parse({
      server: 'studio',
      op: 'look',
      ok: true,
      imageB64: 'AAAA',
      w: 1280,
      h: 720,
      screenW: 3840,
      screenH: 2160,
    });
    expect(lookFacts(look)).toEqual({
      screen_w: 3840,
      screen_h: 2160,
      image_w: 1280,
      image_h: 720,
      scale: 3,
    });
    expect(LOOK_NOTE).toContain('scale');
  });

  it('attach a JPEG to an answer without putting it in the JSON', () => {
    const answer = withImage({ status: 'ok' }, 'AAAA', 'image/jpeg');
    expect(JSON.stringify(answer)).toBe('{"status":"ok"}');
    expect(imageOf(answer)).toEqual({ data: 'AAAA', mimeType: 'image/jpeg' });
    expect(imageOf(withImage({}, 'BBBB'))?.mimeType).toBe('image/png');
    expect(imageOf({})).toBeNull();
  });

  it('word the Mac’s refusals for the person, its own reason when it gave one', () => {
    expect(hostScreenProblemText('locked', 'Studio')).toBe('Studio’s screen is locked.');
    const failed = JSON.parse(
      String(refusal({ code: 'failed', message: "The field isn't a password field." }, 'Studio').content),
    );
    expect(failed).toMatchObject({ code: 'failed', error: 'The field isn’t a password field.' });
  });

  it('never send the assistant back to the step the Mac just refused', () => {
    const notAdmin = JSON.parse(String(refusal({ code: 'not_admin' }, 'Studio').content));
    expect(notAdmin.code).toBe('not_admin');
    expect(notAdmin.error).toContain('administrator');
    // The person switches Whombat Helper on; the assistant neither types the password again nor reopens the setting.
    expect(notAdmin.next).toContain('person');
    expect(notAdmin.next).toContain('Accessibility');
    expect(notAdmin.next).toMatch(/^Stop/);
    expect(MAC_NEXT.no_prompt).not.toContain('mac_screen password');
    expect(MAC_NEXT.locked).not.toContain('password');
  });

  it('carry the Mac’s own note on a step that worked', () => {
    expect(macSays({ message: '  Pressed; the app is still busy. ' })).toEqual({
      message: 'Pressed; the app is still busy.',
    });
    expect(macSays({})).toEqual({});
  });
});

describe('Sign in once on a Mac', () => {
  it('reads the macOS version and who is at the screen; the login window is nobody', () => {
    expect(parseMacFacts('27.2.1\njohn\n')).toEqual({ version: '27.2.1', consoleUser: 'john' });
    expect(parseMacFacts('14.6\nroot\n')).toEqual({ version: '14.6', consoleUser: null });
    expect(parseMacFacts('')).toEqual({ version: null, consoleUser: null });
    expect(macMajor('12.7.6')).toBe(12);
    expect(macMajor(null)).toBeNull();
  });

  it('puts macOS first in the system line and words a too-old Mac', () => {
    expect(systemLine('arm64 · macOS 27.2.1')).toBe('macOS 27.2.1 · arm64');
    const words = installFailureText(
      { code: 'unsupported' },
      { address: '10.100.0.9', mac: { version: '12.7.6', consoleUser: null } },
    );
    expect(words).toContain('12.7.6');
    expect(words).toContain('macOS 13');
  });
});

describe('a Mac elsewhere', () => {
  it('reads as a Mac on the desk', () => {
    expect(
      serverLine({ platform: 'macos', os: 'macOS 27.2.1', cpu: { model: 'M2', cores: 24, threads: 24 } }),
    ).toBe('Mac · 24 cores');
  });
});
