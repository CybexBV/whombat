/**
 * A small Modbus TCP client (docs/decisions/one-whombat-devices.md, ONE-16): no dependency, one request in flight at a
 * time per connection, each with its own timeout. Reads FC1 (coils), FC2 (discrete inputs), FC3 (holding registers),
 * FC4 (input registers); writes FC5 (one coil), FC6 (one register), FC15 (coils), FC16 (registers).
 *
 * The client dials the address it is given and nothing else: where a device may be reached is decided before
 * (`destination.ts`), and the caller passes the checked address. Framing is MBAP (transaction id, protocol 0, length,
 * unit id) over one TCP connection; an answer with another transaction id is dropped, an exception answer becomes a
 * `ModbusError` with its code, and a connection that closes or sends garbage fails every waiting request.
 */
import { connect, type Socket } from 'node:net';

export type ModbusTable = 'holding' | 'input' | 'coil' | 'discrete';

export type ModbusFailure = 'timeout' | 'unreachable' | 'closed' | 'exception' | 'protocol' | 'invalid';

/** Modbus exception codes in plain words (the spec's names, lower case). */
export const MODBUS_EXCEPTIONS: Readonly<Record<number, string>> = {
  1: 'it doesn’t support that kind of request',
  2: 'that address doesn’t exist on it',
  3: 'it refused that value',
  4: 'the device reported a failure',
  5: 'it is still working on it',
  6: 'it is busy',
  8: 'its memory failed a parity check',
  10: 'the gateway has no path to the device',
  11: 'the device behind the gateway didn’t answer',
};

export class ModbusError extends Error {
  constructor(
    readonly reason: ModbusFailure,
    message: string,
    /** The exception code for `exception`. */
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'ModbusError';
  }
}

/** The protocol's own bounds per request. */
export const MODBUS_LIMITS = {
  readBits: 2000,
  readRegisters: 125,
  writeBits: 1968,
  writeRegisters: 123,
  address: 0xffff,
} as const;

export interface ModbusClientOptions {
  /** The address to dial (already checked). */
  host: string;
  port: number;
  /** The unit (slave) id, 0–255; 1 by default, 255 for many TCP-native devices. */
  unitId?: number;
  /** Per request, default 3 s. */
  timeoutMs?: number;
  /** Default 3 s. */
  connectTimeoutMs?: number;
}

interface Pending {
  tid: number;
  fc: number;
  resolve(pdu: Buffer): void;
  reject(err: ModbusError): void;
  timer: NodeJS.Timeout;
}

const READ_FC: Record<ModbusTable, number> = { coil: 1, discrete: 2, holding: 3, input: 4 };

function checkRange(address: number, quantity: number, max: number): void {
  if (!Number.isInteger(address) || address < 0 || address > MODBUS_LIMITS.address)
    throw new ModbusError('invalid', `Address ${address} isn’t a Modbus address (0–65535).`);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > max)
    throw new ModbusError('invalid', `A request reads or writes 1–${max} values at once.`);
  if (address + quantity - 1 > MODBUS_LIMITS.address)
    throw new ModbusError('invalid', 'The values run past the last Modbus address.');
}

function checkWord(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff)
    throw new ModbusError('invalid', `${value} doesn’t fit in a register (0–65535).`);
}

/** Bits packed LSB first, as Modbus sends them. */
function unpackBits(bytes: Buffer, count: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < count; i++) out.push(((bytes[i >> 3] ?? 0) >> (i & 7)) % 2 === 1);
  return out;
}

function packBits(values: readonly boolean[]): Buffer {
  const out = Buffer.alloc(Math.ceil(values.length / 8));
  values.forEach((v, i) => {
    if (v) out[i >> 3] = (out[i >> 3] ?? 0) | (1 << (i & 7));
  });
  return out;
}

export class ModbusTcpClient {
  private readonly socket: Socket;
  private readonly unitId: number;
  private readonly timeoutMs: number;
  private buffer = Buffer.alloc(0);
  private nextTid = 1;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private failure: ModbusError | null = null;

  private constructor(socket: Socket, unitId: number, timeoutMs: number) {
    this.socket = socket;
    this.unitId = unitId;
    this.timeoutMs = timeoutMs;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.fail(new ModbusError('closed', 'The connection to the device broke.')));
    socket.on('close', () => this.fail(new ModbusError('closed', 'The device closed the connection.')));
  }

  /** Opens the TCP connection. */
  static connect(options: ModbusClientOptions): Promise<ModbusTcpClient> {
    const unitId = options.unitId ?? 1;
    if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255)
      return Promise.reject(new ModbusError('invalid', 'A unit id is 0–255.'));
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
      return Promise.reject(new ModbusError('invalid', 'A port is 1–65535.'));
    const connectTimeoutMs = options.connectTimeoutMs ?? 3000;
    return new Promise((resolve, reject) => {
      const socket = connect({ host: options.host, port: options.port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ModbusError('timeout', 'The device didn’t accept a connection in time.'));
      }, connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new ModbusTcpClient(socket, unitId, options.timeoutMs ?? 3000));
      });
      socket.once('error', () => {
        clearTimeout(timer);
        socket.destroy();
        reject(new ModbusError('unreachable', 'Couldn’t connect to the device.'));
      });
    });
  }

  close(): void {
    this.fail(new ModbusError('closed', 'The connection was closed.'));
    this.socket.destroy();
  }

  /** Reads `quantity` values from a table: registers as 16-bit words, coils and discrete inputs as booleans. */
  async read(table: 'holding' | 'input', address: number, quantity: number): Promise<number[]>;
  async read(table: 'coil' | 'discrete', address: number, quantity: number): Promise<boolean[]>;
  async read(table: ModbusTable, address: number, quantity: number): Promise<number[] | boolean[]>;
  async read(table: ModbusTable, address: number, quantity: number): Promise<number[] | boolean[]> {
    const bits = table === 'coil' || table === 'discrete';
    checkRange(address, quantity, bits ? MODBUS_LIMITS.readBits : MODBUS_LIMITS.readRegisters);
    const fc = READ_FC[table];
    const req = Buffer.alloc(5);
    req[0] = fc;
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(quantity, 3);
    const pdu = await this.request(req);
    const byteCount = pdu[1] ?? 0;
    const data = pdu.subarray(2);
    const expected = bits ? Math.ceil(quantity / 8) : quantity * 2;
    if (byteCount !== expected || data.length !== expected)
      throw new ModbusError('protocol', 'The device answered with the wrong number of values.');
    if (bits) return unpackBits(data, quantity);
    const out: number[] = [];
    for (let i = 0; i < quantity; i++) out.push(data.readUInt16BE(i * 2));
    return out;
  }

  readCoils(address: number, quantity: number): Promise<boolean[]> {
    return this.read('coil', address, quantity);
  }

  readDiscreteInputs(address: number, quantity: number): Promise<boolean[]> {
    return this.read('discrete', address, quantity);
  }

  readHoldingRegisters(address: number, quantity: number): Promise<number[]> {
    return this.read('holding', address, quantity);
  }

  readInputRegisters(address: number, quantity: number): Promise<number[]> {
    return this.read('input', address, quantity);
  }

  /** FC5. */
  async writeSingleCoil(address: number, value: boolean): Promise<void> {
    checkRange(address, 1, 1);
    const req = Buffer.alloc(5);
    req[0] = 5;
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(value ? 0xff00 : 0x0000, 3);
    const pdu = await this.request(req);
    if (!pdu.subarray(0, 5).equals(req))
      throw new ModbusError('protocol', 'The device didn’t confirm the write.');
  }

  /** FC6. */
  async writeSingleRegister(address: number, value: number): Promise<void> {
    checkRange(address, 1, 1);
    checkWord(value);
    const req = Buffer.alloc(5);
    req[0] = 6;
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(value, 3);
    const pdu = await this.request(req);
    if (!pdu.subarray(0, 5).equals(req))
      throw new ModbusError('protocol', 'The device didn’t confirm the write.');
  }

  /** FC15. */
  async writeMultipleCoils(address: number, values: readonly boolean[]): Promise<void> {
    checkRange(address, values.length, MODBUS_LIMITS.writeBits);
    const bytes = packBits(values);
    const req = Buffer.alloc(6 + bytes.length);
    req[0] = 15;
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(values.length, 3);
    req[5] = bytes.length;
    bytes.copy(req, 6);
    const pdu = await this.request(req);
    if (!pdu.subarray(0, 5).equals(req.subarray(0, 5)))
      throw new ModbusError('protocol', 'The device didn’t confirm the write.');
  }

  /** FC16. */
  async writeMultipleRegisters(address: number, values: readonly number[]): Promise<void> {
    checkRange(address, values.length, MODBUS_LIMITS.writeRegisters);
    for (const v of values) checkWord(v);
    const req = Buffer.alloc(6 + values.length * 2);
    req[0] = 16;
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(values.length, 3);
    req[5] = values.length * 2;
    values.forEach((v, i) => {
      req.writeUInt16BE(v, 6 + i * 2);
    });
    const pdu = await this.request(req);
    if (!pdu.subarray(0, 5).equals(req.subarray(0, 5)))
      throw new ModbusError('protocol', 'The device didn’t confirm the write.');
  }

  /**
   * FC43/14, Read Device Identification (basic): the vendor, product code and revision a device says it is, or null when
   * it doesn't support it. Read-only.
   */
  async readDeviceIdentification(): Promise<{ vendor?: string; product?: string; revision?: string } | null> {
    let pdu: Buffer;
    try {
      pdu = await this.request(Buffer.from([0x2b, 0x0e, 0x01, 0x00]));
    } catch (err) {
      if (err instanceof ModbusError && err.reason === 'exception') return null;
      throw err;
    }
    if (pdu[1] !== 0x0e || pdu.length < 7) return null;
    const count = pdu[6] ?? 0;
    const out: { vendor?: string; product?: string; revision?: string } = {};
    let at = 7;
    for (let i = 0; i < count && at + 2 <= pdu.length; i++) {
      const id = pdu[at] ?? 0;
      const len = pdu[at + 1] ?? 0;
      const text = pdu
        .subarray(at + 2, at + 2 + len)
        .toString('latin1')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: a device's words, cleaned of control characters.
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 40);
      if (id === 0 && text) out.vendor = text;
      if (id === 1 && text) out.product = text;
      if (id === 2 && text) out.revision = text;
      at += 2 + len;
    }
    return out.vendor || out.product ? out : null;
  }

  /** Sends one PDU and waits for its answer (requests queue: one in flight). */
  private request(pdu: Buffer): Promise<Buffer> {
    const run = this.queue.then(() => this.send(pdu));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private send(pdu: Buffer): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    const tid = this.nextTid;
    this.nextTid = (this.nextTid % 0xffff) + 1;
    const frame = Buffer.alloc(7 + pdu.length);
    frame.writeUInt16BE(tid, 0);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt16BE(pdu.length + 1, 4);
    frame[6] = this.unitId;
    pdu.copy(frame, 7);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.tid !== tid) return;
        this.pending = null;
        reject(new ModbusError('timeout', 'The device didn’t answer in time.'));
      }, this.timeoutMs);
      this.pending = { tid, fc: pdu[0] ?? 0, resolve, reject, timer };
      this.socket.write(frame);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 7) {
      const protocol = this.buffer.readUInt16BE(2);
      const length = this.buffer.readUInt16BE(4);
      if (protocol !== 0 || length < 2 || length > 254) {
        this.fail(new ModbusError('protocol', 'The device doesn’t speak Modbus TCP.'));
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < 6 + length) return;
      const tid = this.buffer.readUInt16BE(0);
      const pdu = Buffer.from(this.buffer.subarray(7, 6 + length));
      this.buffer = this.buffer.subarray(6 + length);
      this.deliver(tid, pdu);
    }
  }

  private deliver(tid: number, pdu: Buffer): void {
    const p = this.pending;
    // A late answer to a request that timed out, or one nobody asked for: dropped.
    if (!p || p.tid !== tid) return;
    this.pending = null;
    clearTimeout(p.timer);
    const fc = pdu[0] ?? 0;
    if (fc === (p.fc | 0x80)) {
      const code = pdu[1] ?? 0;
      p.reject(
        new ModbusError(
          'exception',
          `The device refused: ${MODBUS_EXCEPTIONS[code] ?? `exception ${code}`}.`,
          code,
        ),
      );
      return;
    }
    if (fc !== p.fc) {
      p.reject(new ModbusError('protocol', 'The device answered a different request.'));
      return;
    }
    p.resolve(pdu);
  }

  private fail(err: ModbusError): void {
    if (!this.failure) this.failure = err;
    const p = this.pending;
    if (p) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}
