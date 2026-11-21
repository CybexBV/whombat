import { describe, expect, it } from 'vitest';
import { readBackCopy } from './readBackCopy';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

const tick = () => new Promise((ok) => setTimeout(ok, 0));

describe('the copy read back from the phone', () => {
  it('names its account when it comes in time, before the first screen', async () => {
    const seen: string[] = [];
    readBackCopy(Promise.resolve('acct:gen1'), 1500, {
      restored: (a, late) => seen.push(`${a}${late ? ' late' : ''}`),
      ready: () => seen.push('ready'),
    });
    await tick();
    expect(seen).toEqual(['acct:gen1', 'ready']);
  });

  it('names its account when it comes after the first screen too, so a foreign one is dropped', async () => {
    const copy = deferred<string | null>();
    const timeout = deferred<void>();
    const seen: string[] = [];
    readBackCopy(
      copy.promise,
      1500,
      { restored: (a, late) => seen.push(`${a}${late ? ' late' : ''}`), ready: () => seen.push('ready') },
      () => timeout.promise,
    );
    timeout.resolve();
    await tick();
    expect(seen).toEqual(['ready']);
    copy.resolve('acct:gen1');
    await tick();
    expect(seen).toEqual(['ready', 'acct:gen1 late']);
  });

  it('says nothing once the Whombat is left', async () => {
    const copy = deferred<string | null>();
    const seen: string[] = [];
    const stop = readBackCopy(
      copy.promise,
      1500,
      { restored: () => seen.push('r'), ready: () => seen.push('ready') },
      () => Promise.resolve(),
    );
    await tick();
    stop();
    copy.resolve('acct:gen1');
    await tick();
    expect(seen).toEqual(['ready']);
  });
});
