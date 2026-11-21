import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { COPY } from '@whombat/client/managed';
import { describe, expect, it, vi } from 'vitest';
import { DemoWorld } from './DemoWorld';
import { SignInScreen } from './screens';

// “Look around without a Whombat” (docs/app/decisions/look-around.md): the sign-in page opens the demo world, which
// says on every screen that it is a demo and goes back with Leave the demo.
describe('look around without a Whombat', () => {
  it('the sign-in page offers it where the page is given the way', async () => {
    const user = userEvent.setup();
    const onLookAround = vi.fn();
    const { unmount } = render(<SignInScreen onSend={async () => {}} onLookAround={onLookAround} />);
    await user.click(screen.getByRole('button', { name: COPY.lookAround.open }));
    expect(onLookAround).toHaveBeenCalledOnce();
    unmount();
    render(<SignInScreen onSend={async () => {}} />);
    expect(screen.queryByRole('button', { name: COPY.lookAround.open })).toBeNull();
  });

  it('opens the mock world, says it is a demo, and Leave the demo goes back', async () => {
    const user = userEvent.setup();
    const onLeave = vi.fn();
    render(<DemoWorld onLeave={onLeave} />);
    const notice = await screen.findByTestId('demo-notice', {}, { timeout: 10_000 });
    expect(notice.textContent).toContain(COPY.lookAround.notice);
    await user.click(screen.getByRole('button', { name: COPY.lookAround.leave }));
    expect(onLeave).toHaveBeenCalledOnce();
  }, 20_000);
});
