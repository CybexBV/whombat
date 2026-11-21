/** The device's sealed storage (AP-717): encrypted, scoped, wiped with its key. */
import { defaultCrypto } from '@libp2p/noise/crypto';
import { describe, expect, it, vi } from 'vitest';
import { type BoxCrypto, createSecureBox, memoryBoxDeps, PREFETCH_KEEP_MS } from './secureBox';

const crypto = defaultCrypto as unknown as BoxCrypto;

describe('the secure box (AP-717)', () => {
  it('keeps values sealed: no plaintext and no scope on disk, the key only in the keystore', async () => {
    const deps = memoryBoxDeps(crypto);
    const box = createSecureBox(deps);
    await box.save('managed:org_1/dev_1', 'queries', { text: 'quarterly invoice for Acme' });
    expect(await box.load('managed:org_1/dev_1', 'queries')).toEqual({ text: 'quarterly invoice for Acme' });
    const [[name, bytes] = ['', new Uint8Array()]] = [...deps.stored];
    expect(name).toMatch(/^[0-9a-f]{40}\.bin$/);
    const raw = new TextDecoder().decode(bytes);
    expect(raw).not.toContain('Acme');
    expect(raw).not.toContain('org_1');
    expect(deps.keyValue()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads nothing of another scope or name, even from a copied file', async () => {
    const deps = memoryBoxDeps(crypto);
    const box = createSecureBox(deps);
    await box.save('managed:org_1/dev_1', 'outbox', [1, 2]);
    expect(await box.load('managed:org_1/dev_2', 'outbox')).toBeNull();
    // The file moved under the other scope's name doesn't open (the scope is the AEAD's associated data) and goes.
    await box.save('managed:org_1/dev_2', 'outbox', [3]);
    const names = [...deps.stored.keys()];
    const [mine, theirs] = names;
    deps.stored.set(theirs as string, deps.stored.get(mine as string) as Uint8Array);
    expect(await box.load('managed:org_1/dev_2', 'outbox')).toBeNull();
    expect(deps.stored.has(theirs as string)).toBe(false);
    expect(await box.load('managed:org_1/dev_1', 'outbox')).toEqual([1, 2]);
  });

  it('drops a damaged file', async () => {
    const deps = memoryBoxDeps(crypto);
    const box = createSecureBox(deps);
    await box.save('s', 'n', { a: 1 });
    const [name, bytes] = [...deps.stored][0] as [string, Uint8Array];
    const bad = bytes.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    deps.stored.set(name, bad);
    expect(await box.load('s', 'n')).toBeNull();
    expect(deps.stored.size).toBe(0);
  });

  it('wipes every scope and the key; what was left behind can’t be read with the next key', async () => {
    const deps = memoryBoxDeps(crypto);
    const box = createSecureBox(deps);
    await box.save('a', 'queries', 1);
    await box.save('b', 'outbox', 2);
    const leftover = [...deps.stored][0] as [string, Uint8Array];
    await box.wipe();
    expect(deps.stored.size).toBe(0);
    expect(deps.keyValue()).toBeNull();
    await box.save('c', 'queries', 3);
    deps.stored.set(leftover[0], leftover[1]);
    expect(await box.load('a', 'queries')).toBeNull();
    expect(await box.load('c', 'queries')).toBe(3);
  });

  it('a new box on the same device reads what the last one saved (the next launch)', async () => {
    const deps = memoryBoxDeps(crypto);
    await createSecureBox(deps).save('s', 'n', { kept: true });
    expect(await createSecureBox(deps).load('s', 'n')).toEqual({ kept: true });
  });

  it('a read started ahead is what the next load gets, once; a change or a wipe drops it (AP-920)', async () => {
    const deps = memoryBoxDeps(crypto);
    await createSecureBox(deps).save('s', 'n', { v: 1 });
    const box = createSecureBox(deps);
    const reads = vi.spyOn(deps.files, 'read');
    box.prefetch('s', 'n');
    box.prefetch('s', 'n');
    expect(await box.load('s', 'n')).toEqual({ v: 1 });
    expect(reads).toHaveBeenCalledTimes(1);
    // Taken: the next load reads again.
    expect(await box.load('s', 'n')).toEqual({ v: 1 });
    expect(reads).toHaveBeenCalledTimes(2);
    // Saved after the read ahead started: the load reads what was saved.
    box.prefetch('s', 'n');
    await box.save('s', 'n', { v: 2 });
    expect(await box.load('s', 'n')).toEqual({ v: 2 });
    box.prefetch('s', 'n');
    await box.wipe();
    expect(await box.load('s', 'n')).toBeNull();
  });

  it('a read ahead nobody takes is dropped after a while', async () => {
    vi.useFakeTimers();
    try {
      const deps = memoryBoxDeps(crypto);
      const box = createSecureBox(deps);
      await box.save('s', 'n', { v: 1 });
      const reads = vi.spyOn(deps.files, 'read');
      box.prefetch('s', 'n');
      await vi.advanceTimersByTimeAsync(PREFETCH_KEEP_MS);
      expect(await box.load('s', 'n')).toEqual({ v: 1 });
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
