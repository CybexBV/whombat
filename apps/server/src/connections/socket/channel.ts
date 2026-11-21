/**
 * One WebSocket to a connection's service under its destination policy (docs/decisions/connections-more.md CM-15):
 * `lib/outbound.ts` `outboundConnectOptions` checks the URL, resolves the host and pins the socket to the checked
 * addresses (the home-network list with its ports, or the whole local network when it is open), and with a pinned
 * certificate accepts exactly that leaf. No redirects, no compression, a connect deadline (10 s) and a cap per message.
 *
 * Messages are JSON objects; they are queued from the moment the socket is made (ESPHome's Device Builder speaks first)
 * and taken one by one with `next`. A socket is used for one call and closed (`close` terminates it): no pool.
 *
 * Failures are `OutboundError`s (refused address, unreachable, timeout, certificate) or `SocketUpgradeRefused` when the
 * service answered the handshake without upgrading (404 for a server without the socket, 401/403, a web page).
 */
import { SOCKET_CONNECT_DEADLINE_MS } from '@whombat/core';
import WebSocket from 'ws';
import {
  OutboundError,
  type OutboundPolicy,
  outboundConnectOptions,
  outboundErrorOf,
} from '../../lib/outbound';

/** One message at most (a TrueNAS `pool.query` can be large; the agent sees 64 KiB of it). */
export const SOCKET_MESSAGE_MAX = 4 * 1024 * 1024;
/** Messages a socket keeps unread before it gives up (a chatty server's notifications). */
const QUEUE_MAX = 2048;

/** The service answered the handshake with an ordinary HTTP answer: no socket there, or a refused credential. */
export class SocketUpgradeRefused extends Error {
  constructor(readonly status: number) {
    super(`The service answered ${status} instead of opening the socket.`);
    this.name = 'SocketUpgradeRefused';
  }

  /** 401 or 403: the service refused who Whombat is. */
  get refused(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** The socket closed (or failed) before the message waited for came. */
export class SocketClosed extends Error {
  constructor(readonly reason: 'closed' | 'too_large' | 'unreadable') {
    super(
      reason === 'too_large'
        ? 'It sent a message that was too large.'
        : reason === 'unreadable'
          ? 'It sent something that isn’t JSON.'
          : 'The connection closed.',
    );
    this.name = 'SocketClosed';
  }
}

export interface SocketChannel {
  /** Sends one JSON message. Throws `SocketClosed` when the socket is gone. */
  send(message: unknown): void;
  /** The next message, or rejects: `SocketClosed`, or `OutboundError` `timeout` after `ms`. */
  next(ms: number): Promise<Record<string, unknown>>;
  /** Ends the socket at once (idempotent). */
  close(): void;
}

export interface OpenChannelOptions {
  /** Default `SOCKET_CONNECT_DEADLINE_MS` (10 s, CM-15). */
  connectMs?: number;
  /** Default `SOCKET_MESSAGE_MAX`. */
  maxPayload?: number;
  headers?: Record<string, string>;
}

/** `http(s)://…` → `ws(s)://…` after the policy checked it. */
function socketUrl(url: URL): URL {
  const out = new URL(url.toString());
  out.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return out;
}

/**
 * Opens a socket to `httpUrl` (an `http:`/`https:` URL the policy decides on; the socket speaks `ws:`/`wss:`) and
 * resolves once it is open. Throws `OutboundError` or `SocketUpgradeRefused`.
 */
export async function openChannel(
  httpUrl: string,
  policy: OutboundPolicy,
  options: OpenChannelOptions = {},
): Promise<SocketChannel> {
  const { url, lookup, agent } = outboundConnectOptions(httpUrl, policy);
  const connectMs = options.connectMs ?? SOCKET_CONNECT_DEADLINE_MS;
  const ws = new WebSocket(socketUrl(url), {
    lookup,
    ...(agent ? { agent } : {}),
    followRedirects: false,
    maxPayload: options.maxPayload ?? SOCKET_MESSAGE_MAX,
    handshakeTimeout: connectMs,
    perMessageDeflate: false,
    headers: { 'User-Agent': 'Whombat', ...(options.headers ?? {}) },
  });
  const queue: Record<string, unknown>[] = [];
  const waiting: {
    resolve: (m: Record<string, unknown>) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  let ended: Error | null = null;
  const end = (err: Error) => {
    ended ??= err;
    for (const w of waiting.splice(0)) {
      clearTimeout(w.timer);
      w.reject(ended);
    }
  };
  ws.on('message', (data, isBinary) => {
    let message: Record<string, unknown> | null = null;
    if (!isBinary) {
      try {
        const value = JSON.parse(String(data)) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value))
          message = value as Record<string, unknown>;
      } catch {
        message = null;
      }
    }
    if (!message) {
      ws.terminate();
      end(new SocketClosed('unreadable'));
      return;
    }
    const w = waiting.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(message);
      return;
    }
    queue.push(message);
    if (queue.length > QUEUE_MAX) {
      ws.terminate();
      end(new SocketClosed('too_large'));
    }
  });
  ws.on('close', (code) => end(new SocketClosed(code === 1009 ? 'too_large' : 'closed')));

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        ws.terminate();
        reject(err);
      } else resolve();
    };
    // The handshake's own timeout covers the upgrade; this covers DNS and the TCP and TLS connect before it.
    const timer = setTimeout(
      () => settle(new OutboundError('timeout', `No socket within ${connectMs} ms.`)),
      connectMs,
    );
    timer.unref?.();
    ws.once('open', () => settle(null));
    ws.once('unexpected-response', (req, res) => {
      res.resume();
      req.destroy();
      settle(new SocketUpgradeRefused(res.statusCode ?? 0));
    });
    ws.on('error', (err) => {
      end(outboundErrorOf(err));
      settle(
        /handshake has timed out/i.test(err.message)
          ? new OutboundError('timeout', `No socket within ${connectMs} ms.`)
          : outboundErrorOf(err),
      );
    });
  });

  return {
    send(message) {
      if (ended || ws.readyState !== WebSocket.OPEN) throw new SocketClosed('closed');
      ws.send(JSON.stringify(message));
    },
    next(ms) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (ended) return Promise.reject(ended);
      if (ms <= 0) return Promise.reject(new OutboundError('timeout', 'No time left.'));
      return new Promise((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = waiting.indexOf(entry);
            if (i >= 0) waiting.splice(i, 1);
            reject(new OutboundError('timeout', `No answer within ${ms} ms.`));
          }, ms),
        };
        entry.timer.unref?.();
        waiting.push(entry);
      });
    },
    close() {
      end(new SocketClosed('closed'));
      ws.terminate();
    },
  };
}
