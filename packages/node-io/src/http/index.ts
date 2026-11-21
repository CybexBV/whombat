import { type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, request } from 'node:http';

/** Transport failures only. HTTP statuses, JSON, authentication and retries belong to the adapter. */
export class UnixHttpError extends Error {
  constructor(readonly kind: 'timeout' | 'too_large' | 'aborted' | 'incomplete') {
    super(
      {
        timeout: 'unix HTTP request timed out',
        too_large: 'unix HTTP response too large',
        aborted: 'aborted',
        incomplete: 'unix HTTP response closed before the answer was complete',
      }[kind],
    );
    this.name = 'UnixHttpError';
  }
}

export interface UnixHttpRequest {
  socketPath: string;
  path: string;
  method?: string;
  headers?: OutgoingHttpHeaders;
  body?: string | Buffer;
  signal?: AbortSignal | null;
  /** Socket inactivity, reset by I/O; no limit when omitted or zero. */
  idleTimeoutMs?: number;
  /** Wall-clock deadline from starting the request; no limit when omitted, zero expires on the next timer turn. */
  deadlineMs?: number;
  /** Streaming callers may stop the deadline at headers. Cancellation still follows the stream. */
  deadlineUntil?: 'headers' | 'end';
}

export interface UnixHttpStream {
  res: IncomingMessage;
  request: ClientRequest;
}

/**
 * One request over a Unix socket, resolved at headers without reading the body. The caller owns the response and
 * must read or destroy it. Timers and the abort listener live until the response ends or either side closes.
 */
export function openUnixHttp(options: UnixHttpRequest): Promise<UnixHttpStream> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new UnixHttpError('aborted'));
      return;
    }
    let response: IncomingMessage | undefined;
    let timer: NodeJS.Timeout | undefined;
    const req = request({
      socketPath: options.socketPath,
      path: options.path,
      method: options.method ?? 'GET',
      headers: options.headers,
      // One independently owned connection per call; no pool or mutation retries.
      agent: false,
    });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      req.setTimeout(0);
      req.off('timeout', onTimeout);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
      // After headers the promise has resolved; the same failure reaches the response's reader instead.
      response?.destroy(error);
      req.destroy(error);
    };
    const onAbort = () => fail(new UnixHttpError('aborted'));
    const onTimeout = () => fail(new UnixHttpError('timeout'));
    const onError = (error: Error) => {
      cleanup();
      reject(error);
      response?.destroy(error);
    };
    req.on('error', onError);
    req.once('close', () => {
      cleanup();
      if (!response) reject(new UnixHttpError('incomplete'));
      req.off('error', onError);
    });
    req.once('response', (res) => {
      response = res;
      if (options.deadlineUntil === 'headers') clearTimeout(timer);
      res.once('end', cleanup);
      res.once('close', cleanup);
      // Observe late failures even if the stream's consumer has not attached its handlers yet.
      res.once('error', cleanup);
      resolve({ res, request: req });
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.idleTimeoutMs) req.setTimeout(options.idleTimeoutMs, onTimeout);
    if (options.deadlineMs !== undefined) timer = setTimeout(onTimeout, options.deadlineMs);
    req.end(options.body);
  });
}

/** Read raw response bytes with a hard bound, rejecting partial answers even when their bytes look valid. */
export function readUnixHttpBody(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      res.destroy();
      reject(new RangeError('maxBytes must be a non-negative safe integer'));
      return;
    }
    const incomplete = () =>
      res.errored instanceof UnixHttpError ? res.errored : new UnixHttpError('incomplete');
    if (res.destroyed) {
      reject(incomplete());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      res.off('data', onData);
      res.off('end', onEnd);
      res.off('error', onError);
      res.off('aborted', onAborted);
      res.off('close', onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(incomplete());
    const onClose = () => onAborted();
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        onError(new UnixHttpError('too_large'));
        res.destroy();
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      if (!res.complete) return onAborted();
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    res.on('data', onData);
    res.once('end', onEnd);
    res.once('error', onError);
    res.once('aborted', onAborted);
    res.once('close', onClose);
  });
}

/** One bounded raw answer; accepts every HTTP status and never parses or retries it. */
export async function requestUnixHttp(options: UnixHttpRequest & { maxResponseBytes: number }) {
  const { res } = await openUnixHttp(options);
  const body = await readUnixHttpBody(res, options.maxResponseBytes);
  return { status: res.statusCode ?? 0, headers: res.headers, body };
}
