import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BillingView, SignupInfo } from '@whombat/client/managed';
import { SUBSCRIPTION_TERMS_VERSION } from '@whombat/control-contracts';
import { describe, expect, it, vi } from 'vitest';
import { BillingScreen, type BillingScreenProps } from './BillingScreen';
import { ClaimRefusalNotice, CreateOrgScreen } from './screens';

const info = (mode: SignupInfo['mode'] = 'open'): SignupInfo => ({
  mode,
  billing: 'stripe',
  trialDays: 14,
  termsVersion: SUBSCRIPTION_TERMS_VERSION,
  // One plan at €49 a month (Whombat one-person.md OP-18).
  plans: [
    {
      id: 'whombat',
      name: 'Whombat',
      amountCents: 4900,
      currency: 'eur',
      interval: 'month',
      limits: { connectors: null },
    },
  ],
});

const view = (over: Partial<BillingView> = {}): BillingView => ({
  org: 'org_1',
  provider: 'stripe',
  plan: null,
  state: 'cancelled',
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  whombats: { claimed: 0, paid: 0 },
  setupRequired: true,
  trialAvailable: true,
  manual: false,
  ...over,
});

const billing = (over: Partial<BillingScreenProps> = {}) => {
  const props: BillingScreenProps = {
    view: view(),
    info: info(),
    checkout: null,
    onRetry: vi.fn(),
    onCheckout: vi.fn(async () => {}),
    onPortal: vi.fn(async () => {}),
    onAddWhombat: vi.fn(async () => {}),
    onClaim: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  render(<BillingScreen {...props} />);
  return props;
};

describe('the Billing page', () => {
  it('offers the plan from signup.info, the stepper and the trial; no people per plan', async () => {
    const user = userEvent.setup();
    const props = billing();
    expect(screen.getByRole('heading', { name: 'Choose your plan' })).toBeTruthy();
    expect(screen.getByText('€49 per Whombat a month')).toBeTruthy();
    expect(screen.queryByText(/people/)).toBeNull();
    expect(
      screen.getByText('Prices exclude VAT. You won’t be charged until your trial ends. Cancel anytime.'),
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'One Whombat fewer' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole('radio', { name: /Whombat/ }));
    await user.click(screen.getByRole('button', { name: 'One Whombat more' }));
    await user.click(screen.getByRole('button', { name: 'One Whombat more' }));
    expect(screen.getByText('Total €147 a month')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start 14-day free trial' }));
    expect(props.onCheckout).toHaveBeenCalledWith('whombat', 3);
  });

  it('says Subscribe without a trial, and shows a refusal', async () => {
    const user = userEvent.setup();
    const { ControlError } = await import('@whombat/client/managed');
    billing({
      view: view({ trialAvailable: false }),
      onCheckout: vi.fn(async () => {
        throw new ControlError('billing_provider_error', 'x');
      }),
    });
    expect(screen.getByText('Prices exclude VAT. Cancel anytime.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Subscribe' }));
    expect(
      await screen.findByText('Our payment provider didn’t answer. Try again in a moment.'),
    ).toBeTruthy();
  });

  it('shows the subscription, and adds a Whombat only after a confirmation', async () => {
    const user = userEvent.setup();
    const props = billing({
      view: view({
        plan: { id: 'whombat', name: 'Whombat' },
        state: 'active',
        currentPeriodEnd: Date.UTC(2026, 10, 1, 12) / 1000,
        setupRequired: false,
        whombats: { claimed: 1, paid: 1 },
      }),
    });
    expect(screen.getAllByText('Whombat').length).toBeGreaterThan(0);
    expect(screen.getByText('Active · renews 1 November 2026')).toBeTruthy();
    expect(screen.getByText('1 of 1')).toBeTruthy();
    // No room to claim: Manage billing is the primary action.
    expect(screen.queryByRole('button', { name: 'Claim a Whombat' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add a Whombat' }));
    expect(props.onAddWhombat).not.toHaveBeenCalled();
    expect(screen.getByText('Pay for 2 Whombats from now on? The difference is prorated.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add it' }));
    expect(props.onAddWhombat).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole('button', { name: 'Manage billing' }));
    expect(props.onPortal).toHaveBeenCalled();
  });

  it('has no buttons for a plan Whombat manages', () => {
    billing({
      view: view({
        provider: 'manual',
        manual: true,
        plan: { id: 'free', name: 'Free' },
        state: 'active',
        setupRequired: false,
      }),
    });
    expect(screen.getByText('Your plan is managed by Whombat.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a Whombat' })).toBeNull();
  });

  it('waits after Checkout, then offers to check again', async () => {
    const user = userEvent.setup();
    const props = billing({ checkout: 'waiting' });
    expect(screen.getByRole('status').textContent).toBe('Setting up your subscription…');
    render(<BillingScreen {...props} checkout="slow" />);
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(props.onRetry).toHaveBeenCalled();
  });
});

describe('the create-org screen', () => {
  const org = (mode: SignupInfo['mode'], heldCode: string | null = null) => {
    const onCreate = vi.fn(async () => {});
    const onWaitlist = vi.fn(async () => {});
    render(
      <CreateOrgScreen
        info={info(mode)}
        heldCode={heldCode}
        email="mara@burrowhq.example"
        onCreate={onCreate}
        onWaitlist={onWaitlist}
      />,
    );
    return { onCreate, onWaitlist };
  };

  it('needs the company name and the Subscription Terms', async () => {
    const user = userEvent.setup();
    const { onCreate } = org('open');
    const go = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(screen.queryByLabelText('Invite code')).toBeNull();
    await user.type(screen.getByLabelText('Company name'), 'Burrow HQ');
    expect(go.disabled).toBe(true);
    const link = screen.getByRole('link', { name: 'Whombat Subscription Terms' });
    expect(link.getAttribute('href')).toBe('/legal/subscription-terms');
    await user.click(screen.getByRole('checkbox', { name: 'I agree to the Whombat Subscription Terms' }));
    await user.click(go);
    expect(onCreate).toHaveBeenCalledWith({ name: 'Burrow HQ', code: null });
  });

  it('invite-only: a code is required, and sent normalised', async () => {
    const user = userEvent.setup();
    const { onCreate } = org('invite');
    expect(screen.getByText('Whombat is invite-only for now. Enter your invite code.')).toBeTruthy();
    await user.type(screen.getByLabelText('Company name'), 'Burrow HQ');
    await user.click(screen.getByRole('checkbox', { name: 'I agree to the Whombat Subscription Terms' }));
    const go = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await user.type(screen.getByLabelText('Invite code'), 'nope');
    await user.click(go);
    expect(screen.getByText('That invite code doesn’t work. Check it, or ask for a new one.')).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Invite code'));
    await user.type(screen.getByLabelText('Invite code'), '7kq2 m4xd');
    await user.click(go);
    expect(onCreate).toHaveBeenCalledWith({ name: 'Burrow HQ', code: '7KQ2-M4XD' });
  });

  it('a held code fills the field, also in open mode', () => {
    org('open', '7kq2m4xd');
    expect((screen.getByLabelText('Invite code') as HTMLInputElement).value).toBe('7KQ2-M4XD');
  });

  it('waitlist mode: the waitlist first, “I have an invite code” for the form', async () => {
    const user = userEvent.setup();
    const { onWaitlist } = org('waitlist');
    expect(screen.getByRole('heading', { name: 'Join the waitlist' })).toBeTruthy();
    expect((screen.getByLabelText('Work email') as HTMLInputElement).value).toBe('mara@burrowhq.example');
    await user.type(screen.getByLabelText('Company'), 'Burrow HQ');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));
    expect(onWaitlist).toHaveBeenCalledWith({
      email: 'mara@burrowhq.example',
      company: 'Burrow HQ',
      note: '',
    });
    expect(await screen.findByRole('heading', { name: 'You’re on the waitlist' })).toBeTruthy();
  });

  it('waitlist mode with a code: the form', async () => {
    const user = userEvent.setup();
    org('waitlist');
    await user.click(screen.getByRole('button', { name: 'I have an invite code' }));
    expect(screen.getByLabelText('Invite code')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'No invite code? Join the waitlist' }));
    expect(screen.getByRole('heading', { name: 'Join the waitlist' })).toBeTruthy();
  });
});

describe('a claim refusal with a way out', () => {
  it('runs its action', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn(async () => {});
    render(
      <ClaimRefusalNotice
        text="This Whombat already had a free trial. Start your subscription today to add it."
        action="Start subscription now"
        onAction={onAction}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('already had a free trial');
    await user.click(screen.getByRole('button', { name: 'Start subscription now' }));
    expect(onAction).toHaveBeenCalled();
  });
});
