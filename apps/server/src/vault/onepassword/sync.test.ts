/**
 * When the 1Password sync runs (docs/decisions/onepassword-sync.md OPW-S12): a pass asked for by a command (adding the
 * connection, Sync now, a change to an entry) runs on its own, outside that command, so its commits never land on the
 * command's receipt, which may be settled by then; and a database that fails is logged, never left as a rejection.
 */
import { describe, expect, it, vi } from 'vitest';
import { type CommandScope, currentCommandScope, runInCommandScope } from '../../commit/scope';
import type { Services } from '../../services';
import { OnePasswordSync } from './sync';

describe('a pass asked for inside a command', () => {
  it('runs outside that command', async () => {
    let seen: CommandScope | null | 'not yet' = 'not yet';
    // The pass looks at the maintenance pause first; answering “paused” ends it there.
    const services = {
      config: { NODE_ENV: 'test' },
      schemaAccess: 'read-write',
      maintenance: {
        get paused() {
          seen = currentCommandScope();
          return true;
        },
        held: false,
      },
    } as unknown as Services;
    const sync = new OnePasswordSync(services);
    const scope: CommandScope = {
      active: true,
      accepted: false,
      op: 'connections.create',
      beforeCommit: async () => {},
      afterCommit: () => {},
    };
    await runInCommandScope(scope, async () => {
      expect(currentCommandScope()).toBe(scope);
      sync.request(0);
    });
    await vi.waitFor(() => expect(seen).not.toBe('not yet'));
    expect(seen).toBeNull();
    await sync.close();
  });
});

describe('a database that fails', () => {
  it('is logged by its name, and the pass never leaves a rejected promise', async () => {
    const warn = vi.fn();
    const services = {
      config: { NODE_ENV: 'test' },
      schemaAccess: 'read-write',
      maintenance: { paused: false, held: null },
      db: {
        select: () => {
          throw new TypeError('connection to the database refused');
        },
      },
      log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as Services;
    const sync = new OnePasswordSync(services);
    sync.request(0);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0]?.[0]).toEqual({ err: 'TypeError' });
    await sync.close();
  });
});
