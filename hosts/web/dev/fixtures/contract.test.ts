// Contract tests: the hand-off fixtures and the fixture server's responses
// validate against the runtime schemas that mirror src/api/types.ts.
import { describe, expect, it } from 'vitest';
import {
  fleetSchema,
  fleetSeriesSchema,
  metricsSchema,
  proxmoxDetailSchema,
  standardDetailSchema,
  validate,
} from '../../src/api/validate';
import { loadFixtures } from './data';
import { computeFleet, computeFleetSeries } from './fleet';
import { detailResponse, metricsFor } from './servers';

describe('fixtures validate against the API types', () => {
  const fx = loadFixtures();
  it('fleet.json', () => expect(validate(fleetSchema, fx.fleet)).toEqual([]));
  it('server-basalt.json', () => expect(validate(standardDetailSchema, fx.basalt)).toEqual([]));
  it('server-shale-proxmox.json', () => expect(validate(proxmoxDetailSchema, fx.shale)).toEqual([]));
  it('timeseries-basalt-24h.json', () => expect(validate(metricsSchema, fx.basalt24h)).toEqual([]));
  it('the schema catches a wrong enum', () => {
    const bad = { ...fx.fleet, servers: [{ ...fx.fleet.servers[0], status: 'up' }] };
    expect(validate(fleetSchema, bad).join()).toContain('status');
  });
});

describe('fixture server responses validate', () => {
  it('fleet + series for every group and range', () => {
    const fx = loadFixtures();
    for (const g of ['All', 'Production', 'Lab', 'Edge']) {
      expect(validate(fleetSchema, computeFleet(fx.fleet, g))).toEqual([]);
      for (const r of ['1h', '6h', '24h', '7d', '30d'] as const) {
        expect(validate(fleetSeriesSchema, computeFleetSeries(fx.fleet, g, r))).toEqual([]);
      }
    }
  });
  it('detail and metrics', () => {
    for (const r of ['1h', '24h', '30d'] as const) {
      expect(validate(standardDetailSchema, detailResponse(loadFixtures(), 'basalt', r))).toEqual([]);
      expect(validate(proxmoxDetailSchema, detailResponse(loadFixtures(), 'shale', r))).toEqual([]);
      expect(validate(metricsSchema, metricsFor(loadFixtures(), 'basalt', r, null))).toEqual([]);
    }
  });
});
