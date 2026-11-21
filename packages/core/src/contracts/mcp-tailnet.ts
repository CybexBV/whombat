/**
 * The person's tailnet for the agent (Whombat tailnet-reach.md TN-06): the other devices on the Tailscale network this
 * Whombat is signed in to, which the agent reaches as it reaches the local network (TN-01). Spread into `MCP_TOOLS`
 * (`./mcp`); read-only, no key. The list comes from the box's own Tailscale (the manager reads it from tailscaled).
 */
import { z } from 'zod';
import type { McpTool } from './mcp.js';

export const TailnetDevicesInput = z.object({
  online: z.boolean().optional().describe('true: only the devices online now'),
});
export type TailnetDevicesInput = z.input<typeof TailnetDevicesInput>;

/** One other device on the tailnet, as the agent reaches it. */
export const TailnetDevice = z.object({
  /** Its short name (the MagicDNS name's first label), null when Tailscale gave none. */
  name: z.string().nullable(),
  /** Its full MagicDNS name (`nas.tail1234.ts.net`). */
  dnsName: z.string().nullable(),
  /** Its tailnet addresses, IPv4 first. */
  addresses: z.array(z.string()),
  /** Its operating system as Tailscale names it (linux, macOS, iOS, android, windows). */
  os: z.string().nullable(),
  online: z.boolean(),
  /** When it was last seen, while it is offline. */
  lastSeen: z.string().nullable(),
  /** Networks it routes for the tailnet (a subnet router's), reachable through it. */
  routes: z.array(z.string()),
  /** It offers itself as an exit node. */
  exitNode: z.boolean(),
});
export type TailnetDevice = z.infer<typeof TailnetDevice>;

export const TailnetDevicesOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    /** The tailnet's name as Tailscale shows it. */
    tailnet: z.string().nullable(),
    /** This Whombat's own name on the tailnet. */
    self: z.string().nullable(),
    devices: z.array(TailnetDevice),
  }),
  /** This Whombat isn't on a tailnet now (`message` says what the person can do). */
  z.object({ status: z.literal('off'), message: z.string() }),
  /** It couldn't be asked (a development box, or Tailscale didn't answer). */
  z.object({ status: z.literal('unavailable'), message: z.string() }),
]);
export type TailnetDevicesOutput = z.infer<typeof TailnetDevicesOutput>;

export const TAILNET_MCP_TOOLS = {
  tailnet_devices: {
    name: 'tailnet_devices',
    title: 'Devices on the person’s tailnet',
    description:
      'The other devices on the person’s Tailscale network (tailnet) this Whombat is on: each one’s name, addresses, system, whether it is online, and the networks it routes for the tailnet. You reach them as you reach the local network: by short name (nas), full name (nas.<tailnet>.ts.net) or address, on any port, from your commands, server_command and connections; a network a device routes is reachable through it while it is online. status off: this Whombat isn’t on a tailnet (the person turns Tailscale on in Settings → This Whombat).',
    input: TailnetDevicesInput,
    output: TailnetDevicesOutput,
    requiredKey: null,
    readOnly: true,
  } satisfies McpTool<typeof TailnetDevicesInput, typeof TailnetDevicesOutput>,
} as const;
