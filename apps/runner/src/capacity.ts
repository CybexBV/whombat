import { readFile } from 'node:fs/promises';
import { availableParallelism, freemem } from 'node:os';
import { dirname, join } from 'node:path';

export interface Capacity {
  availableBytes: number;
  cpuCount: number;
  memoryPressure: number;
  cpuPressure: number;
}

const GiB = 1024 ** 3;
const read = (path: string) => readFile(path, 'utf8').catch(() => '');
const pressure = (text: string) => Number(/^some .*avg10=([\d.]+)/m.exec(text)?.[1] ?? 0);

/** Host availability includes the agent's commands and their background jobs. Cgroup ancestors can impose
 * tighter limits than the host; inspect every ancestor, including the runner's own scope. */
export async function readCapacity(): Promise<Capacity> {
  const [memory, memPressure, cpuPressure, membership] = await Promise.all([
    read('/proc/meminfo'),
    read('/proc/pressure/memory'),
    read('/proc/pressure/cpu'),
    read('/proc/self/cgroup'),
  ]);
  let availableBytes = Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1] ?? freemem() / 1024) * 1024;
  let cpuCount = availableParallelism();
  let path = join('/sys/fs/cgroup', /^0::(.*)$/m.exec(membership)?.[1] ?? '/');
  while (path.startsWith('/sys/fs/cgroup')) {
    const [max, current, cpu] = await Promise.all([
      read(join(path, 'memory.max')),
      read(join(path, 'memory.current')),
      read(join(path, 'cpu.max')),
    ]);
    if (/^\d+\s*$/.test(max) && /^\d+\s*$/.test(current))
      availableBytes = Math.min(availableBytes, Math.max(0, Number(max) - Number(current)));
    const [quota, period] = cpu.trim().split(/\s+/).map(Number);
    if (quota && period) cpuCount = Math.min(cpuCount, quota / period);
    if (path === '/sys/fs/cgroup') break;
    path = dirname(path);
  }
  return {
    availableBytes,
    cpuCount,
    memoryPressure: pressure(memPressure),
    cpuPressure: pressure(cpuPressure),
  };
}

/** Reserve memory for the server and OS, and room for one new CLI/browser turn. Existing work is never killed. */
export function capacityAdmission(sample: Capacity, active: number): { allowed: boolean; reason: string } {
  if (sample.availableBytes < 1.5 * GiB)
    return { allowed: false, reason: 'waiting for 1.5 GiB of available memory' };
  if (sample.memoryPressure >= 10) return { allowed: false, reason: 'waiting for memory pressure to ease' };
  if (sample.cpuPressure >= 50 || active >= Math.max(1, Math.floor(sample.cpuCount)))
    return { allowed: false, reason: 'waiting for CPU capacity' };
  return { allowed: true, reason: 'capacity available' };
}
