/** Contracts version of the pins in use (behaviour that changed between contract releases, IN-24). */
import { loadPins } from './pins.ts';

const parts = (v: string) => v.split('.').map((x) => Number.parseInt(x, 10) || 0);

export function contractsAtLeast(version: string): boolean {
  const have = parts(loadPins().contracts.version);
  const want = parts(version);
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
}
