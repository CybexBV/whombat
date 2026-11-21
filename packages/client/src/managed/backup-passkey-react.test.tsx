// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type PasskeySetupFeedback, useBackupPasskeyAction } from './backup-passkey-react';
import { ONE_PASSKEY_TEXT } from './one-passkey';
import { passkeySetupView, PASSKEY_SETUP_TEXT as T } from './passkey-setup';

const empty = passkeySetupView({ hasPasskey: false, linked: false, allLinked: false, bringBack: null });
const ready = passkeySetupView({ hasPasskey: true, linked: true, allLinked: true, bringBack: null });
const incomplete = passkeySetupView({ hasPasskey: true, linked: false, allLinked: false, bringBack: null });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};

describe('one default passkey action', () => {
  it('shares progress and cancellation across navigation, then resumes the same setup', async () => {
    const scope = {};
    const run = deferred<PasskeySetupFeedback>();
    const load = vi.fn().mockResolvedValue(empty);
    const invoke = vi.fn(async (progress?: (note: string) => void) => {
      progress?.('Home · Whombat 1 of 2. Checking saved backups.');
      return run.promise;
    });
    const devices = renderHook(() => useBackupPasskeyAction(scope, invoke, load));
    await waitFor(() => expect(devices.result.current.label).toBe(T.setup));
    let pending!: Promise<PasskeySetupFeedback>;
    await act(async () => {
      pending = devices.result.current();
    });
    const backups = renderHook(() => useBackupPasskeyAction(scope, invoke, load));
    expect(backups.result.current.busy).toBe(true);
    expect(backups.result.current.note).toMatch(/Home.*1 of 2.*saved backups/);
    devices.unmount();
    load.mockResolvedValue(incomplete);
    await act(async () => {
      run.resolve({ note: ONE_PASSKEY_TEXT.cancelled, complete: false });
      await pending;
    });
    expect(backups.result.current.busy).toBe(false);
    expect(backups.result.current.note).toBe(ONE_PASSKEY_TEXT.cancelled);
    expect(backups.result.current.label).toBe(T.finish);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(expect.any(Function));
  });

  it('joins the setup already running from another entry point', async () => {
    const scope = {};
    const run = deferred<PasskeySetupFeedback>();
    const load = vi.fn().mockResolvedValue(empty);
    const first = vi.fn(() => run.promise);
    const second = vi.fn(async () => ({ note: 'failed', complete: false }));
    const overview = renderHook(() => useBackupPasskeyAction(scope, first, load));
    const inbox = renderHook(() => useBackupPasskeyAction(scope, second, load));
    await waitFor(() => expect(overview.result.current.view?.phase).toBe('empty'));
    let a!: Promise<PasskeySetupFeedback>;
    let b!: Promise<PasskeySetupFeedback>;
    act(() => {
      a = overview.result.current();
      b = inbox.result.current();
    });
    expect(a).toBe(b);
    expect(inbox.result.current.busy).toBe(true);
    load.mockResolvedValue(ready);
    await act(async () => {
      run.resolve({ note: 'Everything checked', complete: true });
      expect(await a).toMatchObject({ complete: true });
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(inbox.result.current.view?.action).toBeNull();
    expect(overview.result.current.busy).toBe(false);
  });

  it('keeps pending appliances visible even when the current Whombat is ready', async () => {
    const scope = {};
    const load = vi.fn().mockResolvedValue(ready);
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ note: 'Office is offline', complete: false, pending: true })
      .mockResolvedValueOnce({ note: 'Everything checked', complete: true });
    const first = renderHook(() => useBackupPasskeyAction(scope, invoke, load));
    await waitFor(() => expect(first.result.current.view?.phase).toBe('ready'));
    await act(async () => {
      await first.result.current();
    });
    first.unmount();
    const next = renderHook(() => useBackupPasskeyAction(scope, invoke, load));
    expect(next.result.current.view?.phase).toBe('incomplete');
    expect(next.result.current.label).toBe(T.finish);
    await act(async () => {
      await next.result.current();
    });
    expect(next.result.current.view?.phase).toBe('ready');
  });

  it('keeps Finish setup after an interrupted check, even if the last saved status says ready', async () => {
    const scope = {};
    const load = vi.fn().mockResolvedValue(ready);
    const invoke = vi
      .fn()
      .mockResolvedValue({ note: ONE_PASSKEY_TEXT.cancelled, complete: false, pending: true });
    const devices = renderHook(() => useBackupPasskeyAction(scope, invoke, load));
    await waitFor(() => expect(devices.result.current.view?.phase).toBe('ready'));
    await act(async () => {
      await devices.result.current();
    });
    expect(devices.result.current.view?.phase).toBe('incomplete');
    expect(devices.result.current.label).toBe(T.finish);
    devices.unmount();
    const overview = renderHook(() => useBackupPasskeyAction(scope, invoke, load));
    expect(overview.result.current.label).toBe(T.finish);
    expect(overview.result.current.note).toBe(ONE_PASSKEY_TEXT.cancelled);
  });

  it('does not start a ceremony when account status cannot be read; retry only reloads', async () => {
    const scope = {};
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(empty);
    const invoke = vi.fn();
    const view = renderHook(() => useBackupPasskeyAction(scope, invoke, load));
    await waitFor(() => expect(view.result.current.loadError).toBe(true));
    await act(async () => {
      await view.result.current();
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(view.result.current.view?.phase).toBe('empty');
    expect(view.result.current.loadError).toBe(false);
  });

  it('ignores an older status read while a ceremony finishes', async () => {
    const scope = {};
    const stale = deferred<typeof empty>();
    const run = deferred<PasskeySetupFeedback>();
    const load = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(ready);
    const invoke = vi.fn(() => run.promise);
    const view = renderHook(() => useBackupPasskeyAction(scope, invoke, load));
    await waitFor(() => expect(view.result.current.view?.phase).toBe('empty'));
    await act(async () => {
      void view.result.current.refresh();
    });
    let pending!: Promise<PasskeySetupFeedback>;
    await act(async () => {
      pending = view.result.current();
    });
    await act(async () => {
      run.resolve({ note: 'Ready', complete: true });
      await pending;
    });
    await act(async () => {
      stale.resolve(empty);
    });
    expect(view.result.current.view?.phase).toBe('ready');
  });

  it('keeps appliance sessions separate and releases failed ceremonies', async () => {
    const load = vi.fn().mockResolvedValue(incomplete);
    const invoke = vi.fn().mockRejectedValue(new Error('offline'));
    const aScope = {},
      bScope = {};
    const a = renderHook(() => useBackupPasskeyAction(aScope, invoke, load));
    const b = renderHook(() => useBackupPasskeyAction(bScope, invoke, load));
    await waitFor(() => expect(a.result.current.view?.phase).toBe('incomplete'));
    await act(async () => {
      await expect(a.result.current()).rejects.toThrow('offline');
    });
    expect(a.result.current.busy).toBe(false);
    expect(a.result.current.label).toBe(T.finish);
    expect(b.result.current.note).toBeNull();
  });
});
