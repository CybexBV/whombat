import { describe, expect, it, vi } from 'vitest';
import { killGroup } from './process-group';

describe('killGroup', () => {
  it('signals the whole group: SIGTERM now, SIGKILL after the grace period', () => {
    vi.useFakeTimers();
    try {
      const sent: [number, string][] = [];
      killGroup({ pid: 4242, exitCode: null }, 100, (pid, sig) => void sent.push([pid, sig]));
      expect(sent).toEqual([[-4242, 'SIGTERM']]);
      vi.advanceTimersByTime(100);
      expect(sent).toEqual([
        [-4242, 'SIGTERM'],
        [-4242, 'SIGKILL'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a child without a pid alone and ignores a group that is already gone', () => {
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    killGroup({ exitCode: null }, 1, kill);
    expect(kill).not.toHaveBeenCalled();
    expect(() => killGroup({ pid: 7, exitCode: 0 }, 1, kill)).not.toThrow();
    expect(kill).toHaveBeenCalledWith(-7, 'SIGTERM');
  });
});
