/**
 * One UDP datagram under a destination rule (a console's discovery): it goes only where the rule allows, and the
 * answer is the first one from the address it went to.
 */
import { createSocket, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundError, type OutboundPolicy, outboundDatagram } from './outbound';

let server: Socket;
let port = 0;
const heard: string[] = [];

beforeAll(async () => {
  server = createSocket('udp4');
  server.on('message', (msg, from) => {
    heard.push(msg.toString());
    if (msg.toString() === 'quiet') return;
    server.send(Buffer.from(`answer to ${msg}`), from.port, from.address);
  });
  await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

const allowed = (checked: string[][] = []): OutboundPolicy => ({
  destination: { schemes: ['http:'], check: (_host, addresses) => void checked.push([...addresses]) },
  timeoutMs: 300,
});

describe('outboundDatagram', () => {
  it('checks the address, sends one datagram and returns the answer', async () => {
    const checked: string[][] = [];
    const answer = await outboundDatagram(`http://127.0.0.1:${port}/`, Buffer.from('who'), allowed(checked));
    expect(answer?.toString()).toBe('answer to who');
    expect(checked).toEqual([['127.0.0.1']]);
  });

  it('resolves a name through the rule before sending', async () => {
    const checked: string[][] = [];
    const answer = await outboundDatagram(`http://ps5.home:${port}/`, Buffer.from('named'), {
      ...allowed(checked),
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(answer?.toString()).toBe('answer to named');
    expect(checked).toEqual([['127.0.0.1']]);
  });

  it('is no answer when nothing comes back in time', async () => {
    expect(await outboundDatagram(`http://127.0.0.1:${port}/`, Buffer.from('quiet'), allowed())).toBeNull();
  });

  it('sends nothing where the rule refuses', async () => {
    const before = heard.length;
    const refuse: OutboundPolicy = {
      destination: {
        schemes: ['http:'],
        check: () => {
          throw new OutboundError('destination', 'Not on your home network list.');
        },
      },
    };
    await expect(outboundDatagram(`http://127.0.0.1:${port}/`, Buffer.from('no'), refuse)).rejects.toThrow(
      OutboundError,
    );
    await expect(outboundDatagram(`http://127.0.0.1:${port}/`, Buffer.from('no'))).rejects.toThrow(
      OutboundError,
    );
    expect(heard.length).toBe(before);
  });
});
