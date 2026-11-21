/**
 * Restart one service of the running environment (scenarios: relay restart, runtime restart). The same start
 * functions as `dev/up`, so a restarted service has exactly its configuration.
 *
 *   node restart.ts <relay|runtime|runner|agent-net|manager|control|tuf-refresh|hosts>
 */
import { alive, stopGroup } from '../lib/proc.ts';
import { loadEnv, type ServiceName, saveEnv } from './env.ts';
import {
  startAgentNet,
  startBackup,
  startControl,
  startHosts,
  startManager,
  startRealManager,
  startRelay,
  startRunner,
  startRuntime,
  startTufRefresh,
} from './services.ts';

export async function stopService(name: ServiceName): Promise<void> {
  const state = loadEnv();
  const s = state?.services[name];
  if (!state || !s?.pid) return;
  if (alive(s.pid)) await stopGroup(s.pid, 10_000);
  s.status = 'stopped';
  s.pid = null;
  saveEnv(state);
}

export async function startService(name: ServiceName, log: (l: string) => void = () => {}): Promise<void> {
  const state = loadEnv();
  if (!state) throw new Error('no environment');
  const src = (id: string) => {
    const s = state.sources[id];
    if (!s) throw new Error(`no source ${id} in env.json`);
    return s;
  };
  switch (name) {
    case 'relay':
      await startRelay(state, src('whombat-relay'), log);
      break;
    case 'control':
      await startControl(state, src('whombat-api'), log);
      break;
    case 'runtime':
      await startRuntime(state, src('whombat-runtime'), log);
      break;
    case 'runner':
      await startRunner(state, src('whombat-runtime'), log);
      break;
    case 'agent-net':
      await startAgentNet(state, src('whombat-runtime'), log);
      break;
    case 'backup':
      await startBackup(state, src('appliance-backup'), log);
      break;
    case 'hosts':
      await startHosts(state, src('whombat-hosts'), log);
      break;
    case 'manager':
      if (state.manager?.kind === 'real')
        await startRealManager(state, src('appliance-manager'), src('whombat-runtime'), log);
      else await startManager(state, log);
      break;
    case 'tuf-refresh':
      startTufRefresh(state, log);
      break;
    default:
      throw new Error(`cannot restart ${name}`);
  }
  saveEnv(state);
}

export async function restartService(name: ServiceName, log: (l: string) => void = () => {}): Promise<void> {
  await stopService(name);
  await startService(name, log);
}

if (import.meta.main) {
  const name = process.argv[2] as ServiceName;
  await restartService(name, (l) => process.stderr.write(`${l}\n`));
}
