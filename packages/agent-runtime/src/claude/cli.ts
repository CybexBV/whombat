/**
 * One `claude -p` process in stream-JSON mode (docs/decisions/provider-subscriptions.md SUB-10, SUB-12), for the
 * questions Whombat asks Claude Code without a model turn: its plan's usage (`get_usage`, usage/claude.ts) and its
 * models (`initialize`, models/list.ts). Turns run on Hermes (claude-directsdk.md CDS-01). The unmodified binary runs
 * as a subprocess in its own process group (managed: inside the task's sandbox), one JSON message per line in each
 * direction. Whombat's own requests are correlated with their `control_response`; a request from the CLI is refused
 * (no turn runs, so none is expected). `close()` always kills the whole group.
 */
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { ProcessSpawner } from '../contract';
import { AsyncQueue } from '../support/async-queue';
import { killProcessTree, spawnGroup } from '../support/process-group';

type Obj = Record<string, unknown>;

/** One line out of the CLI. Loosely typed: readers check each field. */
interface ClaudeMessage extends Obj {
  type: string;
}

/** A host-protocol request (either direction). */
interface ControlRequest {
  type: 'control_request';
  request_id: string;
  request: Obj & { subtype: string };
}

interface ControlResponse {
  type: 'control_response';
  response:
    | { subtype: 'success'; request_id: string; response?: Obj }
    | { subtype: 'error'; request_id: string; error: string };
}

export interface ClaudeCliOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Starts the process (managed: inside the task's sandbox); default a process group on the host. */
  spawn?: ProcessSpawner;
  killGraceMs?: number;
}

interface Pending {
  subtype: string;
  resolve: (value: Obj) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/** A `.js`/`.mjs` executable (tests' fake CLI) runs with this Node; anything else is executed directly. */
export function launchCommand(
  executable: string,
  args: readonly string[],
): { command: string; args: string[] } {
  return /\.(c|m)?js$/.test(executable)
    ? { command: process.execPath, args: [executable, ...args] }
    : { command: executable, args: [...args] };
}

export class ClaudeCliProcess {
  readonly child: ChildProcess;
  /** Everything from the CLI except the host protocol's own messages, in order; closed when stdout ends. */
  readonly messages = new AsyncQueue<ClaudeMessage>();
  readonly #pending = new Map<string, Pending>();
  readonly #stderr: string[] = [];
  readonly #killGraceMs: number;
  #closing: Promise<void> | null = null;
  #exited = false;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(options: ClaudeCliOptions) {
    this.#killGraceMs = options.killGraceMs ?? 2000;
    this.child = (options.spawn ?? spawnGroup)(options.command, options.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
    });
    const child = this.child;
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => this.#receive(line));
      lines.on('close', () => this.#ended(null));
    } else this.#ended(null);
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', (line) => {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colour codes from CLI logs
        const clean = line.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 500);
        if (!clean.trim()) return;
        this.#stderr.push(clean.trim());
        if (this.#stderr.length > 20) this.#stderr.shift();
      });
    }
    child.stdin?.on('error', () => {});
    child.once('error', (error) => {
      this.#exited = true;
      this.#ended(error);
    });
    child.once('exit', (code, signal) => {
      this.#exited = true;
      this.#exit = { code, signal };
      this.#rejectPending(new Error(`Claude Code exited (${String(code ?? signal)}).`));
    });
  }

  /** The last lines the CLI wrote to stderr (for error messages; never contains a secret Whombat passed). */
  get stderr(): readonly string[] {
    return this.#stderr;
  }

  get exit(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.#exit;
  }

  /** Writes one message to the CLI's stdin. False when the CLI isn't reading any more. */
  send(message: Obj): boolean {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  /** A host-protocol request to the CLI (`initialize`, `interrupt`): its response, or an error. */
  request(request: Obj & { subtype: string }, timeoutMs = 60_000): Promise<Obj> {
    const id = `wb_${randomBytes(6).toString('hex')}`;
    return new Promise<Obj>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Claude Code didn’t answer ${request.subtype} in time.`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { subtype: request.subtype, resolve, reject, timer });
      const message: ControlRequest = { type: 'control_request', request_id: id, request };
      if (!this.send(message as unknown as Obj)) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error('Claude Code is not running.'));
      }
    });
  }

  /** Closes stdin: the CLI finishes what it is doing and exits. */
  endInput(): void {
    try {
      this.child.stdin?.end();
    } catch {
      // already closed
    }
  }

  /** Kills the process group (and escaped descendants). Idempotent; safe after exit. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#rejectPending(new Error('Claude Code was stopped.'));
      this.endInput();
      await killProcessTree(this.child, { graceMs: this.#exited ? 0 : this.#killGraceMs });
    })();
    return this.#closing;
  }

  #receive(line: string): void {
    let message: ClaudeMessage;
    try {
      message = JSON.parse(line) as ClaudeMessage;
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'control_response':
        this.#answered(message as unknown as ControlResponse);
        return;
      case 'control_request':
        this.#refuse(message as unknown as ControlRequest);
        return;
      case 'control_cancel_request':
      case 'keep_alive':
        return;
      default:
        this.messages.push(message);
    }
  }

  #answered(message: ControlResponse): void {
    const response = message.response;
    const pending = response ? this.#pending.get(response.request_id) : undefined;
    if (!response || !pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(response.request_id);
    if (response.subtype === 'success') pending.resolve(response.response ?? {});
    else pending.reject(new Error(response.error || `Claude Code refused ${pending.subtype}.`));
  }

  /** A request from the CLI (a permission question, a hook): none is expected without a turn, so each is refused. */
  #refuse(message: ControlRequest): void {
    const id = message.request_id;
    if (typeof id !== 'string') return;
    const reply: ControlResponse = {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: id,
        error: `Whombat doesn’t handle ${String(message.request?.subtype)} requests.`,
      },
    };
    this.send(reply as unknown as Obj);
  }

  #rejectPending(error: Error): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      this.#pending.delete(id);
      p.reject(error);
    }
  }

  #ended(error: Error | null): void {
    this.#rejectPending(error ?? new Error('Claude Code closed its output.'));
    if (error) this.messages.fail(error);
    else this.messages.close();
  }
}
