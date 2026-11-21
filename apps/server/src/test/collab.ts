/**
 * Test helper: a headless collaboration client — a Yjs document synced with the collaboration service through the
 * real Hocuspocus provider (what the web editor uses), edited the way the Tiptap binding writes (ProseMirror
 * documents diffed into the Y.XmlFragment). Clients reach the service through `collabTransport`, a loopback
 * WebSocket standing in for a session's collab stream (`managed/resources.ts` `openCollab`).
 */
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { WebSocketLike } from '@hocuspocus/server';
import {
  applyEditsToYDoc,
  type CanvasNode,
  docToMarkdown,
  docToPlainText,
  readCanvas,
  writeCanvas,
} from '@whombat/canvas-schema';
import type { CanvasEdit } from '@whombat/core';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import type { CollabService } from '../collab/service';

export interface TestCollabClient {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  /** The ProseMirror document now. */
  read(): CanvasNode;
  text(): string;
  markdown(): string;
  /** Rewrites the document the way the editor binding does (a minimal diff). */
  write(change: (doc: CanvasNode) => CanvasNode): void;
  /** Applies `canvas_edit`-style edits locally (as a person typing them). */
  edit(edits: CanvasEdit[]): void;
  /** Awareness states of everyone else on the document. */
  peers(): Record<string, unknown>[];
  close(): void;
}

export interface CollabClientOptions {
  token: string;
  documentName: string;
  /** Resolve once authenticated and synced (default) — or reject when authentication fails. */
  timeoutMs?: number;
}

export interface CollabTransport {
  /** The `ws://` URL clients connect to. */
  url: string;
  close(): Promise<void>;
}

/**
 * A loopback WebSocket whose connections go to the collaboration service's Hocuspocus handling, the token checked
 * per document as on a session's collab stream (which issues the session's own token, `openCollab`).
 */
export async function collabTransport(collab: CollabService): Promise<CollabTransport> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket, req) => {
    const request = new Request(`http://127.0.0.1${req.url ?? '/'}`);
    const client = collab.hocuspocus.handleConnection(socket as unknown as WebSocketLike, request);
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      client.handleMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    socket.on('close', (code: number, reason: Buffer) => {
      client.handleClose({ code, reason: reason.toString() });
    });
  });
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/collab`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

export async function collabClient(
  transport: CollabTransport,
  opts: CollabClientOptions,
): Promise<TestCollabClient> {
  const doc = new Y.Doc();
  let failed: ((reason: Error) => void) | undefined;
  let synced: (() => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    synced = resolve;
    failed = reject;
  });
  const provider = new HocuspocusProvider({
    url: transport.url,
    name: opts.documentName,
    document: doc,
    token: opts.token,
    onSynced: () => synced?.(),
    onAuthenticationFailed: ({ reason }) => failed?.(new Error(`authentication failed: ${reason}`)),
  });
  const timer = setTimeout(() => failed?.(new Error('collab client timed out')), opts.timeoutMs ?? 10_000);
  try {
    await ready;
  } catch (err) {
    provider.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const client: TestCollabClient = {
    doc,
    provider,
    read: () => readCanvas(doc).doc,
    text: () => docToPlainText(readCanvas(doc).doc),
    markdown: () => docToMarkdown(readCanvas(doc).doc),
    write(change) {
      const { doc: current, meta } = readCanvas(doc);
      writeCanvas(doc, change(current), meta);
    },
    edit(edits) {
      applyEditsToYDoc(doc, edits);
    },
    peers() {
      const own = provider.awareness?.clientID;
      return [...(provider.awareness?.getStates().entries() ?? [])]
        .filter(([id]) => id !== own)
        .map(([, state]) => state as Record<string, unknown>);
    },
    close() {
      provider.destroy();
      doc.destroy();
    },
  };
  return client;
}

/** Polls until `check` passes (or throws its last error after `timeoutMs`). */
export async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      return await check();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw last;
}
