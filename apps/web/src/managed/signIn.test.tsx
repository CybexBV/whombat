import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SignInScreen } from './screens';

// The sign-in gate (control BL-33): outside `open` mode control mails only accounts, invited addresses and code
// holders, so the page says so before anyone types, and never claims a link was sent.
describe('sign in by signup mode (BL-33)', () => {
  const send = async (mode: 'open' | 'invite' | 'waitlist', held = false) => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => {});
    render(<SignInScreen onSend={onSend} mode={mode} held={held} onWaitlist={() => {}} />);
    return { user, onSend };
  };

  it('open: the usual copy', async () => {
    const { user } = await send('open');
    expect(screen.getByText('We’ll email you a sign-in link. There’s no password to remember.')).toBeTruthy();
    await user.type(screen.getByLabelText('Email'), 'a@b.example');
    await user.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(
      await screen.findByText('We sent a sign-in link to a@b.example. Open it on this device.'),
    ).toBeTruthy();
  });

  it('invite only: the notice first, and a neutral line after sending', async () => {
    const { user, onSend } = await send('invite');
    expect(
      screen.getByText(
        'Whombat is invite-only for now. Sign in with the email address your invitation was sent to.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).toBeNull();
    await user.type(screen.getByLabelText('Email'), 'a@b.example');
    await user.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(onSend).toHaveBeenCalledWith('a@b.example');
    expect(
      await screen.findByText(
        'If you’re invited or already have an account, we sent a sign-in link to a@b.example. Open it on this device.',
      ),
    ).toBeTruthy();
  });

  it('waitlist: offers the waitlist; a held code hides the notice', async () => {
    await send('waitlist');
    expect(screen.getByRole('button', { name: 'Join the waitlist' })).toBeTruthy();
    expect(screen.getByText(/Whombat has a waitlist for now/)).toBeTruthy();
  });

  it('a held invite code: the usual sub line', async () => {
    await send('invite', true);
    expect(screen.getByText('We’ll email you a sign-in link. There’s no password to remember.')).toBeTruthy();
  });
});
