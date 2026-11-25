/**
 * Settings → the assistant → Looks ahead (Whombat looks-ahead.md) against the fixture world: Mara's switch with Check
 * now and the week, her calendars, incoming mail toggle, standing rules (“What to watch for”), stopped kinds with Check
 * again, and recent checks. Facts (requests, names, the shared words), not sentences.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LOOKS_AHEAD_TEXT as T } from '@whombat/client';
import { AHEAD_KIND_WORDS } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import type { WebFixtureOptions } from '../../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../../app/oneFixtures';
import { recordingWorld } from '../../../test/recordingWorld';
import { mockedServices, renderApp } from '../../../test/renderApp';

const PATH = `/burrows/${burrow.slug}/looks-ahead`;
const CHECK_PATH = `${PATH}/check`;
const AHEAD = '/settings?tab=agent&part=ahead';

function open(options: WebFixtureOptions = {}, protocolMinor?: number) {
  const { fetch, calls } = recordingWorld(options);
  renderApp(AHEAD, mockedServices(fetch, protocolMinor === undefined ? {} : { protocolMinor }));
  return {
    calls,
    updates: () => calls.filter((c) => c.method === 'PUT' && c.path === PATH),
    checks: () => calls.filter((c) => c.method === 'POST' && c.path === CHECK_PATH),
  };
}

describe('Settings → the assistant → Looks ahead', () => {
  it('shows the switch, calendars, incoming mail, standing rules, stopped kinds and recent checks', async () => {
    open();
    const main = await screen.findByRole('switch', { name: T.title });
    expect(main.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: T.title })).toBeTruthy();
    expect(screen.getByRole('button', { name: T.checkNow })).toBeTruthy();
    expect(screen.getByText(T.week(4, 1))).toBeTruthy();
    expect(screen.getByText(T.explainFor(ASSISTANT_NAME))).toBeTruthy();
    const calendars = screen.getByRole('region', { name: T.calendars });
    expect(within(calendars).getByRole('switch', { name: 'Mara Okafor' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(within(calendars).getByRole('switch', { name: 'Family' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(within(calendars).getAllByText(/mara@example\.com/)).toHaveLength(2);
    const mail = screen.getByRole('region', { name: T.mail });
    expect(within(mail).getByRole('switch', { name: T.mail }).getAttribute('aria-checked')).toBe('true');
    const rules = screen.getByRole('region', { name: T.rules });
    expect(within(rules).getByText(/Utrecht/)).toBeTruthy();
    const stopped = screen.getByRole('region', { name: T.stopped });
    expect(within(stopped).getByText(AHEAD_KIND_WORDS.crowds)).toBeTruthy();
    const recent = screen.getByRole('region', { name: T.recent });
    expect(within(recent).getByText('The Script')).toBeTruthy();
    expect(within(recent).getByRole('link', { name: T.openThread })).toBeTruthy();
  });

  it('saves each change at once, manages standing rules and triggers Check now', async () => {
    const user = userEvent.setup();
    const { updates, checks } = open();
    await user.click(await screen.findByRole('switch', { name: 'Family' }));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.body).toEqual({ calendar: 'con_google:family', on: true });
    expect(await screen.findByText(T.calendarSwitched('Family', true))).toBeTruthy();

    await user.click(screen.getByRole('switch', { name: T.mail }));
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()[1]?.body).toEqual({ mailOn: false });

    const rulesRegion = screen.getByRole('region', { name: T.rules });
    await user.type(
      within(rulesRegion).getByRole('textbox', { name: T.rules }),
      'Always check train strikes',
    );
    await user.click(within(rulesRegion).getByRole('button', { name: T.addRule }));
    await waitFor(() => expect(updates()).toHaveLength(3));
    expect(updates()[2]?.body).toEqual({ addRule: 'Always check train strikes' });

    await user.click(screen.getByRole('button', { name: T.checkNow }));
    await waitFor(() => expect(checks()).toHaveLength(1));
    expect(await screen.findByText(T.checkStarted)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: T.turnBackOnLabel('crowds') }));
    await waitFor(() => expect(updates()).toHaveLength(4));
    expect(updates()[3]?.body).toEqual({ kind: 'crowds', on: true });
    await waitFor(() => expect(screen.queryByRole('region', { name: T.stopped })).toBeNull());

    await user.click(screen.getByRole('switch', { name: T.title }));
    await waitFor(() => expect(updates()).toHaveLength(5));
    expect(updates()[4]?.body).toEqual({ on: false });
    expect(await screen.findByText(T.switched(false))).toBeTruthy();
    // Off, the calendars keep their choice and rest.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Family' }).hasAttribute('disabled')).toBe(true),
    );
  });

  it('says when no calendar is connected', async () => {
    open({
      looksAhead: { hasCalendar: false, calendarsRead: false, calendars: [], stopped: [], recent: [] },
    });
    const calendars = await screen.findByRole('region', { name: T.calendars });
    expect(within(calendars).getByText(T.noCalendar)).toBeTruthy();
    expect(within(calendars).queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('region', { name: T.stopped })).toBeNull();
  });

  it('hides v2 controls on a minor 10 Whombat and hides the part on minor 9', async () => {
    open({}, 10);
    await screen.findByRole('switch', { name: T.title });
    expect(screen.queryByRole('button', { name: T.checkNow })).toBeNull();
    expect(screen.queryByRole('region', { name: T.rules })).toBeNull();
  });

  it('isn’t there on an older Whombat', async () => {
    open({}, 9);
    await screen.findByRole('region', { name: 'Name and face' });
    expect(screen.queryByRole('radio', { name: T.title })).toBeNull();
    expect(screen.queryByRole('switch', { name: T.title })).toBeNull();
  });
});
