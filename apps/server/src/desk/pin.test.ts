import { describe, expect, it } from 'vitest';
import { hashPin, newPinRefusal, PIN_BACKOFF_MAX_MS, pinBackoffMs, pinTriesLeft, verifyPin } from './pin';

describe('the desk PIN (DK-04)', () => {
  it('keeps a salted scrypt hash that only the same six digits match', async () => {
    const a = await hashPin('482193');
    const b = await hashPin('482193');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('482193');
    expect(await verifyPin('482193', a)).toBe(true);
    expect(await verifyPin('482194', a)).toBe(false);
    expect(await verifyPin('482193', 'plain$482193')).toBe(false);
    expect(await verifyPin('482193', a.replace(/\$[\w-]+$/, '$short'))).toBe(false);
  });

  it('takes 4 to 6 digits and refuses those too easy to guess (DK-26, DK-27)', async () => {
    for (const pin of ['2580', '52031', '860417']) expect(newPinRefusal(pin)).toBeNull();
    for (const pin of ['0000', '1234', '8901', '4321', '1212', '123123'])
      expect(newPinRefusal(pin), pin).toBe('easy_pin');
    for (const pin of ['258', '2580417', '２５８０', ' 2580']) expect(newPinRefusal(pin), pin).toBe('shape');
    expect(await verifyPin('2580', await hashPin('2580'))).toBe(true);
  });

  it('waits after five wrong ones: 1 minute, doubling, at most an hour', () => {
    expect([0, 1, 4].map(pinBackoffMs)).toEqual([0, 0, 0]);
    expect(pinBackoffMs(5)).toBe(60_000);
    expect(pinBackoffMs(6)).toBe(120_000);
    expect(pinBackoffMs(7)).toBe(240_000);
    expect(pinBackoffMs(11)).toBe(PIN_BACKOFF_MAX_MS);
    expect(pinBackoffMs(500)).toBe(PIN_BACKOFF_MAX_MS);
    expect([0, 3, 4, 5, 9].map(pinTriesLeft)).toEqual([5, 2, 1, 0, 0]);
  });
});
