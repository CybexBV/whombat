/**
 * The box's direct ways in, as it tells its clients (hermes-engine.md HE-50; direct-connection.md DC-12; contracts 1.0.0
 * `DirectAddresses`, CT-1252): the direct port, the box's addresses on the local network, its Tailscale name while
 * Tailscale is on, and the routes — for each, the WebSocket a client opens and the page a browser opens there — best
 * first: the local network's IPv4 then IPv6 addresses (`ws://`, `http://`), then the Tailscale name (`wss://`, `https://`
 * with the name's certificate; `ws://`, `http://` while the tailnet has no HTTPS, for the Android app). Clients try them
 * before the relay. Only enrolled sessions are told (`welcome.direct` on the `app` channel): where the box sits on
 * someone's network is for the person's enrolled devices. Loopback is no way in (development): no routes.
 *
 * Only private addresses are named. The image's firewall lets only private peers reach the port, so a phone dialing
 * one of the box's public IPv6 addresses gets no answer at all and waits out its dial limit; and a home network with
 * IPv6 has IPv4 beside it.
 */

import { DIRECT_PATH } from '@whombat/protocol/direct';
import {
  DIRECT_LAN_ADDRESSES_MAX,
  DIRECT_ROUTES_MAX,
  type DirectAddresses,
  type DirectRoute,
  type TailscaleStatus,
} from '@whombat/protocol/session';
import {
  type DirectInterfaceSpec,
  type InterfaceTable,
  interfaceAddresses,
  isPrivateAddress,
} from './network';

export interface DirectAddressInputs {
  port: number;
  interfaces: readonly DirectInterfaceSpec[];
  tailscale: TailscaleStatus;
  interfaceTable?: InterfaceTable;
}

function route(way: DirectRoute['way'], host: string, port: number, tls: boolean): DirectRoute {
  return {
    way,
    socket: `${tls ? 'wss' : 'ws'}://${host}:${port}${DIRECT_PATH}`,
    web: `${tls ? 'https' : 'http'}://${host}:${port}/`,
  };
}

export function directAddresses(inputs: DirectAddressInputs): DirectAddresses {
  const found = interfaceAddresses(inputs.interfaces, inputs.interfaceTable);
  const local = found.filter((a) => a.network === 'lan' && isPrivateAddress(a.address));
  const lan = [...local.filter((a) => a.family === 'IPv4'), ...local.filter((a) => a.family === 'IPv6')]
    .map((a) => a.address)
    .slice(0, DIRECT_LAN_ADDRESSES_MAX);
  const ts = inputs.tailscale;
  const tailscale =
    ts.state === 'on' && ts.name && found.some((a) => a.network === 'tailscale') ? ts.name : null;
  const routes = lan.map((address) =>
    route('lan', address.includes(':') ? `[${address}]` : address, inputs.port, false),
  );
  if (tailscale) routes.push(route('tailscale', tailscale, inputs.port, ts.https));
  return { port: inputs.port, lan, tailscale, routes: routes.slice(0, DIRECT_ROUTES_MAX) };
}
