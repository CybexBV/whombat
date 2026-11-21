/**
 * What the agent runs on your Whombat (Whombat one-person.md OP-19; contracts 3.0 CT-1533…CT-1537; app one-person.md
 * AP-5655; one-person-android.md AP-5760): Settings → Agent → Running — RUNNING ON YOUR WHOMBAT, each website, dev
 * server or dashboard the agent keeps up, with how it is, its link on your home network and Stop, in the web's words
 * (app one-person.md AP-5690). It replaced the agent's computer (OP-04). Pure: the screen renders this.
 */
import {
  type AgentService,
  type AgentServiceState,
  formatAgo,
  type HostInfo,
  type Tone,
} from '@whombat/core';

/**
 * Whether Settings → Agent has a Running part: whenever the host answered, as on the web; a Whombat without a container
 * engine says why there (`services.list`'s `reason`, else `SERVICES_NOT_HERE`).
 */
export function showsServices(host: Pick<HostInfo, 'services'> | undefined): boolean {
  return !!host;
}

/** The part's words, the web's (`features/agent/settings/services.ts`); the agent by its name. */
export const SERVICES_TEXT = {
  /** The part's tab. */
  tab: 'Running',
  title: 'RUNNING ON YOUR WHOMBAT',
  intro: (agent: string) =>
    `Websites, dev servers and dashboards ${agent} keeps running for you. You open them from your home network or Tailscale, never from the internet.`,
  empty: (agent: string) =>
    `Nothing is running. When ${agent} starts a website or a dashboard for you, it shows here.`,
  open: 'Open',
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

export const SERVICE_STATE_LABELS: Readonly<Record<AgentServiceState, string>> = {
  starting: 'Starting',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Stopped working',
};

/** The state's dot: running ok, starting warn, failed bad, stopped quiet. */
export const SERVICE_STATE_TONES: Readonly<Record<AgentServiceState, Tone | null>> = {
  starting: 'warn',
  running: 'ok',
  stopped: null,
  failed: 'bad',
};

export interface ServiceRow {
  id: string;
  name: string;
  stateLabel: string;
  tone: Tone | null;
  /** “Running · started 52 min ago”, “Starting” (the web's `serviceLine`). */
  line: string;
  /** Its link on your network, while it runs or starts (a stopped one's address leads nowhere). */
  url: string | null;
  /** Stop shows on a service that is up or trying to be; a stopped one stays stopped. */
  canStop: boolean;
  /** “Stop dashboard” (TalkBack's hint). */
  stopLabel: string;
  accessibilityLabel: string;
}

export function serviceRows(
  services: readonly AgentService[],
  ctx: { now: Date; timeZone: string },
): ServiceRow[] {
  return services.map((s) => {
    const stateLabel = SERVICE_STATE_LABELS[s.state];
    const line =
      !s.startedAt || s.state === 'starting'
        ? stateLabel
        : `${stateLabel} · started ${formatAgo(s.startedAt, ctx.now, ctx.timeZone)}`;
    const url = s.state === 'running' || s.state === 'starting' ? s.url : null;
    return {
      id: s.id,
      name: s.name,
      stateLabel,
      tone: SERVICE_STATE_TONES[s.state],
      line,
      url,
      canStop: s.state !== 'stopped',
      stopLabel: SERVICES_TEXT.stopLabel(s.name),
      accessibilityLabel: [s.name, line, url].filter(Boolean).join(', '),
    };
  });
}
