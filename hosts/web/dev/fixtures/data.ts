// Loads the hand-off fixtures (docs/handoff/sample-data) for the fixture dev
// server and the contract tests. Read-only.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fleet, Metrics, ProxmoxDetail, StandardDetail } from '../../src/api/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DATA_DIR = resolve(here, '../../../docs/handoff/sample-data');

function load<T>(file: string): T {
  const raw: unknown = JSON.parse(readFileSync(resolve(SAMPLE_DATA_DIR, file), 'utf8'));
  if (raw && typeof raw === 'object' && '_note' in raw) {
    // `_note` is fixture-only, not part of the API.
    const { _note: _ignored, ...rest } = raw as Record<string, unknown>;
    return rest as T;
  }
  return raw as T;
}

export interface FixtureSet {
  fleet: Fleet;
  basalt: StandardDetail;
  shale: ProxmoxDetail;
  basalt24h: Metrics;
}

/** Fresh deep copies every call so request handlers can mutate freely. */
export function loadFixtures(): FixtureSet {
  return {
    fleet: load<Fleet>('fleet.json'),
    basalt: load<StandardDetail>('server-basalt.json'),
    shale: load<ProxmoxDetail>('server-shale-proxmox.json'),
    basalt24h: load<Metrics>('timeseries-basalt-24h.json'),
  };
}
