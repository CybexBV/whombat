/**
 * The Inbox (Whombat inbox.md IBX-01…; needs-you-list.md NYL-01…NYL-09): its groups and the one count, each row's way
 * forward and Settle, its More (Ask Neo to handle it, Talk to Neo about it, Remind me tomorrow), Later and Settled with
 * Bring it back, and the older addresses. The fixture world's Needs you and Watch, with the looks Neo looked into
 * (lookFixtures.ts).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NEEDS_YOU_WORDS } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { HA_LOOK_THREAD, PVE_LOOK_THREAD, UNIFI_LOOK_THREAD } from '../../app/lookFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';

const world = () => fixtureServices({});
const looks = () => fixtureServices({ looks: true });
const group = (name: string | RegExp) => screen.findByRole('region', { name });
const buttons = (el: HTMLElement) =>
  within(el)
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent);
const more = async (user: ReturnType<typeof userEvent.setup>, row: HTMLElement, item: string) => {
  await user.click(within(row).getByRole('button', { name: /^More for/ }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
};

describe('the Inbox (IBX-01; NYL-01, NYL-04, NYL-05)', () => {
  it('groups what needs Mara, what Neo is on, heads-ups folded and what comes back later; one count everywhere', async () => {
    const user = userEvent.setup();
    renderApp('/inbox', looks());
    expect(await screen.findByRole('heading', { name: 'Inbox', level: 1 })).toBeTruthy();
    const you = await group('Needs you');
    const count = within(you).getAllByRole('article').length;
    expect(
      within(await screen.findByRole('complementary', { name: 'Sidebar' })).getByRole('link', {
        name: new RegExp(`^Inbox, ${count} things need you`),
      }),
    ).toBeTruthy();
    const onIt = await group('Neo’s on it');
    const warm = within(onIt).getByRole('article', { name: 'pve-02 is running warm' });
    expect(within(warm).getByText('Neo is looking into it')).toBeTruthy();
    // Neo's own rows only talk: no Settle while it works on them.
    expect(buttons(warm)).toEqual(['More for pve-02 is running warm']);
    const fyi = await group('Heads-ups');
    expect(within(fyi).queryByRole('article')).toBeNull();
    await user.click(within(fyi).getByRole('button', { name: 'Show 2 heads-ups' }));
    expect(within(fyi).getByRole('article', { name: '12 updates waiting on pve-01' })).toBeTruthy();
    const later = await group('Later');
    expect(within(later).getByText(/Until tomorrow 09:00/)).toBeTruthy();
    // Settled is always there and always last, even before anything is settled; what Neo did lives in Chat.
    const sections = document.querySelectorAll('[data-needs-you-group]');
    expect(sections[sections.length - 1]?.getAttribute('data-needs-you-group')).toBe('settled');
    expect(screen.queryByRole('link', { name: /Neo did/ })).toBeNull();
  });

  it('gives each row one way forward, Settle and the rest in More; asks waiting on Mara never settle', async () => {
    const user = userEvent.setup();
    renderApp('/inbox', world());
    const you = await group('Needs you');
    const row = (name: string) => within(you).getByRole('article', { name });
    const disk = await within(you).findByRole('article', { name: 'The disk array on blackbox has failed' });
    expect(buttons(disk)).toEqual(['Ask Neo to handle it', 'More for The disk array on blackbox has failed']);
    const restart = row('Restart arnica-prod-nest-01 on pve-02?');
    expect(buttons(restart)).not.toContain('Settle');
    // An approval's answers in the card's order and words.
    expect(buttons(within(restart).getByRole('group', { name: 'Approval answers' }))).toEqual([
      'Yes, now',
      'Yes, tonight',
      'No',
    ]);
    // Its facts before its answers: no key named, the exact later time.
    expect(restart.textContent).toContain('Not supplied in this request');
    expect(restart.textContent).toMatch(/Yes, tonight means\s*\w+day, \d+ \w+ 2026 at 03:00/);
    // One verb for every problem.
    expect(buttons(row('1 guest has changes waiting for a restart'))[0]).toBe('Ask Neo to handle it');
    await user.click(within(disk).getByRole('button', { name: /^More for/ }));
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    expect(items).toEqual(expect.arrayContaining(['Settle', 'Talk to Neo about it', 'Remind me tomorrow']));
    // No Ignore, “Look into it”, “Not now”, “Snooze” or “Watch again” anywhere.
    expect(
      screen.queryByRole('button', { name: /^Ignore$|Look into it|Not now|Snooze|Watch again/ }),
    ).toBeNull();
  });

  it('reminds tomorrow from More and brings it back from Later', async () => {
    const user = userEvent.setup();
    renderApp('/inbox', world());
    const you = await group('Needs you');
    const alert = await within(you).findByRole('article', { name: 'The disk array on blackbox has failed' });
    await more(user, alert, 'Remind me tomorrow');
    expect(await screen.findByText(/^I’ll remind you tomorrow at 09:00\.$/)).toBeTruthy();
    const later = await group('Later');
    const back = await within(later).findByRole('article', { name: 'The disk array on blackbox has failed' });
    await user.click(within(back).getByRole('button', { name: 'Bring it back' }));
    expect(await screen.findByText(NEEDS_YOU_WORDS.backDone)).toBeTruthy();
    expect(
      await within(await group('Needs you')).findByRole('article', {
        name: 'The disk array on blackbox has failed',
      }),
    ).toBeTruthy();
  });

  it('settles a line into Settled (folded), with Undo, and approves for tonight', async () => {
    const user = userEvent.setup();
    renderApp('/inbox', world());
    const you = await group('Needs you');
    const name = 'No backup of pve-01’s guests for 2 days';
    const hint = await within(you).findByRole('article', { name });
    const next = hint.nextElementSibling as HTMLElement;
    await more(user, hint, 'Settle');
    expect(await screen.findByText(NEEDS_YOU_WORDS.settledLine)).toBeTruthy();
    // Focus goes on to the next row, so the keyboard can settle one after another.
    expect(next.contains(document.activeElement)).toBe(true);
    await waitFor(() => expect(within(you).queryByRole('article', { name })).toBeNull());
    const settled = await group('Settled');
    expect(within(settled).queryByRole('article')).toBeNull();
    await user.click(within(settled).getByRole('button', { name: /^Settled/ }));
    expect(within(settled).getByRole('article', { name })).toBeTruthy();
    const restart = within(you).getByRole('article', { name: 'Restart arnica-prod-nest-01 on pve-02?' });
    await user.click(within(restart).getByRole('button', { name: 'Yes, tonight' }));
    expect(await screen.findByText('Approved. It runs at 03:00.')).toBeTruthy();
  });

  it('brings a settled row back with the toast’s Undo', async () => {
    const user = userEvent.setup();
    renderApp('/inbox', world());
    const you = await group('Needs you');
    const name = 'No backup of pve-01’s guests for 2 days';
    await more(user, await within(you).findByRole('article', { name }), 'Settle');
    await waitFor(() => expect(within(you).queryByRole('article', { name })).toBeNull());
    await user.click(await screen.findByRole('button', { name: NEEDS_YOU_WORDS.undo }));
    expect(await within(await group('Needs you')).findByRole('article', { name })).toBeTruthy();
  });

  it('says what Settled is for only once it is opened', async () => {
    const user = userEvent.setup();
    renderApp('/inbox', world());
    const settled = await group('Settled');
    expect(within(settled).queryByText(NEEDS_YOU_WORDS.noneSettled)).toBeNull();
    await user.click(within(settled).getByRole('button', { name: /^Settled/ }));
    expect(within(settled).getByText(NEEDS_YOU_WORDS.noneSettled)).toBeTruthy();
  });

  it.each([['/watch?item=wch_pve-01-backup'], ['/needs-you?item=wch_pve-01-backup']])(
    'opens on the item %s names, at the Inbox’s address',
    async (url) => {
      const app = renderApp(url, world());
      await waitFor(() => expect(app.location()).toBe('/inbox?item=wch_pve-01-backup'));
      const you = await group('Needs you');
      const row = await within(you).findByRole('article', {
        name: 'No backup of pve-01’s guests for 2 days',
      });
      expect(row.getAttribute('data-focused')).toBe('true');
    },
  );
});

describe('Neo, from a row (IBX-05…IBX-07; NYL-06; look-research-web.md AP-5905)', () => {
  it('asks to fix it in the thing’s own thread instead of starting another', async () => {
    const user = userEvent.setup();
    const app = renderApp('/inbox', looks());
    const you = await group('Needs you');
    const line = await within(you).findByRole('article', {
      name: '1 guest has changes waiting for a restart',
    });
    await user.click(within(line).getByRole('button', { name: 'Ask Neo to handle it' }));
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${PVE_LOOK_THREAD}`));
  });

  it('hands it to Neo and opens the thread it works in (BPL-15)', async () => {
    const user = userEvent.setup();
    const app = renderApp('/inbox', looks());
    const you = await group('Needs you');
    const disk = await within(you).findByRole('article', { name: 'The disk array on blackbox has failed' });
    await user.click(within(disk).getByRole('button', { name: 'Ask Neo to handle it' }));
    await waitFor(() => expect(app.location()).toMatch(/^\/chat\?thread=msg_look-/));
  });

  it('talks it over in a thread Neo opens with the item', async () => {
    const user = userEvent.setup();
    const app = renderApp('/inbox', world());
    const you = await group('Needs you');
    const disk = await within(you).findByRole('article', { name: 'The disk array on blackbox has failed' });
    await more(user, disk, 'Talk to Neo about it');
    await waitFor(() => expect(app.location()).toMatch(/^\/chat\?thread=/));
    expect((await screen.findAllByText(/The disk array on blackbox has failed/)).length).toBeGreaterThan(0);
  });

  it('a finding: its step first; pressed, its thread opens (BPL-15)', async () => {
    const user = userEvent.setup();
    const app = renderApp('/inbox', looks());
    const you = await group('Needs you');
    const ha = await within(you).findByRole('article', { name: 'Zigbee stopped working in Home Assistant' });
    expect(within(ha).getByRole('img', { name: 'Neo' })).toBeTruthy();
    expect(buttons(ha)).toEqual(['Restart Zigbee', 'More for Zigbee stopped working in Home Assistant']);
    await user.click(within(ha).getByRole('button', { name: 'Restart Zigbee' }));
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${HA_LOOK_THREAD}`));
  });

  it('once Neo looked into it, Talk opens the look’s thread, where the whole story is', async () => {
    const user = userEvent.setup();
    const app = renderApp('/inbox', looks());
    const you = await group('Needs you');
    const unifi = await within(you).findByRole('article', { name: 'The hallway access point is offline' });
    await more(user, unifi, 'Talk to Neo about it');
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${UNIFI_LOOK_THREAD}`));
  });
});
