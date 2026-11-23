import { HostScreenResult, HostServer, HostServerDetail } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  serverDashboardHead,
  serverDashboardKind,
  serverDashboardTabs,
  serverDashboardView,
} from './dashboard';
import { createHostsFixtures } from './fixtures';
import { createMacFixture, MAC_SERVER } from './fixtures-mac';
import { installFailureCard } from './install';
import {
  findMyOnMac,
  isMacInstallText,
  isMacServer,
  MAC_SERVER_TABS,
  macAccountProblem,
  macFacts,
  macScreenView,
  macServerTabs,
  macStepText,
  macSystemLine,
  parseMacServerTab,
} from './macos';

const NOW = Date.parse('2026-11-17T10:00:00Z');

/** studio's page as the web's fixture world answers it, with a scenario. */
function studio(scenario?: Parameters<typeof createMacFixture>[1]) {
  const fx = createHostsFixtures(NOW, {
    mac: { listed: true, clock: () => NOW, ...(scenario ? { scenario } : {}) },
  });
  const handle = fx.handle;
  const read = () =>
    HostServerDetail.parse(
      handle({ method: 'GET', path: `/servers/${MAC_SERVER}`, query: {}, body: {} })?.body,
    );
  const step = (body: Record<string, unknown>) =>
    handle({ method: 'POST', path: `/servers/${MAC_SERVER}/screen`, query: {}, body });
  return { fx, handle, read, step };
}

describe('a Mac in the fixture world', () => {
  it('answers its page as the contract has it, listed in the fleet when asked', () => {
    const { fx, read } = studio();
    const d = read();
    expect(isMacServer(d)).toBe(true);
    expect(d.server.platform).toBe('macos');
    expect(d.macos?.modelName).toBe('Mac Studio');
    const row = fx.world.servers.find((s) => s.id === MAC_SERVER);
    expect(HostServer.parse(row).osFamily).toBe('macos');
  });

  it('keeps the mock’s five servers unless it is listed', () => {
    const fx = createHostsFixtures(NOW, { mac: { listed: false } });
    expect(fx.world.servers.some((s) => s.id === MAC_SERVER)).toBe(false);
    expect(fx.world.details.has(MAC_SERVER)).toBe(true);
  });

  it('takes the password only when the Mac does, and forgets it', () => {
    const { read, step } = studio('setup');
    expect(read().macos?.screen.account).toBeNull();
    const wrong = HostScreenResult.parse(
      step({ op: 'account.set', account: { user: 'mara', password: 'wrong' } })?.body,
    );
    expect(wrong).toMatchObject({ ok: false, code: 'sign_in_failed' });
    expect(read().macos?.screen.account).toBeNull();
    const right = HostScreenResult.parse(
      step({ op: 'account.set', account: { user: 'mara', password: 'a-secret' } })?.body,
    );
    expect(right.ok).toBe(true);
    expect(JSON.stringify(right)).not.toContain('a-secret');
    expect(read().macos?.screen).toMatchObject({ account: 'mara', signIn: 'ok' });
    step({ op: 'account.clear' });
    expect(read().macos?.screen.account).toBeNull();
  });

  it('unlocks, looks and refuses a step its body doesn’t allow', () => {
    const { read, step, handle } = studio('locked');
    expect(read().macos?.screen.locked).toBe(true);
    expect(step({ op: 'unlock' })?.body).toMatchObject({ ok: true });
    expect(read().macos?.screen.locked).toBe(false);
    const look = HostScreenResult.parse(
      handle({ method: 'GET', path: `/servers/${MAC_SERVER}/screen`, query: { maxW: '320' }, body: {} })
        ?.body,
    );
    expect(look).toMatchObject({ ok: true, format: 'png', screenW: 3840, screenH: 2160 });
    expect(look.imageB64?.startsWith('iVBORw0KGgo')).toBe(true);
    expect(step({ op: 'click' })?.status).toBe(400);
  });

  it('comes to have Accessibility once the setting was opened and some time went by', () => {
    let now = NOW;
    const mac = createMacFixture(NOW, 'ready', () => now);
    expect(mac.macos().helper.ax).toBe(false);
    expect(mac.screen({ op: 'ui.open', target: 'accessibility' }).body).toMatchObject({ ok: true });
    now += 10_000;
    expect(mac.macos().helper.ax).toBe(true);
  });
});

describe('a Mac’s page', () => {
  it('has its own kind and tabs, and an unknown tab opens the Summary', () => {
    const d = studio().read();
    expect(serverDashboardKind(d)).toBe('macos');
    expect(serverDashboardTabs('macos')).toEqual(MAC_SERVER_TABS);
    expect(parseMacServerTab('screen')).toBe('screen');
    expect(parseMacServerTab('guests')).toBe('summary');
    // Find My is a connection's page now: the Mac keeps its own tab only on a Whombat from before.
    expect(parseMacServerTab('findmy')).toBe('summary');
    expect(parseMacServerTab('findmy', macServerTabs(true))).toBe('findmy');
    expect(macServerTabs(false)).toEqual(MAC_SERVER_TABS);
    expect(findMyOnMac([{ catalogId: 'homeassistant' }])).toBe(true);
    expect(findMyOnMac([{ catalogId: 'homeassistant' }, { catalogId: 'findmy' }])).toBe(false);
    expect(findMyOnMac(undefined)).toBe(false);
  });

  it('says its macOS with the build in Technical details, and its own facts in “This Mac”', () => {
    const d = studio().read();
    const head = serverDashboardHead(d);
    expect(head.details.find((r) => r.label === 'System')?.value).toBe('macOS 27.2.1 (26B131)');
    const view = serverDashboardView({ detail: d, range: '24h', now: NOW });
    const facts = view.details.find((p) => p.id === 'kind_facts');
    expect(facts && 'title' in facts ? facts.title : null).toBe('This Mac');
    expect(macSystemLine({ version: '27.2.1', build: null })).toBe('macOS 27.2.1');
    const m = d.macos;
    if (!m) throw new Error('no macos');
    expect(macFacts(m).map((f) => f.label)).toEqual([
      'Model',
      'Chip',
      'System Integrity Protection',
      'FileVault',
      'Signs in by itself',
    ]);
    expect(macFacts({ ...m, autoLogin: null, sip: null }).map((f) => f.value)).toContain('Not known');
  });

  it('opens a Mac’s own lines on its Screen tab', () => {
    const d = studio().read();
    const withHint: HostServerDetail = {
      ...d,
      hints: [
        {
          serverId: MAC_SERVER,
          kind: 'macos.helper_no_access',
          severity: 'warning',
          entity: 'helper',
          title: 'Whombat Helper needs Accessibility',
          detail: 'It can’t press buttons by name until it has it.',
          section: '',
        },
      ],
    };
    const view = serverDashboardView({ detail: withHint, range: '24h', now: NOW });
    const look = view.panels.find((p) => p.id === 'look');
    const line = look && 'items' in look ? look.items[0] : null;
    expect(line && 'link' in line ? line.link : null).toMatchObject({ kind: 'tab', tab: 'screen' });
  });
});

describe('the Screen part', () => {
  const view = (scenario: Parameters<typeof createMacFixture>[1], owner = true) => {
    const v = macScreenView(studio(scenario).read(), { name: 'studio', owner, now: NOW });
    if (!v) throw new Error('no view');
    return v;
  };

  it('is ready with a password that works, and asks for Accessibility', () => {
    const v = view('ready');
    expect(v.screen.can).toBe(true);
    expect(v.account.tone).toBe('ok');
    expect(v.account.text).toContain('mara');
    expect(v.needsAccess).toBe(true);
    expect(v.helper.map((l) => l.key)).toEqual(['helper', 'access']);
    expect(v.sharingHow).toBeNull();
  });

  it('says how to switch Screen Sharing on, and that the password comes first', () => {
    const off = view('sharing-off');
    expect(off.screen.can).toBe(false);
    expect(off.sharingHow).toContain('System Settings → General → Sharing');
    const setup = view('setup');
    expect(setup.screen).toEqual({ can: false, why: 'Set the Mac’s password first.' });
    expect(setup.accountUser).toBe('mara');
    expect(view('failed').account.tone).toBe('bad');
  });

  it('leaves the screen and its steps to owners and names a missing helper', () => {
    const v = view('ready', false);
    expect(v.unlock.can).toBe(false);
    expect(v.password.can).toBe(false);
    // A look shows the person's whole desktop: an owner's too.
    expect(v.screen.can).toBe(false);
    const none = view('no-helper');
    expect(none.helper).toHaveLength(1);
    expect(none.helperStep.can).toBe(false);
    expect(none.helperNote).toContain('buttons by name');
  });

  it('can’t reach a Mac that isn’t checking in, or whose shell switch is off', () => {
    const d = studio().read();
    const offline = macScreenView(
      { ...d, server: { ...d.server, status: 'offline' } },
      { name: 'studio', owner: true, now: NOW },
    );
    expect(offline?.screen.why).toContain('isn’t checking in');
    const off = macScreenView(
      {
        ...d,
        server: {
          ...d.server,
          remoteControl: { ...d.server.remoteControl, hostShell: false, hostShellReason: null },
        },
      },
      { name: 'studio', owner: true, now: NOW },
    );
    expect(off?.screen.why).toContain('switched off');
  });

  it('goes with the host-shell switch only: consoles switched off are the guests’', () => {
    const d = studio().read();
    const consolesOff = macScreenView(
      {
        ...d,
        server: {
          ...d.server,
          remoteControl: {
            ...d.server.remoteControl,
            console: false,
            consoleReason: 'Consoles are off.',
            hostShell: true,
          },
        },
      },
      { name: 'studio', owner: true, now: NOW },
    );
    expect(consolesOff?.screen.can).toBe(true);
    expect(consolesOff?.password.can).toBe(true);
    expect(consolesOff?.unlock.can).toBe(true);
  });
});

describe('words after a step', () => {
  it('names the user a password didn’t work for, and never the password', () => {
    const t = macStepText(
      { op: 'account.set', account: { user: 'mara' } },
      { ok: false, code: 'sign_in_failed' },
      'studio',
    );
    expect(t).toEqual({ ok: false, text: expect.stringContaining('mara') });
    expect(macStepText({ op: 'unlock' }, { ok: true, status: { locked: true } as never }, 'studio').ok).toBe(
      false,
    );
    expect(macStepText({ op: 'ui.open', target: 'accessibility' }, { ok: true }, 'studio').text).toContain(
      'Accessibility',
    );
    expect(macStepText({ op: 'unlock' }, { ok: false, code: 'no_screen' }, 'studio').text).toContain(
      'Screen Sharing is off',
    );
  });

  it('doesn’t call a lock it couldn’t read unlocked', () => {
    const unknown = macStepText({ op: 'unlock' }, { ok: true, status: { locked: null } as never }, 'studio');
    expect(unknown.text).not.toContain('is unlocked');
    expect(macStepText({ op: 'unlock' }, { ok: true }, 'studio').text).not.toContain('is unlocked');
    expect(
      macStepText({ op: 'unlock' }, { ok: true, status: { locked: false } as never }, 'studio').text,
    ).toContain('is unlocked');
  });

  it('adds the Mac’s own note to a step that worked, and its own reason to one that didn’t', () => {
    const note = 'The Mac locks again when this screen session ends.';
    expect(
      macStepText({ op: 'unlock' }, { ok: true, message: note, status: { locked: false } as never }, 'studio')
        .text,
    ).toContain(note);
    expect(
      macStepText({ op: 'ui.press' }, { ok: true, message: 'Pressed; the app is still busy.' }, 'studio'),
    ).toEqual({ ok: true, text: 'Pressed; the app is still busy.' });
    expect(macStepText({ op: 'look' }, { ok: true, message: note }, 'studio').text).toBe('');
    expect(
      macStepText(
        { op: 'ui.set' },
        { ok: false, code: 'failed', message: "The field isn't a password field." },
        'studio',
      ).text,
    ).toBe('The field isn’t a password field.');
    expect(macStepText({ op: 'password' }, { ok: false, code: 'not_admin' }, 'studio').text).toContain(
      'administrator',
    );
  });
});

describe('the Mac’s password form', () => {
  it('takes a user and a password of at most 63 bytes each, as Apple’s sign-in does', () => {
    expect(macAccountProblem('mara', 'p'.repeat(63))).toBeNull();
    expect(macAccountProblem('', 'p')).toMatch(/user/);
    expect(macAccountProblem('mara', '')).toMatch(/password/);
    expect(macAccountProblem('mara', 'p'.repeat(64))).toContain('63');
    expect(macAccountProblem('m'.repeat(64), 'p')).toContain('63');
    // A letter with an accent is two bytes.
    expect(macAccountProblem('mara', 'é'.repeat(32))).toContain('63');
  });
});

describe('a Mac’s install words', () => {
  const job = { address: '10.100.1.50', serverName: null, hostKey: null, pins: [] };
  it('shows the server’s Mac words for an old macOS and a user without sudo', () => {
    const old = installFailureCard(job, {
      code: 'unsupported',
      text: 'Whombat’s helper needs macOS 13 or later, and 10.100.1.50 has macOS 12.7. Update the Mac first.',
    });
    expect(old.title).toContain('macOS 13');
    expect(old.text).toBe('Update the Mac first.');
    const sudo = installFailureCard(job, {
      code: 'sudo_refused',
      text: 'Signed in, but this user may not use sudo on 10.100.1.50. Sign in as an administrator of the Mac.',
    });
    expect(sudo.text).toContain('administrator of the Mac');
    expect(isMacInstallText('It needs Linux on a 64-bit Intel, AMD or ARM processor.')).toBe(false);
    const linux = installFailureCard(job, { code: 'unsupported', text: 'Not Linux.' });
    expect(linux.text).toContain('Linux');
  });
});
