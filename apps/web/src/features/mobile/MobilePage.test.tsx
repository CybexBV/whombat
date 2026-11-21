import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type AndroidDownload,
  PHONE_HANDOFF_POLL_MS,
  type PhoneHandoffView,
  parsePhoneSignInLink,
  phoneHandoffMac,
} from '@whombat/client/managed';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobilePage } from './MobilePage';
import { appLink, PhoneLinkPage, PublicMobilePage, takePhoneLink } from './PhoneLinkPage';
import type { PhoneSignInDeps } from './usePhoneSignIn';

const ORIGIN = 'https://app.whombat.com';
const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const FP = 'AB12-CD34-EF56';
const APK: AndroidDownload = {
  version: '0.16.0',
  versionCode: 16000,
  size: 41_234_567,
  sha256: 'a'.repeat(64),
  publishedAt: '2026-09-30T12:00:00.000Z',
  url: 'https://api.whombat.com/v1/downloads/android/whombat-0.16.0.apk',
};

/** A control and a Whombat that answer like the real ones; `report` is what the phone sends back. */
function world(options: { phoneFingerprint?: string; forge?: boolean } = {}) {
  let view: Omit<PhoneHandoffView, 'handoffId' | 'expiresAt'> = { state: 'waiting', report: null };
  let n = 0;
  const control = {
    createPhoneHandoff: vi.fn(async () => {
      n++;
      view = { state: 'waiting', report: null };
      return {
        handoffId: `ph_handoff_${n}`,
        token: `token_token_token_token_${n}`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    }),
    phoneHandoff: vi.fn(async (handoffId: string) => ({
      handoffId,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      ...view,
    })),
  };
  const approve = vi.fn(async () => {});
  const lookup = vi.fn(async () => ({
    label: 'Pixel 9',
    platform: 'android',
    fingerprint: options.phoneFingerprint ?? FP,
  }));
  const deps: PhoneSignInDeps = {
    control,
    origin: ORIGIN,
    appliance: { device: 'wmb_0001', peerId: PEER, lookup, approve },
  };
  return {
    deps,
    control,
    lookup,
    approve,
    scan: () => {
      view = { state: 'scanned', report: null };
    },
    report: (key: string) => {
      const handoffId = `ph_handoff_${n}`;
      const code = '1234-5678';
      const macKey = options.forge ? 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' : key;
      view = {
        state: 'ready',
        report: { kind: 'pairing', code, fingerprint: FP, mac: phoneHandoffMac(macKey, handoffId, code, FP) },
      };
    },
  };
}

function renderPage(deps: PhoneSignInDeps | null, download: AndroidDownload | null = APK) {
  return render(
    <MobilePage
      signIn={deps}
      whombatName="Burrow HQ"
      loadDownload={() => Promise.resolve(download)}
      back={<a href="/">Back</a>}
    />,
  );
}

const tick = () => act(() => vi.advanceTimersByTimeAsync(PHONE_HANDOFF_POLL_MS + 10));

describe('the Mobile app page (AP-521…AP-525)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the QR code, a countdown and the download', async () => {
    const w = world();
    renderPage(w.deps);
    expect(
      await screen.findByRole('img', { name: 'QR code that signs your phone in to Whombat' }),
    ).toBeTruthy();
    expect(screen.getByTestId('phone-qr-countdown').textContent).toMatch(/^New code in [45]:\d\d$/);
    expect(screen.getByText('It signs your phone in as you and asks Burrow HQ to let it in.')).toBeTruthy();
    expect(await screen.findByText('41 MB · Updates itself')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Download for Android' });
    expect(link.getAttribute('href')).toBe(APK.url);
    expect(link.hasAttribute('download')).toBe(true);
    expect(w.control.createPhoneHandoff).toHaveBeenCalledTimes(1);
  });

  it('scanned → confirm → “Let it in” approves with the looked-up fingerprint', async () => {
    const w = world();
    const probe = withLinkProbe(w.deps);
    renderPage(probe.deps);
    await screen.findByRole('img', { name: /QR code/ });
    w.scan();
    await tick();
    expect(await screen.findByText('Your phone scanned the code')).toBeTruthy();
    expect(screen.getByText('Waiting for it to ask Burrow HQ…')).toBeTruthy();
    // Installed and scanned are done; letting it in is still to come.
    const steps = within(screen.getByTestId('phone-signin')).getAllByRole('listitem');
    expect(steps.map((li) => li.querySelector('svg') !== null)).toEqual([true, true, false]);
    expect(steps[2]?.textContent).toContain('Let it in here');
    expect(screen.queryByText('Point your phone at this code')).toBeNull();
    w.report(probe.key());
    await tick();
    expect(await screen.findByRole('heading', { name: 'Let Pixel 9 in?' })).toBeTruthy();
    expect(w.lookup).toHaveBeenCalledWith('1234-5678');
    expect(screen.getByTestId('phone-confirm-fingerprint').textContent).toBe(FP);
    expect(screen.getByTestId('phone-confirm-platform').textContent).toBe('Android phone');
    expect(w.approve).not.toHaveBeenCalled();
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole('button', { name: 'Let it in' }));
    expect(await screen.findByRole('heading', { name: 'Pixel 9 is in' })).toBeTruthy();
    expect(w.approve).toHaveBeenCalledTimes(1);
    expect(w.approve).toHaveBeenCalledWith({ code: '1234-5678', approve: true, fingerprint: FP });
  });

  it('a report with a wrong MAC is never looked up or approved', async () => {
    const w = world({ forge: true });
    const probe = withLinkProbe(w.deps);
    renderPage(probe.deps);
    await screen.findByRole('img', { name: /QR code/ });
    w.report(probe.key());
    await tick();
    expect(await screen.findAllByText(/^That answer didn’t come from the phone/)).not.toHaveLength(0);
    await waitFor(() => expect(w.control.createPhoneHandoff).toHaveBeenCalledTimes(2));
    expect(w.lookup).not.toHaveBeenCalled();
    expect(w.approve).not.toHaveBeenCalled();
  });

  it('a Whombat that names another device than the phone reported is never approved', async () => {
    const w = world({ phoneFingerprint: '9999-9999-9999' });
    const probe = withLinkProbe(w.deps);
    renderPage(probe.deps);
    await screen.findByRole('img', { name: /QR code/ });
    w.report(probe.key());
    await tick();
    await waitFor(() => expect(w.lookup).toHaveBeenCalled());
    expect(await screen.findAllByText(/^That answer didn’t come from the phone/)).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Let it in' })).toBeNull();
    expect(w.approve).not.toHaveBeenCalled();
  });

  it('makes no code while the tab is hidden, and one when it shows', async () => {
    const w = world();
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderPage(w.deps);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(w.control.createPhoneHandoff).not.toHaveBeenCalled();
    hidden.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByRole('img', { name: /QR code/ })).toBeTruthy();
    expect(w.control.createPhoneHandoff).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
  });

  it('refreshes the code when its token runs out', async () => {
    const w = world();
    renderPage(w.deps);
    await screen.findByRole('img', { name: /QR code/ });
    await act(() => vi.advanceTimersByTimeAsync(301_000));
    await waitFor(() => expect(w.control.createPhoneHandoff).toHaveBeenCalledTimes(2));
  });

  it('self-hosted: no QR code, the email note and the download; none published says so', async () => {
    renderPage(null, null);
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    expect(
      screen.getByText('On this server, the app signs in with your email, like this browser did.'),
    ).toBeTruthy();
    expect(
      await screen.findByText('The Android app isn’t published here yet. Check back soon.'),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Download for Android' })).toBeNull();
  });

  it('no Android app published: step 1 doesn’t promise a download; the iPhone row asks for an invite', async () => {
    const w = world();
    renderPage(w.deps, null);
    await screen.findByRole('img', { name: /QR code/ });
    expect(await screen.findByText(/^The Android app isn’t published here yet\. On an iPhone/)).toBeTruthy();
    expect(screen.queryByText(/it opens the download/)).toBeNull();
    const invite = screen.getByRole('link', { name: 'Ask for an invite' });
    expect(invite.getAttribute('href')).toMatch(/^mailto:info@whombat\.com\?subject=/);
  });

  it('a failed check for the app offers Try again, which asks again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(APK);
    render(<MobilePage signIn={null} whombatName={null} loadDownload={load} back={null} />);
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Download for Android' })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('no code: the card says why with Try again, and no steps that need a code', async () => {
    const w = world();
    w.control.createPhoneHandoff.mockRejectedValueOnce(new Error('offline'));
    renderPage(w.deps);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No code right now');
    expect(alert.textContent).toContain('Couldn’t reach Whombat’s service');
    expect(screen.queryByText('Scan to sign in')).toBeNull();
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: /QR code/ })).toBeTruthy();
  });

  it('a refused answer heads the card, over the new code', async () => {
    const w = world({ forge: true });
    const probe = withLinkProbe(w.deps);
    renderPage(probe.deps);
    await screen.findByRole('img', { name: /QR code/ });
    w.report(probe.key());
    await tick();
    await screen.findAllByText(/^That answer didn’t come from the phone/);
    await screen.findByRole('img', { name: /QR code/ });
    const card = screen.getByTestId('phone-signin');
    const notice = within(card).getByText(/^That answer didn’t come from the phone/);
    expect(card.firstElementChild?.contains(notice)).toBe(true);
  });

  it('a phone that’s in leads to Devices, where it can be removed', async () => {
    const w = world();
    const probe = withLinkProbe(w.deps);
    render(
      <MobilePage
        signIn={probe.deps}
        whombatName="Burrow HQ"
        loadDownload={() => Promise.resolve(APK)}
        back={null}
        devices={<a href="/settings?part=devices">See your devices</a>}
      />,
    );
    await screen.findByRole('img', { name: /QR code/ });
    w.scan();
    await tick();
    w.report(probe.key());
    await tick();
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(await screen.findByRole('button', { name: 'Let it in' }));
    expect(await screen.findByRole('heading', { name: 'Pixel 9 is in' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See your devices' })).toBeTruthy();
  });
});

/**
 * The key exists only in the QR code's link (never in the DOM as text in production builds); the test wraps
 * `createPhoneHandoff`'s answer to learn the link the page builds from it, by rebuilding it the same way.
 */
function withLinkProbe(deps: PhoneSignInDeps) {
  let key = '';
  const random = crypto.getRandomValues.bind(crypto);
  // The page's key comes from `newPhoneHandoffKey()` (32 random bytes): record the bytes it asks for.
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    const out = random(array as never) as T;
    if (array instanceof Uint8Array && array.length === 32) key = base64url(array);
    return out;
  });
  return { deps, key: () => key };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('/auth/phone in a browser (AP-526)', () => {
  const FRAGMENT = `t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&d=wmb_0001&p=${PEER}`;

  it('holds the link, takes the fragment out of the address bar, and offers the app', async () => {
    window.history.replaceState(null, '', `/auth/phone#${FRAGMENT}`);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<PhoneLinkPage loadDownload={() => Promise.resolve(APK)} />);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/auth/phone');
    const open = screen.getByRole('link', { name: 'Open in the Whombat app' });
    expect(open.getAttribute('href')).toBe(`whombat://auth/phone#${FRAGMENT}`);
    expect(await screen.findByText('41 MB · Updates itself')).toBeTruthy();
    expect(
      screen.getByText('On a computer? This code is for your phone: scan it with the Whombat app.'),
    ).toBeTruthy();
    // Nothing is sent anywhere from this page (the download loader is the page's only call).
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('a link that isn’t one: says so, still offers the app', async () => {
    window.history.replaceState(null, '', '/auth/phone#t=short');
    render(<PhoneLinkPage loadDownload={() => Promise.resolve(null)} />);
    expect(screen.getByText(/^This link is incomplete or already used/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open in the Whombat app' })).toBeNull();
    expect(
      await screen.findByText('The Android app isn’t published here yet. Check back soon.'),
    ).toBeTruthy();
  });

  it('reads only its own path, and rebuilds the same link in the app’s scheme', () => {
    expect(
      takePhoneLink({
        href: `${ORIGIN}/auth/verify#${FRAGMENT}`,
        origin: ORIGIN,
        pathname: '/auth/verify',
        hash: `#${FRAGMENT}`,
      }),
    ).toBeNull();
    const parsed = parsePhoneSignInLink(`${ORIGIN}/auth/phone#${FRAGMENT}`, [ORIGIN]);
    expect(parsed).not.toBeNull();
    const again = parsePhoneSignInLink(appLink(parsed as NonNullable<typeof parsed>), [ORIGIN]);
    expect(again).toEqual(parsed);
  });
});

describe('/mobile signed out (AP-526)', () => {
  it('offers the download and a way to sign in, without asking for a sign-in first', async () => {
    const onSignIn = vi.fn();
    render(<PublicMobilePage loadDownload={() => Promise.resolve(APK)} onSignIn={onSignIn} />);
    expect(screen.getByText('Get Whombat for your phone')).toBeTruthy();
    expect(await screen.findByText('41 MB · Updates itself')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in on this device' }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });
});
