/**
 * `tailnet_devices` (docs/decisions/tailnet-reach.md TN-06): the other devices on the person's tailnet for the agent,
 * read from the box's own Tailscale through the manager. The agent reaches them as it reaches the local network (TN-01).
 */

import type { TailscalePeer } from '@whombat/control-contracts/local';
import type { TailnetDevice, TailnetDevicesInput, TailnetDevicesOutput } from '@whombat/core';
import type { TailscaleStatus } from '@whombat/protocol/session';
import type { z } from 'zod';
import type { ToolContext } from '../mcp/tools';
import { tailscaleOf } from './direct/tailscale';

type Input = z.output<typeof TailnetDevicesInput>;

/** What the tool answers the agent with when there is no list (to the agent, never the chat). */
export const TAILNET_TOOL_TEXT = {
  off: 'This Whombat isn’t on a tailnet now. The person turns Tailscale on in Settings → This Whombat.',
  signedOut:
    'Tailscale signed this Whombat out of the tailnet. The person signs in again in Settings → This Whombat → Tailscale.',
  unavailable: 'Couldn’t ask this Whombat’s Tailscale just now. Try again in a moment.',
  notHere: 'This Whombat has no Tailscale (a development box).',
} as const;

/** One device as the agent reads it: its short name beside the full one, online devices first. */
export function tailnetDevices(peers: TailscalePeer[], onlineOnly = false): TailnetDevice[] {
  return peers
    .filter((p) => !onlineOnly || p.online)
    .map((p) => ({
      name: p.name ? (p.name.split('.')[0] ?? null) : null,
      dnsName: p.name,
      addresses: p.addresses,
      os: p.os,
      online: p.online,
      lastSeen: p.online ? null : p.lastSeen,
      routes: p.routes,
      exitNode: p.exitNode,
    }))
    .sort((a, b) => Number(b.online) - Number(a.online) || (a.name ?? '').localeCompare(b.name ?? ''));
}

/** The answer for a state that isn't on. */
export function notOnAnswer(status: TailscaleStatus): TailnetDevicesOutput {
  if (status.state === 'needs_sign_in' || status.state === 'needs_approval')
    return { status: 'off', message: TAILNET_TOOL_TEXT.signedOut };
  if (status.state === 'error') return { status: 'unavailable', message: TAILNET_TOOL_TEXT.unavailable };
  return { status: 'off', message: TAILNET_TOOL_TEXT.off };
}

export async function tailnetDevicesTool(ctx: ToolContext, input: Input): Promise<TailnetDevicesOutput> {
  const tailscale = tailscaleOf(ctx.services);
  if (!tailscale?.managed) return { status: 'unavailable', message: TAILNET_TOOL_TEXT.notHere };
  try {
    const read = await tailscale.peers();
    if (!read) return { status: 'unavailable', message: TAILNET_TOOL_TEXT.unavailable };
    if (read.status.state !== 'on') return notOnAnswer(read.status);
    return {
      status: 'ok',
      tailnet: read.status.tailnet,
      self: read.status.name,
      devices: tailnetDevices(read.peers, input.online === true),
    };
  } catch (err) {
    ctx.services.log.warn({ err: String(err) }, 'tailnet_devices: the manager did not answer');
    return { status: 'unavailable', message: TAILNET_TOOL_TEXT.unavailable };
  }
}
