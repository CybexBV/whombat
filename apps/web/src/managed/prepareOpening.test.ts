import { createFakeAppliance } from '@whombat/client/fake';
import type { KnownAppliance } from '@whombat/client/managed';
import { createSecureSession } from '@whombat/client/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenTiming } from '../app/openTiming';
import { type Opening, prepareOpening } from './prepareOpening';

const known: KnownAppliance = {
  device: 'wb-home',
  peerId: 'pinned-home',
  name: 'Home',
  enrolled: true,
  orgId: 'org-home',
  kitPending: false,
  pinSource: 'claim',
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});

function setup() {
  const box = createFakeAppliance({ handle: async () => ({ status: 200, body: {} }) });
  const open = vi.fn((): Opening => {
    const session = createSecureSession({ connector: box.connector });
    const timing: OpenTiming = { mark: vi.fn() };
    cleanup.push(() => session.close());
    return { session, timing };
  });
  const prepared = prepareOpening(open, 1000);
  cleanup.push(prepared.clear);
  return { box, open, prepared };
}

describe('preparing a trusted appliance', () => {
  it('opens only the session on intent, then hands that session to the selected appliance once', async () => {
    const { box, open, prepared } = setup();
    prepared.prepare(known);
    const opening = open.mock.results[0]?.value as Opening;
    await vi.waitFor(() => expect(opening.session.state().status).toBe('open'));
    prepared.prepare(known);
    prepared.select(known);
    const ready = prepared.take(known);
    expect(ready).toBe(opening);
    expect(open).toHaveBeenCalledTimes(1);
    expect(box.stats().connects).toBe(1);
    expect(box.stats().requestsSeen).toEqual([]);
    expect(opening.timing.mark).toHaveBeenCalledWith('selected');
    prepared.clear();
    expect(ready?.session.state().status).toBe('open');
    expect(prepared.take(known)).toBeUndefined();
  });

  it('closes the old preparation when another appliance is pointed at', () => {
    const { open, prepared } = setup();
    prepared.prepare(known);
    const first = open.mock.results[0]?.value as Opening;
    const other = { ...known, device: 'wb-other', peerId: 'pinned-other' };
    prepared.prepare(other);
    expect(first.session.state()).toMatchObject({ status: 'closed' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(prepared.take(other)).toBe(open.mock.results[1]?.value);
  });

  it('closes unused preparations at their deadline', async () => {
    vi.useFakeTimers();
    const { open, prepared } = setup();
    prepared.prepare(known);
    const opening = open.mock.results[0]?.value as Opening;
    await vi.advanceTimersByTimeAsync(1000);
    expect(opening.session.state()).toMatchObject({ status: 'closed' });
    expect(prepared.take(known)).toBeUndefined();
  });

  it('never hands a prepared connection to a changed identity or an unenrolled record', () => {
    const { open, prepared } = setup();
    prepared.prepare(known);
    const first = open.mock.results[0]?.value as Opening;
    expect(prepared.take({ ...known, peerId: 'different-pin' })).toBeUndefined();
    expect(first.session.state()).toMatchObject({ status: 'closed' });
    prepared.prepare({ ...known, enrolled: false });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('replaces a failed preparation, and cancelling never closes an adopted connection', () => {
    const { open, prepared } = setup();
    prepared.prepare(known);
    const failed = open.mock.results[0]?.value as Opening;
    failed.session.close();
    prepared.select(known);
    expect(open).toHaveBeenCalledTimes(2);
    const ready = prepared.take(known);
    prepared.clear();
    expect(ready?.session.state().status).not.toBe('closed');
  });
});
