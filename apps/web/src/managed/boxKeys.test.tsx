import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { COPY } from '@whombat/client/managed';
import { DIRECT_IDENTITY_UNCLAIMED } from '@whombat/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoxEnvironment } from './boxEnv';

const keys = vi.hoisted(() => ({ load: vi.fn(), remove: vi.fn() }));
vi.mock('./keys', async (original) => ({
  ...(await original<typeof import('./keys')>()),
  loadOrCreateEndpointKey: keys.load,
  deleteEndpointKey: keys.remove,
}));

const { EndpointKeyUnavailableError } = await import('./keys');
const { BoxRoot } = await import('./BoxRoot');

/** The box's Tailscale page: secure, so no plain-HTTP warning comes first. */
const tailscalePage = {
  identity: async () => DIRECT_IDENTITY_UNCLAIMED,
  secure: () => true,
  connector: () => {
    throw new Error('no session without a key');
  },
} as unknown as BoxEnvironment;

afterEach(() => {
  keys.load.mockReset();
  keys.remove.mockReset();
});

describe('the box’s page when this browser has no key it may use', () => {
  it('says the browser is unsupported instead of showing a blank page', async () => {
    keys.load.mockRejectedValue(new EndpointKeyUnavailableError('unsupported'));
    render(<BoxRoot env={tailscalePage} />);
    expect((await screen.findByRole('alert')).textContent).toContain(COPY.connection.unsupported);
  });

  it('explains an older software key and forgets it only when asked', async () => {
    keys.load.mockRejectedValue(new EndpointKeyUnavailableError('weakKey'));
    keys.remove.mockResolvedValue(undefined);
    render(<BoxRoot env={tailscalePage} />);
    const forget = await screen.findByRole('button', { name: COPY.connection.weakKeyForget });
    expect(keys.remove).not.toHaveBeenCalled();
    await userEvent.click(forget);
    expect(keys.remove).toHaveBeenCalledOnce();
  });
});
