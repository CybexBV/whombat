/**
 * Settings → Agent → **Running** (Whombat one-person.md OP-19; contracts 3.0 CT-1533…CT-1537; one-person.md AP-5690):
 * the pure parts — the words, a service's dot and its line. A service is a container the agent keeps up on the
 * person's Whombat (a website, a dev server, a dashboard), reachable from the home network and Tailscale only.
 */
import type { AgentService, AgentServiceState } from '@whombat/core/contracts';
import { formatAgo } from '@whombat/core/text';
import type { DotTone } from '../../../components/StatusDot';

/** The state's dot: running ok, starting warn, failed bad, stopped quiet. */
export const SERVICE_STATE_TONES: Readonly<Record<AgentServiceState, DotTone>> = {
  starting: 'warn',
  running: 'ok',
  stopped: 'mut',
  failed: 'bad',
};

export const SERVICE_STATE_LABELS: Readonly<Record<AgentServiceState, string>> = {
  starting: 'Starting',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Stopped working',
};

/** The part's words; the agent by its name. */
export const SERVICES_TEXT = {
  tab: 'Running',
  title: 'RUNNING ON YOUR WHOMBAT',
  intro: (agent: string) =>
    `Websites, dev servers and dashboards ${agent} keeps running for you. You open them from your home network or Tailscale, never from the internet.`,
  empty: (agent: string) =>
    `Nothing is running. When ${agent} starts a website or a dashboard for you, it shows here.`,
  stop: 'Stop',
  stopLabel: (name: string) => `Stop ${name}`,
  stopTitle: (name: string) => `Stop ${name}?`,
  stopBody: (agent: string) =>
    `It stays stopped, also after your Whombat restarts. Anyone using it loses it. ${agent} can start it again when you ask.`,
  cancel: 'Cancel',
  stopped: (name: string) => `Stopped ${name}.`,
  failed: 'That didn’t work. Try again in a moment.',
  loadFailed: 'Couldn’t load what’s running. Try again in a moment.',
} as const;

/** “Running · started 52 min ago”, “Stopped working · started yesterday”, “Starting”. */
export function serviceLine(
  service: Pick<AgentService, 'state' | 'startedAt'>,
  now: number,
  timeZone: string,
): string {
  const state = SERVICE_STATE_LABELS[service.state];
  if (!service.startedAt || service.state === 'starting') return state;
  return `${state} · started ${formatAgo(service.startedAt, now, timeZone)}`;
}

/** Stop shows on a service that is up or trying to be (a stopped one stays stopped). */
export function serviceStoppable(service: Pick<AgentService, 'state'>): boolean {
  return service.state !== 'stopped';
}

/** Its link shows while it runs (a stopped one's address leads nowhere). */
export function serviceLink(service: Pick<AgentService, 'state' | 'url'>): string | null {
  return service.state === 'running' || service.state === 'starting' ? service.url : null;
}
