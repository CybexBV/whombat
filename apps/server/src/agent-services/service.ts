/**
 * The agent's services (docs/decisions/one-person.md OP-19; brief I-2, I-5; one-person.md OP-S44…OP-S46): what stays up
 * on the person's Whombat — a website, a dev server, a dashboard — is a container of the Whombat's container engine
 * (`engine.ts`) that carries the label `whombat.service=1` and publishes a port of 20000–20099. The person sees at most
 * five of them (Settings → Agent, `services.list`) and stops one (`services.stop`, signed `service.stopped`); the agent
 * starts and stops them itself with `docker`. Each is reached at the box's address on the home network.
 *
 * Nothing is kept here: every list asks the engine. A list that differs from the one before tells `onChange`'s
 * listeners (the `services.changed` frame). Without `WHOMBAT_CONTAINERS_SOCKET` (development without Podman) the
 * services aren't available, and say why.
 */
import { isIPv6 } from 'node:net';
import {
  AGENT_SERVICE_LABEL,
  AGENT_SERVICE_PORTS,
  AGENT_SERVICES_MAX,
  type AgentService,
  type AgentServiceState,
  SERVICES_NOT_HERE,
  type ServicesListResponse,
} from '@whombat/core';
import type { Config } from '../config';
import { interfaceAddresses } from '../managed/direct/network';
import {
  type ContainerEngine,
  type EngineContainer,
  EngineError,
  EngineUnavailable,
  SocketEngine,
} from './engine';

const SERVICE_LABEL = AGENT_SERVICE_LABEL;
const SERVICE_PORTS = AGENT_SERVICE_PORTS;
export const SERVICES_MAX = AGENT_SERVICES_MAX;

/** Why the services can't be read right now: the engine is there but doesn't answer. */
export const SERVICES_NOT_ANSWERING =
  'The container engine isn’t answering right now. Try again in a minute.';

export type AgentServiceView = AgentService;
export type ServicesList = ServicesListResponse;

const ID = /^[0-9a-f]{12,64}$/;
const NAME_MAX = 63;
const IMAGE_MAX = 255;
const URL_MAX = 200;

/** The port of a service: the first published TCP port in the range. */
function servicePort(c: EngineContainer): number | null {
  for (const p of c.Ports ?? []) {
    const port = p.PublicPort;
    if ((p.Type ?? 'tcp') !== 'tcp' || !Number.isInteger(port)) continue;
    if ((port as number) >= SERVICE_PORTS.from && (port as number) <= SERVICE_PORTS.to) return port as number;
  }
  return null;
}

/** The engine's state in the person's words: stopped by someone (exit 0, SIGTERM, SIGKILL) or failed by itself. */
export function serviceState(c: Pick<EngineContainer, 'State' | 'Status'>): AgentServiceState {
  const state = (c.State ?? '').toLowerCase();
  if (state === 'running' || state === 'paused') return 'running';
  if (state === 'created' || state === 'configured' || state === 'restarting' || state === 'initialized')
    return 'starting';
  if (state === 'exited' || state === 'stopped') {
    const code = Number(/\((-?\d+)\)/.exec(c.Status ?? '')?.[1] ?? 0);
    return code === 0 || code === 137 || code === 143 ? 'stopped' : 'failed';
  }
  return 'failed';
}

function unixToIso(seconds: number | undefined): string | null {
  return seconds && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/** `http://<address>:<port>`, or null without an address (or too long for the view). */
export function serviceUrl(address: string | null, port: number): string | null {
  if (!address) return null;
  const url = `http://${isIPv6(address) ? `[${address}]` : address}:${port}`;
  return url.length <= URL_MAX ? url : null;
}

/** A container as the person's service, or null when it isn't one (no label, no port in the range, a strange id). */
export function toAgentService(c: EngineContainer, address: string | null): AgentServiceView | null {
  if (c.Labels?.[SERVICE_LABEL] !== '1' || !ID.test(c.Id)) return null;
  const port = servicePort(c);
  if (port === null) return null;
  const name = (c.Names?.[0] ?? '').replace(/^\//, '').slice(0, NAME_MAX) || c.Id.slice(0, 12);
  const state = serviceState(c);
  return {
    id: c.Id,
    name,
    port,
    url: serviceUrl(address, port),
    state,
    startedAt: unixToIso(c.StartedAt) ?? (state === 'running' ? unixToIso(c.Created) : null),
    image: (c.Image ?? '').slice(0, IMAGE_MAX) || 'unknown',
  };
}

/**
 * The box's address on the home network (OP-S44): its first private IPv4 address on
 * a network card that is the LAN, else its first such IPv6 address; null when it has none.
 */
export function homeNetworkAddress(): string | null {
  const lan = interfaceAddresses(['lan']).filter((a) => a.network === 'lan');
  return (lan.find((a) => a.family === 'IPv4') ?? lan[0])?.address ?? null;
}

/** The services as the person sees them: in port order, at most `SERVICES_MAX`. */
export function servicesOf(
  containers: readonly EngineContainer[],
  address: string | null,
): AgentServiceView[] {
  return containers
    .map((c) => toAgentService(c, address))
    .filter((s): s is AgentServiceView => s !== null)
    .sort((a, b) => a.port - b.port || a.name.localeCompare(b.name))
    .slice(0, SERVICES_MAX);
}

/** A stop of a service that isn't one (any more). */
export class ServiceNotFound extends Error {
  constructor() {
    super('That service isn’t running here any more.');
    this.name = 'ServiceNotFound';
  }
}

export interface AgentServicesDeps {
  /** The engine; absent: none here (`WHOMBAT_CONTAINERS_SOCKET` unset). */
  engine?: ContainerEngine | null;
  /** The box's address on the home network (default `homeNetworkAddress`). */
  address?: () => string | null;
}

/** The agent's services on this Whombat. */
export class AgentServices {
  readonly #engine: ContainerEngine | null;
  readonly #address: () => string | null;
  readonly #listeners = new Set<(list: ServicesList) => void>();
  #last: string | null = null;

  constructor(deps: AgentServicesDeps = {}) {
    this.#engine = deps.engine ?? null;
    this.#address = deps.address ?? homeNetworkAddress;
  }

  /** From the config: the engine at `WHOMBAT_CONTAINERS_SOCKET`, none without it. */
  static fromConfig(config: Pick<Config, 'WHOMBAT_CONTAINERS_SOCKET'>): AgentServices {
    const socket = config.WHOMBAT_CONTAINERS_SOCKET;
    return new AgentServices({ engine: socket ? new SocketEngine(socket) : null });
  }

  /** Whether the services work here (`HostInfo.services`): an engine is configured. */
  hostStatus(): { available: boolean; reason: string | null } {
    return this.#engine ? { available: true, reason: null } : { available: false, reason: SERVICES_NOT_HERE };
  }

  /** Tells `listener` every list that differs from the one before; returns the unsubscribe. */
  onChange(listener: (list: ServicesList) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** `services.list`: the services as they are now. */
  async list(): Promise<ServicesList> {
    const engine = this.#engine;
    if (!engine) return { ...this.hostStatus(), services: [] };
    let out: ServicesList;
    try {
      const containers = await engine.list(`${SERVICE_LABEL}=1`);
      out = { available: true, reason: null, services: servicesOf(containers, this.#address()) };
    } catch (err) {
      if (
        !(err instanceof EngineUnavailable) &&
        !(err instanceof EngineError) &&
        !(err instanceof SyntaxError)
      )
        throw err;
      return { available: false, reason: SERVICES_NOT_ANSWERING, services: [] };
    }
    const key = JSON.stringify(out.services);
    if (this.#last !== null && key !== this.#last) for (const l of this.#listeners) l(out);
    this.#last = key;
    return out;
  }

  /** One service by id, as it is now; `ServiceNotFound` when it isn't one. */
  async get(id: string): Promise<AgentServiceView> {
    const found = (await this.list()).services.find((s) => s.id === id);
    if (!found) throw new ServiceNotFound();
    return found;
  }

  /**
   * Stops a service: the engine stops the container, and it stays stopped after a restart (its restart policy counts
   * a stop as the person's). The service as it is afterwards.
   */
  async stop(id: string): Promise<AgentServiceView> {
    const engine = this.#engine;
    if (!engine) throw new ServiceNotFound();
    try {
      await engine.stop(id);
    } catch (err) {
      // Removed meanwhile (by the agent): nothing to stop.
      if (err instanceof EngineError && err.status === 404) throw new ServiceNotFound();
      throw err;
    }
    return this.get(id);
  }
}
