/**
 * Page sets on a message (docs/decisions/page-sets.md): the tile, the full-screen viewer and its frame. The set is a
 * real stored ZIP fetched by URL (fixture mode's way); the frame is driven by posting what its script would.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type Attachment,
  PAGES_CONTENT_TYPE,
  PAGES_MANIFEST,
  type PageSetManifest,
  zipStored,
} from '@whombat/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageAttachments } from './MessageAttachments';

const text = (s: string) => new TextEncoder().encode(s);

function setFile(): Uint8Array {
  const manifest: PageSetManifest = {
    v: 1,
    title: 'Invoice mockups',
    open: 'round-1.html',
    files: 4,
    pages: 2,
    cover: false,
    problems: [],
  };
  const parts = zipStored([
    { path: 'round-1.html', bytes: text('<title>Round 1</title><a href="round-2.html">Next</a>') },
    { path: 'round-2.html', bytes: text('<title>Round 2</title>') },
    { path: 'shot.png', bytes: new Uint8Array([137, 80, 78, 71]) },
    { path: 'brand-notes.txt', bytes: text('Burrow ink #2b221d') },
    { path: PAGES_MANIFEST, bytes: text(JSON.stringify(manifest)) },
  ]);
  const zip = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    zip.set(p, at);
    at += p.length;
  }
  return zip;
}

const ZIP = setFile();

const att = (extra: Partial<Attachment> = {}): Attachment => ({
  id: 'att_pagesaaaaaaa',
  name: 'Invoice mockups.zip',
  contentType: PAGES_CONTENT_TYPE,
  size: ZIP.length,
  url: '/api/v1/burrows/burrow-hq/attachments/att_pagesaaaaaaa',
  kind: 'file',
  width: null,
  height: null,
  ...extra,
});

let fetches = 0;
beforeEach(() => {
  fetches = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      fetches += 1;
      return new Response(ZIP.slice(), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The viewer's frame now (a new one for each page). */
const frame = () => {
  const dialog = screen.getByRole('dialog');
  return dialog.querySelector('iframe') as HTMLIFrameElement;
};

/** A message from `source` to the app, as a frame posts it. */
const post = (data: unknown, source: Window) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  });

/** What the app sent a frame: the messages, in order. */
const said = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0]);
const show = (path: string) => ({ type: 'whombat.pages.show', path, hash: '', query: '' });

/** Opens the viewer and starts its frame on the set's first page; returns what the app sent that frame. */
async function openViewer() {
  const user = userEvent.setup();
  render(<MessageAttachments attachments={[att()]} />);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(frame()).toBeTruthy());
  const win = frame().contentWindow as Window;
  const sent = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
  post({ type: 'whombat.ready' }, win);
  post({ type: 'whombat.pages.ready' }, win);
  return { user, win, sent };
}

describe('a page set on a message', () => {
  it('is a tile with its cover, title, size and Open; a plain ZIP stays a file', () => {
    render(
      <MessageAttachments
        attachments={[
          att({ thumbnailUrl: '/cover.png', thumbnailWidth: 720, thumbnailHeight: 450 }),
          att({ id: 'att_zipaaaaaaaaa', name: 'site.zip', contentType: 'application/zip' }),
        ]}
      />,
    );
    const tile = screen.getByRole('figure', { name: 'Invoice mockups' });
    expect(tile.querySelector('img')?.getAttribute('src')).toBe('/cover.png');
    expect(tile.textContent).toContain('Pages ·');
    expect(within(tile).getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(within(tile).getByRole('link', { name: 'Download Invoice mockups.zip' })).toBeTruthy();
    expect(document.querySelectorAll('[data-page-set]')).toHaveLength(1);
    expect(screen.getByText('site.zip')).toBeTruthy();
  });

  it('shows a quiet placeholder without a cover', () => {
    render(<MessageAttachments attachments={[att()]} />);
    const tile = screen.getByRole('figure', { name: 'Invoice mockups' });
    expect(tile.querySelector('img')).toBeNull();
    expect(tile.querySelector('[data-page-set-placeholder]')).toBeTruthy();
  });

  it('opens full screen on the set’s first page, and the frame gets the viewer’s script', async () => {
    const { sent } = await openViewer();
    const dialog = screen.getByRole('dialog', { name: 'Invoice mockups' });
    expect(frame().getAttribute('src')).toBe('/sandbox/html-frame.html');
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
    const loader = sent.mock.calls[0]?.[0] as { type: string; html: string };
    expect(loader.type).toBe('whombat.html');
    expect(loader.html).toMatch(/<script src="[^"]*pages-runtime[^"]*"><\/script>/);
    // The manifest's page, once the set's directory is read.
    await waitFor(() => expect(said(sent)).toContainEqual(show('round-1.html')));
    expect(within(dialog).getByText('Opening…')).toBeTruthy();
    post(
      { type: 'whombat.pages.shown', path: 'round-1.html', title: 'Round 1' },
      frame().contentWindow as Window,
    );
    expect(within(dialog).queryByText('Opening…')).toBeNull();
    expect(within(dialog).getByText('Round 1')).toBeTruthy();
    // The set is read once.
    expect(fetches).toBe(1);
  });

  it('answers only its own frame', async () => {
    const { win, sent } = await openViewer();
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    post({ type: 'whombat.pages.ready' }, window);
    post({ type: 'whombat.pages.need', id: 1, path: 'round-1.html' }, window);
    post({ type: 'whombat.pages.external', url: 'https://example.com/' }, window);
    await act(async () => {});
    expect(sent).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/This link goes to/)).toBeNull();
    // From its frame: the file's bytes, handed over.
    post({ type: 'whombat.pages.need', id: 2, path: 'round-2.html' }, win);
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(3));
    const [answer, , transfer] = sent.mock.calls[2] as unknown as [
      { type: string; id: number; ok: boolean; bytes: ArrayBuffer },
      string,
      ArrayBuffer[],
    ];
    expect(answer).toMatchObject({ type: 'whombat.pages.file', id: 2, ok: true, contentType: 'text/html' });
    expect(transfer).toEqual([answer.bytes]);
  });

  it('opens another page in a new frame, and Back goes back through them', async () => {
    const { user, win } = await openViewer();
    post({ type: 'whombat.pages.shown', path: 'round-1.html', title: 'Round 1' }, win);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    post({ type: 'whombat.pages.open', path: 'round-2', hash: '', query: '' }, win);
    await waitFor(() => expect(frame().contentWindow).not.toBe(win));
    const second = frame().contentWindow as Window;
    const sent = vi.spyOn(second, 'postMessage').mockImplementation(() => {});
    post({ type: 'whombat.pages.ready' }, second);
    expect(said(sent)).toContainEqual(show('round-2.html'));
    // The last page's frame is gone: nothing it posts is heard.
    post({ type: 'whombat.pages.external', url: 'https://example.com/' }, win);
    expect(screen.queryByText(/This link goes to/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    const third = frame().contentWindow as Window;
    expect(third).not.toBe(second);
    const again = vi.spyOn(third, 'postMessage').mockImplementation(() => {});
    post({ type: 'whombat.pages.ready' }, third);
    expect(said(again)).toContainEqual(show('round-1.html'));
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('offers a file of the set for download instead of downloading it', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    // jsdom makes no object URLs.
    URL.createObjectURL = () => 'blob:test/1';
    URL.revokeObjectURL = () => {};
    const { user, win } = await openViewer();
    post({ type: 'whombat.pages.open', path: 'brand-notes.txt', hash: '', query: '' }, win);
    const bar = await waitFor(() => {
      const el = document.querySelector('[data-page-set-offer="file"]');
      if (!el) throw new Error('no bar');
      return el as HTMLElement;
    });
    expect(bar.textContent).toContain('brand-notes.txt');
    expect(click).not.toHaveBeenCalled();
    await user.click(within(bar).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('brand-notes.txt');
  });

  it('asks before a link to the internet opens, and says when a page isn’t in the set', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { user, win } = await openViewer();
    post({ type: 'whombat.pages.external', url: 'https://fonts.google.com/specimen/Fraunces' }, win);
    expect(screen.getByText(/fonts\.google\.com/)).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    const bar = document.querySelector('[data-page-set-offer="external"]') as HTMLElement;
    await user.click(within(bar).getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledWith(
      'https://fonts.google.com/specimen/Fraunces',
      '_blank',
      'noopener,noreferrer',
    );
    post({ type: 'whombat.pages.open', path: 'round-9.html', hash: '', query: '' }, win);
    await waitFor(() => expect(document.querySelector('[data-page-set-offer="missing"]')).toBeTruthy());
  });

  it('says when the set can’t be read, and tries again', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fail ? new Response('', { status: 500 }) : new Response(ZIP.slice(), { status: 200 }),
      ),
    );
    const user = userEvent.setup();
    render(<MessageAttachments attachments={[att()]} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.queryByRole('dialog')?.querySelector('iframe')).toBeNull();
    fail = false;
    await user.click(retry);
    await waitFor(() => expect(frame()).toBeTruthy());
  });

  it('closes on Escape and gives focus back to Open', async () => {
    const { user } = await openViewer();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
  });

  it('closes on Escape pressed inside the page too', async () => {
    const { win } = await openViewer();
    post({ type: 'whombat.pages.escape' }, win);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
