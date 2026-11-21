import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundError, type OutboundPolicy } from './outbound';
import { outboundLine } from './outbound-line';

let server: Server;
let port: number;
const sockets = new Set<Socket>();
const heard: string[] = [];
beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', (bytes) => {
      const command = bytes.toString();
      heard.push(command);
      if (command === 'QUIET\n') return;
      if (command === 'CLOSE\n') {
        socket.end();
        return;
      }
      if (command === 'LONG\n') {
        socket.write('x'.repeat(513));
        return;
      }
      socket.write('OK ');
      socket.write('ready\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const allowed = (): OutboundPolicy => ({
  destination: { schemes: ['http:'], check: () => undefined },
  deadlineMs: 150,
});
const url = () => `http://ps5.home:${port}/`;
const network = (): OutboundPolicy => ({
  ...allowed(),
  resolve: async () => [{ address: '192.168.77.70', family: 4 }],
  dialAddress: () => '127.0.0.1',
});

describe('outbound TCP lines', () => {
  it('pins checked DNS addresses and sends one command, collecting a split reply', async () => {
    const checked: string[][] = [];
    const policy = network();
    policy.destination = {
      schemes: ['http:'],
      check: (_host, addresses) => {
        checked.push([...addresses]);
      },
    };
    const before = heard.length;
    expect(await outboundLine(url(), 'STATUS\n', policy)).toBe('OK ready\n');
    expect(checked).toEqual([['192.168.77.70']]);
    expect(heard.slice(before)).toEqual(['STATUS\n']);
  });

  it('rejects a mixed DNS answer before sending', async () => {
    const before = heard.length;
    await expect(
      outboundLine(url(), 'REBOOT\n', {
        ...network(),
        resolve: async () => [
          { address: '192.168.77.70', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ],
        destination: {
          schemes: ['http:'],
          check: (_host, addresses) => {
            if (addresses.includes('169.254.169.254')) throw new OutboundError('destination', 'Refused');
          },
        },
      }),
    ).rejects.toMatchObject({ reason: 'destination', sent: false });
    expect(heard.length).toBe(before);
  });

  it('rejects a forbidden literal or extra command without connecting', async () => {
    const before = heard.length;
    await expect(outboundLine(`http://127.0.0.1:${port}/`, 'REBOOT\n', {})).rejects.toBeInstanceOf(
      OutboundError,
    );
    await expect(outboundLine(url(), 'STATUS\nREBOOT\n', network())).rejects.toBeInstanceOf(OutboundError);
    expect(heard.length).toBe(before);
  });

  it.each(['QUIET', 'CLOSE', 'LONG'])('never retries a command whose %s reply failed', async (command) => {
    const before = heard.length;
    await expect(outboundLine(url(), `${command}\n`, network())).rejects.toMatchObject({ sent: true });
    expect(heard.slice(before)).toEqual([`${command}\n`]);
  });

  it('includes DNS resolution in its deadline', async () => {
    await expect(
      outboundLine(url(), 'STATUS\n', {
        ...network(),
        resolve: () => new Promise(() => undefined),
        deadlineMs: 20,
      }),
    ).rejects.toMatchObject({ reason: 'timeout', sent: false });
  });
});
