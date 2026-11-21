/** The soak as a vitest run (for the real client's module resolution); `harness/validate --soak 30m` starts it. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { soak } from './soak.ts';

it(
  'soak',
  async () => {
    const out = process.env.WB_SOAK_OUT ?? '.';
    const ms = Number(process.env.WB_SOAK_MS ?? 60_000);
    const r = await soak(ms, out, (l) => process.stdout.write(`${l}\n`));
    writeFileSync(join(out, 'soak.json'), `${JSON.stringify(r, null, 2)}\n`);
    expect(r.reasons).toEqual([]);
  },
  24 * 3_600_000,
);
