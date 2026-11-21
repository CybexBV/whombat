/**
 * Bluetooth on the web (bluetooth-web.md AP-3711…AP-3716): This Whombat's BLUETOOTH — the paired devices
 * after NETWORK, Add a device (looking, a mouse paired without a code, a keyboard's code with the digits typed, the
 * question answered No and Yes, a refusal and Try again, closing cancels), Connect, Disconnect and Remove from a row's
 * menu, Bluetooth switched off with See hardware — and nothing on a machine without an adapter.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFakeBluetooth,
  FAKE_BLUETOOTH_CODE,
  type FakeBluetooth,
  type FakeMachine,
  fakeBluetoothApi,
} from '@whombat/client/host/fake';
import { describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../../app/services';
import { fixtureServices, renderApp } from '../../test/renderApp';

/**
 * The fixture world with `machine`'s Bluetooth on a clock the test moves on (`clock.t`, from now: the section follows
 * a scan or pairing while its time is ahead); devices are found at once.
 */
function world(
  machine: FakeMachine,
  { devices }: { devices?: [] } = {},
): { services: AppServices; fake: FakeBluetooth; clock: { t: number } } {
  const clock = { t: Date.now() };
  const fake = createFakeBluetooth({
    machine,
    now: () => clock.t,
    findAfterMs: 0,
    pairMs: 1_000,
    typeMs: 1_000,
    connectMs: 0,
    ...(devices ? { initial: { machine, devices } } : {}),
  });
  const services: AppServices = { ...fixtureServices({ machine: false }), bluetooth: fakeBluetoothApi(fake) };
  return { services, fake, clock };
}

async function section() {
  const heading = await screen.findByRole('heading', { level: 2, name: 'BLUETOOTH' }, { timeout: 5000 });
  return heading.closest('section') as HTMLElement;
}

async function addDevice(s: HTMLElement) {
  const user = userEvent.setup();
  await user.click(await within(s).findByRole('button', { name: 'Add a device' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add a device' });
  return { user, dialog };
}

/** The next poll's answer (the section asks every second while the box looks or pairs). */
const polled = { timeout: 3000 };

describe('BLUETOOTH (AP-3711…AP-3716)', () => {
  it('lists the paired devices, connected first, right after NETWORK', async () => {
    const { services } = world('z13');
    renderApp('/settings?tab=appliance', {
      ...services,
      network: fixtureServices({ machine: 'z13' }).network,
    });
    const s = await section();
    const rows = await within(s).findAllByText(/^(Keychron K3|WH-1000XM5)$/);
    expect(rows.map((r) => r.textContent)).toEqual(['Keychron K3', 'WH-1000XM5']);
    expect(within(s).getByText('Connected · Battery 80 %')).toBeTruthy();
    expect(within(s).getByText('Not connected')).toBeTruthy();
    expect(within(s).getByRole('button', { name: 'Actions for Keychron K3' })).toBeTruthy();
    const labels = [...document.querySelectorAll('#settings-panel h2')].map((h) => h.textContent);
    expect(labels.indexOf('BLUETOOTH')).toBe(labels.indexOf('NETWORK') + 1);
  });

  it('pairs a mouse without a code: the list without the phone, Pairing…, ready, its row', async () => {
    const { services, clock } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section();
    const { user, dialog } = await addDevice(s);
    expect(within(dialog).getByText(/pairing mode/)).toBeTruthy();
    const list = await within(dialog).findByRole('list', { name: 'Devices nearby' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'MX Master 3S, mouse, strong signal',
      'Magic Keyboard, keyboard, good signal',
      'JBL Flip 6, speaker, good signal',
      'Pebble Keys 2, keyboard, good signal',
      'Xbox Wireless Controller, game controller, weak signal',
    ]);
    expect(within(dialog).getByText('Looking for devices…')).toBeTruthy();

    await user.click(within(list).getByRole('button', { name: /^MX Master 3S/ }));
    expect(await within(dialog).findByText('Pairing with MX Master 3S…')).toBeTruthy();
    clock.t += 1_000;
    expect(await within(dialog).findByText('MX Master 3S is ready.', {}, polled)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await within(s).findByText('MX Master 3S')).toBeTruthy();
  });

  it('shows a keyboard’s code with the digits typed, and closing cancels the pairing', async () => {
    const { services, fake, clock } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section();
    const { user, dialog } = await addDevice(s);
    await user.click(await within(dialog).findByRole('button', { name: /^Magic Keyboard/ }));
    clock.t += 3_000;
    expect(
      await within(dialog).findByText(
        `Type ${FAKE_BLUETOOTH_CODE} on Magic Keyboard, then press Enter.`,
        {},
        polled,
      ),
    ).toBeTruthy();
    const digits = dialog.querySelectorAll('[data-code] > span');
    expect([...digits].map((d) => d.textContent).join('')).toBe(FAKE_BLUETOOTH_CODE);
    expect([...digits].filter((d) => d.className.includes('typed'))).toHaveLength(2);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => {
      const told = fake.call('host.bluetooth', {}).body as {
        bluetooth: { pairing: { phase: string; failure?: string } };
      };
      expect(told.bluetooth.pairing.failure).toBe('canceled');
    });
  });

  it('asks about the number: No goes back to the list, Yes pairs', async () => {
    const { services, clock } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section();
    const { user, dialog } = await addDevice(s);
    await user.click(await within(dialog).findByRole('button', { name: /^Pebble Keys 2/ }));
    clock.t += 1_000;
    const question = `Does Pebble Keys 2 show ${FAKE_BLUETOOTH_CODE}?`;
    expect(await within(dialog).findByText(question, {}, polled)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'No' }));
    expect(await within(dialog).findByRole('list', { name: 'Devices nearby' })).toBeTruthy();

    await user.click(await within(dialog).findByRole('button', { name: /^Pebble Keys 2/ }));
    clock.t += 1_000;
    await within(dialog).findByText(question, {}, polled);
    await user.click(within(dialog).getByRole('button', { name: 'Yes' }));
    expect(await within(dialog).findByText('Pebble Keys 2 is ready.', {}, polled)).toBeTruthy();
  });

  it('says why a pairing didn’t work, and Try again looks again', async () => {
    const { services, clock } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section();
    const { user, dialog } = await addDevice(s);
    await user.click(await within(dialog).findByRole('button', { name: /^Xbox Wireless Controller/ }));
    clock.t += 1_000;
    expect(await within(dialog).findByText(/didn’t accept the pairing/, {}, polled)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('button', { name: /^Xbox Wireless Controller/ })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: /^JBL Flip 6/ }));
    expect(await within(dialog).findByText('Pairing with JBL Flip 6…')).toBeTruthy();
  });

  it('connects, disconnects and removes from a device’s menu', async () => {
    const user = userEvent.setup();
    const { services, fake } = world('z13');
    renderApp('/settings?tab=appliance', services);
    const s = await section();
    await user.click(await within(s).findByRole('button', { name: 'Actions for WH-1000XM5' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Connect' }));
    await waitFor(() => expect(within(s).getAllByText(/^Connected/)).toHaveLength(2));

    await user.click(within(s).getByRole('button', { name: 'Actions for Keychron K3' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(fake.snapshot().devices.find((d) => d.name === 'Keychron K3')?.connected).toBe(false),
    );

    await user.click(within(s).getByRole('button', { name: 'Actions for Keychron K3' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
    const ask = await screen.findByRole('dialog', { name: 'Remove Keychron K3?' });
    expect(within(ask).getByText(/pair it again/)).toBeTruthy();
    await user.click(within(ask).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(s).queryByText('Keychron K3')).toBeNull());
    expect(fake.snapshot().devices.map((d) => d.name)).toEqual(['WH-1000XM5']);
  });

  it('offers Add a device on its own row when nothing is paired yet', async () => {
    const { services } = world('z13', { devices: [] });
    renderApp('/settings?tab=appliance', services);
    const s = await section();
    expect(await within(s).findByText('No devices yet')).toBeTruthy();
    expect(within(s).getByRole('button', { name: 'Add a device' }).className).toMatch(/primary/);
  });

  it('says Bluetooth is switched off, with See hardware and no Add a device', async () => {
    const user = userEvent.setup();
    const { services } = world('nodriver');
    const { location } = renderApp('/settings?tab=appliance', services);
    const s = await section();
    expect(await within(s).findByText('Bluetooth is switched off.')).toBeTruthy();
    expect(within(s).queryByRole('button', { name: 'Add a device' })).toBeNull();
    expect(within(s).queryByRole('button', { name: /^Actions for/ })).toBeNull();
    await user.click(within(s).getByRole('button', { name: 'See hardware' }));
    await waitFor(() => expect(location()).toContain('section=about'));
  });

  it('shows nothing on a machine without an adapter', async () => {
    const { services } = world('vm');
    const api = services.bluetooth as NonNullable<AppServices['bluetooth']>;
    const asked = vi.fn();
    const counted = { ...api, state: () => api.state().finally(asked) };
    renderApp('/settings?tab=appliance', { ...services, bluetooth: counted });
    await screen.findByRole('heading', { level: 2, name: 'AT A GLANCE' }, { timeout: 5000 });
    await waitFor(() => expect(asked).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('heading', { level: 2, name: 'BLUETOOTH' })).toBeNull();
  });
});
