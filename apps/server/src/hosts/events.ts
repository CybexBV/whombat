/**
 * The hosts service's event stream (`GET /api/v1/events`, Server-Sent Events) as Whombat follows it
 * (one-whombat-servers.md ONE-DH06): one stream for the whole Whombat, resumed with `Last-Event-ID` after a break,
 * reconnecting after the service's `retry` (5 s), doubling up to a minute while it stays away. `resync` (the id was too
 * old, or the service restarted) tells the listener to forget what it cached.
 */
import type { IncomingMessage } from 'node:http';
import { HOSTS_API, type HostsClient } from './client';

export interface HostsSseEvent {
  id: string | null;
  event: string;
  data: unknown;
}

/** Incremental SSE parsing (pure): feed text, get whole events. */
export class SseParser {
  #buffer = '';
  #event = '';
  #data: string[] = [];
  #id: string | null = null;
  /** The last `retry:` the stream gave, in ms. */
  retryMs: number | null = null;

  push(chunk: string): { id: string | null; event: string; data: string }[] {
    this.#buffer += chunk;
    const out: { id: string | null; event: string; data: string }[] = [];
    for (;;) {
      const nl = this.#buffer.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const line = this.#buffer.slice(0, nl);
      const width = this.#buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.#buffer = this.#buffer.slice(nl + width);
      if (line === '') {
        if (this.#data.length > 0 || this.#event)
          out.push({ id: this.#id, event: this.#event || 'message', data: this.#data.join('\n') });
        this.#event = '';
        this.#data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.#event = value;
      else if (field === 'data') this.#data.push(value);
      else if (field === 'id') this.#id = value.includes('\u0000') ? this.#id : value;
      else if (field === 'retry' && /^\d+$/.test(value)) this.retryMs = Number(value);
    }
    // A line without an end can't grow without bound.
    if (this.#buffer.length > 1024 * 1024) this.#buffer = '';
    return out;
  }
}

export interface EventStreamOptions {
  /** Called for every event; `resync` and the first connect after a break the id didn't cover come as `resync`. */
  onEvent(event: HostsSseEvent): void;
  /** The stream is up (true) or broken (false). */
  onState?(up: boolean): void;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export class HostsEventStream {
  #lastId: string | null = null;
  #closed = false;
  #res: IncomingMessage | null = null;
  #timer: NodeJS.Timeout | null = null;
  #delay: number;
  #up = false;

  constructor(
    private readonly client: HostsClient,
    private readonly options: EventStreamOptions,
  ) {
    this.#delay = options.minDelayMs ?? 5_000;
  }

  get up(): boolean {
    return this.#up;
  }

  start(): void {
    if (this.#closed || this.#res || this.#timer) return;
    void this.#connect();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#res?.destroy();
    this.#res = null;
  }

  #state(up: boolean): void {
    if (this.#up === up) return;
    this.#up = up;
    this.options.onState?.(up);
  }

  async #connect(): Promise<void> {
    this.#timer = null;
    if (this.#closed) return;
    const parser = new SseParser();
    try {
      const { res } = await this.client.open({
        path: `${HOSTS_API}/events`,
        // One stream with a fixed actor, as admin so the admin-only events (enrollments) arrive (WHOMBAT.md §4).
        actor: { id: 'whombat-server', name: 'Whombat', role: 'admin' },
        headers: { Accept: 'text/event-stream', ...(this.#lastId ? { 'Last-Event-ID': this.#lastId } : {}) },
        timeoutMs: 10_000,
      });
      if (this.#closed) {
        res.destroy();
        return;
      }
      this.#res = res;
      this.#delay = this.options.minDelayMs ?? 5_000;
      this.#state(true);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        for (const raw of parser.push(chunk)) {
          if (raw.id) this.#lastId = raw.id;
          let data: unknown = null;
          try {
            data = raw.data ? JSON.parse(raw.data) : null;
          } catch {
            continue;
          }
          try {
            this.options.onEvent({ id: raw.id, event: raw.event, data });
          } catch {
            // A listener's failure never stops the stream.
          }
        }
      });
      const ended = () => {
        if (this.#res !== res) return;
        this.#res = null;
        this.#state(false);
        this.#schedule(parser.retryMs);
      };
      res.on('end', ended);
      res.on('close', ended);
      res.on('error', ended);
    } catch {
      this.#state(false);
      this.#schedule(null);
    }
  }

  #schedule(retryMs: number | null): void {
    if (this.#closed || this.#timer) return;
    const max = this.options.maxDelayMs ?? 60_000;
    const wait = Math.min(max, Math.max(retryMs ?? 0, this.#delay));
    this.#delay = Math.min(max, this.#delay * 2);
    this.#timer = setTimeout(() => void this.#connect(), wait);
    this.#timer.unref?.();
  }
}
