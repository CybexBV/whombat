/**
 * Modbus devices in Found on your network (docs/decisions/one-whombat-devices.md ONE-DD14; connections-setup.md CS-14):
 * an open port 502 is asked one read — a holding register (FC3), then who it is (FC43/14) — and anything that answers
 * like Modbus TCP, a value or a refusal alike, is a device Whombat can learn (`device`, `modbus://<host>:502`). Reads
 * only, a second and a half each, never a write.
 */
import { ModbusError, ModbusTcpClient } from './modbus';

export const MODBUS_DISCOVERY_PORT = 502;
const PROBE_MS = 1500;

export interface ModbusFound {
  /** “Daikin EKRHH”, when it says. */
  version: string | null;
}

/** Whether a Modbus TCP device answers at the address (already dialable), and who it says it is. */
export async function probeModbusAt(host: string, port: number): Promise<ModbusFound | null> {
  let client: ModbusTcpClient | null = null;
  try {
    client = await ModbusTcpClient.connect({
      host,
      port,
      unitId: 1,
      timeoutMs: PROBE_MS,
      connectTimeoutMs: PROBE_MS,
    });
    try {
      await client.readHoldingRegisters(0, 1);
    } catch (err) {
      // A refusal is still Modbus speaking (no register 0, a gateway with nothing behind it).
      if (!(err instanceof ModbusError) || err.reason !== 'exception') return null;
    }
    const identity = await client.readDeviceIdentification().catch(() => null);
    const version = identity
      ? [identity.vendor, identity.product].filter(Boolean).join(' ').slice(0, 60)
      : '';
    return { version: version || null };
  } catch {
    return null;
  } finally {
    client?.close();
  }
}

/** A found device's address as Found on your network lists it. */
export function modbusUrl(host: string, port: number): string {
  return `modbus://${host}:${port}`;
}
