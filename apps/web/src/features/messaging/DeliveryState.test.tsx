import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createClient, OutcomeUnknownError } from '@whombat/client';
import { sendRequestId, WhombatClientProvider } from '@whombat/client/react';
import { type ApplianceSession, type CommandStatus, createCommandTracker } from '@whombat/client/session';
import type { Message } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { describe, expect, it, vi } from 'vitest';
import { DELIVERY_TEXT, DeliveryState } from './DeliveryState';

describe('a message’s delivery state (AP-14, AP-579)', () => {
  it('keeps Check again while the Whombat says it is still working on it, until it is done', async () => {
    const user = userEvent.setup();
    const answers: CommandStatus[] = [
      { state: 'executing' },
      { state: 'accepted' },
      { state: 'completed', response: { status: 200, body: undefined, requestId: 'r' }, redacted: true },
    ];
    const session = {
      status: vi.fn(async () => answers.shift() as CommandStatus),
    } as unknown as ApplianceSession;
    const commands = createCommandTracker(() => session);
    const message = { id: 'msg_1', clientId: 'cli_0123456789abcd', conversationId: 'cnv_general' } as Message;
    const requestId = sendRequestId(message.clientId as string);
    commands.begin({
      requestId,
      endpoint: api.messages.send,
      input: { params: { burrow: 'b', conversationId: 'cnv_general' }, query: {}, body: { text: 'hi' } },
      label: 'Message',
    });
    commands.settle(requestId, {
      ok: false,
      error: new OutcomeUnknownError('messages.send', requestId, { acknowledged: true }),
    });
    const client = createClient({ session });
    render(
      <WhombatClientProvider client={client} queryClient={new QueryClient()} commands={commands}>
        <DeliveryState message={message} onResend={() => {}} />
      </WhombatClientProvider>,
    );
    expect(screen.getByText('Not confirmed yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: DELIVERY_TEXT.checkAgain }));
    // Still running: said so, and it can be checked again (no dead end).
    await waitFor(() => expect(screen.getByText('Received · working on it')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: DELIVERY_TEXT.checkAgain }));
    await waitFor(() => expect(session.status).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: DELIVERY_TEXT.checkAgain })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: DELIVERY_TEXT.checkAgain }));
    // Done, its answer not kept (CT-195): nothing more to say.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.queryByRole('button', { name: DELIVERY_TEXT.sendAgain })).toBeNull();
  });
});
