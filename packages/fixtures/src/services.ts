/**
 * The agent's services in the mock world (contracts 3.0, CT-1533…CT-1537; Whombat one-person.md OP-19): Dusty runs the
 * invoice PDF preview it built for PR #482 as a container on port 20001, and a stopped Grafana it tried yesterday.
 * `services.list` reads them, `services.stop` stops one (`createServicesWorld`).
 */
import type { AgentService, ServicesListResponse, StopServiceResponse } from '@whombat/core/contracts';
import { at } from './time.js';

export const FIXTURE_SERVICES: readonly AgentService[] = [
  {
    id: '3f9a1c2b7d4e',
    name: 'invoice-preview',
    port: 20_001,
    url: 'http://192.168.1.20:20001',
    state: 'running',
    startedAt: at('11:31'),
    image: 'node:24-alpine',
  },
  {
    id: '8b2e6f0a91c3',
    name: 'grafana',
    port: 20_002,
    url: 'http://192.168.1.20:20002',
    state: 'stopped',
    startedAt: at('16:05', -1),
    image: 'grafana/grafana:11',
  },
];

export const SERVICES_ENDPOINT_IDS = ['services.list', 'services.stop'] as const;

/** One copy of the services a fixture fetch changes. */
export function createServicesWorld() {
  let services: AgentService[] = FIXTURE_SERVICES.map((s) => ({ ...s }));
  return {
    list(): ServicesListResponse {
      return { available: true, reason: null, services: services.map((s) => ({ ...s })) };
    },
    /** Null when the id isn't one of the services (`not_found`). */
    stop(id: string): StopServiceResponse | null {
      const found = services.find((s) => s.id === id);
      if (!found) return null;
      if (found.state === 'stopped') return { service: { ...found }, eventId: null };
      const stopped: AgentService = { ...found, state: 'stopped' };
      services = services.map((s) => (s.id === id ? stopped : s));
      return { service: { ...stopped }, eventId: 'evt_services1stop' };
    },
  };
}
