import { describe, expect, it } from 'vitest';
import { sdNotifier } from './sd-notify';

describe('systemd notifications (NX-20, MR-37)', () => {
  it('never pings a watchdog meant for another process', () => {
    const n = sdNotifier({ NOTIFY_SOCKET: '/x', WATCHDOG_USEC: '30000000', WATCHDOG_PID: '7' }, { pid: 8 });
    expect(n?.intervalMs).toBeNull();
  });
});
