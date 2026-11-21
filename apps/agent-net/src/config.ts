/**
 * The daemon's settings (docs/decisions/one-person.md OP-S106): `WHOMBAT_AGENT_NET_SOCKET`, the proxy's socket
 * (`/run/whombat-agent-net/proxy.sock` on the appliance; default `$WHOMBAT_HOME/agent-net/proxy.sock`, or a short
 * folder in `/tmp` when that path is too long for a unix socket), with `control.sock` beside it; and
 * `WHOMBAT_AGENT_NET_DENY`, more IPv4 CIDRs no command may reach (comma- or space-separated).
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** A unix socket's path has at most 107 bytes. */
const SOCKET_PATH_MAX = 107;

/** The proxy's socket as the daemon and the runner find it. */
export function agentNetSocket(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const explicit = env.WHOMBAT_AGENT_NET_SOCKET?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('WHOMBAT_AGENT_NET_SOCKET must be an absolute path');
    return explicit;
  }
  const whombatHome = env.WHOMBAT_HOME?.trim() || join(home, '.whombat');
  const want = join(whombatHome, 'agent-net', 'proxy.sock');
  if (Buffer.byteLength(join(dirname(want), 'control.sock')) <= SOCKET_PATH_MAX) return want;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `/tmp/whombat-agent-net-${uid}/proxy.sock`;
}

/** The runner's control socket, beside the proxy's. */
export function controlSocketOf(proxySocket: string): string {
  return join(dirname(proxySocket), 'control.sock');
}

/** `WHOMBAT_AGENT_NET_DENY` as a list of CIDRs. */
export function denyList(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.WHOMBAT_AGENT_NET_DENY ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
