/**
 * Settings' home says how things are where it can (docs/decisions/settings-phone-link.md): This Whombat's row names what
 * needs you there, the Phone app row which phone is signed in. Notifications starts with this browser.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { SETTINGS_HOME_TEXT } from '@whombat/client';
import { DESK_TEXT, type DeskUnlockRequest } from '@whombat/client/desk';
import { THIS_WHOMBAT_TEXT } from '@whombat/client/managed';
import { type ApplianceStatus, sessionOps } from '@whombat/client/session';
import type { EndpointSummary } from '@whombat/protocol/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../../app/services';
import { fixtureServices, renderApp } from '../../test/renderApp';

/** The screen asking to unlock, when a test says so. */
const desk = vi.hoisted(() => ({ request: null as DeskUnlockRequest | null }));
vi.mock('../desk/useDeskHere', async (original) => {
  const actual = await original<typeof import('../desk/useDeskHere')>();
  return {
    ...actual,
    useDeskUnlockHere: (burrow: string) => {
      const real = actual.useDeskUnlockHere(burrow);
      return desk.request ? { ...real, request: desk.request } : real;
    },
  };
});

/** A box whose backups aren't set up. */
const status = {
  backup: { state: 'unprotected', lastSuccessAt: null, lastFailure: null },
  recovery: { kitVerified: true, rotationPending: false },
  update: null,
} as unknown as ApplianceStatus;

const endpoint = (label: string, platform: EndpointSummary['platform'], revoked = false) =>
  ({ label, platform, revocation: revoked ? 'applied' : 'none' }) as EndpointSummary;

const managed = (): AppServices => ({
  ...fixtureServices({}),
  managed: {} as NonNullable<AppServices['managed']>,
});

afterEach(() => {
  vi.restoreAllMocks();
  desk.request = null;
});

const row = (selector: string) => document.querySelector(selector) as HTMLElement;
const protectedStatus = { ...status, backup: { ...status.backup, state: 'protected' } } as ApplianceStatus;

describe('Settings’ home on a box', () => {
  it('names what needs you on This Whombat’s row and the phone that is signed in', async () => {
    vi.spyOn(sessionOps, 'applianceStatus').mockResolvedValue(status);
    vi.spyOn(sessionOps, 'endpointsList').mockResolvedValue({
      endpoints: [
        endpoint('Chrome on Windows', 'web'),
        endpoint('Pixel 9', 'android'),
        endpoint('Old iPhone', 'ios', true),
      ],
    });
    renderApp('/settings', managed());
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    const whombat = document.querySelector('[data-settings-group="appliance"]') as HTMLElement;
    expect(await within(whombat).findByText(THIS_WHOMBAT_TEXT.backupsOff)).toBeTruthy();
    const phone = document.querySelector('[data-settings-row="phone-app"]') as HTMLElement;
    expect(await within(phone).findByText(SETTINGS_HOME_TEXT.phoneApp.signedIn(['Pixel 9']))).toBeTruthy();
  });

  it('keeps This Whombat’s own line when nothing needs you, and offers the code while no phone is in', async () => {
    vi.spyOn(sessionOps, 'applianceStatus').mockResolvedValue(protectedStatus);
    vi.spyOn(sessionOps, 'endpointsList').mockResolvedValue({
      endpoints: [endpoint('Chrome on Windows', 'web')],
    });
    renderApp('/settings', managed());
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    const whombat = row('[data-settings-group="appliance"]');
    await waitFor(() => expect(whombat.textContent).toContain('How it’s doing · Network · Backups · About'));
    // Its parts don't break inside: “What Neo may do” is one piece.
    const agent = row('[data-settings-group="agent"]');
    expect([...agent.querySelectorAll('span span')].map((s) => s.textContent)).toContain(
      `What ${agent.querySelector('[class*="name"]')?.textContent} may do ·`,
    );
    expect(within(whombat).queryByText(THIS_WHOMBAT_TEXT.backupsOff)).toBeNull();
    const phone = row('[data-settings-row="phone-app"]');
    expect(await within(phone).findByText(SETTINGS_HOME_TEXT.phoneApp.line(true))).toBeTruthy();
    expect(within(phone).getByText(SETTINGS_HOME_TEXT.phoneApp.lineHere)).toBeTruthy();
  });
});

describe('Settings’ home while it asks', () => {
  it('says nothing on those two rows until the box answers, then says it once', async () => {
    let answer: (s: ApplianceStatus) => void = () => {};
    vi.spyOn(sessionOps, 'applianceStatus').mockReturnValue(new Promise((resolve) => (answer = resolve)));
    let phones: (r: { endpoints: EndpointSummary[] }) => void = () => {};
    vi.spyOn(sessionOps, 'endpointsList').mockReturnValue(new Promise((resolve) => (phones = resolve)));
    renderApp('/settings', managed());
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    const whombat = row('[data-settings-group="appliance"]');
    const phone = row('[data-settings-row="phone-app"]');
    expect(whombat.textContent).not.toContain('Backups');
    expect(phone.textContent).not.toContain(SETTINGS_HOME_TEXT.phoneApp.line(true));
    answer(status);
    phones({ endpoints: [endpoint('Pixel 9', 'android')] });
    expect(await within(whombat).findByText(THIS_WHOMBAT_TEXT.backupsOff)).toBeTruthy();
    expect(await within(phone).findByText(SETTINGS_HOME_TEXT.phoneApp.signedIn(['Pixel 9']))).toBeTruthy();
  });

  it('offers the code when the phones can’t be read', async () => {
    vi.spyOn(sessionOps, 'applianceStatus').mockResolvedValue(protectedStatus);
    vi.spyOn(sessionOps, 'endpointsList').mockRejectedValue(new Error('offline'));
    renderApp('/settings', managed());
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    // It asks once more first.
    const phone = row('[data-settings-row="phone-app"]');
    expect(
      await within(phone).findByText(SETTINGS_HOME_TEXT.phoneApp.line(true), {}, { timeout: 4_000 }),
    ).toBeTruthy();
  });

  it('counts the screen asking to unlock first, as the Overview does', async () => {
    desk.request = { secondsLeft: 40 } as DeskUnlockRequest;
    vi.spyOn(sessionOps, 'applianceStatus').mockResolvedValue(status);
    vi.spyOn(sessionOps, 'endpointsList').mockResolvedValue({ endpoints: [] });
    renderApp('/settings', managed());
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    const whombat = row('[data-settings-group="appliance"]');
    expect(
      await within(whombat).findByText(SETTINGS_HOME_TEXT.needsYou(DESK_TEXT.unlock.title, 1)),
    ).toBeTruthy();
  });
});

describe('Settings → Notifications', () => {
  it('starts with whether this browser can notify you', async () => {
    renderApp('/settings?part=notifications', fixtureServices());
    const browser = await screen.findByRole('region', { name: 'THIS BROWSER' });
    const dnd = screen.getByRole('region', { name: 'DO NOT DISTURB' });
    expect(browser.compareDocumentPosition(dnd) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
