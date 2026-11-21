/** Count retained cancellation listeners after real fake-appliance downloads, without browser or network timing. */
import assert from 'node:assert/strict';
import { getEventListeners, setMaxListeners } from 'node:events';
import { createFakeAppliance } from '../../packages/client/src/session/fake';
import { createSecureSession } from '../../packages/client/src/session/secure';
import type { ApplianceSession, ResourceStream } from '../../packages/client/src/session/types';

const iterations = 30;
const repetitions = 5;
const bytes = new Uint8Array(64 * 1024).fill(73);
const ref = { kind: 'attachment', burrow: 'benchmark', attachmentId: 'att_benchmark' } as const;
const resource = {
  meta: { contentType: 'application/octet-stream', size: bytes.byteLength, name: null, sha256: null },
  bytes,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function consume(stream: ResourceStream): Promise<number> {
  let received = 0;
  for await (const chunk of stream.chunks) received += chunk.byteLength;
  assert.equal(received, bytes.byteLength);
  return received;
}

function sessionWith(resources: Parameters<typeof createFakeAppliance>[0]['resources']): ApplianceSession {
  const appliance = createFakeAppliance({
    handle: async () => ({ status: 200, body: {} }),
    resources,
  });
  return createSecureSession({ connector: appliance.connector });
}

const samples: { transfers: number; receivedBytes: number; retainedAbortListeners: number }[] = [];
for (let run = 0; run < repetitions; run++) {
  const session = sessionWith(async () => resource);
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);
  try {
    // Warm the interactive and bulk connections without registering on the measured signal.
    await consume(await session.openResource(ref));
    let receivedBytes = 0;
    for (let i = 0; i < iterations; i++)
      receivedBytes += await consume(await session.openResource(ref, { signal: controller.signal }));
    samples.push({
      transfers: iterations,
      receivedBytes,
      retainedAbortListeners: getEventListeners(controller.signal, 'abort').length,
    });
  } finally {
    session.close();
  }
}

const requested = deferred<void>();
const metadata = deferred<null>();
const session = sessionWith(async () => {
  requested.resolve();
  return metadata.promise;
});
const controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
let cancellation: string;
try {
  const result = session.openResource(ref, { signal: controller.signal }).then(
    () => 'opened',
    (error: unknown) => (error instanceof Error ? error.name : String(error)),
  );
  await requested.promise;
  controller.abort();
  cancellation = await Promise.race([
    result,
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('pending after 50 ms'), 50);
    }),
  ]);
} finally {
  clearTimeout(timer);
  metadata.resolve(null);
  session.close();
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      workload: { iterations, repetitions, bytesPerTransfer: bytes.byteLength, warmupTransfers: 1 },
      samples,
      cancellationBeforeMetadata: cancellation,
      metric: 'Listener counts and cancellation completion; no latency or heap-size claim.',
    },
    null,
    2,
  ),
);
