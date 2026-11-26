/**
 * Whombat Link at the account site (link-account-site.md, account-home.md): the code as typed, `/add` from a code in
 * the address to the confirm, the account with the plan's one button, and the home with each Whombat.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ADD_TEXT,
  type ControlApi,
  ControlError,
  type ControlSession,
  HOME_TEXT,
  LINK_ADDRESS_POLL_EVERY_MS,
  LINK_CLAIM_URL_GRACE_MS,
  LINK_OPEN_FALLBACK_MS,
  type LinkAccount,
  OWN_NAME_TEXT as N,
  SUBSCRIPTION_TERMS_VERSION,
  WHOMBAT_LINK_TEXT as T,
} from '@whombat/client/managed';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountScreen, HomeScreen } from './Home';
import { LinkCodeFlow, typedLinkCode } from './LinkAccount';

afterEach(() => window.history.replaceState(null, '', '/'));

const session: ControlSession = {
  account: { accountId: 'acc_mara', email: 'mara@burrowhq.example', name: 'Mara' },
  orgs: [],
};
const now = Math.floor(Date.now() / 1000);
const account = (patch: Partial<LinkAccount['plan']> = {}): LinkAccount => ({
  plan: {
    state: 'trialing',
    trialEndsAt: now + 20 * 86_400,
    currentPeriodEnd: now + 20 * 86_400,
    cancelAtPeriodEnd: false,
    trialAvailable: false,
    boxes: 1,
    ...patch,
  },
  boxes: [
    {
      device: 'dev_7KQ2M4XD',
      name: 'Home',
      state: 'on',
      since: now - 86_400,
      graceEndsAt: null,
      label: 'calm-otter-reef',
      host: 'calm-otter-reef.box.whombat.app',
      lastSeenAt: now,
    },
  ],
});

describe('the code as typed', () => {
  it('upper case, the dash after four letters, nothing past eight', () => {
    expect(typedLinkCode('kxqm')).toBe('KXQM');
    expect(typedLinkCode('kxqm t')).toBe('KXQM-T');
    expect(typedLinkCode('kx-qm-tr-vw-zz')).toBe('KXQM-TRVW');
  });
});

describe('/link', () => {
  it('looks up a code from the address at once and confirms it; the free month is said', async () => {
    const user = userEvent.setup();
    const linkLookup = vi.fn(async () => ({
      code: 'KXQM-TRVW',
      name: 'Home',
      expiresAt: now + 600,
      linked: false,
      trial: true,
    }));
    const linkConfirm = vi.fn(async () => account().boxes[0] as LinkAccount['boxes'][number]);
    const control = { linkLookup, linkConfirm, linkAccount: async () => account({ state: 'none' }) };
    render(
      <LinkCodeFlow control={control as unknown as ControlApi} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    expect(await screen.findByRole('heading', { name: ADD_TEXT.confirmName('Home') })).toBeTruthy();
    expect(screen.getByText(T.trial)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: T.confirm }));
    expect(await screen.findByRole('heading', { name: T.doneTitle('Home') })).toBeTruthy();
    expect(linkConfirm).toHaveBeenCalledWith('KXQM-TRVW', undefined);
  });

  it('asks for the Subscription Terms where control names them, and sends the version ticked', async () => {
    const user = userEvent.setup();
    const linkConfirm = vi.fn(async () => account().boxes[0] as LinkAccount['boxes'][number]);
    const control = {
      linkLookup: async () => ({
        code: 'KXQM-TRVW',
        name: 'Home',
        expiresAt: now + 600,
        linked: false,
        trial: true,
        termsVersion: SUBSCRIPTION_TERMS_VERSION,
      }),
      linkConfirm,
      linkAccount: async () => account({ state: 'none' }),
    };
    render(
      <LinkCodeFlow control={control as unknown as ControlApi} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    const confirm = await screen.findByRole('button', { name: T.confirm });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: T.termsLink }).getAttribute('href')).toBe(
      '/legal/subscription-terms',
    );
    await user.click(screen.getByRole('checkbox'));
    await user.click(confirm);
    expect(await screen.findByRole('heading', { name: T.doneTitle('Home') })).toBeTruthy();
    expect(linkConfirm).toHaveBeenCalledWith('KXQM-TRVW', { version: SUBSCRIPTION_TERMS_VERSION });
  });

  it('a third Whombat in the free month offers Add a card', async () => {
    const user = userEvent.setup();
    const control = {
      linkLookup: async () => ({
        code: 'KXQM-TRVW',
        name: null,
        expiresAt: now + 600,
        linked: false,
        trial: false,
      }),
      linkConfirm: async () => {
        throw new ControlError('link_trial_boxes', 'Add a card.');
      },
      linkAccount: async () => account(),
      // Checkout from here takes the country chosen beside the button (4.10).
      linkCheckout: vi.fn(async (_input: unknown) => {
        throw new ControlError('link_country', 'Not sold there.');
      }),
      linkPortal: vi.fn(),
    };
    render(
      <LinkCodeFlow control={control as unknown as ControlApi} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    expect(await screen.findByRole('heading', { name: ADD_TEXT.confirmTitle })).toBeTruthy();
    // Not named yet: the code on its screen says which Whombat this is.
    expect(screen.getByText('KXQM-TRVW', { exact: false })).toBeTruthy();
    // A control before 4.6 (no `discount`): the month only.
    expect(screen.getByText(`${T.joins} ${T.priceMonth}`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: T.confirm }));
    expect(await screen.findByText(T.errors.link_trial_boxes)).toBeTruthy();
    const addCard = screen.getByRole('button', { name: T.addCard }) as HTMLButtonElement;
    await user.selectOptions(screen.getByRole('combobox', { name: T.country }), 'other');
    expect(addCard.disabled).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: T.country }), 'IE');
    await user.click(addCard);
    expect(control.linkCheckout).toHaveBeenCalledWith({ country: 'IE' });
    expect(await screen.findByText(T.errors.link_country)).toBeTruthy();
  });

  it('a stopped plan: says why and offers Subscribe', async () => {
    const user = userEvent.setup();
    const control = {
      linkLookup: async () => ({
        code: 'KXQM-TRVW',
        name: null,
        expiresAt: now + 600,
        linked: false,
        trial: false,
      }),
      linkConfirm: async () => {
        throw new ControlError('link_subscribe', 'Subscribe to add this Whombat.');
      },
      linkAccount: async () => account({ state: 'cancelled' }),
    };
    render(
      <LinkCodeFlow control={control as unknown as ControlApi} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    await user.click(await screen.findByRole('button', { name: T.confirm }));
    expect(await screen.findByText(T.errors.link_subscribe)).toBeTruthy();
    expect(screen.getByRole('button', { name: T.subscribe })).toBeTruthy();
    expect(screen.queryByRole('button', { name: T.addCard })).toBeNull();
  });
});

describe('the Web address on the confirm step', () => {
  const lookup = async () => ({
    code: 'KXQM-TRVW',
    name: null,
    expiresAt: now + 600,
    linked: false,
    trial: true,
    chooseName: true,
  });
  const box = account().boxes[0] as LinkAccount['boxes'][number];

  it('a random name unless the person chooses one; the name is checked and sent with the confirm', async () => {
    const user = userEvent.setup();
    const linkNameCheck = vi.fn(async (name: string) =>
      name === 'office'
        ? { name, verdict: 'taken' as const }
        : { name, verdict: 'free' as const, host: `${name}.whombat.app` },
    );
    const linkConfirm = vi.fn(async () => box);
    const control = { linkLookup: lookup, linkConfirm, linkNameCheck, linkAccount: async () => account() };
    render(
      <LinkCodeFlow control={control as unknown as ControlApi} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    expect(await screen.findByText(N.random(N.randomExample))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: N.choose }));
    const field = screen.getByLabelText(N.row);
    expect(screen.getByText(N.privacy)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: T.confirm }) as HTMLButtonElement;
    // Nothing typed yet: confirm waits for a free name.
    expect(confirm.disabled).toBe(true);
    // A name nobody gets is said at once, without asking control.
    await user.type(field, 'admin');
    expect(await screen.findByText(N.reserved)).toBeTruthy();
    await user.clear(field);
    await user.type(field, 'office');
    expect(await screen.findByText(N.taken)).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    await user.clear(field);
    await user.type(field, 'home');
    expect(await screen.findByText(N.free('home.whombat.app'))).toBeTruthy();
    // The row tells the confirm step about the free name a render after it shows it.
    await waitFor(() => expect(confirm.disabled).toBe(false));
    // Only the name as it stands was asked about once the typing paused.
    expect(linkNameCheck).not.toHaveBeenCalledWith('hom');
    await user.click(confirm);
    expect(await screen.findByRole('heading', { name: T.doneTitle('Home') })).toBeTruthy();
    expect(linkConfirm).toHaveBeenCalledWith('KXQM-TRVW', undefined, 'home');
  });

  it('Use a random name goes back, and the confirm sends no name', async () => {
    const user = userEvent.setup();
    const linkConfirm = vi.fn(async () => box);
    const control = {
      linkLookup: lookup,
      linkConfirm,
      linkNameCheck: async (name: string) => ({ name, verdict: 'free' as const }),
      linkAccount: async () => account(),
    };
    render(
      <LinkCodeFlow control={control as unknown as ControlApi} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    await user.click(await screen.findByRole('button', { name: N.choose }));
    await user.type(screen.getByLabelText(N.row), 'x');
    expect(await screen.findByText(N.invalid)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: N.useRandom }));
    await user.click(screen.getByRole('button', { name: T.confirm }));
    expect(await screen.findByRole('heading', { name: T.doneTitle('Home') })).toBeTruthy();
    expect(linkConfirm).toHaveBeenCalledWith('KXQM-TRVW', undefined);
  });

  it('a name taken meanwhile brings the person back to the field, and nothing was added', async () => {
    const user = userEvent.setup();
    const linkConfirm = vi.fn(async (_code: string, _terms?: unknown, label?: string) => {
      if (label === 'home') throw new ControlError('label_taken', 'That name is taken.');
      return box;
    });
    const control = {
      linkLookup: lookup,
      linkConfirm,
      linkNameCheck: async (name: string) => ({
        name,
        verdict: 'free' as const,
        host: `${name}.whombat.app`,
      }),
      linkAccount: async () => account(),
    };
    render(
      <LinkCodeFlow control={control as unknown as ControlApi} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    await user.click(await screen.findByRole('button', { name: N.choose }));
    const field = screen.getByLabelText(N.row);
    await user.type(field, 'home');
    await screen.findByText(N.free('home.whombat.app'));
    const confirm = screen.getByRole('button', { name: T.confirm }) as HTMLButtonElement;
    await user.click(confirm);
    expect(await screen.findByText(N.taken)).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    expect(screen.queryByRole('heading', { name: T.doneTitle('Home') })).toBeNull();
    await user.type(field, '2');
    await screen.findByText(N.free('home2.whombat.app'));
    await user.click(confirm);
    expect(await screen.findByRole('heading', { name: T.doneTitle('Home') })).toBeTruthy();
    expect(linkConfirm).toHaveBeenLastCalledWith('KXQM-TRVW', undefined, 'home2');
  });

  it('no row where control can’t check names (an older one)', async () => {
    const control = { linkLookup: lookup, linkConfirm: async () => box, linkAccount: async () => account() };
    render(
      <LinkCodeFlow control={control as unknown as ControlApi} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    await screen.findByRole('button', { name: T.confirm });
    expect(screen.queryByRole('button', { name: N.choose })).toBeNull();
  });

  it('no row where control says the box can’t take a chosen name', async () => {
    const control = {
      linkLookup: async () => ({ ...(await lookup()), chooseName: false }),
      linkConfirm: async () => box,
      linkNameCheck: async (name: string) => ({ name, verdict: 'free' as const }),
      linkAccount: async () => account(),
    };
    render(
      <LinkCodeFlow control={control as unknown as ControlApi} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    await screen.findByRole('button', { name: T.confirm });
    expect(screen.queryByRole('button', { name: N.choose })).toBeNull();
  });
});

describe('/link once it is linked: its own page', () => {
  const easy = (patch: Partial<LinkAccount['boxes'][number]>) => ({
    ...(account().boxes[0] as LinkAccount['boxes'][number]),
    name: null,
    ...patch,
  });
  const starting = easy({ state: 'starting', label: null, host: null });
  const ready = easy({});
  function linking(answers: LinkAccount['boxes'][number][], then = ready, confirmed = starting) {
    const linkAccount = vi.fn(async () => ({ ...account(), boxes: [answers.shift() ?? then] }));
    const control = {
      linkLookup: async () => ({
        code: 'KXQM-TRVW',
        name: null,
        expiresAt: now + 600,
        linked: false,
        trial: true,
      }),
      linkConfirm: async () => confirmed,
      linkAccount,
    };
    return { control: control as unknown as ControlApi, linkAccount };
  }
  afterEach(() => vi.useRealTimers());

  it('waits for its claim link, showing what it is doing, then opens it by itself with the name and email', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The lookup's own load, then the first wait's answer: still no address; then the address before its claim link.
    const withLink = { ...ready, claimUrl: 'https://calm-otter-reef.box.whombat.app/c/pqrtvw' };
    const { control } = linking([starting, starting, ready], withLink);
    const openPage = vi.fn();
    render(
      <LinkCodeFlow
        control={control}
        session={session}
        initialCode="KXQM-TRVW"
        onAccount={vi.fn()}
        openPage={openPage}
      />,
    );
    // A new Whombat: linking it is the setup's first step of four.
    expect(await screen.findByText('STEP 1 OF 4')).toBeTruthy();
    expect(within(screen.getByTestId('auth-steps')).getAllByRole('listitem')).toHaveLength(4);
    await user.click(await screen.findByRole('button', { name: T.confirm }));
    expect(await screen.findByText(T.addressWaiting)).toBeTruthy();
    const progress = screen.getByTestId('link-progress');
    expect(within(progress).getByText(T.progress.address).closest('li')?.dataset.state).toBe('current');
    // A little more than one wait between asks: the next answer, not the one after.
    const nextAsk = LINK_ADDRESS_POLL_EVERY_MS * 1.2;
    await vi.advanceTimersByTimeAsync(nextAsk);
    // The address alone: still waiting, for its page to answer; nothing opened, no button.
    await vi.waitFor(() =>
      expect(within(progress).getByText(T.progress.page).closest('li')?.dataset.state).toBe('current'),
    );
    expect(openPage).not.toHaveBeenCalled();
    expect(screen.queryByTestId('link-claim-now')).toBeNull();
    await vi.advanceTimersByTimeAsync(nextAsk);
    await vi.waitFor(() => expect(openPage).toHaveBeenCalledTimes(1));
    const url = new URL(openPage.mock.calls[0]?.[0] as string);
    expect(url.origin).toBe('https://calm-otter-reef.box.whombat.app');
    expect(url.pathname).toBe('/c/pqrtvw');
    expect(Object.fromEntries(new URLSearchParams(url.hash.slice(1)))).toEqual({
      name: 'Mara',
      email: 'mara@burrowhq.example',
      from: 'link',
    });
    expect(await screen.findByText(T.addressOpening)).toBeTruthy();
    // The button only when the page is still here a while later.
    expect(screen.queryByTestId('link-claim-now')).toBeNull();
    await vi.advanceTimersByTimeAsync(LINK_OPEN_FALLBACK_MS + 1_000);
    const claim = await screen.findByRole('link', { name: T.claimNow });
    expect(claim.getAttribute('href')).toBe(openPage.mock.calls[0]?.[0]);
  });

  it('opens its page with the fragment when no claim link comes (an older Whombat or control)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { control } = linking([starting, starting]);
    const openPage = vi.fn();
    render(
      <LinkCodeFlow
        control={control}
        session={session}
        initialCode="KXQM-TRVW"
        onAccount={vi.fn()}
        openPage={openPage}
      />,
    );
    await user.click(await screen.findByRole('button', { name: T.confirm }));
    await vi.advanceTimersByTimeAsync(6_000 + LINK_CLAIM_URL_GRACE_MS - 30_000);
    expect(openPage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_000);
    await vi.waitFor(() => expect(openPage).toHaveBeenCalledTimes(1));
    const url = new URL(openPage.mock.calls[0]?.[0] as string);
    expect(url.origin).toBe('https://calm-otter-reef.box.whombat.app');
    expect(url.pathname).toBe('/');
    expect(new URLSearchParams(url.hash.slice(1)).get('email')).toBe('mara@burrowhq.example');
  });

  it('says when it takes long, asks again on Check again, and stops asking once the page closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { control, linkAccount } = linking(Array.from({ length: 200 }, () => starting));
    const page = render(
      <LinkCodeFlow control={control} session={session} initialCode="KXQM-TRVW" onAccount={vi.fn()} />,
    );
    await user.click(await screen.findByRole('button', { name: T.confirm }));
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(await screen.findByText(T.addressSlow)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: T.checkAgain }));
    expect(await screen.findByText(T.addressWaiting)).toBeTruthy();
    page.unmount();
    const asked = linkAccount.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(linkAccount.mock.calls.length).toBe(asked);
  });

  it('a Whombat already set up (it has a name) waits for its owner’s Open, with nothing in the fragment', async () => {
    const user = userEvent.setup();
    const home = { ...ready, name: 'Home' };
    const { control } = linking([], home, home);
    const openPage = vi.fn();
    render(
      <LinkCodeFlow
        control={control}
        session={session}
        initialCode="KXQM-TRVW"
        onAccount={vi.fn()}
        openPage={openPage}
      />,
    );
    await user.click(await screen.findByRole('button', { name: T.confirm }));
    const open = await screen.findByRole('link', { name: T.openName('Home') });
    expect(open.getAttribute('href')).toBe('https://calm-otter-reef.box.whombat.app/');
    expect(openPage).not.toHaveBeenCalled();
    // Not a new Whombat's setup: no step count here.
    expect(screen.queryByText('STEP 1 OF 4')).toBeNull();
    expect(screen.queryByTestId('auth-steps')).toBeNull();
  });
});

describe('Your Whombats', () => {
  const props = {
    session,
    checkout: null,
    onRetry: vi.fn(),
    onPlan: vi.fn(async () => {}),
    onHome: vi.fn(),
    onAccount: vi.fn(),
    onPhone: vi.fn(),
    onSignOut: vi.fn(),
    onDeleteAccount: vi.fn(),
  };
  const home = {
    session,
    onRetry: vi.fn(),
    onRemove: vi.fn(async () => null),
    onAdd: vi.fn(),
    onAccount: vi.fn(),
    onPhone: vi.fn(),
    onSignOut: vi.fn(),
    lastOpened: null,
    onOpen: vi.fn(),
  };
  const two = (patch: Partial<LinkAccount['plan']> = {}): LinkAccount => {
    const a = account(patch);
    const home = a.boxes[0] as LinkAccount['boxes'][number];
    a.boxes = [
      home,
      { ...home, device: 'dev_9QW3R5YZ', name: 'Office', host: 'quiet-heron-dune.box.whombat.app' },
      {
        ...home,
        device: 'dev_2MN4P6RT',
        name: 'Cabin',
        state: 'ended',
        host: 'pale-fern-cove.box.whombat.app',
      },
    ];
    return a;
  };
  // jsdom has no navigation: an Open link's click runs its handler and goes nowhere.
  const stay = (e: MouseEvent) => e.preventDefault();
  afterEach(() => document.removeEventListener('click', stay, true));

  it('the free month: its line, Add a card, the Whombat with its address', () => {
    render(<AccountScreen {...props} account={account()} />);
    const plan = screen.getByRole('list', { name: T.plan });
    expect(within(plan).getByText(/^Free month · until /)).toBeTruthy();
    expect(within(plan).getByRole('button', { name: T.addCard })).toBeTruthy();
  });

  it('back from Checkout, says “subscribed” only once a card is on file, then offers Manage subscription', () => {
    const { unmount } = render(
      <AccountScreen
        {...props}
        checkout="done"
        account={account({ state: 'trialing', cardOnFile: false })}
      />,
    );
    expect(screen.queryByText(T.subscribed)).toBeNull();
    expect(screen.getByRole('button', { name: T.addCard })).toBeTruthy();
    unmount();
    render(
      <AccountScreen {...props} checkout="done" account={account({ state: 'trialing', cardOnFile: true })} />,
    );
    expect(screen.getByTestId('link-notice').textContent).toBe(T.subscribed);
    expect(screen.getByRole('button', { name: T.manage })).toBeTruthy();
  });

  it('Included has no button; grace says until when and Tailscale', () => {
    const { unmount } = render(<AccountScreen {...props} account={account({ state: 'comp' })} />);
    const plan = screen.getByRole('list', { name: T.plan });
    expect(within(plan).queryByRole('button')).toBeNull();
    expect(within(plan).getByText(T.planIncluded, { exact: false })).toBeTruthy();
    unmount();
    const ending = account({ state: 'cancelled' });
    ending.boxes = ending.boxes.map((b) => ({ ...b, state: 'grace', graceEndsAt: now + 5 * 86_400 }));
    render(<AccountScreen {...props} account={ending} />);
    expect(screen.getByTestId('link-notice').textContent).toContain('Tailscale');
    expect(screen.getByRole('button', { name: T.subscribeAgain })).toBeTruthy();
  });

  it('Remove asks first, behind ⋯', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn(async () => null);
    render(<HomeScreen {...home} onRemove={onRemove} account={account({ state: 'active' })} />);
    await user.click(screen.getByRole('button', { name: HOME_TEXT.more('Home') }));
    await user.click(screen.getByRole('button', { name: HOME_TEXT.remove }));
    expect(onRemove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: T.removeIt }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('one Whombat leads with one big Open at its own address, which this device remembers', async () => {
    const user = userEvent.setup();
    document.addEventListener('click', stay, true);
    const onOpen = vi.fn();
    render(<HomeScreen {...home} onOpen={onOpen} account={account({ state: 'active' })} />);
    expect(screen.getByRole('heading', { name: HOME_TEXT.title(1) })).toBeTruthy();
    const open = screen.getByRole('link', { name: HOME_TEXT.openName('Home') });
    expect(open.getAttribute('href')).toBe('https://calm-otter-reef.box.whombat.app/');
    expect(open.getAttribute('target')).toBeNull();
    expect(screen.getAllByRole('link', { name: /^Open / })).toHaveLength(1);
    expect(screen.getByText('calm-otter-reef.box.whombat.app')).toBeTruthy();
    await user.click(open);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ device: 'dev_7KQ2M4XD' }));
  });

  it('more Whombats: each with Open where its address works, the one opened last first', () => {
    render(<HomeScreen {...home} lastOpened="dev_9QW3R5YZ" account={two({ state: 'active', boxes: 2 })} />);
    expect(screen.queryByTestId('home-only')).toBeNull();
    const boxes = screen.getByRole('list', { name: HOME_TEXT.title(3) });
    const names = within(boxes)
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-whombat'));
    expect(names).toEqual(['dev_9QW3R5YZ', 'dev_7KQ2M4XD', 'dev_2MN4P6RT']);
    expect(within(boxes).getByText(HOME_TEXT.openedLast)).toBeTruthy();
    expect(
      within(boxes)
        .getByRole('link', { name: HOME_TEXT.openName('Office') })
        .getAttribute('href'),
    ).toBe('https://quiet-heron-dune.box.whombat.app/');
    expect(within(boxes).queryByRole('link', { name: HOME_TEXT.openName('Cabin') })).toBeNull();
    // The plan in one line at the foot, with how many Whombats.
    expect(screen.getByText(/^Whombat Link · .+ · 2 Whombats$/)).toBeTruthy();
  });

  it('a Whombat control hasn’t heard from for hours says since when', () => {
    const quiet = account({ state: 'active' });
    quiet.boxes = quiet.boxes.map((b) => ({ ...b, lastSeenAt: now - 5 * 3600 }));
    render(<HomeScreen {...home} account={quiet} />);
    expect(screen.getByText(/^Not heard from since 5 hours ago$/)).toBeTruthy();
    // It may be back: Open stays.
    expect(screen.getByRole('link', { name: HOME_TEXT.openName('Home') })).toBeTruthy();
  });

  it('no Whombat yet: the three steps and the code right here', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const none = account({ state: 'none', boxes: 0, trialAvailable: true });
    none.boxes = [];
    render(<HomeScreen {...home} onAdd={onAdd} account={none} />);
    expect(screen.getByRole('heading', { name: HOME_TEXT.emptyTitle })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    await user.type(screen.getByLabelText(T.code), 'kqxmtrvw');
    await user.click(screen.getByRole('button', { name: T.find }));
    expect(onAdd).toHaveBeenCalledWith('KQXM-TRVW');
  });

  it('an older organization’s Whombat opens on this site; one linked at its own address opens nowhere here', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const none = account({ state: 'none', boxes: 0 });
    none.boxes = [];
    const old = {
      device: 'dev_OLD1',
      orgId: 'org_old',
      name: 'Workshop',
      state: 'claimed' as const,
      contentPeerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
      lastSeenAt: now,
      revocationsPending: 0,
    };
    render(
      <HomeScreen
        {...home}
        onOpen={onOpen}
        account={none}
        hosted={[old, { ...old, device: 'dev_OLD2', name: 'Barn', ownAddress: true }]}
      />,
    );
    expect(screen.getByText(HOME_TEXT.elsewhere)).toBeTruthy();
    expect(screen.queryByRole('button', { name: HOME_TEXT.openName('Barn') })).toBeNull();
    await user.click(screen.getByRole('button', { name: HOME_TEXT.openName('Workshop') }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ device: 'dev_OLD1' }));
  });

  it('the account menu: the account, the phone app and signing out', async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(<HomeScreen {...home} onSignOut={onSignOut} account={account()} />);
    const button = screen.getByRole('button', { name: HOME_TEXT.menu.label(session.account.email) });
    await user.click(button);
    const menu = document.getElementById(button.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(within(menu).getByRole('button', { name: HOME_TEXT.menu.account })).toBeTruthy();
    expect(within(menu).getByRole('button', { name: HOME_TEXT.menu.phone })).toBeTruthy();
    await user.click(within(menu).getByRole('button', { name: HOME_TEXT.menu.signOut }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('during free time the plan says until when, and the price as what follows (#15)', () => {
    const grantEnd = now + 180 * 86_400;
    const { unmount } = render(
      <AccountScreen
        {...props}
        account={account({
          state: 'trialing',
          cardOnFile: true,
          interval: 'year',
          discount: { percentOff: 100, endsAt: grantEnd, code: 'FRIENDS' },
        })}
      />,
    );
    const plan = screen.getByRole('list', { name: T.plan });
    // The grant's end, never “Free month”, and nothing reads as charged now.
    expect(within(plan).getByText(/^Free until /)).toBeTruthy();
    expect(within(plan).queryByText(/Free month/)).toBeNull();
    expect(screen.getByTestId('link-discount').textContent).toBe(T.fromCode('FRIENDS'));
    expect(screen.getByTestId('link-price').textContent).toMatch(/^Then €25 a year for each Whombat from /);
    expect(within(plan).queryByText(T.paidYear)).toBeNull();
    unmount();

    render(
      <AccountScreen
        {...props}
        account={account({
          state: 'active',
          cardOnFile: true,
          interval: 'month',
          discount: { percentOff: 100, endsAt: null, code: null },
        })}
      />,
    );
    expect(screen.getByRole('list', { name: T.plan }).textContent).toContain(T.freeForGood);
    expect(screen.queryByTestId('link-price')).toBeNull();
  });

  it('a six-month grant during the free month reads as free time on both of control’s payloads (R2 B4)', () => {
    const grantEnd = now + 182 * 86_400;
    const grant = { percentOff: 100, endsAt: grantEnd, code: null };
    // Before CL-218 the trial is stretched to the grant's end (the same second); from it `trialEndsAt` is the month's.
    for (const trialEndsAt of [grantEnd, now + 20 * 86_400]) {
      const { unmount } = render(
        <AccountScreen
          {...props}
          account={account({ state: 'trialing', trialEndsAt, currentPeriodEnd: grantEnd, discount: grant })}
        />,
      );
      expect(screen.queryByText(/Free month/)).toBeNull();
      expect(within(screen.getByRole('list', { name: T.plan })).getByText(/^Free until /)).toBeTruthy();
      unmount();
    }
  });

  it('paid, the plan says what it pays; part off says so beside it', () => {
    render(
      <AccountScreen
        {...props}
        account={account({
          state: 'active',
          cardOnFile: true,
          interval: 'year',
          discount: { percentOff: 50, endsAt: now + 90 * 86_400, code: 'SPRING26' },
        })}
      />,
    );
    const plan = screen.getByRole('list', { name: T.plan });
    expect(within(plan).getByText(T.paidYear)).toBeTruthy();
    expect(screen.getByTestId('link-discount').textContent).toMatch(
      /^50% off until .+, with the code SPRING26$/,
    );
    // A subscription switches in the portal: no choice here.
    expect(within(plan).queryByRole('radiogroup')).toBeNull();
  });

  it('Checkout by the month or the year chosen here; the code is the payment page’s, never sent from here', async () => {
    const user = userEvent.setup();
    const onPlan = vi.fn(async (_choice: unknown) => {});
    render(
      <AccountScreen
        {...props}
        onPlan={onPlan}
        account={account({ state: 'none', trialAvailable: false, discount: null })}
      />,
    );
    expect(screen.getByText(T.price)).toBeTruthy();
    expect(screen.getByText(T.haveCode)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('radio', { name: T.year }));
    await user.selectOptions(screen.getByRole('combobox', { name: T.country }), 'NL');
    // What Checkout may answer, in plain words (an old tab's code included); the button is there again after each.
    for (const code of [
      'checkout_busy',
      'billing_provider_error',
      'billing_provider_refused',
      'promotion_code_on_payment_page',
    ] as const) {
      onPlan.mockRejectedValueOnce(new ControlError(code, 'x'));
      await user.click(screen.getByRole('button', { name: T.subscribe }));
      expect(await screen.findByText(T.errors[code])).toBeTruthy();
    }
    await user.click(screen.getByRole('button', { name: T.subscribe }));
    expect(onPlan).toHaveBeenLastCalledWith({ via: 'checkout', interval: 'year', country: 'NL' });
  });

  it('free time without a card is Add a card (Checkout); Manage only with a card on file', async () => {
    const user = userEvent.setup();
    const onPlan = vi.fn(async (_choice: unknown) => {});
    const grant = { percentOff: 100, endsAt: now + 120 * 86_400, code: null };
    const { unmount } = render(
      <AccountScreen
        {...props}
        onPlan={onPlan}
        account={account({ state: 'trialing', trialEndsAt: null, cardOnFile: false, discount: grant })}
      />,
    );
    expect(screen.queryByRole('button', { name: T.manage })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: T.country }), 'NL');
    await user.click(screen.getByRole('button', { name: T.addCard }));
    expect(onPlan).toHaveBeenLastCalledWith({ via: 'checkout', interval: 'month', country: 'NL' });
    unmount();

    render(
      <AccountScreen
        {...props}
        onPlan={onPlan}
        account={account({ state: 'active', cardOnFile: true, interval: 'year', discount: null })}
      />,
    );
    expect(screen.queryByRole('radiogroup')).toBeNull();
    await user.click(screen.getByRole('button', { name: T.manage }));
    expect(onPlan).toHaveBeenLastCalledWith({ via: 'portal', interval: 'month' });
  });

  it('the portal’s no_subscription offers Subscribe (Checkout) instead', async () => {
    const user = userEvent.setup();
    const onPlan = vi.fn(async (_choice: unknown) => {});
    onPlan.mockRejectedValueOnce(new ControlError('no_subscription', 'No subscription.'));
    render(
      <AccountScreen
        {...props}
        onPlan={onPlan}
        account={account({ state: 'active', cardOnFile: true, discount: null })}
      />,
    );
    expect(screen.queryByRole('combobox', { name: T.country })).toBeNull();
    await user.click(screen.getByRole('button', { name: T.manage }));
    expect(await screen.findByText(T.errors.no_subscription)).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: T.country }), 'NL');
    await user.click(screen.getByRole('button', { name: T.subscribe }));
    expect(onPlan).toHaveBeenLastCalledWith({ via: 'checkout', interval: 'month', country: 'NL' });
  });

  it('an account without accepted terms is asked for them, and they go along', async () => {
    const user = userEvent.setup();
    const onPlan = vi.fn(async (_choice: unknown) => {});
    onPlan.mockRejectedValueOnce(new ControlError('terms_required', 'Terms.'));
    render(
      <AccountScreen
        {...props}
        onPlan={onPlan}
        account={account({ state: 'none', trialAvailable: false, discount: null })}
      />,
    );
    const subscribe = screen.getByRole('button', { name: T.subscribe });
    await user.selectOptions(screen.getByRole('combobox', { name: T.country }), 'NL');
    await user.click(subscribe);
    expect(await screen.findByText(T.errors.terms_required)).toBeTruthy();
    expect((subscribe as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox'));
    await user.click(subscribe);
    expect(onPlan).toHaveBeenLastCalledWith({
      via: 'checkout',
      interval: 'month',
      terms: { version: SUBSCRIPTION_TERMS_VERSION },
      country: 'NL',
    });
  });

  it('asks where the person lives before Checkout: another country says so and pays nothing', async () => {
    const user = userEvent.setup();
    const onPlan = vi.fn(async (_choice: unknown) => {});
    render(
      <AccountScreen
        {...props}
        onPlan={onPlan}
        account={account({ state: 'none', trialAvailable: false, discount: null })}
      />,
    );
    const where = screen.getByRole('combobox', { name: T.country });
    expect(within(where).getAllByRole('option')).toHaveLength(29);
    expect(screen.getByText(T.vatNumber)).toBeTruthy();
    const subscribe = screen.getByRole('button', { name: T.subscribe }) as HTMLButtonElement;
    await user.selectOptions(where, 'other');
    expect(screen.getByRole('status').textContent).toBe(T.countryOutside);
    expect(subscribe.disabled).toBe(true);
    await user.click(subscribe);
    expect(onPlan).not.toHaveBeenCalled();
    await user.selectOptions(where, 'DE');
    expect(screen.queryByText(T.countryOutside)).toBeNull();
    await user.click(subscribe);
    expect(onPlan).toHaveBeenLastCalledWith({ via: 'checkout', interval: 'month', country: 'DE' });
  });

  it('no Whombat linked: no Subscribe, one line to link one (the free month starts then)', () => {
    const { unmount } = render(
      <AccountScreen
        {...props}
        account={account({ state: 'none', boxes: 0, trialAvailable: true, discount: null })}
      />,
    );
    expect(screen.queryByRole('button', { name: T.subscribe })).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByText(T.needsBox)).toBeTruthy();
    unmount();
    render(
      <AccountScreen
        {...props}
        account={account({ state: 'cancelled', boxes: 0, trialAvailable: false, discount: null })}
      />,
    );
    expect(screen.queryByRole('button', { name: T.subscribeAgain })).toBeNull();
    expect(screen.getByText(T.needsBoxAgain)).toBeTruthy();
  });

  it('a payment page open for the other interval: control’s until-when, and the way back to that page', async () => {
    const user = userEvent.setup();
    const onPlan = vi.fn(async (_choice: unknown) => {});
    const busy = 'A payment page is already open for your Whombat Link until 14:05 UTC. Finish it there.';
    onPlan.mockRejectedValueOnce(new ControlError('checkout_busy', busy));
    render(
      <AccountScreen
        {...props}
        onPlan={onPlan}
        openPage="year"
        account={account({ state: 'none', trialAvailable: false, discount: null })}
      />,
    );
    // The open page's interval comes first; another asks control, which says until when.
    expect((screen.getByRole('radio', { name: T.year }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('radio', { name: T.month }));
    await user.selectOptions(screen.getByRole('combobox', { name: T.country }), 'NL');
    await user.click(screen.getByRole('button', { name: T.subscribe }));
    expect(await screen.findByText(busy)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: T.backToPage(T.year) }));
    expect(onPlan).toHaveBeenLastCalledWith({ via: 'checkout', interval: 'year', country: 'NL' });
  });

  it('a plan set to end says until when and opens the portal to resume it, with or without a Whombat', async () => {
    const user = userEvent.setup();
    const onPlan = vi.fn(async (_choice: unknown) => {});
    for (const boxes of [1, 0]) {
      const { unmount } = render(
        <AccountScreen
          {...props}
          onPlan={onPlan}
          account={account({
            state: 'active',
            cardOnFile: true,
            cancelAtPeriodEnd: true,
            currentPeriodEnd: now + 20 * 86_400,
            boxes,
            discount: null,
          })}
        />,
      );
      const plan = screen.getByRole('list', { name: T.plan });
      expect(
        within(plan).getByText(/^Your Whombat Link ends on .+\. Resume it in Manage subscription\.$/),
      ).toBeTruthy();
      expect(screen.queryByText(T.needsBoxAgain)).toBeNull();
      await user.click(within(plan).getByRole('button', { name: T.manage }));
      expect(onPlan).toHaveBeenLastCalledWith({ via: 'portal', interval: 'month' });
      unmount();
    }
  });

  it('an older control (no discount said): the month only, no choice', () => {
    render(<AccountScreen {...props} account={account({ state: 'none', trialAvailable: false })} />);
    expect(screen.getByText(T.priceMonth)).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});
