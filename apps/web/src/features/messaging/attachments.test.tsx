import { QueryClient } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createClient, type UploadItem, type UploadOptions } from '@whombat/client';
import { createFakeSession, restHandler } from '@whombat/client/fake';
import { WhombatClientProvider } from '@whombat/client/react';
import type { Attachment } from '@whombat/core';
import { mara, PRINCIPALS } from '@whombat/fixtures';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerProps, WAIT_FOR_UPLOADS } from './Composer';
import { MessageAttachments, previewLines, thumbSize, thumbSrcSet } from './MessageAttachments';
import { type MessageFiles, MessageFilesValue } from './messageFiles';
import { resetUploads, useUploads } from './useUploads';

const uploads = vi.hoisted(() => ({
  calls: [] as { options: UploadOptions; resolve: (a: Attachment) => void; reject: (e: unknown) => void }[],
}));

vi.mock('@whombat/client', async (original) => {
  const actual = await original<typeof import('@whombat/client')>();
  return {
    ...actual,
    uploadFile: (_client: unknown, options: UploadOptions) =>
      new Promise<Attachment>((resolve, reject) => {
        uploads.calls.push({ options, resolve, reject });
        options.signal?.addEventListener('abort', () =>
          reject(new actual.UploadError('Cancelled.', null, true)),
        );
      }),
  };
});

const att = (id: string, extra: Partial<Attachment> = {}): Attachment => ({
  id,
  name: 'shot.png',
  contentType: 'image/png',
  size: 4096,
  url: `/api/v1/burrows/burrow-hq/attachments/${id}`,
  kind: 'image',
  width: 1200,
  height: 800,
  ...extra,
});

afterEach(() => {
  uploads.calls.length = 0;
  resetUploads();
});

describe('useUploads', () => {
  const requests: { url: string; method: string }[] = [];
  const client = createClient({
    session: createFakeSession({
      handle: restHandler(
        async (url, init) => {
          requests.push({ url, method: init.method ?? 'GET' });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        { origin: '' },
      ),
    }).session,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhombatClientProvider client={client} queryClient={new QueryClient()}>
      {children}
    </WhombatClientProvider>
  );
  const file = (name: string) => new File(['abc'], name, { type: 'text/plain' });

  it('uploads with progress, becomes ready, and sent files leave the composer', async () => {
    const { result } = renderHook(() => useUploads('burrow-hq', 'cnv_general'), { wrapper });
    act(() => result.current.pick([file('a.txt')]));
    expect(result.current.uploading).toBe(true);
    const call = uploads.calls[0];
    act(() => call?.options.onProgress?.(0.5));
    expect(result.current.attachments[0]).toMatchObject({ state: 'uploading', progress: 0.5 });
    await act(async () => call?.resolve(att('att_aaaaaaaaaaaa', { kind: 'text' })));
    expect(result.current.readyIds).toEqual(['att_aaaaaaaaaaaa']);
    expect(result.current.uploading).toBe(false);
    act(() => result.current.clearSent(['att_aaaaaaaaaaaa']));
    expect(result.current.attachments).toEqual([]);
  });

  it('cancel aborts the transfer and discards the reservation; retry starts again', async () => {
    const { result } = renderHook(() => useUploads('burrow-hq', 'cnv_general'), { wrapper });
    act(() => result.current.pick([file('big.bin'), file('bad.bin')]));
    const [first, second] = uploads.calls;
    act(() => first?.options.onReserved?.('att_bbbbbbbbbbbb', 1024));
    const localId = result.current.attachments[0]?.localId as string;
    await act(async () => result.current.remove(localId));
    expect(first?.options.signal?.aborted).toBe(true);
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: '/api/v1/burrows/burrow-hq/uploads/att_bbbbbbbbbbbb',
        method: 'DELETE',
      }),
    );
    await act(async () => second?.reject(new Error('nope')));
    expect(result.current.attachments).toEqual([
      expect.objectContaining({ name: 'bad.bin', state: 'failed', error: 'Upload failed. Try again.' }),
    ]);
    act(() => result.current.retry(result.current.attachments[0]?.localId as string));
    expect(uploads.calls).toHaveLength(3);
    expect(result.current.attachments[0]?.state).toBe('uploading');
  });
});

function item(extra: Partial<UploadItem>): UploadItem {
  return {
    localId: 'l1',
    name: 'shot.png',
    size: 2048,
    mediaType: 'image/png',
    state: 'uploading',
    progress: 0.3,
    attachment: null,
    error: null,
    ...extra,
  };
}

function ControlledComposer(props: Partial<ComposerProps> & { onSubmit: (text: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <Composer
      placeholder="Message #general"
      value={value}
      onValueChange={setValue}
      mentionables={PRINCIPALS}
      viewerId={mara.id}
      onPickFiles={vi.fn()}
      {...props}
    />
  );
}

describe('Composer chips', () => {
  it('shows progress and Cancel while uploading, and waits before sending', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onRemove = vi.fn();
    render(<ControlledComposer onSubmit={onSubmit} attachments={[item({})]} onRemoveAttachment={onRemove} />);
    expect(
      screen.getByRole('progressbar', { name: 'Uploading shot.png' }).getAttribute('aria-valuenow'),
    ).toBe('30');
    expect(screen.getByText('Uploading 30%')).toBeTruthy();
    expect(screen.getByTestId('upload-summary').textContent).toBe('1 file: 1 uploading');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(send.getAttribute('title')).toBe(WAIT_FOR_UPLOADS);
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('look{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel shot.png' }));
    expect(onRemove).toHaveBeenCalledWith('l1');
  });

  it('a failed upload says why and offers Retry; a ready one sends without text', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = render(
      <ControlledComposer
        onSubmit={onSubmit}
        attachments={[item({ state: 'failed', error: 'That file is too big. Files can be up to 25 MB.' })]}
        onRetryAttachment={onRetry}
        onRemoveAttachment={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('That file is too big. Files can be up to 25 MB.');
    await user.click(screen.getByRole('button', { name: 'Retry shot.png' }));
    expect(onRetry).toHaveBeenCalledWith('l1');
    rerender(
      <ControlledComposer
        onSubmit={onSubmit}
        attachments={[item({ state: 'ready', progress: 1, attachment: att('att_cccccccccccc') })]}
        onRemoveAttachment={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Remove shot.png' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith('');
  });
});

describe('thumbnails (contracts CT-298; web-messages.md WX-03)', () => {
  const thumbed = (id: string) =>
    att(id, {
      thumbnailUrl: `/api/v1/burrows/burrow-hq/attachments/${id}/thumbnail`,
      thumbnailWidth: 720,
      thumbnailHeight: 480,
    });

  it('shows the Whombat’s thumbnail, the file only for screens that need more, decoded off the main thread', () => {
    render(<MessageAttachments attachments={[thumbed('att_tttttttttttt')]} />);
    const img = screen.getByRole('img', { name: 'shot.png' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/v1/burrows/burrow-hq/attachments/att_tttttttttttt/thumbnail');
    expect(img.getAttribute('srcset')).toBe(
      '/api/v1/burrows/burrow-hq/attachments/att_tttttttttttt/thumbnail 720w, /api/v1/burrows/burrow-hq/attachments/att_tttttttttttt 1200w',
    );
    expect(img.getAttribute('sizes')).toBe('360px');
    expect(img.getAttribute('decoding')).toBe('async');
  });

  it('falls back to the file when the thumbnail doesn’t load, and has no srcset without sizes', async () => {
    render(<MessageAttachments attachments={[thumbed('att_uuuuuuuuuuuu')]} />);
    const img = screen.getByRole('img', { name: 'shot.png' });
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'shot.png' }).getAttribute('src')).toBe(
        '/api/v1/burrows/burrow-hq/attachments/att_uuuuuuuuuuuu',
      ),
    );
    expect(thumbSrcSet(att('a', { thumbnailUrl: '/t', thumbnailWidth: null }))).toBeUndefined();
    expect(thumbSrcSet(att('a', { thumbnailUrl: null }))).toBeUndefined();
  });
});

describe('MessageAttachments', () => {
  it('fits thumbnails in their box and opens an accessible lightbox with a download', async () => {
    const user = userEvent.setup();
    expect(thumbSize({ width: 1200, height: 800 })).toEqual({ width: 360, height: 240 });
    expect(thumbSize({ width: 100, height: 50 })).toEqual({ width: 100, height: 50 });
    render(<MessageAttachments attachments={[att('att_dddddddddddd')]} />);
    const thumb = screen.getByRole('button', { name: 'Open shot.png' });
    expect(thumb.querySelector('img')?.getAttribute('alt')).toBe('shot.png');
    await user.click(thumb);
    const dialog = await screen.findByRole('dialog', { name: 'shot.png' });
    const download = screen.getByRole('link', { name: 'Download shot.png' });
    expect(download.getAttribute('href')).toBe(
      '/api/v1/burrows/burrow-hq/attachments/att_dddddddddddd?download=1',
    );
    expect(dialog.textContent).toContain('1200 × 800 · 4 KB');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('PDFs and other files are chips with a download; text shows a safe preview', async () => {
    const fetchMock = vi.fn(async () => new Response('<script>alert(1)</script>\nline 2\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(
        <MessageAttachments
          attachments={[
            att('att_eeeeeeeeeeee', {
              name: 'report.pdf',
              kind: 'document',
              contentType: 'application/pdf',
              width: null,
              height: null,
            }),
            att('att_ffffffffffff', {
              name: 'build.log',
              kind: 'text',
              contentType: 'text/plain',
              size: 36,
              width: null,
              height: null,
            }),
          ]}
        />,
      );
      expect(screen.getByText('PDF · 4 KB')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Download report.pdf' })).toBeTruthy();
      const pre = await screen.findByText(/alert\(1\)/);
      expect(pre.tagName).toBe('PRE');
      expect(pre.textContent).toBe('<script>alert(1)</script>\nline 2');
      expect(document.querySelector('script')).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/burrows/burrow-hq/attachments/att_ffffffffffff',
        expect.objectContaining({ headers: { range: 'bytes=0-4095' } }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows an .html file as a live page in the sandboxed frame, with its own download (CT-152)', async () => {
    const page = '<!doctype html><html><head><title>Logo</title></head><body><h1>Logo</h1></body></html>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(page, { status: 200 })),
    );
    try {
      render(
        <MessageAttachments
          attachments={[
            att('att_hhhhhhhhhhhh', {
              name: 'logo.html',
              kind: 'text',
              contentType: 'text/plain',
              size: page.length,
              width: null,
              height: null,
            }),
          ]}
        />,
      );
      const card = await screen.findByRole('figure', { name: 'Logo' });
      expect(card.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
      expect(card.textContent).toContain('logo.html');
      expect(screen.getByRole('link', { name: 'Download logo.html' })).toBeTruthy();
      expect(document.querySelector('h1')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('plays audio and video in the browser’s players (AP-326)', () => {
    render(
      <MessageAttachments
        attachments={[
          att('att_aaaaaaaaaaab', {
            name: 'chime.wav',
            kind: 'file',
            contentType: 'audio/wav',
            width: null,
            height: null,
          }),
          att('att_vvvvvvvvvvvv', {
            name: 'demo.mp4',
            kind: 'file',
            contentType: 'video/mp4',
            width: null,
            height: null,
          }),
          att('att_zzzzzzzzzzzz', {
            name: 'odd.bin',
            kind: 'file',
            contentType: 'audio/x-weird',
            width: null,
            height: null,
          }),
        ]}
      />,
    );
    const audio = screen.getByLabelText('chime.wav', { selector: 'audio' }) as HTMLAudioElement;
    expect(audio.controls).toBe(true);
    expect(audio.getAttribute('src')).toBe('/api/v1/burrows/burrow-hq/attachments/att_aaaaaaaaaaab');
    expect(screen.getByLabelText('demo.mp4', { selector: 'video' })).toBeTruthy();
    expect(document.querySelectorAll('audio, video')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Download odd.bin' })).toBeTruthy();
  });

  it('lays several pictures out as a gallery, AVIF files included (AP-324)', () => {
    render(
      <MessageAttachments
        attachments={[
          att('att_gggggggggggg'),
          att('att_gggggggggggh', { name: 'photo.avif', kind: 'file', contentType: 'image/avif' }),
          att('att_gggggggggggi', { name: 'third.webp', contentType: 'image/webp' }),
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Images' });
    expect(list.className).toContain('gallery');
    expect(list.className).toContain('cols3');
    expect(screen.getByRole('button', { name: 'Open photo.avif' })).toBeTruthy();
  });

  it('previews at most ten lines and marks a cut-off file', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    expect(previewLines(text, true)).toEqual({
      lines: Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'),
      more: true,
    });
    expect(previewLines('a\nb\nhalf-a-li', false)).toEqual({ lines: 'a\nb', more: true });
    expect(previewLines('a\nb\n', true)).toEqual({ lines: 'a\nb', more: false });
  });
});

describe('Save to Files and Download on a message’s files (CT-312, AP-834)', () => {
  const files = (extra: Partial<MessageFiles> = {}): MessageFiles => ({
    busy: new Set(),
    save: vi.fn(),
    filesHref: (id) => `/files/c/${id}`,
    openFiles: vi.fn(),
    ...extra,
  });
  const chip = (id: string, extra: Partial<Attachment> = {}) =>
    att(id, {
      name: 'fonts.zip',
      kind: 'file',
      contentType: 'application/zip',
      width: null,
      height: null,
      ...extra,
    });

  function renderIn(
    value: MessageFiles,
    attachments: Attachment[],
    /** null: shown outside a message. */
    conversationId: string | null = 'cnv_general',
  ) {
    return render(
      <MessageFilesValue value={value}>
        <MessageAttachments attachments={attachments} conversationId={conversationId ?? undefined} />
      </MessageFilesValue>,
    );
  }

  it('an agent’s picture: Save to Files and Download beside the thumbnail, not inside it; Save never opens it', async () => {
    const user = userEvent.setup();
    const value = files();
    const picture = att('att_sssssssssss1', { inFiles: false });
    renderIn(value, [picture]);
    const open = screen.getByRole('button', { name: 'Open shot.png' });
    const save = screen.getByRole('button', { name: 'Save shot.png to Files' });
    const download = screen.getByRole('link', { name: 'Download shot.png' });
    expect(save.getAttribute('title')).toBe('Save to Files');
    expect(download.getAttribute('title')).toBe('Download');
    expect(open.contains(save) || open.contains(download)).toBe(false);
    await user.click(save);
    expect(value.save).toHaveBeenCalledWith(picture, 'cnv_general');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a file in Files says so and opens its conversation’s Files; busy while the save is on its way', async () => {
    const user = userEvent.setup();
    const value = files({ busy: new Set(['att_sssssssssss3']) });
    renderIn(value, [
      chip('att_sssssssssss2', { inFiles: true }),
      chip('att_sssssssssss3', { name: 'b.zip', inFiles: true }),
    ]);
    const inFiles = screen.getByRole('button', { name: 'fonts.zip is in Files. Open Files' });
    expect(inFiles.getAttribute('title')).toBe('In Files');
    expect(inFiles.getAttribute('aria-busy')).toBeNull();
    await user.click(inFiles);
    expect(value.openFiles).toHaveBeenCalledWith('cnv_general');
    const busy = screen.getByRole('button', { name: 'b.zip is in Files. Open Files' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await user.click(busy);
    expect(value.openFiles).toHaveBeenCalledTimes(1);
    expect(value.save).not.toHaveBeenCalled();
  });

  it('only Download where the Whombat doesn’t say, or outside a message', () => {
    const { unmount } = renderIn(files(), [chip('att_sssssssssss4')]);
    expect(screen.getByRole('link', { name: 'Download fonts.zip' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Files/ })).toBeNull();
    unmount();
    renderIn(files(), [chip('att_sssssssssss6', { inFiles: false })], null);
    expect(screen.queryByRole('button', { name: /Files/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download fonts.zip' })).toBeTruthy();
  });

  it('the lightbox’s bar has Save to Files beside Download, and follows the message after a save', async () => {
    const user = userEvent.setup();
    const value = files();
    const picture = att('att_sssssssssss7', { inFiles: false });
    const { rerender } = renderIn(value, [picture]);
    await user.click(screen.getByRole('button', { name: 'Open shot.png' }));
    const dialog = await screen.findByRole('dialog', { name: 'shot.png' });
    const save = within(dialog).getByRole('button', { name: 'Save to Files: shot.png' });
    expect(save.textContent).toBe('Save to Files');
    rerender(
      <MessageFilesValue value={value}>
        <MessageAttachments attachments={[{ ...picture, inFiles: true }]} conversationId="cnv_general" />
      </MessageFilesValue>,
    );
    expect(within(dialog).getByRole('button', { name: 'In Files: shot.png' }).textContent).toBe('In Files');
  });
});
