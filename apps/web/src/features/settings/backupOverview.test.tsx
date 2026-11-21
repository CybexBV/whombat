/**
 * Settings → This Whombat → Backups (app backup-options.md AP-6800…, backup-v2.md AP-6880…), in the fixture world: the
 * top card with the settings as chips and whether it can be brought back, Back up now saying “Backed up just now” once
 * it is made, the older backups still on the box with Move and Remove, the list with Show all and one backup's page with
 * what's in it and its check, Details, the options dialog's Save, the same page while the backup service isn't
 * answering, the line about older backups on a place used before, and a box from before showing only what it showed
 * before. Words come from the shared text, so rewording doesn't mean editing these.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { earlierPlacesLine, BACKUP_OPTIONS_TEXT as T } from '@whombat/client/managed';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

const PATH = '/settings?tab=appliance&section=backups';
const hero = () => screen.findByRole('region', { name: T.backedUp('2 hours ago') }, { timeout: 5000 });
const list = () => document.querySelector('[data-backup-list]') as HTMLElement;
const rows = () => list().querySelectorAll('[data-backup]').length;

describe('Backups', () => {
  it('answers “am I safe?” in the top card, with the settings as chips and the way back', async () => {
    renderApp(PATH, fixtureServices());
    const card = await hero();
    expect(card.getAttribute('data-state')).toBe('ok');
    expect(within(card).getByText(/^On blackbox · next one at \d\d:00 · the oldest is from/)).toBeTruthy();
    const chips = within(card).getByRole('list', { name: T.chipsLabel });
    for (const chip of [T.chips.frequency['6h'], T.chips.keptYear])
      expect(within(chips).getByText(chip)).toBeTruthy();
    expect(within(chips).getByText(/^Checked \w+/)).toBeTruthy();
    expect(within(chips).getByText(/6\.2\sGB used · 1\.9\sTB free/)).toBeTruthy();
    // “Can be brought back” is part of being backed up; no passkey ask while a passkey holds the key.
    expect(within(card).getByText(T.wayBack.ready)).toBeTruthy();
    expect(card.querySelector('[data-backup-passkey]')).toBeNull();
    expect(within(card).queryByRole('button', { name: /to fix it$/ })).toBeNull();
  });

  it('says “Backed up just now” once Back up now made the backup', async () => {
    const user = userEvent.setup();
    renderApp(PATH, fixtureServices());
    const card = await hero();
    await user.click(within(card).getByRole('button', { name: T.backUpNow }));
    expect(await screen.findByRole('region', { name: T.running })).toBeTruthy();
    const done = await screen.findByRole('region', { name: T.justNow }, { timeout: 5000 });
    expect(done.getAttribute('data-state')).toBe('justNow');
  });

  it('lists the first backups by day, Show all the rest, and opens one with what’s in it', async () => {
    const user = userEvent.setup();
    renderApp(PATH, fixtureServices());
    await hero();
    expect(rows()).toBe(9);
    expect(within(list()).getByText('Before the update to 0.198')).toBeTruthy();
    await user.click(within(list()).getByRole('button', { name: /^Show all \d+$/ }));
    expect(rows()).toBeGreaterThan(9);
    expect(within(list()).getByText('First backup')).toBeTruthy();
    expect(within(list()).getAllByText(`✓ ${T.list.checkedOk}`).length).toBe(1);
    // The one that left an attachment out says so in the list and on its page.
    const gap = within(list()).getByText(T.list.leftOut).closest('[data-backup]') as HTMLElement;
    await user.click(gap);
    const page = await screen.findByRole('dialog');
    expect(page.querySelector('[data-line="files"][data-gap]')).toBeTruthy();
    expect(within(page).getByText(T.detail.lines.filesMissing(1))).toBeTruthy();
    expect(within(page).getByText(T.detail.lines.voices)).toBeTruthy();
    expect(within(page).getByText(T.detail.lines.voicesNote)).toBeTruthy();
    // No servers on this box: no servers' line.
    expect(page.querySelector('[data-line="servers"]')).toBeNull();
    await user.click(within(page).getByRole('button', { name: T.detail.checkNow }));
    expect(await within(page).findByText(T.detail.checkQueued)).toBeTruthy();
    expect(within(page).queryByRole('button', { name: /as files/ })).toBeNull();
  });

  it('keeps who clears, the place and checking the newest behind Details', async () => {
    const user = userEvent.setup();
    renderApp(PATH, fixtureServices());
    await hero();
    const details = document.querySelector('[data-backup-details]') as HTMLElement;
    expect(within(details).queryByText(T.details.noDelete, { exact: false })).toBeNull();
    await user.click(within(details).getByRole('button', { name: T.details.show }));
    expect(within(details).getByText(T.details.where('blackbox'))).toBeTruthy();
    expect(within(details).getByText(T.details.clears.place('blackbox'))).toBeTruthy();
    expect(within(details).getByText(`${T.details.noDelete}.`)).toBeTruthy();
    await user.click(within(details).getByRole('button', { name: T.details.checkNewest }));
    expect(await within(details).findByText(T.detail.checkQueued)).toBeTruthy();
  });

  it('removes the older backups on this Whombat after its confirm', async () => {
    const user = userEvent.setup();
    renderApp(PATH, fixtureServices());
    await hero();
    const needs = document.querySelector('[data-needs="local"]') as HTMLElement;
    expect(within(needs).getByText(T.local.title(14))).toBeTruthy();
    expect(within(needs).getByRole('button', { name: T.local.move('blackbox') })).toBeTruthy();
    await user.click(within(needs).getByRole('button', { name: T.local.remove }));
    const confirm = await screen.findByRole('dialog', { name: T.local.removeTitle });
    await user.click(within(confirm).getByRole('button', { name: T.local.removeConfirm }));
    await waitFor(() => expect(document.querySelector('[data-needs="local"]')).toBeNull());
  });

  it('saves the options all at once, and the card says them', async () => {
    const user = userEvent.setup();
    renderApp(PATH, fixtureServices());
    const card = await hero();
    await user.click(within(card).getByRole('button', { name: T.options }));
    const dialog = await screen.findByRole('dialog', { name: T.dialog.title });
    expect(within(dialog).getByText(/^Backups are kept up to a year\./)).toBeTruthy();
    // The limit off says the place's real free space.
    expect(within(dialog).getByText(/^Off\. blackbox has 1\.9\sTB free\.$/)).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: T.dialog.frequency.hourly }));
    expect(within(dialog).getByText(T.dialog.frequencyHint.hourly)).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: /^Everything for 90 days/ }));
    expect(within(dialog).getByText(/^Backups are kept 90 days\./)).toBeTruthy();
    await user.click(within(dialog).getByRole('switch', { name: T.dialog.limit }));
    expect(within(dialog).getByText(/^Use at most 50\sGB/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: T.dialog.save }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await within(card).findByText(T.chips.frequency.hourly)).toBeTruthy();
    expect(within(card).getByText(T.chips.kept90)).toBeTruthy();
  });

  it('stays on this page while the backup service isn’t answering, says so and offers Ask to fix it', async () => {
    renderApp(PATH, fixtureServices({ backupFake: { serviceDown: true } }));
    await waitFor(() => expect(document.querySelector('[data-backup-hero]')).toBeTruthy(), { timeout: 5000 });
    const card = document.querySelector('[data-backup-hero]') as HTMLElement;
    expect(card.getAttribute('data-state')).toBe('unknown');
    expect(within(card).getByText(/backup service isn’t answering/)).toBeTruthy();
    expect(within(card).getByRole('button', { name: /to fix it$/ })).toBeTruthy();
    // Nothing it doesn't know: no empty list, no options without the options.
    expect(document.querySelector('[data-backup-list]')).toBeNull();
    expect(within(card).queryByRole('button', { name: T.options })).toBeNull();
  });

  it('says where the older backups are when they were made on another place', async () => {
    const earlierPlaces = [{ placeId: 'connection:con_attic', name: 'Attic' }];
    renderApp(PATH, fixtureServices({ backupFake: { earlierPlaces } }));
    await hero();
    const line = list().querySelector('[data-backup-earlier]');
    expect(line?.textContent).toBe(earlierPlacesLine(earlierPlaces));
  });

  it('says nothing about other places when there were none', async () => {
    renderApp(PATH, fixtureServices());
    await hero();
    expect(list().querySelector('[data-backup-earlier]')).toBeNull();
  });

  it('shows what it showed before on a box from before', async () => {
    renderApp(PATH, fixtureServices({ backupOptions: false }));
    await screen.findByRole('heading', { name: 'On your network' }, { timeout: 5000 });
    expect(document.querySelector('[data-backup-hero]')).toBeNull();
    expect(document.querySelector('[data-backup-list]')).toBeNull();
  });
});
