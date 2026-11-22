import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LINK_OFFER_TEXT } from '../../vendor/whombat-contracts/link-price';
import type { Check, Disk, InstallerState } from './api';
import { parseState } from './api';
import { INSTALLER } from './copy';
import {
  checksFolded,
  checksVerdict,
  chosenDisk,
  eraseConfirmed,
  formatSize,
  installerScreen,
  installRequest,
  LOGIN_SERVER_RE,
  loginServerValid,
  nextStep,
  preflightRequest,
  prevStep,
  reachChoice,
  START,
  stepOf,
  stepStates,
  type Wizard,
  wizardSteps,
} from './installer';

const GiB = 1024 ** 3;
const sda: Disk = {
  path: '/dev/sda',
  name: 'sda',
  model: 'QEMU',
  sizeBytes: 128 * GiB,
  eligible: true,
  reason: '',
};
const sdb: Disk = { ...sda, path: '/dev/sdb', name: 'sdb' };
const usb: Disk = { ...sda, path: '/dev/sdc', name: 'sdc', eligible: false, reason: 'installer-medium' };
const ok: Check[] = [
  { id: 'uefi', status: 'ok', value: '' },
  { id: 'cpu', status: 'ok', value: '' },
];

function state(
  p: Partial<InstallerState> = {},
  install: Partial<InstallerState['install']> = {},
): InstallerState {
  return {
    mode: 'installer',
    platform: 'self-installed',
    storage: 'host-encrypted',
    environment: 'prod',
    release: null,
    appUrl: 'app.whombat.com',
    preflight: { status: 'done', checks: ok, disks: [sda, usb] },
    ...p,
    install: { status: 'idle', disk: null, step: null, percent: 0, log: [], error: '', ...install },
  };
}

describe('installerScreen', () => {
  it('walks the wizard while nothing is installing', () => {
    expect(installerScreen(state(), START)).toBe('welcome');
    expect(installerScreen(state(), { ...START, step: 'erase' })).toBe('erase');
  });

  it('follows the server once an installation started (a reload lands on the right screen)', () => {
    expect(installerScreen(state({}, { status: 'running' }), START)).toBe('installing');
    expect(installerScreen(state({}, { status: 'done' }), { ...START, step: 'disk' })).toBe('done');
    expect(installerScreen(state({}, { status: 'failed' }), START)).toBe('failed');
  });

  it('shows the wizard again after “Try again” until a new installation starts', () => {
    const w = { ...START, step: 'checks' as const, retrying: true };
    expect(installerScreen(state({}, { status: 'failed' }), w)).toBe('checks');
    expect(installerScreen(state({}, { status: 'running' }), w)).toBe('installing');
  });
});

describe('wizard steps', () => {
  it('skips Disk with exactly one eligible disk', () => {
    expect(wizardSteps(state())).toEqual(['welcome', 'reach', 'checks', 'erase']);
  });

  it('asks how the box will be reached before the checks, except on a community image (LNK-12, NX-445)', () => {
    expect(wizardSteps(state({ edition: 'commercial' }))).toEqual(['welcome', 'reach', 'checks', 'erase']);
    expect(wizardSteps(state({ edition: 'community' }))).toEqual(['welcome', 'checks', 'erase']);
    const s = state();
    expect(nextStep(s, 'welcome')).toBe('reach');
    expect(nextStep(s, 'reach')).toBe('checks');
    expect(prevStep(s, 'checks')).toBe('reach');
    expect(prevStep(s, 'reach')).toBe('welcome');
    expect(stepOf(s, 'reach')).toEqual({ n: 1, of: 3 });
  });

  it('asks for a disk when there are several, or none', () => {
    const two = state({ preflight: { status: 'done', checks: ok, disks: [sda, sdb, usb] } });
    expect(wizardSteps(two)).toEqual(['welcome', 'reach', 'checks', 'disk', 'erase']);
    const none = state({ preflight: { status: 'done', checks: ok, disks: [usb] } });
    expect(wizardSteps(none)).toContain('disk');
  });

  it('has no Before you install step on any platform or storage (CG-32)', () => {
    for (const p of [
      { platform: 'self-installed', storage: 'host-encrypted' },
      { platform: 'factory', storage: 'luks-tpm2' },
    ] as const) {
      expect(wizardSteps(state(p))).toEqual(['welcome', 'reach', 'checks', 'erase']);
    }
  });

  it('offers Wi-Fi after the checks when no cable has an address (HD-08)', () => {
    expect(wizardSteps(state({ wired: false }))).toEqual(['welcome', 'reach', 'checks', 'wifi', 'erase']);
    expect(wizardSteps(state({ wired: true }))).not.toContain('wifi');
    // Not checked yet: no step to count, the checks come first anyway.
    expect(wizardSteps(state({ wired: null }))).not.toContain('wifi');
    expect(wizardSteps(state())).not.toContain('wifi');
    const s = state({ wired: false });
    expect(nextStep(s, 'checks')).toBe('wifi');
    expect(nextStep(s, 'wifi')).toBe('erase');
    expect(prevStep(s, 'erase')).toBe('wifi');
    // Part of the checks' stage: the count doesn't grow once the checks found no cable.
    expect(stepOf(s, 'wifi')).toEqual({ n: 2, of: 3 });
    expect(stepOf(s, 'erase')).toEqual({ n: 3, of: 3 });
  });

  it('goes forward and back along the steps', () => {
    const s = state();
    expect(nextStep(s, 'welcome')).toBe('reach');
    expect(nextStep(s, 'reach')).toBe('checks');
    expect(nextStep(s, 'checks')).toBe('erase');
    expect(nextStep(s, 'erase')).toBe('erase');
    expect(prevStep(s, 'erase')).toBe('checks');
    expect(prevStep(s, 'checks')).toBe('reach');
    expect(prevStep(s, 'reach')).toBe('welcome');
    expect(prevStep(s, 'welcome')).toBe('welcome');
    const community = state({ edition: 'community' });
    expect(nextStep(community, 'welcome')).toBe('checks');
    expect(prevStep(community, 'checks')).toBe('welcome');
  });

  it('numbers the steps after Welcome', () => {
    const s = state();
    expect(stepOf(s, 'welcome')).toBeNull();
    expect(stepOf(s, 'reach')).toEqual({ n: 1, of: 3 });
    expect(stepOf(s, 'checks')).toEqual({ n: 2, of: 3 });
    expect(stepOf(s, 'erase')).toEqual({ n: 3, of: 3 });
    // Choosing a disk is part of the last stage: the total is the same with one disk, several, or none found yet.
    for (const disks of [[sda], [sda, sdb, usb], []]) {
      const s2 = state({ preflight: { status: 'done', checks: ok, disks } });
      expect(['reach', 'checks', 'disk', 'erase'].map((x) => stepOf(s2, x as 'checks'))).toEqual([
        { n: 1, of: 3 },
        { n: 2, of: 3 },
        { n: 3, of: 3 },
        { n: 3, of: 3 },
      ]);
    }
    expect(stepOf(state({ edition: 'community' }), 'erase')).toEqual({ n: 2, of: 2 });
  });
});

describe('checksVerdict', () => {
  const withCheck = (c: Partial<Check>, status: 'running' | 'done' = 'done') =>
    state({
      preflight: { status, checks: [...ok, { id: 'memory', status: 'ok', value: '', ...c }], disks: [sda] },
    });

  it('is running while any check runs or none came back', () => {
    expect(checksVerdict(withCheck({ status: 'running' }))).toBe('running');
    expect(checksVerdict(withCheck({}, 'running'))).toBe('running');
    expect(checksVerdict(state({ preflight: { status: 'done', checks: [], disks: [] } }))).toBe('running');
  });

  it('fails on any fail, warns on warnings only', () => {
    expect(checksVerdict(withCheck({ status: 'fail' }))).toBe('fail');
    expect(checksVerdict(withCheck({ status: 'warn' }))).toBe('warn');
    expect(checksVerdict(withCheck({}))).toBe('ok');
  });
});

describe('which checks fold behind Details', () => {
  it('folds every check that passed and shows the ones that need reading', () => {
    const checks: Check[] = [...ok, { id: 'memory', status: 'fail', value: '2 GiB' }];
    expect(checksFolded(ok)).toEqual({ shown: [], folded: ok });
    expect(checksFolded(checks)).toEqual({ shown: [checks[2]], folded: ok });
    const warn: Check = { id: 'reach-relay', status: 'warn', value: 'relay.example.com' };
    expect(checksFolded([warn]).shown).toEqual([warn]);
  });
});

describe('disks', () => {
  it('takes the only eligible disk without asking', () => {
    expect(chosenDisk(state(), null)).toEqual(sda);
  });

  it('takes the pick when it is eligible, nothing otherwise', () => {
    const two = state({ preflight: { status: 'done', checks: ok, disks: [sda, sdb, usb] } });
    expect(chosenDisk(two, null)).toBeNull();
    expect(chosenDisk(two, '/dev/sdb')).toEqual(sdb);
    expect(chosenDisk(two, '/dev/sdc')).toBeNull();
  });

  it('enables Erase at once on an empty disk, and sends its name as the confirmation', () => {
    const empty: Disk = { ...sda, empty: true, parts: [] };
    expect(eraseConfirmed('', empty)).toBe(true);
    expect(installRequest(state(), START, empty, '')).toMatchObject({ disk: '/dev/sda', confirm: 'sda' });
    // Not known to be empty (an older server): typed, as before.
    expect(eraseConfirmed('', { ...sda, parts: [] })).toBe(false);
  });

  it('enables Erase only for the exact name', () => {
    expect(eraseConfirmed('sda', sda)).toBe(true);
    expect(eraseConfirmed(' sda ', sda)).toBe(true);
    expect(eraseConfirmed('sd', sda)).toBe(false);
    expect(eraseConfirmed('SDA', sda)).toBe(false);
    expect(eraseConfirmed('/dev/sda', sda)).toBe(false);
    expect(eraseConfirmed('sda', null)).toBe(false);
  });

  it('formats sizes in binary units', () => {
    expect(formatSize(128 * GiB)).toBe('128 GiB');
    expect(formatSize(1000204886016)).toBe('932 GiB');
    expect(formatSize(4000787030016)).toBe('3.6 TiB');
    expect(formatSize(1024 ** 4)).toBe('1 TiB');
    expect(formatSize(1.5 * GiB)).toBe('1.5 GiB');
  });
});

describe('stepStates', () => {
  it('marks the steps before the current one done', () => {
    expect(stepStates(state({}, { status: 'running', step: 'copy' }))).toEqual({
      partition: 'done',
      filesystems: 'done',
      copy: 'current',
      boot: 'pending',
      finish: 'pending',
    });
  });

  it('marks everything done when done, and the failed step when failed', () => {
    expect(Object.values(stepStates(state({}, { status: 'done', step: 'finish' })))).toEqual(
      Array(5).fill('done'),
    );
    expect(stepStates(state({}, { status: 'failed', step: 'boot' })).boot).toBe('failed');
  });

  it('starts at partition while running without a step yet', () => {
    expect(stepStates(state({}, { status: 'running' })).partition).toBe('current');
  });
});

describe('how the box will be reached (LNK-12)', () => {
  const tailscale = (loginServer = ''): Wizard => ({ ...START, reach: 'tailscale', loginServer });

  it('has Whombat Link chosen at the start, for the image’s own environment', () => {
    expect(START.reach).toBe('link');
    expect(START.loginServer).toBe('');
    expect(reachChoice(START)).toEqual({ link: true, tailscale: false });
  });

  it('takes Tailscale, with Tailscale’s own login server or the person’s own', () => {
    expect(reachChoice(tailscale())).toEqual({ link: false, tailscale: true });
    expect(reachChoice(tailscale('  https://headscale.example.com  '))).toEqual({
      link: false,
      tailscale: true,
      loginServer: 'https://headscale.example.com',
    });
    // A login server typed and then Link chosen again: Link takes no login server.
    expect(reachChoice({ ...tailscale('https://headscale.example.com'), reach: 'link' })).toEqual({
      link: true,
      tailscale: false,
    });
  });

  it('takes only an https address as the login server', () => {
    for (const good of [
      '',
      '   ',
      'https://headscale.example.com',
      'https://hs.example.com:8443',
      'https://hs.example.com/base/path',
      'https://a',
    ]) {
      expect(loginServerValid(good), good).toBe(true);
    }
    for (const bad of [
      'headscale.example.com',
      'http://headscale.example.com',
      'https://',
      'https://-x.example.com',
      'https://user@hs.example.com',
      'https://hs.example.com?x=1',
      'https://hs.example.com#x',
      'https://hs.example.com:123456',
      'https://hs.example.com/a b',
      'https://hs.example.com/"x',
      'https://hs.example.com/\\x',
      'https://é.example.com',
      'https://hs.example.com\nhttps://b.example.com',
    ]) {
      expect(loginServerValid(bad), bad).toBe(false);
    }
    expect(reachChoice(tailscale('http://headscale.example.com'))).toBeNull();
  });

  it('uses the same pattern as the appliance and whombat-install', () => {
    const goSource = readFileSync(new URL('../../../../internal/reach/reach.go', import.meta.url), 'utf8');
    const go = /loginServerRe = regexp\.MustCompile\(`([^`]+)`\)/.exec(goSource)?.[1];
    expect(go).toBe(LOGIN_SERVER_RE.source.replaceAll('\\/', '/'));
    const nix = readFileSync(new URL('../../../../nix/profiles/installer-base.nix', import.meta.url), 'utf8');
    expect(nix).toContain(`grep -qE '${go?.replaceAll('(?:', '(')}'`);
  });

  it('sends the choice with the checks and with the install', () => {
    const s = state();
    expect(preflightRequest(s, START)).toEqual({ reach: { link: true, tailscale: false } });
    expect(preflightRequest(s, tailscale('https://hs.example.com'))).toEqual({
      reach: { link: false, tailscale: true, loginServer: 'https://hs.example.com' },
    });
    expect(installRequest(s, START, sda, ' sda ')).toEqual({
      disk: '/dev/sda',
      confirm: 'sda',
      reach: { link: true, tailscale: false },
    });
    expect(installRequest(s, tailscale(), sda, 'sda')).toEqual({
      disk: '/dev/sda',
      confirm: 'sda',
      reach: { link: false, tailscale: true },
    });
  });

  it('sends no choice from a community image, where the page doesn’t ask', () => {
    const s = state({ edition: 'community' });
    expect(preflightRequest(s, START)).toBeUndefined();
    expect(installRequest(s, START, sda, 'sda')).toEqual({ disk: '/dev/sda', confirm: 'sda' });
  });

  it('reads the edition from the server, and nothing from an older one', () => {
    const base = { mode: 'installer', preflight: {}, install: {} };
    expect((parseState({ ...base, edition: 'community' }) as InstallerState).edition).toBe('community');
    expect((parseState({ ...base, edition: 'commercial' }) as InstallerState).edition).toBe('commercial');
    expect(parseState(base)).not.toHaveProperty('edition');
    expect(parseState({ ...base, edition: 'other' })).not.toHaveProperty('edition');
  });
});

describe('no developer option (ONE-02)', () => {
  it('never names an environment to the checks or the install', () => {
    expect(preflightRequest(state(), START)).toEqual({ reach: { link: true, tailscale: false } });
    expect(installRequest(state(), START, sda, 'sda')).toEqual({
      disk: '/dev/sda',
      confirm: 'sda',
      reach: { link: true, tailscale: false },
    });
    expect(preflightRequest(state({ edition: 'community' }), START)).toBeUndefined();
  });
});

describe('the reach step’s words (ONE-12)', () => {
  it('take the offer sentence from the contracts (ONE-07)', () => {
    const vendored = readFileSync(
      new URL('../../vendor/whombat-contracts/link-price.ts', import.meta.url),
      'utf8',
    );
    expect(vendored).toContain('packages/protocol/src/link.ts');
    expect(vendored).toContain('export const LINK_OFFER_TEXT =');
    expect(INSTALLER.reachLinkPrice).toBe(LINK_OFFER_TEXT);
  });

  it('list what Easy gives and what Expert lacks', () => {
    expect(INSTALLER.reachLinkPoints).toHaveLength(6);
    expect(INSTALLER.reachTailscalePoints).toHaveLength(2);
    expect(INSTALLER.reachEasy).not.toBe(INSTALLER.reachExpert);
  });
});
