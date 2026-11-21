/**
 * Settings of the essentials (items 6, 12): the Notifications tab; GitHub through the person's own sign-in. Members
 * went (one-person.md AP-5670). Against the fixture world with its essentials layer (`essentialsSettings: true`).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch, FIXTURE_BASE_URL } from '../../app/fixtureFetch';
import { mockedServices, renderApp } from '../../test/renderApp';
import { DEVICE_POLL } from '../ai/DeviceCode';

function world() {
  const fixtures = createWebFixtureFetch({ essentialsSettings: true });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    fixtures(
      new URL(String(input instanceof Request ? input.url : input), FIXTURE_BASE_URL).toString(),
      init,
    ),
  );
  const calls = (method: string, path: string) =>
    fetch.mock.calls.filter(
      ([url, init]) => (init?.method ?? 'GET') === method && String(url).includes(path),
    );
  return { fetch, calls, services: mockedServices(fetch as typeof globalThis.fetch) };
}

describe('Settings → Notifications (essentials item 12, AP-490, AP-491)', () => {
  it('turns Do not disturb on for an hour, sending only the notification settings, and off again', async () => {
    const user = userEvent.setup();
    const w = world();
    renderApp('/settings?part=notifications', w.services);
    await screen.findByText('DO NOT DISTURB');
    await user.click(screen.getByRole('button', { name: '1 hour' }));
    expect(await screen.findByText(/^Do not disturb until (tomorrow at )?\d\d:\d\d\.$/)).toBeTruthy();
    const patches = w.calls('PATCH', '/me/preferences');
    const body = JSON.parse(String(patches.at(-1)?.[1]?.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['notifications']);
    expect(body.notifications).toMatchObject({ email: 'hourly', threadReplies: true });
    expect(typeof (body.notifications as { dndUntil: unknown }).dndUntil).toBe('string');
    expect(await screen.findByText(/^Do not disturb is on until (tomorrow at )?\d\d:\d\d\.$/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Do not disturb is off.')).toBeTruthy();
    const last = JSON.parse(String(w.calls('PATCH', '/me/preferences').at(-1)?.[1]?.body));
    expect(last.notifications.dndUntil).toBeNull();
  });

  it('switches quiet hours on and picks days; email shows where the Whombat can send mail', async () => {
    const user = userEvent.setup();
    const w = world();
    renderApp('/settings?part=notifications', w.services);
    await user.click(await screen.findByRole('switch', { name: 'Quiet hours' }));
    expect(await screen.findByText('Every day, 22:00–08:00 (until the next morning)')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Saturday' }));
    await user.click(screen.getByRole('button', { name: 'Sunday' }));
    expect(await screen.findByText('Weekdays, 22:00–08:00 (until the next morning)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Monday' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Sunday' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('group', { name: 'Email about what’s unread' })).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Daily' }));
    await waitFor(() =>
      expect(
        JSON.parse(String(w.calls('PATCH', '/me/preferences').at(-1)?.[1]?.body)).notifications.email,
      ).toBe('daily'),
    );
  });

  it('one sentence, and no THREADS (less-is-more.md AP-1790)', async () => {
    renderApp('/settings?part=notifications');
    expect(await screen.findByText('These are yours alone, for every chat in Burrow HQ.')).toBeTruthy();
    expect(screen.getByText('DO NOT DISTURB')).toBeTruthy();
    expect(screen.queryByText('THREADS')).toBeNull();
    expect(screen.queryByText(/The bell in a conversation’s header/)).toBeNull();
  });

  it('leaves email out on a Whombat that can’t send it', async () => {
    renderApp('/settings?part=notifications');
    await screen.findByText('DO NOT DISTURB');
    expect(screen.queryByText('EMAIL')).toBeNull();
    expect(screen.queryByText('THREADS')).toBeNull();
  });
});

describe('GitHub through your own sign-in (essentials item 6, AP-493…AP-495)', () => {
  const poll = DEVICE_POLL.ms;
  beforeEach(() => {
    DEVICE_POLL.ms = 5;
  });
  afterEach(() => {
    DEVICE_POLL.ms = poll;
  });

  it('signs in with GitHub’s device code, then connects GitHub for the burrow', async () => {
    const user = userEvent.setup();
    const w = world();
    const app = renderApp('/settings?tab=dev', w.services);
    // `?tab=dev` (Software Dev, before AP-540; then Repositories) opens GitHub's page in Connections (SS-02).
    expect(await screen.findByRole('heading', { level: 2, name: 'GitHub' })).toBeTruthy();
    await waitFor(() => expect(app.location()).toBe('/connections?connection=github'));
    expect(
      await screen.findByText(
        /^Sign in with your GitHub account and Burrow HQ is connected right after\. \S+ then works on your repos as you\.$/,
      ),
    ).toBeTruthy();
    // No host to run gh on: no command.
    expect(screen.queryByText('gh auth login')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign in to GitHub' }));
    const flow = await screen.findByRole('region', { name: 'GitHub sign-in' });
    expect(
      within(flow)
        .getByRole('link', { name: /Open github\.com/ })
        .getAttribute('href'),
    ).toBe('https://github.com/login/device');
    expect(within(flow).getByText('Enter this code')).toBeTruthy();
    // Signed in: the burrow is connected without another click (AP-543).
    expect(await screen.findByText('@maraokafor', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    expect(await screen.findByText('whombat/web')).toBeTruthy();
  });

  it('keeps your GitHub sign-in on GitHub’s page, with Sign out (AP-550, SS-05)', async () => {
    const user = userEvent.setup();
    const w = world();
    renderApp('/connections?connection=github', w.services);

    expect(await screen.findByText('Your GitHub sign-in')).toBeTruthy();
    expect(screen.getByText('Not signed in')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use a token instead' }));
    await user.type(screen.getByLabelText('GitHub token'), 'ghp_fixture_token_123');
    await user.click(screen.getByRole('button', { name: 'Save token' }));
    expect(await screen.findByText('Signed in as @maraokafor')).toBeTruthy();
    // Your sign-in connects the burrow too.
    expect(await screen.findByText(/every repository @maraokafor owns/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out (GitHub)' })).toBeTruthy();
  });
});
