import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModbusError, ModbusTcpClient } from './modbus';
import { type FakeModbus, startFakeModbus } from './testing/fake-modbus';
import { decodeRegisters } from './values';

describe('ModbusTcpClient', () => {
  let fake: FakeModbus;
  let client: ModbusTcpClient | null = null;

  beforeEach(async () => {
    fake = await startFakeModbus();
  });
  afterEach(async () => {
    client?.close();
    client = null;
    await fake.close();
  });

  const open = async (unitId = 1, timeoutMs = 500) => {
    client = await ModbusTcpClient.connect({ host: '127.0.0.1', port: fake.port, unitId, timeoutMs });
    return client;
  };

  it('reads input and holding registers (FC4, FC3)', async () => {
    const c = await open();
    const input = await c.readInputRegisters(0, 10);
    expect(decodeRegisters(input.slice(0, 1), 's16', { scale: 0.1 })).toBe(21);
    expect(input[1]).toBe(34);
    expect(decodeRegisters(input.slice(4, 6), 'f32')).toBeCloseTo(1.2, 5);
    expect(decodeRegisters(input.slice(7, 9), 'u32')).toBe(12_345);
    expect(await c.readHoldingRegisters(100, 2)).toEqual([200, 7]);
    expect(fake.requests.map((r) => r.fc)).toEqual([4, 3]);
  });

  it('reads coils and discrete inputs (FC1, FC2), bits packed LSB first', async () => {
    fake.tables.coil[0] = true;
    fake.tables.coil[9] = true;
    fake.tables.discrete[2] = true;
    const c = await open();
    const coils = await c.readCoils(0, 10);
    expect(coils.filter(Boolean)).toHaveLength(2);
    expect(coils[0]).toBe(true);
    expect(coils[9]).toBe(true);
    expect(await c.readDiscreteInputs(0, 3)).toEqual([false, false, true]);
  });

  it('writes one coil and one register (FC5, FC6)', async () => {
    const c = await open();
    await c.writeSingleCoil(0, true);
    await c.writeSingleRegister(100, 215);
    expect(fake.tables.coil[0]).toBe(true);
    expect(fake.tables.holding[100]).toBe(215);
    await c.writeSingleCoil(0, false);
    expect(fake.tables.coil[0]).toBe(false);
  });

  it('writes several coils and registers (FC15, FC16)', async () => {
    const c = await open();
    await c.writeMultipleCoils(10, [true, false, true, true, false, false, false, false, true]);
    await c.writeMultipleRegisters(200, [1, 2, 0xffff]);
    expect(fake.tables.coil.slice(10, 19)).toEqual([
      true,
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(fake.tables.holding.slice(200, 203)).toEqual([1, 2, 0xffff]);
    expect(fake.requests.map((r) => r.fc)).toEqual([15, 16]);
  });

  it('turns an exception answer into a plain ModbusError with its code', async () => {
    const c = await open();
    await expect(c.readHoldingRegisters(1020, 10)).rejects.toMatchObject({
      reason: 'exception',
      code: 2,
      message: 'The device refused: that address doesn’t exist on it.',
    });
    // The connection keeps working after an exception.
    expect(await c.readHoldingRegisters(101, 1)).toEqual([7]);
  });

  it('times out when the device stays silent, and the next request still works', async () => {
    const c = await open(1, 150);
    fake.knobs.silent = true;
    await expect(c.readInputRegisters(0, 1)).rejects.toMatchObject({ reason: 'timeout' });
    fake.knobs.silent = false;
    expect(await c.readInputRegisters(1, 1)).toEqual([34]);
  });

  it('drops a late answer to a request that timed out', async () => {
    const c = await open(1, 100);
    fake.knobs.delayMs = 200;
    await expect(c.readInputRegisters(0, 1)).rejects.toMatchObject({ reason: 'timeout' });
    fake.knobs.delayMs = 0;
    await new Promise((r) => setTimeout(r, 150));
    // The late answer (tid 1) arrived meanwhile and was dropped; this one gets its own.
    expect(await c.readInputRegisters(2, 1)).toEqual([48]);
  });

  it('queues requests: one in flight at a time', async () => {
    const c = await open();
    const [a, b, d] = await Promise.all([
      c.readInputRegisters(0, 1),
      c.readInputRegisters(1, 1),
      c.readHoldingRegisters(101, 1),
    ]);
    expect([a, b, d]).toEqual([[210], [34], [7]]);
  });

  it('uses the unit id it was given', async () => {
    const c = await open(255);
    await c.readInputRegisters(0, 1);
    expect(fake.requests[0]?.unitId).toBe(255);
  });

  it('refuses what Modbus can’t carry before sending', async () => {
    const c = await open();
    await expect(c.readHoldingRegisters(0, 126)).rejects.toBeInstanceOf(ModbusError);
    await expect(c.readHoldingRegisters(65535, 2)).rejects.toMatchObject({ reason: 'invalid' });
    await expect(c.writeSingleRegister(0, 70000)).rejects.toMatchObject({ reason: 'invalid' });
    expect(fake.requests).toHaveLength(0);
  });

  it('fails plainly when nothing listens', async () => {
    const port = fake.port;
    await fake.close();
    await expect(ModbusTcpClient.connect({ host: '127.0.0.1', port })).rejects.toMatchObject({
      reason: 'unreachable',
    });
    fake = await startFakeModbus();
  });

  it('fails waiting requests when the device closes the connection', async () => {
    const c = await open(1, 2000);
    fake.knobs.silent = true;
    const pending = c.readInputRegisters(0, 1);
    await fake.close();
    await expect(pending).rejects.toMatchObject({ reason: 'closed' });
    fake = await startFakeModbus();
  });
});
