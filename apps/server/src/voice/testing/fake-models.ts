/**
 * A fake speech model fetcher (docs/decisions/dictation.md): what `whombat-voice-models` answers, without the
 * internet. Development runs it in process with the fake voice (`WHOMBAT_VOICE=fake`), whose health lists the models it
 * has downloaded; tests drive it directly or on a unix socket (`startFakeVoiceModels`), as the runtime's client talks to
 * the real one.
 *
 * It names both models (sizes as the release's), downloads one at a time in a few seconds with progress (the others
 * asked for wait their turn), leaves a model that is there or on its way as it is, starts a failed one again, stops a
 * download and deletes on `remove`, and records what it was asked. Tests make the next download of a model fail with a
 * problem, shorten the downloads, or start with models there.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VOICE_MODELS_PATHS,
  VoiceModelRequest,
  type VoiceModelState,
  type VoiceModelsState,
} from '@whombat/control-contracts/local';
import { VOICE_DOWNLOAD_MODELS, type VoiceDownloadModel, type VoiceModelProblem } from '@whombat/core/domain';
import { VoiceModelsCallError, type VoiceModelsPort } from '../models';

/** The downloads' sizes, as the release pins them (Parakeet, Whisper, Supertonic 3). */
export const FAKE_MODEL_SIZES: Readonly<Record<VoiceDownloadModel, number>> = {
  parakeet: 669_000_000,
  whisper: 574_000_000,
  supertonic: 145_310_775,
};

export interface FakeVoiceModelsOptions {
  /** How long a download takes (default 6 s) and how often it moves on (default 250 ms). */
  downloadMs?: number;
  stepMs?: number;
  /** Models there from the start. */
  ready?: readonly VoiceDownloadModel[];
}

export type FakeVoiceModelsCall = { kind: 'fetch' | 'remove'; model: VoiceDownloadModel };

export class FakeVoiceModels implements VoiceModelsPort {
  /** The next download of that model fails with this problem (once). */
  readonly failNext: Partial<Record<VoiceDownloadModel, VoiceModelProblem>> = {};
  /** Fail the next N `remove(model)` calls as if the fetcher were temporarily unreachable. */
  readonly failNextRemove: Partial<Record<VoiceDownloadModel, number>> = {};
  /** When true, `state()` throws as if the fetcher were temporarily unreachable. */
  unreachable = false;
  /** What it was asked, in order. */
  readonly calls: FakeVoiceModelsCall[] = [];
  readonly #models = new Map<VoiceDownloadModel, VoiceModelState>();
  /** Asked for and not started yet, in order. */
  readonly #queue: VoiceDownloadModel[] = [];
  #timer: NodeJS.Timeout | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #downloadMs: number;
  readonly #stepMs: number;

  constructor(options: FakeVoiceModelsOptions = {}) {
    this.#downloadMs = options.downloadMs ?? 6_000;
    this.#stepMs = options.stepMs ?? 250;
    for (const id of VOICE_DOWNLOAD_MODELS) {
      const size = FAKE_MODEL_SIZES[id];
      const there = options.ready?.includes(id) ?? false;
      this.#models.set(id, { id, state: there ? 'ready' : 'absent', size, received: there ? size : 0 });
    }
  }

  /** Tells `listener` about every change of a model's state (tests wait on it); returns what stops it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Until `done` holds for the models (checked now and at every change). */
  until(done: (models: VoiceModelState[]) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!done([...this.#models.values()])) return;
        stop();
        resolve();
      };
      const stop = this.onChange(check);
      check();
    });
  }

  /** The models downloaded (the fake voice's health). */
  ready(): VoiceDownloadModel[] {
    return [...this.#models.values()].filter((m) => m.state === 'ready').map((m) => m.id);
  }

  /** Sets leftover partial bytes on an absent model (e.g. an interrupted opt-in download after restart). */
  setPartial(model: VoiceDownloadModel, received: number): void {
    const m = this.#model(model);
    this.#set(model, { id: model, state: 'absent', size: m.size, received });
  }

  async state(): Promise<VoiceModelsState> {
    if (this.unreachable) throw new VoiceModelsCallError(0, 'unavailable', 'fetcher unreachable');
    return {
      v: 1,
      models: [...this.#models.values()].map((m) => ({ ...m })),
      free: 50_000_000_000,
    };
  }

  async fetch(model: VoiceDownloadModel): Promise<VoiceModelsState> {
    this.calls.push({ kind: 'fetch', model });
    if (this.unreachable) throw new VoiceModelsCallError(0, 'unavailable', 'fetcher unreachable');
    const m = this.#model(model);
    if (m.state === 'absent' || m.state === 'failed') {
      this.#set(model, { id: model, state: 'waiting', size: m.size, received: m.received });
      this.#queue.push(model);
      this.#next();
    }
    return this.state();
  }

  async remove(model: VoiceDownloadModel): Promise<VoiceModelsState> {
    this.calls.push({ kind: 'remove', model });
    if (this.unreachable) throw new VoiceModelsCallError(0, 'unavailable', 'fetcher unreachable');
    const failCount = this.failNextRemove[model] ?? 0;
    if (failCount > 0) {
      this.failNextRemove[model] = failCount - 1;
      throw new VoiceModelsCallError(0, 'unavailable', 'remove failed');
    }
    const m = this.#model(model);
    const queued = this.#queue.indexOf(model);
    if (queued >= 0) this.#queue.splice(queued, 1);
    this.#set(model, { id: model, state: 'absent', size: m.size, received: 0 });
    if (m.state === 'downloading') this.#stop();
    this.#next();
    return this.state();
  }

  /** Stops the download that runs (the server closes). */
  close(): void {
    this.#stop();
  }

  #set(id: VoiceDownloadModel, state: VoiceModelState): void {
    this.#models.set(id, state);
    for (const listener of this.#listeners) listener();
  }

  #model(id: VoiceDownloadModel): VoiceModelState {
    const m = this.#models.get(id);
    if (!m) throw new Error(`fake voice models: no ${id}`);
    return m;
  }

  #stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Starts the next download asked for, when none runs. */
  #next(): void {
    if (this.#timer) return;
    const id = this.#queue.shift();
    if (!id) return;
    const m = this.#model(id);
    this.#set(id, { id, state: 'downloading', size: m.size, received: 0 });
    const steps = Math.max(1, Math.round(this.#downloadMs / this.#stepMs));
    let step = 0;
    this.#timer = setInterval(() => {
      step++;
      const problem = this.failNext[id];
      if (problem && step * 2 >= steps) {
        delete this.failNext[id];
        this.#set(id, { id, state: 'failed', size: m.size, received: 0, problem });
      } else if (step >= steps) {
        this.#set(id, { id, state: 'ready', size: m.size, received: m.size });
      } else {
        this.#set(id, {
          id,
          state: 'downloading',
          size: m.size,
          received: Math.floor((m.size * step) / steps),
        });
        return;
      }
      this.#stop();
      this.#next();
    }, this.#stepMs);
    this.#timer.unref?.();
  }
}

/* On a unix socket ------------------------------------------------------------------------------------------------ */

export interface FakeVoiceModelsServer {
  socketPath: string;
  models: FakeVoiceModels;
  close(): Promise<void>;
}

/** The fake behind the models socket, as `whombat-voice-models` serves it (errors as `LocalError`s). */
export async function startFakeVoiceModels(
  options: { models?: FakeVoiceModels } = {},
): Promise<FakeVoiceModelsServer> {
  const models = options.models ?? new FakeVoiceModels();
  const dir = mkdtempSync(join(tmpdir(), 'wb-voice-models-'));
  const socketPath = join(dir, 'models.sock');
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = createServer((req, res) => {
    serve(models, req, res).catch(() => fail(res, 500, 'internal', 'failed'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    models,
    close: () =>
      new Promise<void>((resolve) => {
        models.close();
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  if (!res.headersSent) send(res, status, { error: { code, message } });
}

async function serve(models: FakeVoiceModels, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === VOICE_MODELS_PATHS.state)
    return send(res, 200, await models.state());
  const post = req.method === 'POST';
  if (!post || (req.url !== VOICE_MODELS_PATHS.fetch && req.url !== VOICE_MODELS_PATHS.remove))
    return fail(res, 400, 'bad_request', 'no such route');
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: VoiceModelRequest;
  try {
    body = VoiceModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return fail(res, 400, 'bad_request', 'bad request');
  }
  const answer =
    req.url === VOICE_MODELS_PATHS.fetch ? await models.fetch(body.model) : await models.remove(body.model);
  send(res, 200, answer);
}
