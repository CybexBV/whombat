/**
 * The server's way to the Hermes homes (hermes-engine.md HE-38, HE-S110): one executor per server — the runner over the
 * long poll (`HermesHomeBridge`), or a service tests hand in — and the transfers of a home's archive in chunks.
 */
import { createHash } from 'node:crypto';
import {
  HERMES_HOME_CHUNK_BYTES,
  type HermesHomeAnswer,
  type HermesHomeMethod,
  type HermesHomeParams,
  type HermesHomeRef,
  type HermesHomeRequest,
  type HermesHomeResult,
  type HermesImportMode,
} from '@whombat/core';
import type { Services } from '../services';
import { HermesHomeBridge, HermesHomeCallError, type HermesHomeExecutor, settle } from './bridge';

export { HermesHomeCallError, type HermesHomeExecutor, type HermesHomeFailure } from './bridge';

const executors = new WeakMap<Services, HermesHomeExecutor>();

/** The server's executor: the runner's, unless a test set one (`useHermesHome`). */
export function hermesHome(services: Services): HermesHomeExecutor {
  let e = executors.get(services);
  if (!e) {
    e = new HermesHomeBridge();
    executors.set(services, e);
  }
  return e;
}

/** The bridge the runner's routes serve, when the executor is the runner's. */
export function hermesHomeBridge(services: Services): HermesHomeBridge | null {
  const e = hermesHome(services);
  return e instanceof HermesHomeBridge ? e : null;
}

/** Tests: steps run by `service` in this process (the runner's `HermesHomeService` on a throwaway root). */
export function useHermesHome(
  services: Services,
  service: { handle(req: HermesHomeRequest): Promise<HermesHomeAnswer> },
): void {
  executors.get(services)?.close();
  let n = 0;
  executors.set(services, {
    runnerSeen: true,
    close() {},
    call<M extends HermesHomeMethod>(method: M, params: HermesHomeParams<M>) {
      return new Promise<HermesHomeResult<M>>((resolve, reject) => {
        void service
          .handle({ id: `local_${++n}`, method, params })
          .then(
            (answer) => settle({ method, resolve: resolve as (v: unknown) => void, reject }, answer),
            reject,
          );
      });
    },
  });
}

/** Closes the executor at shutdown (calls waiting fail as not taken). */
export function closeHermesHome(services: Services): void {
  executors.get(services)?.close();
  executors.delete(services);
}

/** How long one step of a transfer may take: packing or unpacking a home is the long one. */
const PACK_TIMEOUT_MS = 10 * 60_000;
const CHUNK_TIMEOUT_MS = 60_000;

export interface ExportedHome {
  bytes: number;
  sha256: string;
  files: number;
  /** The archive's bytes, chunk by chunk from the runner; the transfer is dropped at the end (or on a failure). */
  read(): AsyncGenerator<Buffer>;
  /** Drops the transfer without reading it. */
  discard(): Promise<void>;
}

/** Asks the runner to pack a home; its bytes are then read in chunks. */
export async function exportHome(exec: HermesHomeExecutor, home: HermesHomeRef): Promise<ExportedHome> {
  const begun = await exec.call('home.exportBegin', { home }, { timeoutMs: PACK_TIMEOUT_MS });
  const discard = () =>
    exec.call('home.discard', { transfer: begun.transfer }).then(
      () => {},
      () => {},
    );
  return {
    bytes: begun.bytes,
    sha256: begun.sha256,
    files: begun.files,
    discard,
    async *read() {
      const hash = createHash('sha256');
      try {
        for (let offset = 0; offset < begun.bytes; ) {
          const length = Math.min(HERMES_HOME_CHUNK_BYTES, begun.bytes - offset);
          const { data } = await exec.call(
            'home.exportChunk',
            { transfer: begun.transfer, offset, length },
            { timeoutMs: CHUNK_TIMEOUT_MS },
          );
          const chunk = Buffer.from(data, 'base64');
          if (chunk.length !== length)
            throw new HermesHomeCallError('failed', 'The runner sent a chunk of the wrong size.');
          hash.update(chunk);
          offset += chunk.length;
          yield chunk;
        }
        if (hash.digest('hex') !== begun.sha256)
          throw new HermesHomeCallError('failed', 'The home’s archive doesn’t match its checksum.');
      } finally {
        await discard();
      }
    },
  };
}

/** Sends a home's archive to the runner and has it put in place; how many files came, and how many things were kept. */
export async function importHome(
  exec: HermesHomeExecutor,
  home: HermesHomeRef,
  archive: { bytes: number; sha256: string; read(): AsyncIterable<Uint8Array> },
  mode: HermesImportMode,
): Promise<{ files: number; kept: number }> {
  const { transfer } = await exec.call('home.importBegin', {
    home,
    bytes: archive.bytes,
    sha256: archive.sha256,
  });
  try {
    let offset = 0;
    let pending = Buffer.alloc(0);
    const send = async (chunk: Buffer) => {
      await exec.call(
        'home.importChunk',
        { transfer, offset, data: chunk.toString('base64') },
        { timeoutMs: CHUNK_TIMEOUT_MS },
      );
      offset += chunk.length;
    };
    for await (const piece of archive.read()) {
      pending = Buffer.concat([pending, Buffer.from(piece)]);
      while (pending.length >= HERMES_HOME_CHUNK_BYTES) {
        await send(pending.subarray(0, HERMES_HOME_CHUNK_BYTES));
        pending = pending.subarray(HERMES_HOME_CHUNK_BYTES);
      }
    }
    if (pending.length > 0) await send(pending);
    return await exec.call('home.importCommit', { transfer, mode }, { timeoutMs: PACK_TIMEOUT_MS });
  } catch (err) {
    await exec.call('home.discard', { transfer }).catch(() => {});
    throw err;
  }
}
