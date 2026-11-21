import { cleanup, configure } from '@testing-library/react';
import { setInstallPollMsForTests } from '@whombat/client/hosts';
import { failOnLeftOut } from '@whombat/client/testing/contract-tripwire';
import { afterEach } from 'vitest';
import { setBluetoothPollMsForTests } from '../features/machine/useMachine';
import { clearDrafts } from '../features/messaging/drafts';
import { resetPendingDeletes } from '../features/messaging/pendingDeletes';

// The default 1000ms `findBy*`/`waitFor` timeout is tuned for an idle machine; on a loaded CI runner
// (many workers, shared cores) a genuine async round trip — a mutation followed by a refetch, a
// simulated agent reply — can take longer than that even though nothing is actually stuck. Widening it
// only affects how long a *failing* assertion waits before giving up: passing assertions still resolve
// as soon as the DOM changes (findBy*/waitFor resolve on mutation, not on a timer). See
// docs/decisions/polish-ci.md.
configure({ asyncUtilTimeout: 5000 });

// A server's install job is read again every 2 s and Bluetooth every second while it pairs: a test waiting for the next
// step would wait on the clock. Here both are read again after 20 ms, so the tests wait on what changed.
setInstallPollMsForTests(20);
setBluetoothPollMsForTests(20);

// jsdom lays nothing out, so it has no `scrollIntoView`: the router's hash scrolling and Settings' anchors
// (`?tab=ai#usage`, settings-simplify.md SS-02) call it; here it does nothing.
// A test file in the node environment (`@vitest-environment node`, e.g. the key store's) has no DOM at all.
const dom = typeof document !== 'undefined';
if (dom && !Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

// Nor `ResizeObserver`, which Radix's switch measures itself with inside a form; here it observes nothing. A test that
// stubs its own (charts) replaces this one.
if (!('ResizeObserver' in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

// A fake answer that no longer matches the contract fails its test (`expectLeftOut` for a test about it).
failOnLeftOut();

afterEach(() => {
  if (!dom) return;
  cleanup();
  // Theme choice and other local state must not leak between tests.
  localStorage.clear();
  sessionStorage.clear();
  // Drafts and deletes waiting for their Undo live outside the tree (WX-05, WX-09).
  clearDrafts();
  resetPendingDeletes();
  delete document.documentElement.dataset.theme;
});
