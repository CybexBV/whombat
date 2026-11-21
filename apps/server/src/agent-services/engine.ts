/**
 * The container engine the agent's services run in (docs/decisions/one-person.md OP-16, OP-19; brief I-2): rootless
 * Podman with Docker's API on its unix socket (`WHOMBAT_CONTAINERS_SOCKET`, `/run/whombat-containers/podman.sock` on the
 * appliance). The server only lists the containers that carry the services' label and stops one: what is started is the
 * agent's (`docker run` in its commands).
 *
 * One HTTP/1.1 request per call. A socket that isn't there, refuses or doesn't answer in time is `EngineUnavailable`;
 * another status is `EngineError` with the engine's message.
 */
import { requestUnixHttp } from '@whombat/node-io/http';

/** Docker's API version Podman's compatible API answers on (Podman 4 and 5 serve 1.41). */
export const ENGINE_API = '/v1.41';
/** An answer of the engine is refused beyond this. */
const MAX_BODY = 4 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
/** How long a stop waits for the container before the engine kills it, seconds. */
const STOP_GRACE_S = 10;

/** One container of `GET /containers/json` as far as the services need it. */
export interface EngineContainer {
  Id: string;
  Names?: string[] | null;
  Image?: string;
  /** `created`, `running`, `restarting`, `paused`, `exited`, `dead`, `removing` (Podman also `configured`, `stopped`). */
  State?: string;
  /** Unix seconds. */
  Created?: number;
  /** Podman's own field: when it last started (unix seconds; Docker's list doesn't carry it). */
  StartedAt?: number;
  /** `Up 5 minutes`, `Exited (1) 2 minutes ago`. */
  Status?: string;
  Ports?: { IP?: string; PrivatePort?: number; PublicPort?: number; Type?: string }[] | null;
  Labels?: Record<string, string> | null;
}

/** The engine isn't reachable: no socket configured, nothing listening, or no answer in time. */
export class EngineUnavailable extends Error {
  constructor(
    readonly reason: 'not_configured' | 'not_running' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'EngineUnavailable';
  }
}

/** The engine answered with an error status. */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** What the services need of the engine (a fake in tests). */
export interface ContainerEngine {
  /** Every container, running or not, that carries `label` (`key=value`). */
  list(label: string): Promise<EngineContainer[]>;
  /** Stops one; false when it was stopped already. Throws `EngineError` 404 for a container that isn't there. */
  stop(id: string): Promise<boolean>;
}

/** Podman's (Docker's) API over its unix socket. */
export class SocketEngine implements ContainerEngine {
  constructor(readonly socket: string) {}

  async #call(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: Buffer }> {
    try {
      const res = await requestUnixHttp({
        socketPath: this.socket,
        path: `${ENGINE_API}${path}`,
        method,
        headers: { host: 'containers', accept: 'application/json' },
        deadlineMs: TIMEOUT_MS,
        maxResponseBytes: MAX_BODY,
      });
      return { status: res.status, body: res.body };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES')
        throw new EngineUnavailable('not_running', `The container engine isn’t running (${code}).`);
      if (err instanceof Error && err.name === 'UnixHttpError')
        throw new EngineUnavailable('timeout', `The container engine didn’t answer (${err.message}).`);
      throw err;
    }
  }

  async list(label: string): Promise<EngineContainer[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    const res = await this.#call('GET', `/containers/json?all=1&filters=${filters}`);
    if (res.status !== 200) throw new EngineError(res.status, engineMessage(res.body, res.status));
    const parsed: unknown = JSON.parse(res.body.toString('utf8'));
    return Array.isArray(parsed) ? (parsed as EngineContainer[]) : [];
  }

  async stop(id: string): Promise<boolean> {
    const res = await this.#call('POST', `/containers/${encodeURIComponent(id)}/stop?t=${STOP_GRACE_S}`);
    if (res.status === 204) return true;
    if (res.status === 304) return false;
    throw new EngineError(res.status, engineMessage(res.body, res.status));
  }
}

/** The engine's own words of an error answer (`{"message": …}`), else its status. */
function engineMessage(body: Buffer, status: number): string {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message.slice(0, 300);
  } catch {
    // Not JSON.
  }
  return `the container engine answered ${status}`;
}
