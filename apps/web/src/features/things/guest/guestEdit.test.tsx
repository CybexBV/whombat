/**
 * Guest editing on the web (proxmox-wa.md): a disk detached to an unused one and deleted with `confirm`, the guest
 * agent switched off with its other settings kept (PX-08), tags as chips, and high availability through its review,
 * against the fixture world (`fixtures-wa.ts`).
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { Providers } from '../../../app/providers';
import { fixtureServices } from '../../../test/renderApp';
import { ThingScreen } from '../ThingScreen';

const text = (el: Element | null) => (el?.textContent ?? '').replaceAll(' ', ' ');

function renderGuest(guest: string, gtab: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const thing = createRoute({
    getParentRoute: () => root,
    path: 'things/$thing',
    component: function Thing() {
      const { thing: id } = thing.useParams();
      return <ThingScreen burrow={burrow.slug} thing={id} />;
    },
  });
  const history = createMemoryHistory({
    initialEntries: [`/things/server%3Apve-02?guest=${encodeURIComponent(guest)}&gtab=${gtab}`],
  });
  render(
    <Providers services={fixtureServices({ hosts: true })}>
      <RouterProvider router={createRouter({ routeTree: root.addChildren([thing]), history })} />
    </Providers>,
  );
}

const review = async () => text(await screen.findByRole('list', { name: 'Changes' }));

describe('guest hardware', () => {
  it('detaches a disk to an unused one, then deletes it for good', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    renderGuest('pve:124', 'hardware');
    await user.click(await screen.findByRole('button', { name: 'More for scsi0' }, { timeout: 8000 }));
    await user.click(screen.getByRole('menuitem', { name: 'Detach…' }));
    expect(await review()).toBe('scsi0local-zfs:vm-124-disk-0,iothread=1,size=64G → removed');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Unused disk (unused2)')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete… unused2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete unused2?' });
    expect(text(dialog)).toContain('is destroyed with everything on it');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByText('Unused disk (unused2)')).toBeNull());
  });

  it('locks what only Proxmox changes', { timeout: 20_000 }, async () => {
    renderGuest('pve:132', 'hardware');
    const row = (await screen.findByText('Mount point (mp1)', {}, { timeout: 8000 })).parentElement;
    expect(text(row)).toContain('Change this in Proxmox');
    expect(screen.getByRole('button', { name: 'More for mp0' })).toBeTruthy();
  });
});

describe('guest options', () => {
  it('switches the guest agent off and keeps its other settings', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    renderGuest('pve:123', 'options');
    await user.click(await screen.findByRole('button', { name: 'Change guest agent' }, { timeout: 8000 }));
    await user.click(screen.getByRole('checkbox', { name: 'Use the guest agent' }));
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await review()).toBe('agent1,fstrim_cloned_disks=1 → 0,fstrim_cloned_disks=1');
  });

  it('adds and removes tags as chips', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    renderGuest('pve:118', 'options');
    await user.click(await screen.findByRole('button', { name: 'Change tags' }, { timeout: 8000 }));
    await user.type(screen.getByLabelText('Add a tag'), 'web{Enter}k3s');
    await user.click(screen.getByRole('button', { name: 'Remove tag prod' }));
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await review()).toBe('tagsprod → web;k3s');
  });

  it('changes high availability through a review', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    renderGuest('pve:118', 'options');
    await user.click(
      await screen.findByRole('button', { name: 'Change… high availability' }, { timeout: 8000 }),
    );
    await user.selectOptions(screen.getByLabelText('Keep it'), 'stopped');
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await review()).toBe('statestarted → stopped');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Saved high availability for arnica-prod-nest-01.')).toBeTruthy();
  });
});
