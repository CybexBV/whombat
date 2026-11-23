/**
 * The box's own address after it can change (Whombat own-address.md): Settings → ADDRESS's Change with the live check,
 * a refusal in plain words, the old address while it still works and Cloudflare's line; the banner at the old address
 * and its way to the new one; the passkeys section's prompt at the new address.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OWN_NAME_TEXT as N } from '@whombat/client/managed';
import { OperationError, type OwnAddressSummary } from '@whombat/client/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';

const DAY = 86_400_000;
const OLD = 'maple-otter-river.box.whombat.app';

const services = vi.hoisted(() => ({
  value: { session: {}, managed: { page: { kind: 'box', secure: true, host: null as string | null } } } as {
    session: object;
    managed: { page: { kind: 'box'; secure: boolean; host: string | null }; appliancePeerId?: string };
  },
}));
vi.mock('../../app/providers', () => ({ useAppServices: () => services.value }));

const ops = vi.hoisted(() => ({
  own: null as unknown,
  check: vi.fn(),
  rename: vi.fn(),
  linkCreate: vi.fn(),
  passkeys: vi.fn(),
  registerBegin: vi.fn(),
}));
vi.mock('@whombat/client/managed', async (original) => ({
  ...(await original<typeof import('@whombat/client/managed')>()),
  readOwnAddress: async () => ops.own,
  readReach: async () => ({ link: { state: 'on' } }),
  createBoxPasskey: async () => ops.registerBegin(),
}));
vi.mock('@whombat/client/session', async (original) => {
  const real = await original<typeof import('@whombat/client/session')>();
  return {
    ...real,
    sessionOps: {
      ...real.sessionOps,
      ownAddressCheck: ops.check,
      ownAddressRename: ops.rename,
      linkCreate: ops.linkCreate,
      passkeysList: ops.passkeys,
    },
  };
});
vi.mock('../../managed/passkeyEnv', () => ({ PASSKEYS: null, webAuthnExists: () => true }));

const { OwnAddressSection } = await import('./OwnAddressSection');
const { MovedBanner } = await import('../../managed/MovedBanner');
const { BoxPasskeysSection } = await import('../settings/BoxPasskeysSection');

function summary(host: string, leaving?: { host: string; days: number }): OwnAddressSummary {
  return {
    host,
    url: `https://${host}/`,
    state: 'ready',
    reachable: true,
    certificateEndsAt: new Date(Date.now() + 60 * DAY).toISOString(),
    watch: { lastCheckAt: new Date().toISOString(), missed: [], foreign: [] },
    ...(leaving && {
      leaving: {
        host: leaving.host,
        url: `https://${leaving.host}/`,
        until: new Date(Date.now() + leaving.days * DAY).toISOString(),
      },
    }),
  } as OwnAddressSummary;
}

const assign = vi.fn();
beforeEach(() => {
  vi.stubGlobal('location', { ...window.location, assign, hostname: 'localhost' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  services.value.managed.page.host = null;
});

describe('Settings → ADDRESS', () => {
  it('changes the address with a checked name; the old one shows with its last day', async () => {
    const user = userEvent.setup();
    ops.own = summary(OLD);
    ops.check.mockImplementation(async (_s: unknown, label: string) =>
      label === 'office'
        ? { label, verdict: 'taken' }
        : { label, verdict: 'free', host: `${label}.whombat.app` },
    );
    const renamed = summary('home.whombat.app', { host: OLD, days: 30 });
    // The box answers the new state, and says the same when asked again.
    ops.rename.mockImplementation(async () => {
      ops.own = renamed;
      return { ownAddress: renamed };
    });
    render(
      <ToastProvider>
        <OwnAddressSection />
      </ToastProvider>,
    );
    // Under box.whombat.app: Cloudflare's certificates don't cover it.
    expect(await screen.findByText(OLD)).toBeTruthy();
    expect(screen.queryByText(N.cloudflare)).toBeNull();
    await user.click(screen.getByRole('button', { name: N.change }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText(N.label);
    const change = within(dialog).getByRole('button', { name: N.changeAddress }) as HTMLButtonElement;
    expect(within(dialog).getByText(N.explain)).toBeTruthy();
    expect(within(dialog).getByText(N.privacy)).toBeTruthy();
    expect(change.disabled).toBe(true);
    // Its own name now: nothing to change, and the box isn't asked.
    await user.type(field, 'maple-otter-river');
    expect(await within(dialog).findByText(N.current)).toBeTruthy();
    await user.clear(field);
    await user.type(field, 'office');
    expect(await within(dialog).findByText(N.taken)).toBeTruthy();
    expect(change.disabled).toBe(true);
    await user.clear(field);
    await user.type(field, 'home');
    expect(await within(dialog).findByText(N.free('home.whombat.app'))).toBeTruthy();
    await user.click(change);
    expect(ops.rename).toHaveBeenCalledWith(expect.anything(), 'home');
    expect(ops.check).not.toHaveBeenCalledWith(expect.anything(), 'maple-otter-river');
    // The new state at once: the old address with its last day, and Cloudflare's line under whombat.app.
    const leaving = await vi.waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-row="leaving"]');
      if (!row) throw new Error('no leaving row yet');
      return row;
    });
    expect(leaving.textContent).toContain(OLD);
    expect(screen.getByText(N.cloudflare)).toBeTruthy();
    expect(screen.getByText('home.whombat.app')).toBeTruthy();
  });

  it('says a refusal in plain words', async () => {
    const user = userEvent.setup();
    ops.own = summary('home.whombat.app');
    ops.check.mockResolvedValue({ label: 'cottage', verdict: 'free', host: 'cottage.whombat.app' });
    ops.rename.mockRejectedValue(
      new OperationError('ownAddress.rename', 429, 'rate_limited', 'Too many.', { code: 'rename_limit' }),
    );
    render(
      <ToastProvider>
        <OwnAddressSection />
      </ToastProvider>,
    );
    await user.click(await screen.findByRole('button', { name: N.change }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(N.label), 'cottage');
    await within(dialog).findByText(N.free('cottage.whombat.app'));
    await user.click(within(dialog).getByRole('button', { name: N.changeAddress }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(N.errors.rename_limit);
  });
});

describe('the banner at the old address', () => {
  it('says where it moved and goes there with a device link for this account', async () => {
    const user = userEvent.setup();
    ops.own = summary('home.whombat.app', { host: OLD, days: 30 });
    const link = `https://home.whombat.app/add-device#s=${'A'.repeat(32)}&p=12D3KooWQ3BpNQUAmF3wTbNsGDk2RJhC9k1H7rpu97Vb2Q6hRfmQ&o=https://home.whombat.app/`;
    ops.linkCreate.mockResolvedValue({ link });
    services.value.managed.page.host = OLD;
    render(<MovedBanner />);
    const banner = await screen.findByTestId('own-address-moved');
    expect(banner.textContent).toContain('home.whombat.app');
    await user.click(within(banner).getByRole('button', { name: N.go }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(link));
  });

  it('isn’t shown at the new address', async () => {
    ops.own = summary('home.whombat.app', { host: OLD, days: 30 });
    services.value.managed.page.host = 'home.whombat.app';
    render(<MovedBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('own-address-moved')).toBeNull();
  });
});

describe('passkeys after the address changed', () => {
  const passkey = (rpId: string) => ({
    id: `pk-${rpId}`,
    name: 'Chrome on this Mac',
    accountId: 'acc_mara',
    personName: 'Mara',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    synced: true,
    current: false,
    rpId,
  });

  it('asks for a passkey for the new address while all are for the old one', async () => {
    const own = summary('home.whombat.app', { host: OLD, days: 30 });
    ops.passkeys.mockResolvedValue({ passkeys: [passkey(OLD)], policy: { deviceBoundOnly: false } });
    services.value.managed.page.host = 'home.whombat.app';
    render(
      <ToastProvider>
        <BoxPasskeysSection own={own} />
      </ToastProvider>,
    );
    expect(await screen.findByText(N.passkeyNew)).toBeTruthy();
  });

  it('at the old address the box makes none: the way to the new one instead', async () => {
    const user = userEvent.setup();
    const own = summary('home.whombat.app', { host: OLD, days: 30 });
    ops.passkeys.mockResolvedValue({ passkeys: [], policy: { deviceBoundOnly: false } });
    ops.registerBegin.mockRejectedValue(
      new OperationError('boxPasskey.register.begin', 409, 'conflict', 'Moved.', {
        code: 'address_moved',
        host: 'home.whombat.app',
      }),
    );
    ops.linkCreate.mockRejectedValue(new Error('no link'));
    // The page counts as the current address here, so Add a passkey is offered; the box answers it moved.
    services.value.managed.page.host = 'home.whombat.app';
    services.value.managed.appliancePeerId = 'peer';
    render(
      <ToastProvider>
        <BoxPasskeysSection own={own} />
      </ToastProvider>,
    );
    const add = await screen.findByRole('button', { name: 'Add a passkey' });
    await vi.waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    await user.click(add);
    await user.click(await screen.findByRole('button', { name: N.go }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://home.whombat.app/'));
  });
});
