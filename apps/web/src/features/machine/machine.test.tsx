/**
 * The machine on the web (hardware-support-web.md AP-3223…AP-3230): This Whombat's NETWORK — the cable and
 * the Wi-Fi, joining with a wrong and then the right password, a network that hides its name, forgetting one, why there
 * is no Wi-Fi with See hardware — and About's HARDWARE with its problems and Download report; nothing without a machine.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFakeNetwork,
  FAKE_WIFI_PASSWORDS,
  type FakeMachine,
  type FakeNetwork,
  fakeHardware,
  fakeNetworkApi,
} from '@whombat/client/host/fake';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../../app/services';
import { fixtureServices, renderApp } from '../../test/renderApp';

/** The fixture world with `machine`, its changes quick (the poller asks every 2 s while one runs). */
function world(machine: FakeMachine): { services: AppServices; fake: FakeNetwork } {
  const fake = createFakeNetwork({ machine, applyMs: 0, confirmMs: 0, moveStepMs: 0 });
  const services: AppServices = {
    ...fixtureServices({ machine: false }),
    network: fakeNetworkApi(fake),
    hardware: async () => ({ hardware: fakeHardware(machine) }),
  };
  return { services, fake };
}

async function section(name: 'NETWORK' | 'HARDWARE') {
  const heading = await screen.findByRole('heading', { level: 2, name }, { timeout: 5000 });
  return heading.closest('section') as HTMLElement;
}

afterEach(() => vi.useRealTimers());

describe('NETWORK (AP-3223…AP-3227)', () => {
  it('shows the cable and the Wi-Fi, after SCREEN’s place and before AT A GLANCE', async () => {
    const { services } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section('NETWORK');
    expect(await within(s).findByText('Cable · Connected')).toBeTruthy();
    expect(within(s).getByText('Wi-Fi · Home · Strong signal')).toBeTruthy();
    expect(within(s).getAllByRole('button', { name: /^Forget / }).length).toBe(2);
    const labels = [...document.querySelectorAll('#settings-panel h2')].map((h) => h.textContent);
    expect(labels.indexOf('NETWORK')).toBe(labels.indexOf('AT A GLANCE') - 1);
  });

  it('joins: a wrong password says so and keeps nothing, the right one joins', async () => {
    const user = userEvent.setup();
    const { services, fake } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section('NETWORK');
    await user.click(await within(s).findByRole('button', { name: 'Join a Wi-Fi network' }));
    const dialog = await screen.findByRole('dialog', { name: 'Join a Wi-Fi network' });
    // Company networks are listed but can't be chosen; the one in use neither.
    expect(
      (await within(dialog).findByRole('button', { name: /^Lumio Corp/ })).hasAttribute('disabled'),
    ).toBe(true);
    expect(within(dialog).getByRole('button', { name: /^Home/ }).hasAttribute('disabled')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: /^Neighbours/ }));
    expect(within(dialog).getByText(/goes back to the one it uses now/)).toBeTruthy();
    const password = within(dialog).getByLabelText('Password');
    await user.type(password, 'short');
    await user.click(within(dialog).getByRole('button', { name: 'Join' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('8 to 63');

    await user.clear(password);
    await user.type(password, 'not the password');
    expect(password.getAttribute('type')).toBe('password');
    await user.click(within(dialog).getByRole('button', { name: 'Show' }));
    expect(password.getAttribute('type')).toBe('text');
    await user.click(within(dialog).getByRole('button', { name: 'Join' }));
    expect(await within(dialog).findByText('That password didn’t work.', {}, { timeout: 5000 })).toBeTruthy();
    expect(fake.snapshot().saved.map((n) => n.ssid)).not.toContain('Neighbours');

    await user.type(within(dialog).getByLabelText('Password'), FAKE_WIFI_PASSWORDS.Neighbours as string);
    await user.click(within(dialog).getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Done' })).toBeTruthy(), {
      timeout: 5000,
    });
    expect(fake.snapshot().connected).toBe('Neighbours');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await within(s).findByText('Wi-Fi · Neighbours · Good signal')).toBeTruthy();
  });

  it('joins a network that hides its name', async () => {
    const user = userEvent.setup();
    const { services, fake } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section('NETWORK');
    await user.click(await within(s).findByRole('button', { name: 'Join a Wi-Fi network' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Other network…' }));
    await user.click(within(dialog).getByRole('button', { name: 'Join' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('name');
    await user.type(within(dialog).getByLabelText('Network name'), 'Attic');
    await user.type(
      within(dialog).getByLabelText('Password', { selector: 'input:not([type=radio])' }),
      FAKE_WIFI_PASSWORDS.Attic as string,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(fake.snapshot().connected).toBe('Attic'), { timeout: 5000 });
  });

  it('forgets a saved network once asked', async () => {
    const user = userEvent.setup();
    const { services, fake } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section('NETWORK');
    await user.click(await within(s).findByRole('button', { name: 'Forget Office' }));
    const dialog = await screen.findByRole('dialog', { name: 'Forget “Office”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(fake.snapshot().saved.map((n) => n.ssid)).toEqual(['Home']), {
      timeout: 5000,
    });
    await waitFor(() => expect(within(s).queryByRole('button', { name: 'Forget Office' })).toBeNull());
  });

  it('says why there is no Wi-Fi, and See hardware opens About at HARDWARE', async () => {
    const user = userEvent.setup();
    const { services } = world('nodriver');
    const { location } = renderApp('/settings?tab=appliance', services);
    const s = await section('NETWORK');
    expect(await within(s).findByText('This Wi-Fi card has no driver yet.')).toBeTruthy();
    expect(within(s).queryByRole('button', { name: 'Join a Wi-Fi network' })).toBeNull();
    await user.click(within(s).getByRole('button', { name: 'See hardware' }));
    expect(location()).toContain('section=about');
    const h = await section('HARDWARE');
    expect(await within(h).findAllByText('This Wi-Fi card has no driver yet.')).toBeTruthy();
  });

  it('is not there for a VM’s missing card as a problem, and not without a manager', async () => {
    const { services } = world('vm');
    renderApp('/settings?tab=appliance', services);
    const s = await section('NETWORK');
    expect(await within(s).findByText('No Wi-Fi card')).toBeTruthy();
    expect(within(s).queryByRole('button', { name: 'See hardware' })).toBeNull();
  });
});

describe('Wi-Fi only (network-move-app.md)', () => {
  it('Use Wi-Fi only asks once, sends host.cable.set and shows the cable switched off and the servers found', async () => {
    const user = userEvent.setup();
    const { services, fake } = world('z13');
    const ops: unknown[] = [];
    const call = fake.call.bind(fake);
    fake.call = (op, input) => {
      if (op === 'host.cable.set') ops.push(input);
      return call(op, input);
    };
    renderApp('/settings?tab=appliance', services);
    const s = await section('NETWORK');
    await user.click(await within(s).findByRole('button', { name: 'Use Wi-Fi only' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use Wi-Fi only?' });
    expect(within(dialog).getByText(/“Home”/)).toBeTruthy();
    expect(within(dialog).getByText(/2 minutes/)).toBeTruthy();
    // The fixture's Wi-Fi is on the cable's network: no note about pointing servers here.
    expect(within(dialog).queryByText(/point them here/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Use Wi-Fi only' }));
    await waitFor(() => expect(fake.snapshot().wifiOnly).toBe(true), { timeout: 5000 });
    expect(ops).toEqual([{ use: 'wifi' }]);
    expect(await within(s).findByText('Cable · Switched off', {}, { timeout: 5000 })).toBeTruthy();
    expect(await within(s).findByText(/All your servers found/, {}, { timeout: 5000 })).toBeTruthy();
    expect(within(s).getByText(/AE:00:00:16:47:58/)).toBeTruthy();
    expect(within(s).queryByRole('button', { name: 'Use Wi-Fi only' })).toBeNull();

    await user.click(within(s).getByRole('button', { name: 'Use the cable again' }));
    const back = await screen.findByRole('dialog', { name: 'Use the cable again?' });
    await user.click(within(back).getByRole('button', { name: 'Use the cable' }));
    await waitFor(() => expect(fake.snapshot().wifiOnly).toBe(false), { timeout: 5000 });
    expect(ops).toEqual([{ use: 'wifi' }, { use: 'cable' }]);
    expect(await within(s).findByText('Cable · Connected', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('shows a refusal in the dialog', async () => {
    const user = userEvent.setup();
    const { services, fake } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section('NETWORK');
    await user.click(await within(s).findByRole('button', { name: 'Use Wi-Fi only' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use Wi-Fi only?' });
    // Someone else switched meanwhile: the box already uses Wi-Fi only.
    fake.call('host.cable.set', { use: 'wifi' });
    await user.click(within(dialog).getByRole('button', { name: 'Use Wi-Fi only' }));
    expect(await within(dialog).findByRole('status')).toBeTruthy();
    expect(within(dialog).getByRole('status').textContent).toMatch(/still running|already/);
  });
});

describe('HARDWARE (AP-3228…AP-3230)', () => {
  it('lists the machine, the groups with drivers, and downloads the report', async () => {
    const user = userEvent.setup();
    const { services } = world('z13');
    const blobs: Blob[] = [];
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blobs.push(b as Blob);
      return 'blob:report';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    renderApp('/settings?tab=appliance&section=about', services);
    const h = await section('HARDWARE');
    expect(await within(h).findByText(/ROG Flow Z13/)).toBeTruthy();
    // Every part and its driver is folded.
    expect(within(h).queryByText('mt7925e')).toBeNull();
    await user.click(within(h).getByRole('button', { name: 'Show every part' }));
    expect(within(h).getByText('mt7925e')).toBeTruthy();
    expect(within(h).getByText('GRAPHICS & SCREENS')).toBeTruthy();
    await user.click(within(h).getByRole('button', { name: 'Download report' }));
    expect(clicks[0]).toMatch(/^whombat-hardware-\d{4}-\d{2}-\d{2}\.txt$/);
    const text = await (blobs[0] as Blob).text();
    expect(text).toContain('Whombat hardware report');
    expect(text).toContain('14c3:7925');
    create.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });

  it('says it couldn’t read the hardware, with Try again', async () => {
    const user = userEvent.setup();
    const { services } = world('z13');
    let fail = true;
    const hardware = async () =>
      fail ? { hardware: null, reason: 'unavailable' as const } : { hardware: fakeHardware('vm') };
    renderApp('/settings?tab=appliance&section=about', { ...services, hardware });
    const h = await section('HARDWARE');
    expect(await within(h).findByText('The hardware couldn’t be read right now.')).toBeTruthy();
    fail = false;
    await user.click(within(h).getByRole('button', { name: 'Try again' }));
    expect(await within(h).findByText('Virtual machine (KVM)')).toBeTruthy();
  });
});

describe('without a machine', () => {
  it('shows neither section where there is no machine', async () => {
    renderApp('/settings?tab=appliance', fixtureServices({ machine: false }));
    await screen.findByRole('heading', { level: 2, name: 'AT A GLANCE' }, { timeout: 5000 });
    expect(screen.queryByRole('heading', { level: 2, name: 'NETWORK' })).toBeNull();
  });
});
