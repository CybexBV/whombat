/** The list of Whombats with retired ones (AP-694, AP-695). */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApplianceSummary, ControlSession } from '@whombat/client/managed';
import { describe, expect, it, vi } from 'vitest';
import { AppliancesScreen } from './screens';

const session: ControlSession = {
  account: { accountId: 'acc_mara', email: 'mara@burrowhq.example', name: 'Mara' },
  orgs: [{ orgId: 'org_burrowhq', name: 'Burrow HQ' }],
};

const whombat = (device: string, name: string, state: ApplianceSummary['state']): ApplianceSummary => ({
  device,
  orgId: 'org_burrowhq',
  name,
  state,
  contentPeerId: `12D3KooW${'A'.repeat(44)}`,
  lastSeenAt: Math.floor(Date.now() / 1000),
  revocationsPending: 0,
});

const live = whombat('dev_new', 'New Whombat', 'claimed');
const old = whombat('dev_old', 'Burrow HQ', 'retired');
const never = whombat('dev_never', 'Old Whombat', 'retired');

function list(props: Partial<Parameters<typeof AppliancesScreen>[0]> = {}) {
  const handlers = {
    onOpen: vi.fn(),
    onClaim: vi.fn(),
    onSignOut: vi.fn(),
    onForget: vi.fn(),
    onRecover: vi.fn(),
  };
  render(
    <AppliancesScreen
      session={session}
      appliances={[]}
      error={null}
      remembers={(device) => device === 'dev_old'}
      canRecover={() => true}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('the list with a retired Whombat (AP-695)', () => {
  it('lists a retired Whombat this browser remembers as Retired, to forget, never to open', async () => {
    const user = userEvent.setup();
    const { onForget, onOpen } = list({ appliances: [old, live, never] });
    const rows = within(screen.getByRole('list', { name: 'Whombats' })).getAllByRole('listitem');
    // In use first, then the retired one; one this browser never knew isn't listed.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('New Whombat'),
      'Burrow HQRetiredForget',
    ]);
    const retired = rows[1] as HTMLElement;
    expect(retired.dataset.state).toBe('retired');
    expect(within(retired).getByLabelText('Retired')).toBeTruthy();
    expect(within(retired).queryByRole('button', { name: /^Open/ })).toBeNull();
    expect(within(retired).queryByRole('button', { name: /recovery kit/ })).toBeNull();
    expect(screen.queryByText('Old Whombat')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Forget Burrow HQ' }));
    expect(onForget).toHaveBeenCalledWith(old);
    await user.click(screen.getByRole('button', { name: 'Open New Whombat' }));
    expect(onOpen).toHaveBeenCalledWith(live);
    // A Whombat in use: no empty line.
    expect(screen.queryByText(/^No Whombats/)).toBeNull();
  });

  it('every Whombat retired: the notice, the retired row, “No Whombats in use” and the claim', () => {
    list({ appliances: [old, never], notice: 'Burrow HQ was retired. It can’t be opened any more.' });
    expect(screen.getByRole('status').textContent).toBe(
      'Burrow HQ was retired. It can’t be opened any more.',
    );
    expect(screen.getByText('Retired', { selector: 'span' })).toBeTruthy();
    expect(
      screen.getByText('No Whombats in use. Plug in another one, then claim it with the code on its screen.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim a Whombat' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open/ })).toBeNull();
  });

  it('a retired Whombat this browser never knew: no row, the same empty line', () => {
    list({ appliances: [never] });
    expect(screen.queryByRole('list', { name: 'Whombats' })).toBeNull();
    expect(
      screen.getByText('No Whombats in use. Plug in another one, then claim it with the code on its screen.'),
    ).toBeTruthy();
  });

  it('no Whombats at all: “No Whombats yet”, as before; no notice without one', () => {
    list({ appliances: [] });
    expect(
      screen.getByText('No Whombats yet. Plug yours in, then claim it with the code on its screen.'),
    ).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('still loading: neither rows nor an empty line', () => {
    list({ appliances: null });
    expect(screen.queryByRole('list', { name: 'Whombats' })).toBeNull();
    expect(screen.queryByText(/^No Whombats/)).toBeNull();
  });
});

describe('naming a Whombat on the list (AP-3086)', () => {
  const unnamed: ApplianceSummary = { ...live, device: 'wb-3fkq-8mzt-2049', name: null };

  it('without a way to rename: no Rename', () => {
    list({ appliances: [unnamed] });
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull();
  });

  it('names an unnamed Whombat: its id until then, the typed name trimmed, Esc leaves it', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => null);
    list({ appliances: [unnamed], onRename });
    await user.click(screen.getByRole('button', { name: 'Rename wb-3fkq-8mzt-2049' }));
    const field = screen.getByRole('textbox', { name: 'Name for wb-3fkq-8mzt-2049' });
    expect(field).toBe(document.activeElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onRename).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Rename wb-3fkq-8mzt-2049' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('Give it a name.');
    await user.type(screen.getByRole('textbox'), '  Z13 office ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onRename).toHaveBeenCalledWith(unnamed, 'Z13 office');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps the field open with control’s refusal', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => 'Couldn’t save the name. Try again.');
    list({ appliances: [live], onRename });
    await user.click(screen.getByRole('button', { name: 'Rename New Whombat' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('New Whombat');
    await user.type(screen.getByRole('textbox'), '{Enter}');
    expect(onRename).toHaveBeenCalledWith(live, 'New Whombat');
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t save the name');
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
