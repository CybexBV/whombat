import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ControlApi } from '@whombat/client/managed';
import { describe, expect, it, vi } from 'vitest';
import { MOBILE_TEXT } from '../../features/mobile/copy';
import { fixtureServices, renderApp } from '../../test/renderApp';

/** A box's services: a Whombat open, with control behind it. */
function managedServices(
  control = {
    createPhoneHandoff: async () => ({
      handoffId: 'ph_0123456789',
      token: 'token_token_token_token_1',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
    phoneHandoff: () => new Promise(() => {}),
    androidDownload: async () => null,
  } as unknown as ControlApi,
) {
  return {
    applianceId: 'wmb_0001',
    applianceName: 'Burrow HQ',
    deviceFingerprint: '0000-0000-0000',
    appliancePeerId: '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo',
    applianceFingerprint: '0000-0000-0000',
    kitPending: false,
    onKit: () => {},
    signOut: () => {},
    switchAppliance: () => {},
    control,
  } as unknown as NonNullable<ReturnType<typeof fixtureServices>['managed']>;
}

describe('/mobile (AP-521) and Settings → Phone app (settings-phone-link.md SPL-23)', () => {
  it('the account menu’s “Phone app” opens it inside the app, under Settings', async () => {
    const app = renderApp('/chat');
    const side = await screen.findByRole('complementary', { name: 'Sidebar' });
    await userEvent.click(await within(side).findByRole('button', { name: /^Account,/ }));
    await userEvent.click(within(side).getByRole('link', { name: 'Phone app' }));
    expect(await screen.findByRole('heading', { name: 'Phone app', level: 1 })).toBeTruthy();
    expect(app.location()).toBe('/settings?tab=phone');
    // The sidebar stays, and the way back is Settings'.
    expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toBeTruthy();
    expect(await screen.findByText('41 MB · Updates itself')).toBeTruthy();
  });

  it('with a Whombat open, /mobile is Settings → Phone app', async () => {
    const services = fixtureServices();
    services.managed = managedServices();
    const app = renderApp('/mobile', services);
    expect(await screen.findByRole('heading', { name: 'Phone app', level: 1 })).toBeTruthy();
    expect(app.location()).toBe('/settings?tab=phone');
  });

  it('without a Whombat open, /mobile keeps its own page', async () => {
    renderApp('/mobile', fixtureServices({ signedIn: false }));
    expect(await screen.findByRole('heading', { name: MOBILE_TEXT.title, level: 1 })).toBeTruthy();
  });

  it('without a control (self-hosted, fixtures): the download and the email note, no QR code', async () => {
    renderApp('/mobile');
    expect(await screen.findByText('41 MB · Updates itself')).toBeTruthy();
    expect(
      screen.getByText('On this server, the app signs in with your email, like this browser did.'),
    ).toBeTruthy();
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
  });

  it('managed: a QR code from control naming the open Whombat, and control’s APK', async () => {
    const services = fixtureServices();
    const control = {
      createPhoneHandoff: vi.fn(async () => ({
        handoffId: 'ph_0123456789',
        token: 'token_token_token_token_1',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })),
      phoneHandoff: vi.fn(async () => {
        throw new Error('not in this test');
      }),
      androidDownload: vi.fn(async () => null),
    } as unknown as ControlApi;
    services.managed = managedServices(control);
    renderApp('/settings?tab=phone', services);
    expect(
      await screen.findByRole('img', { name: 'QR code that signs your phone in to Whombat' }),
    ).toBeTruthy();
    expect(screen.getByText('It signs your phone in as you and asks Burrow HQ to let it in.')).toBeTruthy();
    expect(
      await screen.findByText('The Android app isn’t published here yet. Check back soon.'),
    ).toBeTruthy();
    expect(control.createPhoneHandoff).toHaveBeenCalledTimes(1);
  });
});
