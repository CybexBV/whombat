/**
 * The speech models' fetcher (docs/decisions/dictation.md): the appliance's `whombat-voice-models`, which downloads
 * the models the speech service runs (the speech service itself has no network), as the runtime sees it, a small JSON
 * API on its unix socket (`WHOMBAT_VOICE_MODELS_SOCKET`, contracts 3.1):
 *
 *   GET  /v1/voice-models          → {v, models, free?}
 *   POST /v1/voice-models/fetch    {v, model} → {v, models, free?}   (starts or queues a download; a failed one again)
 *   POST /v1/voice-models/remove   {v, model} → {v, models, free?}   (stops a download and deletes the model)
 *
 * It only fetches what it is asked; what to fetch and when is the runtime's (`service.ts`). Errors are `LocalError`s
 * (400 `bad_request`, 403 `forbidden`). `WHOMBAT_VOICE=fake` puts the fake fetcher (`testing/fake-models.ts`) in its
 * place, unset leaves the box without one.
 */
import {
  LocalError,
  VOICE_MODELS_INCLUDE_PARAM,
  VOICE_MODELS_PATHS,
  VoiceModelRequest,
  VoiceModelsState,
} from '@whombat/control-contracts/local';
import type { VoiceDownloadModel } from '@whombat/core/domain';
import { requestUnixHttp, UnixHttpError } from '@whombat/node-io/http';
import type { Config } from '../config';
import { FakeVoiceModels } from './testing/fake-models';

/** The fetcher: the socket's client, or the fake. */
export interface VoiceModelsPort {
  state(): Promise<VoiceModelsState>;
  /** *Download* and *Try again*: a model there or on its way stays as it is. */
  fetch(model: VoiceDownloadModel): Promise<VoiceModelsState>;
  /** *Remove*: stops its download and deletes it. */
  remove(model: VoiceDownloadModel): Promise<VoiceModelsState>;
}

/** A call the fetcher refused (its status and `LocalError` code), or one it didn't answer (status 0). */
export class VoiceModelsCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceModelsCallError';
  }
}

/** The fetcher answers from memory; a remove deletes a file first. */
const CALL_MS = 5_000;
const ANSWER_BYTES = 64 * 1024;

export class VoiceModelsSocketClient implements VoiceModelsPort {
  constructor(private readonly socketPath: string) {}

  private async call(path: string, body?: VoiceModelRequest): Promise<VoiceModelsState> {
    const payload = body === undefined ? undefined : JSON.stringify(VoiceModelRequest.parse(body));
    let answer: Awaited<ReturnType<typeof requestUnixHttp>>;
    try {
      answer = await requestUnixHttp({
        socketPath: this.socketPath,
        path,
        method: payload === undefined ? 'GET' : 'POST',
        headers:
          payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        ...(payload === undefined ? {} : { body: payload }),
        deadlineMs: CALL_MS,
        maxResponseBytes: ANSWER_BYTES,
      });
    } catch (err) {
      const why = err instanceof UnixHttpError ? err.kind : String(err);
      throw new VoiceModelsCallError(0, 'unreachable', `voice models ${path}: ${why}`);
    }
    const text = answer.body.toString('utf8');
    if (answer.status >= 300) {
      let code = 'error';
      try {
        code = LocalError.parse(JSON.parse(text)).error.code;
      } catch {
        /* not a LocalError */
      }
      throw new VoiceModelsCallError(answer.status, code, `voice models ${path}: ${answer.status} ${code}`);
    }
    try {
      return VoiceModelsState.parse(JSON.parse(text));
    } catch {
      throw new VoiceModelsCallError(answer.status, 'invalid_answer', `voice models ${path}: not its answer`);
    }
  }

  private withInclude(path: string): string {
    return `${path}?${VOICE_MODELS_INCLUDE_PARAM}=supertonic`;
  }

  state(): Promise<VoiceModelsState> {
    return this.call(this.withInclude(VOICE_MODELS_PATHS.state));
  }

  fetch(model: VoiceDownloadModel): Promise<VoiceModelsState> {
    return this.call(this.withInclude(VOICE_MODELS_PATHS.fetch), { v: 1, model });
  }

  remove(model: VoiceDownloadModel): Promise<VoiceModelsState> {
    return this.call(this.withInclude(VOICE_MODELS_PATHS.remove), { v: 1, model });
  }
}

/* Per process ----------------------------------------------------------------------------------------------------- */

type ModelsConfig = Pick<Config, 'WHOMBAT_VOICE' | 'WHOMBAT_VOICE_MODELS_SOCKET'>;

const ports = new WeakMap<object, VoiceModelsPort | null>();

/** The process's model fetcher (one per `Services`): the fake with the fake voice, the socket's client, or none. */
export function voiceModelsFor(services: { config: ModelsConfig }): VoiceModelsPort | null {
  if (ports.has(services)) return ports.get(services) ?? null;
  const { WHOMBAT_VOICE: mode, WHOMBAT_VOICE_MODELS_SOCKET: socket } = services.config;
  const port =
    mode === 'off'
      ? null
      : mode === 'fake'
        ? new FakeVoiceModels()
        : socket
          ? new VoiceModelsSocketClient(socket)
          : null;
  ports.set(services, port);
  return port;
}

/** Tests: this fetcher (or none) for these services. */
export function setVoiceModelsFor(services: object, port: VoiceModelsPort | null): void {
  ports.set(services, port);
}
