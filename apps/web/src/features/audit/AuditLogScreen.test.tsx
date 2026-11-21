import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/renderApp';

async function log() {
  return screen.findByRole('heading', { name: 'Audit log' });
}

describe('AuditLogScreen (fixture bootstrap)', () => {
  beforeEach(() => {
    // jsdom has no object URL implementation; the CSV download flow needs a stub.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to evt_9f18 expanded, as the mock opens it', async () => {
    renderApp('/log');
    await log();
    const row = await screen.findByRole('button', {
      name: /Asked to deploy feat\/invoice-pdf to staging/,
    });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('SIGNED BY')).toBeTruthy();
    expect(screen.getByText('KEY USED')).toBeTruthy();
    expect(screen.getByText('ON BEHALF OF')).toBeTruthy();
    expect(screen.getByText('DECIDED')).toBeTruthy();
    expect(screen.getByText(/signature verified/)).toBeTruthy();
    expect(screen.getByText('WAITING ON A PERSON')).toBeTruthy();
  });

  it('toggles a row open and closed by its raw event id', async () => {
    const user = userEvent.setup();
    renderApp('/log');
    await log();
    const row = await screen.findByRole('button', {
      name: /Asked to deploy feat\/invoice-pdf to staging/,
    });
    expect(row.getAttribute('aria-expanded')).toBe('true');

    await user.click(row);
    await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('false'));
    expect(screen.queryByText('SIGNED BY')).toBeNull();

    await user.click(row);
    await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('true'));
  });

  it('closing a different, explicitly-opened row does not reopen the default evt_9f18 row', async () => {
    const user = userEvent.setup();
    renderApp('/log');
    await log();
    const defaultRow = await screen.findByRole('button', {
      name: /Asked to deploy feat\/invoice-pdf to staging/,
    });
    expect(defaultRow.getAttribute('aria-expanded')).toBe('true');

    const otherRow = await screen.findByRole('button', {
      name: /Requested 2 changes on PR #482/,
    });
    expect(otherRow.getAttribute('aria-expanded')).toBe('false');

    // Open a different row — the default closes (only one row is open at a time).
    await user.click(otherRow);
    await waitFor(() => expect(otherRow.getAttribute('aria-expanded')).toBe('true'));
    expect(defaultRow.getAttribute('aria-expanded')).toBe('false');

    // Close it again: the log should stay fully closed, not fall back to reopening the default.
    await user.click(otherRow);
    await waitFor(() => expect(otherRow.getAttribute('aria-expanded')).toBe('false'));
    expect(defaultRow.getAttribute('aria-expanded')).toBe('false');
  });

  it('narrows by kind and reflects the filter in the URL', async () => {
    const user = userEvent.setup();
    const app = renderApp('/log');
    await log();
    await user.click(screen.getByRole('button', { name: /^Blocked/ }));
    await waitFor(() => expect(app.location()).toContain('kind=blocked'));
    for (const row of screen.getAllByRole('button', { name: /·/ })) {
      expect(within(row).getByText('BLOCKED')).toBeTruthy();
    }
  });

  it('filters by agent and shows the "Only {agent} ×" chip', async () => {
    const app = renderApp('/log?actor=agents&who=neo');
    await log();
    const chip = await screen.findByRole('button', { name: /Remove filter: Only Neo/ });
    expect(chip.textContent).toMatch(/Only\s*Neo/);
    expect(app.location()).toContain('who=neo');

    const user = userEvent.setup();
    await user.click(chip);
    await waitFor(() => expect(app.location()).not.toContain('who=neo'));
  });

  it('shows the empty state when no events match', async () => {
    // No person has a Blocked event in the fixture, so this combination is genuinely empty
    // (unlike `kind=keys`, which a person does have — see docs/decisions/states.md).
    renderApp('/log?actor=people&kind=blocked');
    await log();
    expect(await screen.findByText('Nothing in the log matches these filters.')).toBeTruthy();
  });

  it('exports the filtered log as CSV and toasts the row count', async () => {
    const user = userEvent.setup();
    renderApp('/log');
    await log();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/Exported \d+ signed events as CSV\./);
  });
});
