/**
 * Notifications on by themselves (docs/decisions/web-push-connect.md): the Chat's one question where the browser never
 * asked, and Settings → Notifications' switch for this browser.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_NAME } from '../app/oneFixtures';
import type { ManagedWebPush } from '../managed/webPush';
import { fixtureServices, renderApp } from '../test/renderApp';
import { NOTIFICATIONS_OFFER_TEXT } from './NotificationsOffer';
import { readPushChoice } from './pushChoice';

/** A browser with Push and the permission given; asking grants it. */
function browser(permission: NotificationPermission) {
  const requestPermission = vi.fn(async () => {
    fake.permission = 'granted';
    return 'granted' as const;
  });
  const fake: { permission: NotificationPermission; requestPermission: typeof requestPermission } = {
    permission,
    requestPermission,
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: async () => ({
        pushManager: {
          subscribe: async () => ({
            endpoint: 'https://push.example/abc',
            toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
          }),
        },
      }),
      getRegistration: async () => undefined,
    },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', fake);
  return { requestPermission };
}

/** A Whombat with control behind the page, whose notifications reach this browser. */
function withPush(registered = false) {
  const push = {
    vapidKey: async () =>
      'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    registered: async () => registered,
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
  } satisfies ManagedWebPush;
  const services = fixtureServices();
  services.managed = {
    applianceId: 'wmb_0001',
    applianceName: 'Burrow HQ',
    deviceFingerprint: '0000-0000-0000',
    appliancePeerId: '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo',
    applianceFingerprint: '0000-0000-0000',
    kitPending: false,
    signOut: () => {},
    switchAppliance: () => {},
    push,
  } as unknown as NonNullable<typeof services.managed>;
  return { services, push };
}

const question = () => NOTIFICATIONS_OFFER_TEXT.title(ASSISTANT_NAME);

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  localStorage.clear();
});

describe('the Chat asks once where the browser never asked', () => {
  it('Not now hides it in this browser for good', async () => {
    browser('default');
    const user = userEvent.setup();
    const first = renderApp('/chat', withPush().services);
    const card = await screen.findByRole('region', { name: question() });
    await user.click(within(card).getByRole('button', { name: NOTIFICATIONS_OFFER_TEXT.notNow }));
    expect(screen.queryByRole('region', { name: question() })).toBeNull();
    expect(readPushChoice().answered).toBe(true);
    first.unmount();

    renderApp('/chat', withPush().services);
    await screen.findByRole('heading', { name: 'Chat', level: 1 });
    expect(screen.queryByRole('region', { name: question() })).toBeNull();
  });

  it('Turn on asks the browser from the click and turns them on', async () => {
    const b = browser('default');
    const user = userEvent.setup();
    const { services, push } = withPush();
    renderApp('/chat', services);
    const card = await screen.findByRole('region', { name: question() });
    await user.click(within(card).getByRole('button', { name: NOTIFICATIONS_OFFER_TEXT.turnOn }));
    expect(b.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(push.enable).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: question() })).toBeNull();
  });

  it('isn’t there where the browser already allows them: they come on by themselves', async () => {
    const b = browser('granted');
    const { services, push } = withPush();
    renderApp('/chat', services);
    await waitFor(() => expect(push.enable).toHaveBeenCalledTimes(1));
    expect(b.requestPermission).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: question() })).toBeNull();
  });
});

describe('Settings → Notifications’ switch for this browser', () => {
  it('turns them off and remembers it here; blocked says where to allow them', async () => {
    browser('granted');
    const user = userEvent.setup();
    const { services, push } = withPush(true);
    const view = renderApp('/settings?part=notifications', services);
    const toggle = await screen.findByRole('switch', { name: 'Notifications in this browser' });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    await user.click(toggle);
    await waitFor(() => expect(push.disable).toHaveBeenCalled());
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(readPushChoice().off).toBe(true);
    view.unmount();

    browser('denied');
    renderApp('/settings?part=notifications', withPush().services);
    const blocked = await screen.findByRole('switch', { name: 'Notifications in this browser' });
    await waitFor(() => expect(blocked.hasAttribute('disabled')).toBe(true));
    expect(screen.getByText(/site settings/)).toBeTruthy();
  });
});
