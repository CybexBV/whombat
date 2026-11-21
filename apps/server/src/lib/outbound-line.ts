/** One bounded TCP line under the same destination and DNS rules as outbound HTTP. */
import { createConnection, isIP, type Socket } from 'node:net';
import {
  checkOutboundUrl,
  OutboundError,
  type OutboundPolicy,
  outboundErrorOf,
  safeLookup,
} from './outbound';

/** A failed reply after the command was written may still have changed the device. */
export class OutboundLineError extends OutboundError {
  constructor(
    error: OutboundError,
    readonly sent: boolean,
  ) {
    super(error.reason, error.message);
  }
}

export async function outboundLine(raw: string, command: string, policy: OutboundPolicy): Promise<string> {
  const url = checkOutboundUrl(raw, policy);
  // The scheme is for the destination rule, not TLS or an HTTP request.
  if (url.protocol !== 'http:' || !url.port)
    throw new OutboundError('scheme', 'A TCP line needs an http address with a port.');
  if (!/^[A-Z]{1,32}\n$/.test(command))
    throw new OutboundError('bad_url', 'A command must be one bounded line.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<string>((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    let sent = false;
    let answer = Buffer.alloc(0);
    const finish = (error?: unknown, line?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(new OutboundLineError(outboundErrorOf(error), sent));
      else resolve(line ?? '');
    };
    // Includes DNS and connect time; a missing answer is uncertain, never retried.
    const timer = setTimeout(
      () => finish(new OutboundError('timeout', 'The TCP service did not answer in time.')),
      Math.min(policy.deadlineMs ?? 3000, policy.timeoutMs ?? 3000),
    );
    socket = createConnection({
      host: isIP(host) && policy.dialAddress ? policy.dialAddress(host) : host,
      port: Number(url.port),
      lookup: safeLookup(policy),
      autoSelectFamily: false,
    });
    socket.once('connect', () => {
      sent = true;
      socket?.write(command);
    });
    socket.on('data', (chunk: Buffer) => {
      if (answer.length + chunk.length > 512) {
        finish(new OutboundError('too_large', 'The TCP answer exceeded one bounded line.'));
        return;
      }
      answer = Buffer.concat([answer, chunk]);
      const end = answer.indexOf(10);
      if (end >= 0) finish(undefined, answer.subarray(0, end + 1).toString('utf8'));
    });
    socket.once('error', finish);
    socket.once('end', () => finish(new OutboundError('network', 'The TCP answer ended before a line.')));
    socket.once('close', () =>
      finish(new OutboundError('network', 'The TCP service closed without an answer.')),
    );
  });
}
