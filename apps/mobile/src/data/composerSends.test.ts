import { MutationObserver, QueryClient } from '@tanstack/query-core';
import { describe, expect, it } from 'vitest';
import { filesToSend, sendWithFollowUp } from './composerSends';

/** A send whose answers come when the test says so, through TanStack's own observer (what `useMutation` uses). */
function sender() {
  const answers: ((id: string) => void)[] = [];
  const observer = new MutationObserver<string, Error, string>(new QueryClient(), {
    mutationFn: (text) => new Promise<string>((ok) => answers.push(() => ok(`sent:${text}`))),
  });
  // Subscribed, as `useMutation` keeps it.
  observer.subscribe(() => {});
  return { send: (v: string) => observer.mutate(v), answer: (i: number) => answers[i]?.('') };
}

const tick = () => new Promise((ok) => setTimeout(ok, 0));

describe('two messages sent close together', () => {
  it('each runs its own follow-up, the first one too', async () => {
    const { send, answer } = sender();
    const done: string[] = [];
    const onTheirWay = new Set<string>();
    const then = { done: (r: string) => done.push(r), failed: () => done.push('failed') };
    sendWithFollowUp(send, 'photo', { ids: ['att_1'], onTheirWay }, then);
    expect(filesToSend(['att_1'], onTheirWay)).toEqual([]);
    sendWithFollowUp(send, 'see above', { ids: [], onTheirWay }, then);
    await tick();
    answer(0);
    answer(1);
    await tick();
    expect(done.sort()).toEqual(['sent:photo', 'sent:see above']);
    expect(filesToSend(['att_1'], onTheirWay)).toEqual(['att_1']);
  });
});
