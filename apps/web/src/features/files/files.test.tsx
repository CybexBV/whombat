import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FilesUploadOptions } from '@whombat/client';
import type { Attachment, FileEntry } from '@whombat/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { resetFilesUploads } from './useFilesUploads';

const uploads = vi.hoisted(() => ({
  calls: [] as {
    options: FilesUploadOptions;
    resolve: (e: FileEntry) => void;
    reject: (e: unknown) => void;
  }[],
}));

vi.mock('@whombat/client', async (original) => {
  const actual = await original<typeof import('@whombat/client')>();
  return {
    ...actual,
    uploadToFiles: (_client: unknown, options: FilesUploadOptions) =>
      new Promise<FileEntry>((resolve, reject) => {
        uploads.calls.push({ options, resolve, reject });
      }),
  };
});

afterEach(() => {
  uploads.calls.length = 0;
  resetFilesUploads();
});

const seeded = () => fixtureServices({ files: true });

describe('/files (AP-773)', () => {
  it('shows the Chat’s files straight away, the other conversations at its top like folders', async () => {
    const user = userEvent.setup();
    const app = renderApp('/files', seeded());
    // “Files” alone: the Chat's own name isn't a step of its own.
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Files');
    const list = await screen.findByRole('list', { name: 'Your files' });
    const branch = await within(list).findByRole('link', { name: 'feat/invoice-pdf' });
    expect(branch.getAttribute('href')).toBe('/files/pr/482');
    expect(within(branch.closest('li') as HTMLElement).getByText('4 files')).toBeTruthy();
    await user.click(branch);
    await waitFor(() => expect(app.location()).toBe('/files/pr/482'));
  });

  it('shows the same page at the Chat’s own Files address', async () => {
    renderApp('/files/dm/chat', seeded());
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Files');
    expect(await screen.findByRole('list', { name: 'Your files' })).toBeTruthy();
  });

  it('says so when there are none', async () => {
    renderApp('/files');
    expect(await screen.findByText(/No files (here )?yet/)).toBeTruthy();
  });
});

describe('a conversation’s Files (AP-774…AP-777)', () => {
  it('shows its folders first, then its files newest first, and opens a folder with breadcrumbs', async () => {
    const user = userEvent.setup();
    const app = renderApp('/files/pr/482', seeded());
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Files/feat/invoice-pdf');
    const list = await screen.findByRole('list', { name: 'Files in feat/invoice-pdf' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent?.match(/^(\S+)/)?.[1])).toEqual([
      'Drawings2',
      'invoice-pdf-brief.pdfIn',
      'invoices-q3.csvSaved',
    ]);
    // A message's file opens its message.
    expect(
      within(list)
        .getAllByRole('link', { name: 'In a message' })
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/pr/482#msg_pr482-mara-1120']);
    await user.click(within(list).getByRole('link', { name: 'Drawings' }));
    await waitFor(() => expect(app.location()).toBe('/files/pr/482?folder=Drawings'));
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Files/feat/invoice-pdf/Drawings',
    );
    const inside = await screen.findByRole('list', { name: 'Files in Drawings' });
    expect(within(inside).getByRole('link', { name: '2024' })).toBeTruthy();
    expect(within(inside).getByRole('button', { name: 'Download 1904Technischmodel.skp' })).toBeTruthy();
    await user.click(screen.getByRole('link', { name: 'feat/invoice-pdf' }));
    await waitFor(() => expect(app.location()).toBe('/files/pr/482'));
  });

  it('offers only what the Whombat allows: no Rename for a message’s file', async () => {
    const user = userEvent.setup();
    renderApp('/files/pr/482', seeded());
    await user.click(await screen.findByRole('button', { name: 'More for invoice-pdf-brief.pdf' }));
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Download', 'Open message', 'Move to folder…', 'Remove from Files']);
  });

  it('renames a saved file', async () => {
    const user = userEvent.setup();
    renderApp('/files/pr/482', seeded());
    await user.click(await screen.findByRole('button', { name: 'More for invoices-q3.csv' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename “invoices-q3.csv”' });
    const input = within(dialog).getByLabelText('NAME');
    await user.clear(input);
    await user.type(input, 'invoices-september.csv');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('Renamed to “invoices-september.csv”.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Download invoices-september.csv' })).toBeTruthy();
  });

  it('moves a file to a folder, taking over the folder’s spelling', async () => {
    const user = userEvent.setup();
    renderApp('/files/pr/482', seeded());
    await user.click(await screen.findByRole('button', { name: 'More for invoices-q3.csv' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to folder…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move “invoices-q3.csv”' });
    expect(
      within(within(dialog).getByRole('list', { name: 'Folders' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Top of Filesnow', 'Drawings', 'Drawings / 2024']);
    await user.type(within(dialog).getByLabelText('OR A NEW FOLDER'), 'drawings/../x');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/1–64 characters/);
    await user.clear(within(dialog).getByLabelText('OR A NEW FOLDER'));
    await user.type(within(dialog).getByLabelText('OR A NEW FOLDER'), 'drawings');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Moved to Drawings.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Download invoices-q3.csv' })).toBeNull(),
    );
  });

  it('removes a message’s file from Files after asking, saying it stays on its message', async () => {
    const user = userEvent.setup();
    renderApp('/files/pr/482', seeded());
    await user.click(await screen.findByRole('button', { name: 'More for invoice-pdf-brief.pdf' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove from Files' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove “invoice-pdf-brief.pdf” from Files?' });
    expect(within(dialog).getByText(/stays on its message in feat\/invoice-pdf/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove from Files' }));
    expect(await screen.findByText('Removed from Files.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open invoice-pdf-brief.pdf' })).toBeNull(),
    );
  });

  it('makes a new folder a place to upload into, until a file is in it', async () => {
    const user = userEvent.setup();
    const app = renderApp('/files/pr/482', seeded());
    await user.click(await screen.findByRole('button', { name: 'New folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'New folder in feat/invoice-pdf' });
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Give the folder a name.');
    await user.type(within(dialog).getByLabelText('NAME'), 'Contracts');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(app.location()).toBe('/files/pr/482?folder=Contracts'));
    expect(await screen.findByText(/Nothing in this folder yet\./)).toBeTruthy();
  });

  it('uploads into the open folder with progress, then the list reads again', async () => {
    const user = userEvent.setup();
    renderApp('/files/pr/482?folder=Drawings', seeded());
    await screen.findByRole('list', { name: 'Files in Drawings' });
    const input = screen.getByLabelText('Upload files to Drawings');
    await user.upload(input, new File(['abc'], 'section-b.pdf', { type: 'application/pdf' }));
    const call = uploads.calls[0];
    expect(call?.options).toMatchObject({ conversationId: 'cnv_pr482', folder: 'Drawings' });
    act(() => call?.options.onProgress?.(0.42));
    const chips = screen.getByRole('list', { name: 'Uploads' });
    expect(within(chips).getByText('Uploading 42%')).toBeTruthy();
    const att: Attachment = {
      id: 'att_up',
      name: 'section-b.pdf',
      contentType: 'application/pdf',
      size: 3,
      url: '/api/v1/burrows/burrow-hq/attachments/att_up',
      kind: 'document',
      width: null,
      height: null,
    };
    act(() => call?.options.onUploaded?.(att));
    expect(within(chips).getByText('Saving…')).toBeTruthy();
    await act(async () =>
      call?.resolve({
        attachment: att,
        conversationId: 'cnv_pr482',
        folder: 'Drawings',
        uploadedById: 'prn_mara',
        addedAt: new Date().toISOString(),
        messageId: null,
        threadRootId: null,
      }),
    );
    expect(await within(chips).findByText('Saved · 3 bytes')).toBeTruthy();
  });

  it('refuses a file larger than the Whombat takes once a reservation has said the limit', async () => {
    const user = userEvent.setup();
    renderApp('/files/pr/482', seeded());
    await screen.findByRole('list', { name: 'Files in feat/invoice-pdf' });
    const input = screen.getByLabelText('Upload files to feat/invoice-pdf');
    await user.upload(input, new File(['abc'], 'a.txt'));
    act(() => uploads.calls[0]?.options.onReserved?.('att_a', 2));
    await user.upload(input, new File(['abcdef'], 'big.bin'));
    expect(uploads.calls).toHaveLength(1);
    expect(
      await screen.findByText('big.bin is larger than 2 bytes, the most this Whombat takes.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry big.bin' })).toBeNull();
  });

  it('says so for a conversation the viewer can’t see', async () => {
    renderApp('/files/dm/nobody', seeded());
    expect(
      await screen.findByText('These files aren’t here, or you’re not in this conversation.'),
    ).toBeTruthy();
  });
});

describe('the conversation header’s Files (AP-778)', () => {
  it('sits after Plans and opens the branch room’s Files', async () => {
    renderApp('/pr/482', seeded());
    const plans = await screen.findByRole('link', { name: 'Plans' });
    const files = plans.nextElementSibling;
    expect(files?.textContent).toBe('Files');
    expect(files?.getAttribute('href')).toBe('/files/pr/482');
  });
});
