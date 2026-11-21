import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { durations } from '@whombat/tokens';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Modal } from './Modal';
import { StatusDot } from './StatusDot';
import { ACTION_TOAST_MS, ToastProvider, useToast } from './Toast';
import { ToggleRow } from './Toggle';

afterEach(() => {
  vi.useRealTimers();
});

describe('Toggle', () => {
  it('toggles from its row label; locked rows stay off and explain why', () => {
    function Rows() {
      const [on, setOn] = useState(false);
      return (
        <>
          <ToggleRow label="Open pull requests" checked={on} onCheckedChange={setOn} />
          <ToggleRow label="Merge into main" checked onCheckedChange={() => {}} locked note="people only" />
        </>
      );
    }
    render(<Rows />);
    fireEvent.click(screen.getByText('Open pull requests'));
    expect(screen.getByRole('switch', { name: 'Open pull requests' }).getAttribute('aria-checked')).toBe(
      'true',
    );

    const locked = screen.getByRole('switch', { name: 'Merge into main' });
    expect(locked.getAttribute('aria-checked')).toBe('false');
    expect(locked.hasAttribute('disabled')).toBe(true);
    expect(locked.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(locked.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'people only',
    );
  });
});

describe('Modal', () => {
  it('returns focus to what had it when it opened', async () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open</Button>
          <Modal open={open} title="Browse channels" onOpenChange={setOpen}>
            <Button>Inside</Button>
          </Modal>
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Browse channels' });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Radix hands focus back a tick after closing.
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe('Toast', () => {
  function Trigger() {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast.show('Exported 14 signed events as CSV.')}>
        Export CSV
      </button>
    );
  }

  it('shows in a live region and auto-dismisses after 2.6s', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(screen.getByRole('status').textContent).toBe('Exported 14 signed events as CSV.');

    act(() => vi.advanceTimersByTime(durations.toast - 1));
    expect(screen.getByRole('status').textContent).toBe('Exported 14 signed events as CSV.');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  /** Shows what `run` asks for and records how each toast ended. */
  function Driver({ run }: { run: (toast: ReturnType<typeof useToast>) => void }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => run(toast)}>
        Go
      </button>
    );
  }

  it('shows two at once, the oldest leaving for a third; the same words replace each other (WX-09)', () => {
    vi.useFakeTimers();
    const ends: string[] = [];
    render(
      <ToastProvider>
        <Driver
          run={(toast) => {
            toast.show('One.', { onEnd: (how) => ends.push(`one:${how}`) });
            toast.show('Two.');
            toast.show('Two.');
            toast.show('Three.');
          }}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByRole('status').textContent).toBe('Two.Three.');
    expect(ends).toEqual(['one:replaced']);
  });

  it('takes an action, ends with it, and waits while the pointer is over it (WX-09)', () => {
    vi.useFakeTimers();
    const ends: string[] = [];
    let undone = 0;
    render(
      <ToastProvider>
        <Driver
          run={(toast) =>
            toast.show('Message deleted.', {
              action: { label: 'Undo', onAction: () => undone++ },
              onEnd: (how) => ends.push(how),
            })
          }
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    const region = screen.getByRole('status');
    fireEvent.pointerEnter(region);
    act(() => vi.advanceTimersByTime(ACTION_TOAST_MS * 2));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(ACTION_TOAST_MS - 1));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undone).toBe(1);
    expect(ends).toEqual(['action']);
    expect(region.textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    act(() => vi.advanceTimersByTime(ACTION_TOAST_MS));
    expect(ends).toEqual(['action', 'timeout']);
  });
});

describe('small helpers', () => {
  it('labels status dots for assistive tech', () => {
    render(<StatusDot status="waiting" />);
    expect(screen.getByRole('img', { name: 'Waiting' })).toBeTruthy();
  });
});
