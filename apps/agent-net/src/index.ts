/**
 * `whombat-agent-net` (docs/decisions/one-person.md OP-07, OP-S106; interface I-4): the small daemon behind the agent's
 * commands' network. Under its own uid on the appliance (`whombat-agent-net`, whose nftables rules hold its traffic,
 * OP-S114), it serves the commands' proxy on `proxy.sock` (0660: the runner's group reaches it, and every pod's holder
 * bridges `127.0.0.1:3128` to it) and the runner on `control.sock` (the policy). It reads this host's own addresses
 * again every minute: they are never reachable through it. Until the runner set a policy, nothing goes through. Each
 * opening closes by itself when its time is up (`HeldPolicy`), and the proxy cuts the tunnels it carried.
 */
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { agentNetSocket, controlSocketOf, denyList } from './config';
import { startControl } from './control';
import { HeldPolicy } from './held';
import { startProxy } from './proxy';
import { EMPTY_POLICY, type HostFacts } from './rules';

const log = (level: 'info' | 'warn' | 'debug', msg: string) => {
  if (level === 'debug' && !process.env.WHOMBAT_AGENT_NET_DEBUG) return;
  (level === 'warn' ? process.stderr : process.stdout).write(
    `${new Date().toISOString()} ${level} agent-net · ${msg}\n`,
  );
};

function hostAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

const proxyPath = agentNetSocket();
mkdirSync(dirname(proxyPath), { recursive: true, mode: 0o750 });
const deny = denyList();
let facts: HostFacts = { hostAddresses: hostAddresses(), deny };
// Closed until the runner set the policy (production servers are only closed once it said which they are).
const held = new HeldPolicy();
const proxy = await startProxy({
  path: proxyPath,
  mode: 0o660,
  policy: () => held.get(),
  facts: () => facts,
  onRefused: (host, port, reason) => log('debug', `${host}:${port} refused (${reason})`),
});
const control = await startControl({
  path: controlSocketOf(proxyPath),
  mode: 0o660,
  apply: (next) => {
    held.set(next);
    proxy.recheck();
    log(
      'info',
      `policy · ${next.homeNetworks.length} home network(s), local network ${next.lan ? 'on' : 'off'}, ${next.production.length} production address(es), ${next.open.length} opening(s)`,
    );
  },
  current: () => held.get() ?? EMPTY_POLICY,
});
log('info', `serving the commands' proxy on ${proxyPath}${deny.length ? ` · deny ${deny.join(', ')}` : ''}`);
const refresh = setInterval(() => {
  facts = { hostAddresses: hostAddresses(), deny };
}, 60_000);
refresh.unref();

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(refresh);
    void Promise.all([proxy.close(), control.close()]).then(() => process.exit(0));
  });
