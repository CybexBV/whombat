/**
 * The direct listener's settings from the config (direct-connection.md DC-02, DC-03): its port, the interfaces it
 * answers on and the addresses it binds. In production the listener binds every address (`::`, IPv4 too) and
 * `network.ts` keeps it to the configured interfaces per connection — addresses change with DHCP, and `tailscale0`
 * appears only once the person signs Tailscale in, without a restart. With only `loopback` it binds loopback alone.
 */

import { DIRECT_PORT } from '@whombat/protocol/direct';
import type { Config } from '../../config';
import { type DirectInterfaceSpec, parseInterfaceSpecs } from './network';

export interface DirectSettings {
  port: number;
  interfaces: DirectInterfaceSpec[];
  hosts: string[];
  hostnames: string[];
  development: boolean;
}

type DirectConfig = Pick<
  Config,
  'NODE_ENV' | 'PORT' | 'WHOMBAT_DIRECT_PORT' | 'WHOMBAT_DIRECT_INTERFACES' | 'WHOMBAT_DIRECT_HOSTNAMES'
>;

/** Null when the direct listener is off. */
export function directSettings(config: DirectConfig): DirectSettings | null {
  const production = config.NODE_ENV === 'production';
  const setting = config.WHOMBAT_DIRECT_PORT;
  if (setting === 'off') return null;
  const port = setting ?? (production ? DIRECT_PORT : Math.min(65535, config.PORT + 80));
  const interfaces = parseInterfaceSpecs(
    config.WHOMBAT_DIRECT_INTERFACES ?? (production ? 'lan,tailscale0' : 'loopback'),
  );
  if (!interfaces.length) return null;
  const loopbackOnly = interfaces.every((s) => s === 'loopback');
  return {
    port,
    interfaces,
    hosts: loopbackOnly ? ['127.0.0.1', '::1'] : ['::'],
    hostnames: parseInterfaceSpecs(config.WHOMBAT_DIRECT_HOSTNAMES ?? '').map((h) => h.toLowerCase()),
    development: config.NODE_ENV === 'development',
  };
}
