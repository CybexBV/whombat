import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { PUSH_TEXT, pushText } from '@whombat/client/managed';
import { describe, expect, it, vi } from 'vitest';

/** `public/sw.js` in a fake worker scope: what it shows and closes for a push (AP-808). */
function worker(url = '/sw.js') {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const open = [{ tag: 't:thread', close: vi.fn() }];
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
      getNotifications: async ({ tag }: { tag: string }) => open.filter((n) => n.tag === tag),
    },
    location: { origin: 'https://app.example', href: `https://app.example${url}` },
    clients: { matchAll: async () => [], openWindow: async () => null },
  };
  const source = readFileSync(resolve(import.meta.dirname, '../../public/sw.js'), 'utf8');
  runInNewContext(source, { self, Object, URL, encodeURIComponent });
  const push = async (payload: unknown) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get('push')?.({
      data: { json: () => payload },
      waitUntil: (p: Promise<unknown>) => {
        done = p;
      },
    });
    await done;
  };
  return { push, shown, open, source };
}

describe('the web push worker', () => {
  it('has exactly the shared words per kind', () => {
    const { source } = worker();
    const block = source.slice(source.indexOf('const GENERIC_TEXT'), source.indexOf('};') + 2);
    const words = Object.fromEntries(
      [...block.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1] as string, m[2] as string]),
    );
    expect(words).toEqual(PUSH_TEXT);
  });

  it('has exactly the shared Dutch words per kind', () => {
    const { source } = worker();
    const start = source.indexOf('const GENERIC_TEXT_NL');
    const block = source.slice(start, source.indexOf('};', start) + 2);
    const words = Object.fromEntries(
      [...block.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1] as string, m[2] as string]),
    );
    expect(words).toEqual(pushText('nl-NL'));
  });

  it('shows a managed push’s preview under its tag, quietly replacing the one before', async () => {
    const w = worker();
    await w.push({
      title: 'Hazel in #general',
      body: 'The deploy is done.',
      kind: 'message',
      ref: 'r1',
      tag: 't:thread',
    });
    expect(w.shown).toEqual([
      {
        title: 'Hazel in #general',
        options: expect.objectContaining({
          body: 'The deploy is done.',
          tag: 't:thread',
          renotify: false,
          data: { path: '/?push=message&ref=r1' },
        }),
      },
    ]);
  });

  it('says what kind it is when there is no preview (control’s fixed text)', async () => {
    const w = worker();
    await w.push({ title: 'Whombat', body: 'Whombat needs you', kind: 'run', ref: 'r2' });
    await w.push({ title: 'Whombat', body: 'Whombat needs you', kind: 'odd', ref: 'r3' });
    expect(w.shown.map((s) => [s.title, s.options.body, s.options.tag])).toEqual([
      ['Whombat', 'An agent has news about a run', 'r2'],
      ['Whombat', 'Whombat needs you', 'r3'],
    ]);
  });

  it('closes the notification with the tag on clear and shows nothing', async () => {
    const w = worker();
    await w.push({
      title: 'Whombat',
      body: 'Whombat needs you',
      kind: 'approval',
      ref: 'r4',
      tag: 't:thread',
      clear: true,
    });
    expect(w.shown).toEqual([]);
    expect(w.open[0]?.close).toHaveBeenCalledOnce();
  });
});

describe('a push without a preview', () => {
  const secret = { title: 'Mara in #payroll', body: 'Salaries go up 12% in March' };

  for (const [url, language] of [
    ['/sw.js', 'en'],
    ['/sw.js?lang=nl', 'nl'],
  ] as const) {
    const lines = language === 'nl' ? pushText('nl-NL') : PUSH_TEXT;

    it(`never shows the managed push’s preview (${language})`, async () => {
      const w = worker(url);
      await w.push({ ...secret, kind: 'message', ref: 'r1', preview: false });
      expect(w.shown.map((s) => [s.title, s.options.body])).toEqual([['Whombat', lines.message]]);
      expect(JSON.stringify(w.shown)).not.toContain('Salaries');
    });

    it(`never shows the box’s own push’s preview (${language})`, async () => {
      const w = worker(url);
      await w.push({
        ...secret,
        kind: 'mention',
        path: '/c/general',
        notificationId: 'n1',
        burrow: 'b',
        preview: false,
      });
      await w.push({
        ...secret,
        kind: 'needs_you',
        path: '/inbox',
        notificationId: 'n2',
        burrow: 'b',
        preview: false,
      });
      expect(w.shown.map((s) => [s.title, s.options.body, s.options.data])).toEqual([
        ['Whombat', lines.mention, { path: '/c/general' }],
        ['Whombat', lines.generic, { path: '/inbox' }],
      ]);
      expect(JSON.stringify(w.shown)).not.toContain('Mara');
      expect(JSON.stringify(w.shown)).not.toContain('Salaries');
    });
  }

  it('shows the box’s own push as it came when previews are on', async () => {
    const w = worker();
    await w.push({ ...secret, kind: 'mention', path: '/c/general', notificationId: 'n3', burrow: 'b' });
    expect(w.shown.map((s) => [s.title, s.options.body])).toEqual([[secret.title, secret.body]]);
  });
});
