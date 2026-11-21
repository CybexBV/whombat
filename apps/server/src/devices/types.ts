/**
 * Device profiles (docs/decisions/one-whombat.md ONE-16…ONE-19): contracts 0.80 (`domain/devices.ts`, CT-340), and
 * where a device is.
 */
export {
  type DeviceAction,
  type DeviceChoice,
  type DeviceDriver,
  type DeviceProfile,
  type DeviceReading,
  MODBUS_DEFAULT_PORT,
  MODBUS_DEFAULT_UNIT_ID,
  type ModbusAddress,
} from '@whombat/core';

/** Where a device is: its host (an address on the local network or a name), port and Modbus unit id. */
export interface DeviceAddress {
  host: string;
  port: number;
  unitId?: number;
  basePath?: string;
}
