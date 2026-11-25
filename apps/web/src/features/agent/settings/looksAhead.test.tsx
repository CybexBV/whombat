/**
 * Settings → the assistant → Looks ahead (Whombat looks-ahead.md) against the fixture world: Mara's switch with Check
 * now and the week, her calendars, incoming mail toggle, standing rules (“What to watch for”), stopped kinds with Check
 * again, what it keeps an eye on (“Keeping an eye on”, each with Remove), and recent checks with a look through new mail
 * and a follow-up. Facts (requests, names, the shared words), not sentences.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { looksAheadCheckMeta, matterLine, LOOKS_AHEAD_TEXT as T } from '@whombat/client';
import { AHEAD_KIND_WORDS } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch, type WebFixtureOptions } from '../../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../../app/oneFixtures';
import { jsonAnswer, type RecordedCall, recordingWorld } from '../../../test/recordingWorld';
import { mockedServices, renderApp } from '../../../test/renderApp';

const PATH = `/burrows/${burrow.slug}/looks-ahead`;
const CHECK_PATH = `${PATH}/check`;
const AHEAD = '/settings?tab=agent&part=ahead';

function open(options: WebFixtureOptions = {}, protocolMinor?: number) {
  const { fetch, calls } = recordingWorld(options);
  renderApp(AHEAD, mockedServices(fetch, protocolMinor === undefined ? {} : { protocolMinor }));
  return world(calls);
}

/** The fixture world whose Looks ahead refuses every change before it makes it. */
function openRefusing() {
  const inner = createWebFixtureFetch({});
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request ? input : new Request(new URL(String(input), 'http://whombat.test'), init);
    const path = new URL(req.url).pathname.replace('/api/v1', '');
    if (req.method === 'PUT' && path === PATH) {
      calls.push({ method: req.method, path, body: await req.clone().json() });
      return jsonAnswer({ error: { code: 'internal', message: '' } }, 500);
    }
    return inner(req);
  });
  renderApp(AHEAD, mockedServices(fetch));
  return world(calls);
}

function world(calls: RecordedCall[]) {
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
    expect(within(recent).getAllByRole('link', { name: T.openThread })).toHaveLength(2);
  });

  it('lists what it keeps an eye on, after incoming mail and before what to watch for', async () => {
    open();
    const matters = await screen.findByRole('region', { name: T.matters });
    const sections = [...document.querySelectorAll('[data-ahead]')].map((s) => s.getAttribute('data-ahead'));
    expect(sections.indexOf('matters')).toBe(sections.indexOf('mail') + 1);
    expect(sections.indexOf('rules')).toBe(sections.indexOf('matters') + 1);
    const rows = within(matters).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const notary = rows[0] as HTMLElement;
    expect(within(notary).getByText('Answer the notary about the deed')).toBeTruthy();
    // The quieter line: who, whom it waits on, its date.
    expect(within(notary).getByText(/The notary/).textContent).toContain(T.matterWaiting.you);
    expect(within(notary).getByText(/The notary/).textContent).toContain('16 Dec');
    expect(
      within(rows[1] as HTMLElement).getByText(matterLine({ who: 'The airline', waitingOn: 'them' })),
    ).toBeTruthy();
    expect(
      within(notary).getByRole('button', { name: T.removeMatterLabel('Answer the notary about the deed') }),
    ).toBeTruthy();
  });

  it('stops keeping an eye on one with Remove', async () => {
    const user = userEvent.setup();
    const { updates } = open();
    const matters = await screen.findByRole('region', { name: T.matters });
    await user.click(
      within(matters).getByRole('button', { name: T.removeMatterLabel('Refund for the cancelled flight') }),
    );
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.body).toEqual({ removeMatter: 'ahm_2' });
    expect(await screen.findByText(T.matterRemoved)).toBeTruthy();
    await waitFor(() => expect(within(matters).getAllByRole('listitem')).toHaveLength(2));
    expect(within(matters).queryByText('Refund for the cancelled flight')).toBeNull();
  });

  it('puts a removed one back when the change doesn’t go through', async () => {
    const user = userEvent.setup();
    const { updates } = openRefusing();
    const matters = await screen.findByRole('region', { name: T.matters });
    await user.click(
      within(matters).getByRole('button', { name: T.removeMatterLabel('Refund for the cancelled flight') }),
    );
    await waitFor(() => expect(updates()).toHaveLength(1));
    await waitFor(() => expect(within(matters).getAllByRole('listitem')).toHaveLength(3));
    expect(within(matters).getByText('Refund for the cancelled flight')).toBeTruthy();
  });

  it('says so in one quiet line when it keeps an eye on nothing', async () => {
    open({ looksAhead: { matters: [] } });
    const matters = await screen.findByRole('region', { name: T.matters });
    expect(within(matters).getByText(T.mattersEmpty(ASSISTANT_NAME))).toBeTruthy();
    expect(within(matters).queryByRole('listitem')).toBeNull();
  });

  it('leaves out what it keeps an eye on without a mailbox and nothing kept', async () => {
    open({ looksAhead: { hasMail: false, matters: [] } });
    await screen.findByRole('region', { name: T.rules });
    expect(screen.queryByRole('region', { name: T.matters })).toBeNull();
  });

  it('still lists what it keeps, each removable, when the mailbox dropped out', async () => {
    const user = userEvent.setup();
    const { updates } = open({ looksAhead: { hasMail: false } });
    const matters = await screen.findByRole('region', { name: T.matters });
    expect(within(matters).getAllByRole('listitem')).toHaveLength(3);
    await user.click(
      within(matters).getByRole('button', { name: T.removeMatterLabel('Refund for the cancelled flight') }),
    );
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.body).toEqual({ removeMatter: 'ahm_2' });
  });

  it('leaves out what it keeps an eye on below its minor', async () => {
    open({}, 13);
    await screen.findByRole('region', { name: T.rules });
    expect(screen.queryByRole('region', { name: T.matters })).toBeNull();
    expect(screen.queryByText('Answer the notary about the deed')).toBeNull();
  });

  it('labels a look through new mail and a follow-up with the shared words', async () => {
    open();
    const recent = await screen.findByRole('region', { name: T.recent });
    const triage = recent.querySelector('[data-check="ahc_4"]') as HTMLElement;
    expect(within(triage).getByText(T.recentTriage(42, 2))).toBeTruthy();
    expect(within(triage).queryByRole('link')).toBeNull();
    const followUp = recent.querySelector('[data-check="ahc_3"]') as HTMLElement;
    const meta = looksAheadCheckMeta({ stage: 'mail', state: 'told', kind: 'deadline', of: 'matter' });
    expect(meta.startsWith(T.recentMatter)).toBe(true);
    expect(within(followUp).getByText(meta)).toBeTruthy();
    expect(within(followUp).getByRole('link', { name: T.openThread })).toBeTruthy();
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
