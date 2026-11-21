import { describe, expect, it } from 'vitest';
import { capacityAdmission } from './capacity';

describe('appliance admission', () => {
  const idle = { availableBytes: 6 * 1024 ** 3, cpuCount: 4, memoryPressure: 0, cpuPressure: 0 };
  it('admits work again after background memory usage or pressure eases', () => {
    expect(capacityAdmission({ ...idle, availableBytes: 1024 ** 3 }, 0).allowed).toBe(false);
    expect(capacityAdmission({ ...idle, memoryPressure: 15 }, 0).allowed).toBe(false);
    expect(capacityAdmission(idle, 0).allowed).toBe(true);
  });
  it('respects fractional CPU limits and CPU contention', () => {
    expect(capacityAdmission({ ...idle, cpuCount: 1.5 }, 1).allowed).toBe(false);
    expect(capacityAdmission({ ...idle, cpuCount: 0.5 }, 0).allowed).toBe(true);
    expect(capacityAdmission({ ...idle, cpuPressure: 60 }, 0).allowed).toBe(false);
  });
});
