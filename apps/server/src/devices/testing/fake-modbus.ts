/**
 * Tests only: an in-process Modbus TCP server on 127.0.0.1 that plays a heat pump (docs/decisions/one-whombat-devices.md).
 * Its tables are plain arrays the test can read and change; every request is kept; knobs make it answer exceptions,
 * stay silent or answer late.
 *
 * The heat pump's map (unit id 1, also answers 255):
 *
 * | table    | address | what                                   | type        |
 * |----------|---------|----------------------------------------|-------------|
 * | input    | 0       | room temperature × 10                  | s16         |
 * | input    | 1       | water to the radiators                 | u16         |
 * | input    | 2       | hot water                              | u16         |
 * | input    | 3       | outside × 10                           | s16         |
 * | input    | 4–5     | power in kW                            | f32 (big)   |
 * | input    | 6       | mode (0 off, 1 heating, 2 cooling)     | u16         |
 * | input    | 7–8     | compressor hours                       | u32 (big)   |
 * | input    | 9       | error code                             | u16         |
 * | holding  | 100     | room temperature setpoint × 10         | s16         |
 * | holding  | 101     | heating curve (1–20)                   | u16         |
 * | coil     | 0       | hot water boost                        | bool        |
 * | discrete | 0       | defrosting                             | bool        |
 */
import net, { type AddressInfo, type Server, type Socket } from 'node:net';

export interface SeenModbusRequest {
  unitId: number;
  fc: number;
  address: number;
  quantity: number;
  /** Written words or bits (writes only). */
  values?: number[] | boolean[];
}

export interface FakeModbus {
  port: number;
  tables: { holding: number[]; input: number[]; coil: boolean[]; discrete: boolean[] };
  requests: SeenModbusRequest[];
  knobs: {
    /** Answer every request with this exception code. */
    exception: number | null;
    /** Don't answer at all. */
    silent: boolean;
    /** Answer after this many milliseconds. */
    delayMs: number;
    /** Unit ids it answers. */
    unitIds: number[];
    /** What FC43/14 answers; null: not supported (exception 1). */
    identity: { vendor: string; product: string } | null;
  };
  /** How many connections were opened. */
  connections(): number;
  close(): Promise<void>;
}

const SIZE = 1024;

/** The heat pump's starting values. */
export function heatPumpTables(): FakeModbus['tables'] {
  const holding = new Array<number>(SIZE).fill(0);
  const input = new Array<number>(SIZE).fill(0);
  const coil = new Array<boolean>(SIZE).fill(false);
  const discrete = new Array<boolean>(SIZE).fill(false);
  input[0] = 210; // 21.0 °C
  input[1] = 34;
  input[2] = 48;
  input[3] = 90; // 9.0 °C
  const f = Buffer.alloc(4);
  f.writeFloatBE(1.2, 0);
  input[4] = f.readUInt16BE(0);
  input[5] = f.readUInt16BE(2);
  input[6] = 1;
  input[7] = 0;
  input[8] = 12_345;
  input[9] = 0;
  holding[100] = 200; // 20.0 °C
  holding[101] = 7;
  return { holding, input, coil, discrete };
}

export async function startFakeModbus(tables: FakeModbus['tables'] = heatPumpTables()): Promise<FakeModbus> {
  const requests: SeenModbusRequest[] = [];
  const knobs: FakeModbus['knobs'] = {
    exception: null,
    silent: false,
    delayMs: 0,
    unitIds: [1, 255],
    identity: { vendor: 'Daikin', product: 'EKRHH' },
  };
  let opened = 0;
  const sockets = new Set<Socket>();

  const answer = (socket: Socket, tid: number, unitId: number, pdu: Buffer) => {
    const frame = Buffer.alloc(7 + pdu.length);
    frame.writeUInt16BE(tid, 0);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt16BE(pdu.length + 1, 4);
    frame[6] = unitId;
    pdu.copy(frame, 7);
    const send = () => {
      if (!socket.destroyed) socket.write(frame);
    };
    if (knobs.delayMs > 0) setTimeout(send, knobs.delayMs);
    else send();
  };

  const handle = (socket: Socket, tid: number, unitId: number, pdu: Buffer) => {
    const fc = pdu[0] ?? 0;
    const address = pdu.length >= 3 ? pdu.readUInt16BE(1) : 0;
    const quantity = pdu.length >= 5 ? pdu.readUInt16BE(3) : 0;
    const exception = (code: number) => answer(socket, tid, unitId, Buffer.from([fc | 0x80, code]));
    const seen: SeenModbusRequest = { unitId, fc, address, quantity };
    requests.push(seen);
    if (knobs.silent || !knobs.unitIds.includes(unitId)) return;
    if (knobs.exception !== null) return exception(knobs.exception);
    switch (fc) {
      case 1:
      case 2: {
        const table = fc === 1 ? tables.coil : tables.discrete;
        if (quantity < 1 || quantity > 2000) return exception(3);
        if (address + quantity > SIZE) return exception(2);
        const bytes = Buffer.alloc(Math.ceil(quantity / 8));
        for (let i = 0; i < quantity; i++)
          if (table[address + i]) bytes[i >> 3] = (bytes[i >> 3] ?? 0) | (1 << (i & 7));
        return answer(socket, tid, unitId, Buffer.concat([Buffer.from([fc, bytes.length]), bytes]));
      }
      case 3:
      case 4: {
        const table = fc === 3 ? tables.holding : tables.input;
        if (quantity < 1 || quantity > 125) return exception(3);
        if (address + quantity > SIZE) return exception(2);
        const data = Buffer.alloc(quantity * 2);
        for (let i = 0; i < quantity; i++) data.writeUInt16BE((table[address + i] ?? 0) & 0xffff, i * 2);
        return answer(socket, tid, unitId, Buffer.concat([Buffer.from([fc, data.length]), data]));
      }
      case 5: {
        const raw = quantity;
        if (raw !== 0xff00 && raw !== 0) return exception(3);
        if (address >= SIZE) return exception(2);
        tables.coil[address] = raw === 0xff00;
        seen.quantity = 1;
        seen.values = [raw === 0xff00];
        return answer(socket, tid, unitId, pdu.subarray(0, 5));
      }
      case 6: {
        if (address >= SIZE) return exception(2);
        tables.holding[address] = quantity;
        seen.quantity = 1;
        seen.values = [quantity];
        return answer(socket, tid, unitId, pdu.subarray(0, 5));
      }
      case 15: {
        if (address + quantity > SIZE) return exception(2);
        const bits: boolean[] = [];
        for (let i = 0; i < quantity; i++) bits.push(((pdu[6 + (i >> 3)] ?? 0) >> (i & 7)) % 2 === 1);
        bits.forEach((b, i) => {
          tables.coil[address + i] = b;
        });
        seen.values = bits;
        return answer(socket, tid, unitId, pdu.subarray(0, 5));
      }
      case 16: {
        if (address + quantity > SIZE) return exception(2);
        const words: number[] = [];
        for (let i = 0; i < quantity; i++) words.push(pdu.readUInt16BE(6 + i * 2));
        words.forEach((w, i) => {
          tables.holding[address + i] = w;
        });
        seen.values = words;
        return answer(socket, tid, unitId, pdu.subarray(0, 5));
      }
      case 0x2b: {
        // Read Device Identification (basic): vendor and product code.
        if (pdu[1] !== 0x0e || !knobs.identity) return exception(1);
        const objects = [
          [0, knobs.identity.vendor],
          [1, knobs.identity.product],
        ] as const;
        const body = Buffer.concat(
          objects.map(([id, text]) =>
            Buffer.concat([Buffer.from([id, text.length]), Buffer.from(text, 'latin1')]),
          ),
        );
        return answer(
          socket,
          tid,
          unitId,
          Buffer.concat([Buffer.from([0x2b, 0x0e, 0x01, 0x01, 0x00, 0x00, objects.length]), body]),
        );
      }
      default:
        return exception(1);
    }
  };

  const server: Server = net.createServer((socket) => {
    opened++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 7) {
        const length = buffer.readUInt16BE(4);
        if (buffer.length < 6 + length) return;
        const tid = buffer.readUInt16BE(0);
        const unitId = buffer[6] ?? 0;
        const pdu = Buffer.from(buffer.subarray(7, 6 + length));
        buffer = buffer.subarray(6 + length);
        handle(socket, tid, unitId, pdu);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    tables,
    requests,
    knobs,
    connections: () => opened,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
