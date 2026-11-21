import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/core';
import { anchorForQuote, buildCanvasYDoc } from '@whombat/canvas-schema';
import { CANVAS_COMMENTS, CANVAS_MARKDOWN, canvas, plan } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';
import './test/jsdom';

/** A mocked server for HTTP; the document comes from the fixture world's local hub (no `/collab` in jsdom). */
function mockedWithFixtureDoc(fetch: typeof globalThis.fetch) {
  return { ...mockedServices(fetch), fixtures: true };
}

function article() {
  return screen.getByRole('heading', { level: 1 }).closest('article') as HTMLElement;
}

describe('CanvasScreen (fixture bootstrap)', () => {
  it('renders the header, the plan-bound steps and the comments column', async () => {
    renderApp('/canvases/invoice-pdf-export-plan');
    await screen.findByRole('heading', { name: 'Invoice PDF export' });

    expect(screen.getByText('Invoice PDF export · plan')).toBeTruthy();
    expect(screen.getByText(/here$/)).toBeTruthy();

    const art = article();
    expect(within(art).getByRole('heading', { name: 'Goal' })).toBeTruthy();
    expect(within(art).getByRole('heading', { name: 'Steps' })).toBeTruthy();
    expect(within(art).getByRole('heading', { name: 'Rules to keep' })).toBeTruthy();
    expect(within(art).getByRole('heading', { name: 'Out of scope' })).toBeTruthy();
    expect(within(art).getByText('Invoice numbers come from the invoice-number service.')).toBeTruthy();

    // Comments column: seeded threads render with their authors.
    expect(screen.getByText(/Step 2 should read the number/)).toBeTruthy();
    expect(screen.getByText('Agreed. Made it a rule.')).toBeTruthy();
  });
});

describe('CanvasScreen quiet states (TODO 16.4)', () => {
  it('shows a one-line error with Retry when the canvas fails to load', async () => {
    const user = userEvent.setup();
    renderApp('/canvases/invoice-pdf-export-plan', fixtureServices({ failing: ['canvases.get'] }));
    expect(await screen.findByText('Couldn’t load this canvas. Try again in a moment.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Invoice PDF export' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Couldn’t load this canvas. Try again in a moment.')).toBeTruthy();
  });
});

describe('CanvasScreen (mocked server)', () => {
  function mockServer() {
    const base = createWebFixtureFetch();
    let resolved: boolean | null = null;
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
      const path = url.pathname.replace('/api/v1', '');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

      if (
        method === 'GET' &&
        path === '/burrows/burrow-hq/canvases/invoice-pdf-export-plan' &&
        resolved !== null
      ) {
        const res = await base(new Request(url, init), init);
        const detail = await res.json();
        for (const thread of detail.comments) {
          if (thread.id === 'cmt_pdf-plan-1') thread.resolved = resolved;
        }
        return new Response(JSON.stringify(detail), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST' && path === '/burrows/burrow-hq/canvases/invoice-pdf-export-plan/comments') {
        posted.push(body);
        return new Response(
          JSON.stringify({
            comment: {
              id: 'cmt_new',
              canvasId: 'cvs_invoice-pdf-plan',
              anchor: body.anchor ?? null,
              parentId: body.parentId ?? null,
              authorId: 'prn_mara',
              text: body.text,
              createdAt: '2026-09-23T14:10:00.000+02:00',
              resolved: false,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (
        method === 'PATCH' &&
        path.startsWith('/burrows/burrow-hq/canvases/invoice-pdf-export-plan/comments/')
      ) {
        resolved = body.resolved;
        return new Response(
          JSON.stringify({
            comment: {
              id: 'cmt_pdf-plan-1',
              canvasId: 'cvs_invoice-pdf-plan',
              anchor: null,
              parentId: null,
              authorId: 'prn_dusty',
              text: 'x',
              createdAt: '2026-09-23T14:05:00.000+02:00',
              resolved: body.resolved,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // `createWebFixtureFetch`'s Request construction needs an absolute URL.
      return base(new Request(url, init), init);
    });
    return Object.assign(fetch, { posted });
  }

  it('resolves a comment thread', async () => {
    const user = userEvent.setup();
    renderApp('/canvases/invoice-pdf-export-plan', mockedWithFixtureDoc(mockServer()));
    await screen.findByRole('heading', { name: 'Invoice PDF export' });

    const resolveButtons = screen.getAllByRole('button', { name: 'Resolve' });
    await user.click(resolveButtons[0] as HTMLElement);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reopen' }).length).toBeGreaterThan(0));
  });

  it('comments on the selected words, anchored where they are in the document', async () => {
    const user = userEvent.setup();
    const server = mockServer();
    renderApp('/canvases/invoice-pdf-export-plan', mockedWithFixtureDoc(server));
    await screen.findByRole('heading', { name: 'Invoice PDF export' });
    const dom = await waitFor(() => {
      const el = article().querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
      if (!el?.editor) throw new Error('no editor yet');
      return el;
    });
    const editor = dom.editor as Editor;
    const quote = 'The PDF path never generates or reuses one.';
    let from = -1;
    editor.state.doc.descendants((node, pos) => {
      if (from < 0 && node.isText && node.text?.includes(quote))
        from = pos + (node.text?.indexOf(quote) ?? 0);
    });
    act(() => {
      editor
        .chain()
        .focus()
        .setTextSelection({ from, to: from + quote.length })
        .run();
    });
    // Mod-Alt-M (the "Comment" button does the same) opens the comment box for the selection.
    act(() => {
      dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true, bubbles: true }),
      );
    });
    const box = await screen.findByRole('form', { name: 'New comment' });
    expect(within(box).getByText(quote)).toBeTruthy();
    await user.type(within(box).getByLabelText('Comment'), 'Also for credit notes later?');
    await user.click(within(box).getByRole('button', { name: 'Comment' }));

    await waitFor(() => expect(server.posted).toHaveLength(1));
    const { ydoc } = buildCanvasYDoc(CANVAS_MARKDOWN[canvas.id] ?? '', {
      title: canvas.title,
      plan,
      comments: CANVAS_COMMENTS,
    });
    expect(server.posted[0]).toEqual({
      anchor: anchorForQuote(ydoc, quote),
      text: 'Also for credit notes later?',
    });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'New comment' })).toBeNull());
  });
});
