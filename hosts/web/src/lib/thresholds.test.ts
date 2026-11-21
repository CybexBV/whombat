import { describe, expect, it } from 'vitest';
import {
  diskUsedLevel,
  displayWear,
  heatBin,
  memoryAssignedLevel,
  overcommitLevel,
  sensorLevel,
  serverStatus,
  vcpuMeterWidth,
  wearAlertRule,
  wearLabel,
  wearLevel,
} from './thresholds';

// Vectors from docs/handoff/docs/ACCEPTANCE.md section 7.

describe('sensor temperature status (PRODUCT-SPEC 5)', () => {
  it('limit 85', () => {
    expect(sensorLevel(72.0, 85)).toBe('good');
    expect(sensorLevel(72.25, 85)).toBe('warning');
    expect(sensorLevel(84.9, 85)).toBe('warning');
    expect(sensorLevel(85.0, 85)).toBe('serious');
  });
  it('limit 90 (VRM)', () => {
    expect(sensorLevel(76.4, 90)).toBe('good');
    expect(sensorLevel(76.5, 90)).toBe('warning');
    expect(sensorLevel(90, 90)).toBe('serious');
  });
  it('uses the per-sensor limit, defaulting to 85 when missing', () => {
    expect(sensorLevel(64, 75)).toBe('warning'); // NVMe limit
    expect(sensorLevel(47, 55)).toBe('warning'); // HDD limit
    expect(sensorLevel(72.25, null)).toBe('warning');
    expect(sensorLevel(72, undefined)).toBe('good');
  });
  it('no data -> null', () => {
    expect(sensorLevel(null, 85)).toBeNull();
  });
});

describe('disk used %', () => {
  it('79 good, 80 warning, 89 warning, 90 serious', () => {
    expect(diskUsedLevel(79)).toBe('good');
    expect(diskUsedLevel(80)).toBe('warning');
    expect(diskUsedLevel(89)).toBe('warning');
    expect(diskUsedLevel(90)).toBe('serious');
  });
});

describe('SSD wear %', () => {
  it('levels', () => {
    expect(wearLevel(74)).toBe('good');
    expect(wearLevel(75)).toBe('warning');
    expect(wearLevel(89)).toBe('warning');
    expect(wearLevel(90)).toBe('serious');
  });
  it('label and alert', () => {
    expect(wearLabel(74)).toBe('Healthy');
    expect(wearLabel(75)).toBe('Wear high');
    expect(wearAlertRule(74)).toBeNull();
    expect(wearAlertRule(75)).toBe('disk.wear_high');
    expect(wearAlertRule(89)).toBe('disk.wear_high');
    expect(wearAlertRule(90)).toBe('disk.wear_critical');
  });
  it('100 displays as 100 (capped)', () => {
    expect(displayWear(100)).toBe(100);
    expect(displayWear(112)).toBe(100);
  });
});

describe('memory assigned / host RAM', () => {
  it('79 good, 80 warning, 90 serious', () => {
    expect(memoryAssignedLevel(79)).toBe('good');
    expect(memoryAssignedLevel(80)).toBe('warning');
    expect(memoryAssignedLevel(90)).toBe('serious');
  });
});

describe('vCPU overcommit', () => {
  it('1.50 good, 1.51 warning', () => {
    expect(overcommitLevel(1.5)).toBe('good');
    expect(overcommitLevel(1.51)).toBe('warning');
    expect(overcommitLevel(52 / 32)).toBe('warning');
    expect(overcommitLevel(22 / 48)).toBe('good');
  });
  it('meter width = min(ratio / 2, 1) x 100%', () => {
    expect(vcpuMeterWidth(0.46)).toBeCloseTo(23);
    expect(vcpuMeterWidth(1)).toBe(50);
    expect(vcpuMeterWidth(1.625)).toBeCloseTo(81.25);
    expect(vcpuMeterWidth(3)).toBe(100);
  });
});

describe('heatmap bins', () => {
  it.each([
    [7.9, 0],
    [8, 1],
    [19.9, 1],
    [20, 2],
    [34.9, 2],
    [35, 3],
    [49.9, 3],
    [50, 4],
    [64.9, 4],
    [65, 5],
    [79.9, 5],
    [80, 6],
    [100, 6],
  ])('%s -> bin %s', (v, bin) => {
    expect(heatBin(v)).toBe(bin);
  });
  it('null -> blank cell', () => {
    expect(heatBin(null)).toBeNull();
  });
});

describe('server status', () => {
  it('59 s online (or warning with an open warning), 60 s offline', () => {
    expect(serverStatus(59, false)).toBe('online');
    expect(serverStatus(59, true)).toBe('warning');
    expect(serverStatus(60, false)).toBe('offline');
    expect(serverStatus(60, true)).toBe('offline');
  });
});
