/**
 * Test helper: surface server errors in test output. The integration apps run with `logger: false`, so
 * without this a failing request is only a bare `500` and a failing background step (after-commit work,
 * runner protocol, collab store) is silent. Errors and warnings are printed to stderr, which Vitest
 * attaches to the test that was running.
 */
import type { FastifyError, FastifyInstance } from 'fastify';
import { ApiError } from '../lib/errors';
import type { Logger } from '../services';

/** An error with its `cause` chain (Drizzle wraps the Postgres error as the cause of "Failed query"). */
function formatError(err: unknown): string {
  const lines: string[] = [];
  for (let e: unknown = err, depth = 0; e !== undefined && depth < 5; depth++) {
    if (!(e instanceof Error)) {
      lines.push(String(e));
      break;
    }
    lines.push(depth === 0 ? (e.stack ?? e.message) : `caused by: ${e.stack ?? e.message}`);
    e = e.cause;
  }
  return lines.join('\n');
}

function format(obj: unknown): string {
  if (obj instanceof Error) return formatError(obj);
  if (obj && typeof obj === 'object') {
    const { err, ...rest } = obj as { err?: unknown };
    const parts: string[] = [];
    if (Object.keys(rest).length) parts.push(JSON.stringify(rest));
    if (err !== undefined) parts.push(formatError(err));
    return parts.join('\n');
  }
  return String(obj);
}

/** A services logger that prints errors and warnings (not info/debug) to stderr. */
export function testLogger(): Logger {
  return {
    info() {},
    debug() {},
    warn: (obj, msg) => console.warn(`[server warn] ${msg ?? ''}\n${format(obj)}`),
    error: (obj, msg) => console.error(`[server error] ${msg ?? ''}\n${format(obj)}`),
  };
}

/** Prints every request that ends in a server error (5xx), with its stack. Call before `ready()`. */
export function logServerErrors(app: FastifyInstance, log: Logger = testLogger()) {
  app.addHook('onError', async (req, _reply, err: FastifyError | ApiError) => {
    const status = err instanceof ApiError ? err.status : (err as FastifyError).statusCode;
    if (status !== undefined && status < 500) return;
    if (err instanceof ApiError && err.code === 'not_implemented') return;
    log.error({ method: req.method, url: req.url, err }, 'request failed');
  });
}
