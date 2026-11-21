/**
 * An in-process container engine for tests (one-person.md OP-19): Docker's API on a unix socket in a temporary folder,
 * answering `GET /v1.41/containers/json` (with the `label` filter) and `POST /v1.41/containers/{id}/stop` from a list
 * of containers a test changes as it goes. It records each request.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineContainer } from './engine';

export class FakeEngine {
  readonly dir = mkdtempSync(join(tmpdir(), 'whombat-engine-'));
  readonly socket = join(this.dir, 'podman.sock');
  containers: EngineContainer[] = [];
  readonly requests: { method: string; url: string }[] = [];
  /** Answer every request with this status instead (an engine in trouble). */
  failWith: number | null = null;
  readonly #server: Server;

  constructor() {
    this.#server = createServer((req, res) => {
      const url = req.url ?? '';
      this.requests.push({ method: req.method ?? 'GET', url });
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (this.failWith) return send(this.failWith, { message: 'engine trouble' });
      const parsed = new URL(url, 'http://engine');
      if (req.method === 'GET' && parsed.pathname === '/v1.41/containers/json') {
        const labels =
          (JSON.parse(parsed.searchParams.get('filters') ?? '{}') as { label?: string[] }).label ?? [];
        return send(
          200,
          this.containers.filter((c) =>
            labels.every((l) => {
              const [k, v] = l.split('=');
              return c.Labels?.[k as string] === v;
            }),
          ),
        );
      }
      const stop = /^\/v1\.41\/containers\/([^/]+)\/stop$/.exec(parsed.pathname);
      if (req.method === 'POST' && stop) {
        const c = this.containers.find((x) => x.Id === decodeURIComponent(stop[1] as string));
        if (!c) return send(404, { message: 'no such container' });
        if (c.State !== 'running') return send(304);
        c.State = 'exited';
        c.Status = 'Exited (143) Less than a second ago';
        return send(204);
      }
      send(404, { message: 'page not found' });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(this.socket, resolve));
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A running service container (the agent's `docker run -l whombat.service=1 -p 20000:80 …`). */
export function serviceContainer(over: Partial<EngineContainer> & { port?: number } = {}): EngineContainer {
  const { port = 20_000, ...rest } = over;
  return {
    Id: 'a'.repeat(64),
    Names: ['/invoice-site'],
    Image: 'node:24-alpine',
    State: 'running',
    Status: 'Up 5 minutes',
    Created: 1_790_000_000,
    StartedAt: 1_790_000_100,
    Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: port, Type: 'tcp' }],
    Labels: { 'whombat.service': '1' },
    ...rest,
  };
}
