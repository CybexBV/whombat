/**
 * The agent's services (Whombat one-person.md OP-19, contracts 3.0, CT-1533…CT-1537): what stays up on the person's
 * Whombat — a website, a dev server, a dashboard — runs as a container of the Whombat's own container engine (OP-16:
 * rootless Podman with Docker's API) with a port from `AGENT_SERVICE_PORTS` (at most `AGENT_SERVICES_MAX`), reachable
 * from private networks only (the home network, Tailscale), never the internet. It runs until the agent or the person
 * stops it, and comes back after a restart when it was started to. Settings → Agent lists them with Stop; the agent
 * gets the link. Session ops too (`services.*`).
 *
 * - `services.list`: the services as they are now, read from the engine (containers labelled `whombat.service=1` with a
 *   published port in the range). `available: false` with `reason` where there is no container engine
 *   (`HostInfo.services`): development without Podman.
 * - `services.stop`: the person stops one (the panel's Stop): the container stops and doesn't come back after a restart.
 *   An id that isn't one of the services is `not_found`. Signs `service.stopped`.
 *
 * The `services.changed` event (topic `burrow`) says the list changed: one started, stopped, failed or came back.
 */
import { z } from 'zod';
import { Timestamp } from '../domain/common.js';
import { EventId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

/** The Whombat's ports the agent's services get (OP-19, I-5): open from private networks only. */
export const AGENT_SERVICE_PORTS = { from: 20_000, to: 20_099 } as const;
/** At most this many services at once (OP-19). */
export const AGENT_SERVICES_MAX = 5;
/** The label the container engine's containers carry (`=1`) when they are one of the agent's services (I-2). */
export const AGENT_SERVICE_LABEL = 'whombat.service';
/** The longest `reason` a services answer carries. */
export const AGENT_SERVICES_REASON_MAX = 500;

/** `ServicesHostStatus.reason` where this Whombat has no container engine (development without Podman). */
export const SERVICES_NOT_HERE = 'This Whombat can’t run containers.';

/** A service's id: its container's id as the engine gives it (12 to 64 lowercase hex). */
export const AgentServiceId = z.string().regex(/^[0-9a-f]{12,64}$/);
export type AgentServiceId = z.infer<typeof AgentServiceId>;

/** A port of `AGENT_SERVICE_PORTS`. */
export const AgentServicePort = z.number().int().min(AGENT_SERVICE_PORTS.from).max(AGENT_SERVICE_PORTS.to);

/**
 * - `starting`: made, not running yet (or starting again after a restart);
 * - `running`: up, reachable at `url`;
 * - `stopped`: stopped by the agent or the person; it stays stopped;
 * - `failed`: it exited on its own or couldn't start (the agent sees why in the engine's logs).
 */
export const AGENT_SERVICE_STATES = ['starting', 'running', 'stopped', 'failed'] as const;
export const AgentServiceState = z.enum(AGENT_SERVICE_STATES);
export type AgentServiceState = z.infer<typeof AgentServiceState>;

/** One of the agent's services as the person sees it (Settings → Agent). */
export const AgentService = z.object({
  id: AgentServiceId,
  /** What the agent called it (its container's name): “invoice-site”, “grafana”. */
  name: z.string().min(1).max(63),
  /** The Whombat's port it is published on. */
  port: AgentServicePort,
  /** Where people open it: `http://<the Whombat's address on the home network>:<port>`; null while that isn't known. */
  url: z.string().max(200).nullable(),
  state: AgentServiceState,
  /** When it last started; null when it never did. */
  startedAt: Timestamp.nullable(),
  /** The image it runs (`node:24-alpine`, `grafana/grafana:11`). */
  image: z.string().min(1).max(255),
});
export type AgentService = z.infer<typeof AgentService>;

/** Whether the agent's services work on this Whombat (`HostInfo.services`, `services.list`). */
export const ServicesHostStatus = z.object({
  /** The container engine is there. */
  available: z.boolean(),
  /** Why not (`SERVICES_NOT_HERE`, or what is wrong with the engine); null when available. */
  reason: z.string().max(AGENT_SERVICES_REASON_MAX).nullable(),
});
export type ServicesHostStatus = z.infer<typeof ServicesHostStatus>;

/** `services.list`: whether services work here, and the services (empty when they don't). */
export const ServicesListResponse = ServicesHostStatus.extend({
  services: z.array(AgentService).max(AGENT_SERVICES_MAX),
});
export type ServicesListResponse = z.infer<typeof ServicesListResponse>;

/** `services.stop`: which one. */
export const StopServiceBody = z.object({ id: AgentServiceId });
export type StopServiceBody = z.infer<typeof StopServiceBody>;

/** `services.stop`: the service as it is now and the signed event (null when it was already stopped). */
export const StopServiceResponse = z.object({ service: AgentService, eventId: EventId.nullable() });
export type StopServiceResponse = z.infer<typeof StopServiceResponse>;

const BA = z.object({ burrow: BurrowParam });

export const serviceEndpoints = {
  list: endpoint({
    id: 'services.list',
    method: 'GET',
    path: '/burrows/:burrow/agent/services',
    summary:
      'What the agent runs on this Whombat as containers (websites, dev servers, dashboards): name, port, link, state, image; whether the container engine is here.',
    params: BA,
    response: ServicesListResponse,
  }),
  stop: endpoint({
    id: 'services.stop',
    method: 'POST',
    path: '/burrows/:burrow/agent/services/stop',
    summary:
      'Stop one of the agent’s services; it stays stopped after a restart. An id that isn’t one is `not_found`. Signs `service.stopped`.',
    params: BA,
    body: StopServiceBody,
    response: StopServiceResponse,
  }),
};
