import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MESSAGE_MAX_LENGTH } from '@whombat/core';
import { mara, PRINCIPALS } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { messageFits } from './messageLimit';

describe('message length (AP-327)', () => {
  it('takes 48 000 characters within 48 KiB of JSON', () => {
    expect(messageFits('x'.repeat(MESSAGE_MAX_LENGTH))).toBe(true);
    expect(messageFits('x'.repeat(MESSAGE_MAX_LENGTH + 1))).toBe(false);
    // Within the characters but over 48 KiB of JSON (escaped quotes count twice).
    expect(messageFits('"'.repeat(30_000))).toBe(false);
  });

  it('holds Send and says why while the draft is too long', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Composer
        placeholder="Message #general"
        value={'x'.repeat(MESSAGE_MAX_LENGTH + 1)}
        onValueChange={() => {}}
        onSubmit={onSubmit}
        mentionables={PRINCIPALS}
        viewerId={mara.id}
      />,
    );
    expect(screen.getByText('That message is too long.')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    await user.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
