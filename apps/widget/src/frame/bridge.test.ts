import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_TAG, randomToken } from '../shared/protocol';
import { connectBridge, type FrameWindowLike, frameParams } from './bridge';

const SITE = 'fbs_abcdefghijklmnopqrstuvwx';
const PARENT = 'https://shop.example.com';
const instance = randomToken();

function win(
  query: Record<string, string>,
  opts: { hash?: string; ancestors?: string[]; framed?: boolean } = {},
): FrameWindowLike {
  const self: FrameWindowLike = {
    location: {
      search: `?${new URLSearchParams(query)}`,
      hash: opts.hash ?? `#instance=${instance}`,
      ...(opts.ancestors ? { ancestorOrigins: Object.assign([...opts.ancestors], {}) } : {}),
    },
    parent: null,
  };
  self.parent = opts.framed === false ? self : {};
  return self;
}

describe('frameParams', () => {
  it('accepts a framed page with a canonical parent that matches ancestorOrigins', () => {
    expect(frameParams(win({ site: SITE, parent: PARENT, theme: 'dark' }, { ancestors: [PARENT] }))).toEqual({
      site: SITE,
      parent: PARENT,
      theme: 'dark',
      instance,
      key: null,
    });
    // Browsers without ancestorOrigins (Firefox) rely on the server's frame-ancestors.
    expect(frameParams(win({ site: SITE, parent: 'http://localhost:5173' }))).toMatchObject({
      parent: 'http://localhost:5173',
      theme: 'auto',
    });
    // A trailing dot is another origin, not the allowed one: it is kept exactly (the server's allowlist and
    // ancestorOrigins decide), never folded into https://shop.example.com.
    expect(frameParams(win({ site: SITE, parent: 'https://shop.example.com.' }))).toMatchObject({
      parent: 'https://shop.example.com.',
    });
    expect(
      frameParams(win({ site: SITE, parent: 'https://shop.example.com.' }, { ancestors: [PARENT] })),
    ).toHaveProperty('refused');
  });

  it('reads a site key (drop mode, Whombat FD-27)', () => {
    const key = 'fbk_AAAAAAAAAAAAAAAAAAAAAA';
    expect(frameParams(win({ site: SITE, parent: PARENT, key }, { ancestors: [PARENT] }))).toMatchObject({
      key,
    });
    expect(frameParams(win({ site: SITE, parent: PARENT }))).toMatchObject({ key: null });
  });

  it('refuses to run otherwise', () => {
    const refused = [
      win({ site: SITE, parent: PARENT }, { framed: false }),
      win({ site: 'fbs_x', parent: PARENT }),
      win({ parent: PARENT }),
      win({ site: SITE }),
      win({ site: SITE, parent: 'null' }),
      win({ site: SITE, parent: 'https://shop.example.com/' }),
      win({ site: SITE, parent: 'https://shop.example.com:443' }),
      win({ site: SITE, parent: 'https://SHOP.example.com' }),
      win({ site: SITE, parent: 'http://shop.example.com' }),
      win({ site: SITE, parent: 'https://*.example.com' }),
      win({ site: SITE, parent: 'javascript:alert(1)' }),
      win({ site: SITE, parent: PARENT }, { ancestors: ['https://shop.example.com.evil.com'] }),
      win({ site: SITE, parent: PARENT }, { ancestors: ['null'] }),
      win({ site: SITE, parent: PARENT }, { hash: '' }),
      win({ site: SITE, parent: PARENT }, { hash: '#instance=short' }),
      win({ site: SITE, parent: PARENT, key: 'fbk_short' }),
      win({ site: SITE, parent: PARENT, key: '' }),
    ];
    for (const w of refused)
      expect(frameParams(w), `${w.location.search} ${w.location.hash}`).toHaveProperty('refused');
  });
});

describe('connectBridge', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts to the parent with the exact origin and accepts only its messages', () => {
    const parent = window.parent;
    const post = vi.spyOn(parent, 'postMessage').mockImplementation(() => {});
    const onMessage = vi.fn();
    const bridge = connectBridge(
      window,
      { site: SITE, parent: PARENT, theme: 'auto', instance, key: null },
      onMessage,
    );
    bridge.post({ type: 'ready', payload: {} });
    expect(post).toHaveBeenCalledWith({ wb: BRIDGE_TAG, instance, type: 'ready', payload: {} }, PARENT);

    const send = (data: unknown, origin = PARENT, source: unknown = parent) =>
      window.dispatchEvent(
        new MessageEvent('message', { data, origin, source: source as MessageEventSource | null }),
      );
    const good = { wb: BRIDGE_TAG, instance, type: 'close', payload: {} };
    send(good, 'https://evil.example.com');
    send(good, 'https://shop.example.com.evil.com');
    send(good, 'null');
    send(good, PARENT, null);
    send(good, PARENT, new MessageChannel().port1);
    send({ ...good, instance: randomToken() });
    send({ ...good, wb: 'x' });
    send({ ...good, type: 'ready' });
    send({ ...good, payload: { x: 1 } });
    expect(onMessage).not.toHaveBeenCalled();
    send(good);
    expect(onMessage).toHaveBeenCalledWith({ type: 'close', payload: {} }, PARENT);
    bridge.close();
    send(good);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});
