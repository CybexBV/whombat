import { screen, waitFor } from '@testing-library/react';
import { BURROW_ROUTES } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import type { Membership } from '@whombat/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { MOBILE_TEXT } from '../features/mobile/copy';
import { fixtureServices, renderApp } from '../test/renderApp';
import { routeTree } from './router';

/** The screen in <main> (queried from the DOM: an open modal hides the page from the a11y tree). */
async function screenId(): Promise<string | null> {
  let id: string | null = null;
  await waitFor(() => {
    id = document.querySelector('main [data-screen]')?.getAttribute('data-screen') ?? null;
    expect(id).not.toBeNull();
  });
  return id;
}

const membership = (slug: string, name: string): Membership => ({
  burrowId: `bur_${slug}`,
  burrowSlug: slug,
  burrowName: name,
  principalId: `prn_mara_${slug}`,
});
const HQ = membership('burrow-hq', 'Burrow HQ');
const SIDE = membership('side-quest', 'Side Quest');

/** Whether the bootstrap of `slug` was loaded (the fixtures answer for any burrow, so the cache tells them apart). */
function loaded(services: ReturnType<typeof fixtureServices>, slug: string): boolean {
  return (
    services.queryClient.getQueryData(queryKeys.conversations.bootstrap({ params: { burrow: slug } })) !==
    undefined
  );
}

describe('routing', () => {
  it.each([
    ['/pr/482', 'branch', 'feat/invoice-pdf'],
    ['/runs/1907', 'run', 'Address review on PR #482'],
    ['/canvases', 'canvases', 'Canvases'],
    ['/canvases/invoice-pdf-export-plan', 'canvas', 'Invoice PDF export'],
    ['/log', 'log', 'Audit log'],
    ['/search', 'search', 'Search'],
  ])('deep link %s opens the %s screen', async (url, screenName, title) => {
    const app = renderApp(url);
    expect(await screen.findByRole('heading', { name: title, level: 1 })).toBeTruthy();
    expect(await screenId()).toBe(screenName);
    expect(app.location()).toBe(url);
  });

  it('opens Chat at / (chat-channel.md AP-2401; one shell, one-agent.md AP-4920)', async () => {
    const app = renderApp('/');
    await waitFor(() => expect(app.location()).toBe('/chat'));
  });

  it.each([
    ['/settings/agent', '/settings?tab=agent'],
    ['/settings/agent?part=keys&key=deploy', '/settings?tab=agent&part=may&key=deploy'],
    ['/settings?tab=agent&part=skills', '/settings?tab=advanced&part=skills'],
    ['/settings/agent?part=skills', '/settings?tab=advanced&part=skills'],
    ['/skills', '/settings?tab=advanced&part=skills'],
  ])('opens the agent’s address %s at %s (AP-4922, AP-4923, AP-5530)', async (url, to) => {
    const app = renderApp(url);
    await waitFor(() => expect(app.location()).toBe(to));
  });

  it.each(['/agents', '/agents/dusty/settings', '/c/general', '/direct/cnv_x'])(
    'has no %s any more: Not found (AP-4922)',
    async (url) => {
      renderApp(url);
      expect(await screen.findByRole('heading', { name: 'Nothing lives here' })).toBeTruthy();
    },
  );

  it('renders the mobile info page without signing in', async () => {
    renderApp('/mobile', fixtureServices({ signedIn: false }));
    expect(await screen.findByRole('heading', { name: MOBILE_TEXT.title })).toBeTruthy();
  });

  // The brand page is a lazy route with every mark: its first transform in a full run takes longer than 5 s.
  it('renders the brand page without signing in', { timeout: 30_000 }, async () => {
    renderApp('/brand', fixtureServices({ signedIn: false }));
    expect(
      await screen.findByRole('heading', { name: 'The Whombat logo' }, { timeout: 25_000 }),
    ).toBeTruthy();
  });

  it('declares exactly the burrow routes the shared path rules know (BURROW_ROUTES)', () => {
    type Node = { id: string; fullPath: string; children?: Node[] | Record<string, Node> };
    const kids = (n: Node): Node[] => (n.children ? Object.values(n.children) : []);
    const layout = kids(routeTree as unknown as Node).find((r) => r.id === '/_burrow');
    expect(layout).toBeTruthy();
    const paths = new Set<string>();
    const walk = (n: Node) => {
      const children = kids(n);
      if (!children.length) paths.add(n.fullPath.length > 1 ? n.fullPath.replace(/\/$/, '') : n.fullPath);
      children.forEach(walk);
    };
    walk(layout as Node);
    expect([...paths].sort()).toEqual([...BURROW_ROUTES].sort());
  });
});

describe('burrow-less URLs (AP-360…AP-363)', () => {
  // The remembered burrow lives in this browser's storage: each test starts without one.
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('turns an old /<burrow>/… link into the new form, search and hash kept, in place of the old entry', async () => {
    const services = fixtureServices();
    const app = renderApp('/burrow-hq/pr/482?thread=m1#msg_x', services);
    expect(await screenId()).toBe('branch');
    await waitFor(() => expect(app.location()).toBe('/pr/482?thread=m1'));
    expect(app.history.location.hash).toBe('#msg_x');
    // Replaced, not pushed: Back doesn't return to the old address.
    expect(app.history.length).toBe(1);
    expect(services.burrowMemory.get()).toBe('burrow-hq');
  });

  it.each([
    ['/burrow-hq', /^\/chat$/],
    ['/burrow-hq/settings/agent?part=keys', /^\/settings\?tab=agent&part=may$/],
    ['/burrow-hq/settings?tab=agent&part=may', /^\/settings\?tab=agent&part=may$/],
    ['/burrow-hq/settings?tab=profile', /^\/settings\?part=profile$/],
  ])('opens %s burrow-less', async (url, expected) => {
    const app = renderApp(url);
    await waitFor(() => expect(app.location()).toMatch(expected));
  });

  it('switches to the burrow an old link names, when the person belongs to it', async () => {
    const services = fixtureServices({ memberships: [HQ, SIDE] });
    const app = renderApp('/side-quest/canvases', services);
    expect(await screenId()).toBe('canvases');
    await waitFor(() => expect(app.location()).toBe('/canvases'));
    expect(services.burrowMemory.get()).toBe('side-quest');
    await waitFor(() => expect(loaded(services, 'side-quest')).toBe(true));
  });

  it('switches with ?burrow= and takes it out of the address', async () => {
    const services = fixtureServices({ memberships: [HQ, SIDE] });
    const app = renderApp('/settings?tab=agent&burrow=side-quest', services);
    await waitFor(() => expect(app.location()).toBe('/settings?tab=agent'));
    expect(services.burrowMemory.get()).toBe('side-quest');
    await waitFor(() => expect(loaded(services, 'side-quest')).toBe(true));
  });

  it('opens the remembered burrow, and the first one when it is gone', async () => {
    const services = fixtureServices({ memberships: [HQ, SIDE] });
    services.burrowMemory.set('side-quest');
    renderApp('/canvases', services);
    await waitFor(() => expect(loaded(services, 'side-quest')).toBe(true));

    const again = fixtureServices({ memberships: [HQ] });
    again.burrowMemory.set('gone-burrow');
    renderApp('/canvases', again);
    await waitFor(() => expect(loaded(again, 'burrow-hq')).toBe(true));
    // The gone one is forgotten; the one opened is remembered (open-speed.md AP-4404).
    expect(again.burrowMemory.get()).toBe('burrow-hq');
  });

  it('shows Not found for an old link to a burrow the person isn’t in', async () => {
    const services = fixtureServices();
    renderApp('/elsewhere/chat', services);
    expect(await screen.findByRole('heading', { name: 'Nothing lives here' })).toBeTruthy();
    expect(services.burrowMemory.get()).toBeNull();
  });

  it('shows Not found for ?burrow= of a burrow the person isn’t in', async () => {
    renderApp('/canvases?burrow=elsewhere');
    expect(await screen.findByRole('heading', { name: 'Nothing lives here' })).toBeTruthy();
  });

  it('shows Not found for a path that is neither form', async () => {
    renderApp('/burrow-hq/chat/more/than');
    expect(await screen.findByRole('heading', { name: 'Nothing lives here' })).toBeTruthy();
  });

  it('reads a route name first as the screen, and as a burrow only when the rest needs one (AP-362)', async () => {
    const inbox = membership('inbox', 'Inbox');
    const services = fixtureServices({ memberships: [HQ, inbox] });
    const app = renderApp('/inbox', services);
    expect(await screenId()).toBe('inbox');
    expect(app.location()).toBe('/inbox');
    // The burrow it opened, not one called “inbox” (AP-4404).
    expect(services.burrowMemory.get()).toBe('burrow-hq');

    const other = fixtureServices({ memberships: [HQ, inbox] });
    const old = renderApp('/inbox/canvases', other);
    await waitFor(() => expect(old.location()).toBe('/canvases'));
    expect(other.burrowMemory.get()).toBe('inbox');
  });

  it.each([
    ['/work', '/inbox', 'inbox'],
    ['/work?section=needs_you', '/inbox', 'inbox'],
    ['/work?section=failed', '/inbox', 'inbox'],
    ['/work/deploys', '/deploys', 'deploys'],
    ['/burrow-hq/work?section=needs_you', '/inbox', 'inbox'],
  ])('sends the Work view’s old address %s to %s (AP-851)', async (url, to, screenName) => {
    const app = renderApp(url);
    await waitFor(() => expect(app.location()).toBe(to));
    expect(await screenId()).toBe(screenName);
  });
});
