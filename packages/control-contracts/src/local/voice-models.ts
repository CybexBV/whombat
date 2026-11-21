/**
 * The voice models socket (3.1; Whombat docs/decisions/dictation.md): the runtime → the appliance's model fetcher
 * `whombat-voice-models`, HTTP/1.1 JSON over a unix socket at `WHOMBAT_VOICE_MODELS_SOCKET` (`VOICE_MODELS_SOCKET_DEFAULT`;
 * unset: the box has no speech models to fetch). The speech service itself has no network, so its models are fetched by
 * this second service after the box is installed, never with the image: from the sources the box's release names, each
 * checked by its size and sha256 before the speech service sees it.
 *
 * | Path | Request | Answer |
 * |---|---|---|
 * | `GET /v1/voice-models` | — | `VoiceModelsState {v, models, free?}` |
 * | `POST /v1/voice-models/fetch` | `VoiceModelRequest {v, model}` | `VoiceModelsState` |
 * | `POST /v1/voice-models/remove` | `VoiceModelRequest {v, model}` | `VoiceModelsState` |
 *
 * Plain v1 responses carry only speech-recognition models (`parakeet`, `whisper`) so an earlier runtime after a
 * rollback still parses the response; newer runtimes pass `?include=supertonic` (or name `supertonic` in a fetch or
 * remove request) to receive opt-in TTS models as well.
 *
 * `fetch` starts a download or queues it behind the one that runs (one at a time); a model that is there or on its way
 * is left as it is, and a failed one starts again. A download that can't go on (no internet) waits and tries again by
 * itself, resuming where it stopped. `remove` stops a download and deletes the model. Policy (what to fetch, when) is
 * the runtime's; this service only fetches what it is asked.
 *
 * Errors are `LocalError`: 400 `bad_request` (not the request's JSON, a model the release doesn't name, a wrong path or
 * method). A peer that isn't the runtime or root gets 403 `forbidden`. Requests are strict, answers tolerant.
 */
import {
  VoiceDownloadModel,
  VoiceModelProblem,
  VoiceModelState as VoiceModelStateName,
} from '@whombat/core/domain';
import { z } from 'zod';

const V = z.literal(1);

export const VOICE_MODELS_SOCKET_ENV = 'WHOMBAT_VOICE_MODELS_SOCKET';
export const VOICE_MODELS_SOCKET_DEFAULT = '/run/whombat-voice-models/models.sock';

export const VOICE_MODELS_PATHS = {
  /** GET: every model the release names and how far it is. */
  state: '/v1/voice-models',
  fetch: '/v1/voice-models/fetch',
  remove: '/v1/voice-models/remove',
} as const;

/** Query parameter opting into non-STT models (e.g. `?include=supertonic`) so older v1 runtimes stay compatible. */
export const VOICE_MODELS_INCLUDE_PARAM = 'include';

/** A model's size bound (4 GiB): the release's models are well under it. */
export const VOICE_MODEL_MAX_BYTES = 4_294_967_296;

/**
 * One model: `size` its download in bytes (known before it starts), `received` the bytes kept so far, `problem` why it
 * waits (`waiting`) or stopped (`failed`).
 */
export const VoiceModelState = z.object({
  id: VoiceDownloadModel,
  state: VoiceModelStateName,
  size: z.number().int().min(0).max(VOICE_MODEL_MAX_BYTES),
  received: z.number().int().min(0).max(VOICE_MODEL_MAX_BYTES),
  problem: VoiceModelProblem.optional(),
});
export type VoiceModelState = z.infer<typeof VoiceModelState>;

/** Every model the release names, and the free bytes where they are kept. */
export const VoiceModelsState = z.object({
  v: V,
  models: z.array(VoiceModelState).max(8),
  free: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type VoiceModelsState = z.infer<typeof VoiceModelsState>;

export const VoiceModelRequest = z.strictObject({ v: V, model: VoiceDownloadModel });
export type VoiceModelRequest = z.infer<typeof VoiceModelRequest>;
