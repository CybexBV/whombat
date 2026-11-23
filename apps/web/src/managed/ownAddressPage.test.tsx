/**
 * The box's page at its own address (own-address.md): the claim only with the link from
 * the box's screen, the setup's words only on a box set up there, and the hosted list and its link code.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakePeerId } from '@whombat/client/fake';
import {
  type ApplianceSummary,
  BOX_SETUP_TEXT,
  COMMUNITY_TEXT,
  COPY,
  OWN_ADDRESS_TEXT,
} from '@whombat/client/managed';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoxEnvironment } from './boxEnv';

const keys = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./keys', async (original) => ({
  ...(await original<typeof import('./keys')>()),
  loadOrCreateEndpointKey: keys.load,
}));

// The box's passkey without a browser's WebAuthn: made at once, as a person's touch would.
const boxPasskey = vi.hoisted(() => ({ create: vi.fn(async () => ({ backups: 'saving' })) }));
vi.mock('@whombat/client/managed', async (original) => ({
  ...(await original<typeof import('@whombat/client/managed')>()),
  createBoxPasskey: boxPasskey.create,
}));

const { BoxRoot } = await import('./BoxRoot');
const { createFakeWorld, FAKE_OWN_CLAIM_LINK, FAKE_OWN_HOST } = await import('./fake/world');
const { AppliancesScreen } = await import('./screens');
const { LinkWhombatScreen } = await import('./LinkWhombat');

const T = OWN_ADDRESS_TEXT;

afterEach(() => {
  keys.load.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function ownBoxPage(path: string) {
  keys.load.mockResolvedValue({ peerId: fakePeerId('chrome-at-the-address'), identity: {} });
  const world = await createFakeWorld();
  world.faults.ownBox(true);
  window.history.replaceState(null, '', path);
  // The address is HTTPS: no plain-HTTP warning first.
  const env = { ...world.box(), secure: () => true } as unknown as BoxEnvironment;
  render(<BoxRoot env={env} />);
  return world;
}

describe('an unclaimed box at its own address', () => {
  it('claims only with the claim link from its screen', async () => {
    await ownBoxPage(`/c/${FAKE_OWN_CLAIM_LINK}`);
    expect(await screen.findByRole('heading', { name: T.claim.title })).toBeTruthy();
    // Claim, who you are, the passkey, Set up your AI: four steps at the address; no backups step.
    expect(screen.getByText(BOX_SETUP_TEXT.stepLabel(0, 4))).toBeTruthy();
    expect(screen.getByText(BOX_SETUP_TEXT.steps.passkey.t)).toBeTruthy();
    expect(screen.getByText(BOX_SETUP_TEXT.steps.account.t)).toBeTruthy();
  });

  it('asks for the letters after /c/ when the page has no link, and claims with them', async () => {
    const user = userEvent.setup();
    await ownBoxPage('/');
    const field = await screen.findByLabelText(T.openOnScreen.label);
    expect(screen.queryByRole('heading', { name: T.claim.title })).toBeNull();
    // A wrong link is the box's to refuse: the page says so and asks again.
    await user.type(field, 'bbbbbb');
    await user.click(screen.getByRole('button', { name: T.openOnScreen.next }));
    expect(await screen.findByText(T.openOnScreen.wrong)).toBeTruthy();
    // The whole address pasted works too.
    await user.type(screen.getByLabelText(T.openOnScreen.label), `${FAKE_OWN_HOST}/c/${FAKE_OWN_CLAIM_LINK}`);
    await user.click(screen.getByRole('button', { name: T.openOnScreen.next }));
    expect(await screen.findByRole('heading', { name: T.claim.title })).toBeTruthy();
    expect(window.location.pathname).toBe(`/c/${FAKE_OWN_CLAIM_LINK}`);
  });

  it('from the link page: the name and email sent along claim it with the letters alone, and its count goes on', async () => {
    const user = userEvent.setup();
    const world = await ownBoxPage(
      `/c/${FAKE_OWN_CLAIM_LINK}#name=Mara+Visser&email=mara%40burrowhq.example&from=link`,
    );
    expect(await screen.findByRole('heading', { name: T.claim.title })).toBeTruthy();
    expect(window.location.hash).toBe('');
    // Link your Whombat was the first step, on the account site; Who are you? isn't asked.
    expect(screen.getByText(BOX_SETUP_TEXT.stepLabel(1, 4))).toBeTruthy();
    expect(screen.getByText(BOX_SETUP_TEXT.steps.link.t)).toBeTruthy();
    expect(screen.queryByText(BOX_SETUP_TEXT.steps.account.t)).toBeNull();
    expect(screen.queryByLabelText(COMMUNITY_TEXT.account.name)).toBeNull();
    await user.type(screen.getByLabelText(COMMUNITY_TEXT.claim.letters), world.faults.ownLetters() as string);
    await user.click(screen.getByRole('button', { name: COMMUNITY_TEXT.claim.next }));
    expect(await screen.findByRole('heading', { name: T.passkey.title }, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByText(BOX_SETUP_TEXT.stepLabel(2, 4))).toBeTruthy();
    // Made, it goes on by itself to Set up your AI in the app: no Continue, no backups step.
    await user.click(screen.getByRole('button', { name: T.passkey.make }));
    await vi.waitFor(() => expect(window.location.pathname).toBe('/connect-ai'), { timeout: 5_000 });
    expect(boxPasskey.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: T.passkey.title })).toBeNull();
    expect(screen.queryByRole('button', { name: T.passkey.next })).toBeNull();
  });

  it('from the link page without a name: the claim asks for the name beside the letters', async () => {
    await ownBoxPage(`/c/${FAKE_OWN_CLAIM_LINK}#email=mara%40burrowhq.example&from=link`);
    expect(await screen.findByRole('heading', { name: T.claim.title })).toBeTruthy();
    const name = screen.getByLabelText(COMMUNITY_TEXT.account.name) as HTMLInputElement;
    expect(name.value).toBe('');
    expect(screen.queryByLabelText(COMMUNITY_TEXT.account.email)).toBeNull();
    expect(
      (screen.getByRole('button', { name: COMMUNITY_TEXT.claim.next }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('a box with the shared route at its own address (Home today, design §7.5)', () => {
  it('offers its passkey to sign in, and never the setup’s words', async () => {
    keys.load.mockResolvedValue({ peerId: fakePeerId('chrome-at-home'), identity: {} });
    const home: BoxEnvironment = {
      identity: async () => ({ v: 1, appliance: fakePeerId('home'), edition: 'commercial', claimed: true }),
      connector: () => ({
        connect: () => new Promise(() => {}),
      }),
      secure: () => true,
      ownAddress: () => FAKE_OWN_HOST,
    };
    render(<BoxRoot env={home} />);
    expect(await screen.findByRole('button', { name: T.join.use })).toBeTruthy();
    expect(screen.queryByText(T.passkey.words, { exact: false })).toBeNull();
    expect(screen.queryByText(T.hosted.accountPasskeyWords, { exact: false })).toBeNull();
    // The recovery key is a way in too.
    await userEvent.click(screen.getByRole('button', { name: COPY.recover.entry }));
    expect(await screen.findByRole('heading', { name: COPY.recover.title })).toBeTruthy();
  });
});

describe('the account’s list and its link code', () => {
  const whombat = (over: Partial<ApplianceSummary>): ApplianceSummary => ({
    device: 'dev_4WNBX8QA',
    orgId: 'org_burrowhq',
    name: 'Home',
    state: 'claimed',
    contentPeerId: fakePeerId('home'),
    lastSeenAt: Math.floor(Date.now() / 1000),
    revocationsPending: 0,
    ...over,
  });
  const session = {
    account: { accountId: 'acc_mara', email: 'mara@burrowhq.example', name: 'Mara' },
    orgs: [{ orgId: 'org_burrowhq', name: 'Burrow HQ' }],
  };

  it('shows a Whombat set up at its own address by name only, with nothing to open', () => {
    const onLinkWhombat = vi.fn();
    render(
      <AppliancesScreen
        session={session}
        appliances={[whombat({ ownAddress: true }), whombat({ device: 'dev_7KQ2M4XD', name: 'Studio' })]}
        error={null}
        onOpen={vi.fn()}
        onClaim={vi.fn()}
        onSignOut={vi.fn()}
        onLinkWhombat={onLinkWhombat}
      />,
    );
    const [own, other] = within(screen.getByRole('list', { name: 'Whombats' })).getAllByRole('listitem');
    expect(own?.textContent).toBe(`Home${T.hosted.addressElsewhere}`);
    expect(within(own as HTMLElement).queryByRole('button')).toBeNull();
    expect(within(other as HTMLElement).getByRole('button', { name: 'Open Studio' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a Whombat' })).toBeTruthy();
  });

  it('shows the code once the terms are agreed, with its countdown and the account passkey’s words', async () => {
    const user = userEvent.setup();
    const createWhombatLink = vi.fn(async () => ({ code: 'ABCD-EFGH', expiresAt: '2026-11-18T12:10:00Z' }));
    render(
      <LinkWhombatScreen
        control={{ createWhombatLink, passkeyRegisterOptions: vi.fn(), passkeyRegisterVerify: vi.fn() }}
        orgId="org_burrowhq"
        platform={{ create: vi.fn() }}
        onBack={vi.fn()}
        now={() => Date.parse('2026-11-18T12:00:01Z')}
      />,
    );
    const make = screen.getByRole('button', { name: T.hosted.linkEntry });
    expect((make as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox'));
    await user.click(make);
    expect((await screen.findByTestId('whombat-link-code')).textContent).toBe('ABCD-EFGH');
    expect(screen.getByText(T.hosted.left('9:59'))).toBeTruthy();
    expect(createWhombatLink).toHaveBeenCalledWith('org_burrowhq', { version: expect.any(String) });
    expect(screen.getByText(T.hosted.accountPasskeyWords, { exact: false })).toBeTruthy();
  });
});
