import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorNote, SkeletonRows } from './ListState';

describe('SkeletonRows', () => {
  it('renders the requested number of hidden placeholder rows', () => {
    const { container } = render(<SkeletonRows count={3} avatarSize={36} lines={2} />);
    const root = container.querySelector('[data-state="loading"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.children.length).toBe(3);
  });
});

describe('ErrorNote', () => {
  it('shows the message and calls onRetry when Retry is clicked', () => {
    const onRetry = vi.fn();
    render(<ErrorNote message="Couldn’t load this. Try again in a moment." onRetry={onRetry} />);
    expect(screen.getByText('Couldn’t load this. Try again in a moment.')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the Retry button when there is nothing to retry', () => {
    render(<ErrorNote message="This request isn’t here any more." />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
