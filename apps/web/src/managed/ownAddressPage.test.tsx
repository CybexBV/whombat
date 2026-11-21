/**
 * The box's page at its own address (own-address.md): the claim only with the link from
 * the box's screen, the setup's words only on a box set up there, and the hosted list and its link code.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakePeerId } from '@whombat/client/fake';
import { type ApplianceSummary, BOX_SETUP_TEXT, COPY, OWN_ADDRESS_TEXT } from '@whombat/client/managed';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoxEnvironment } from './boxEnv';

const keys = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./keys', async (original) => ({
  ...(await original<typeof import('./keys')>()),
  loadOrCreateEndpointKey: keys.load,
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
    // Claim, who you are, the passkey, backups, Connect your AI: five steps at the address (LNK-40).
    expect(screen.getByText(BOX_SETUP_TEXT.stepLabel(0, 7))).toBeTruthy();
    expect(screen.getByText(BOX_SETUP_TEXT.steps.passkey.t)).toBeTruthy();
  });

  it('says where the link is when the page has none', async () => {
    await ownBoxPage('/');
    expect(await screen.findByText(T.openOnScreen.sub)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: T.claim.title })).toBeNull();
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
    expect(screen.getByRole('button', { name: T.hosted.linkEntry })).toBeTruthy();
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
