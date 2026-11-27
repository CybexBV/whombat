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
import { mobileTranslator } from '../i18n/translate';

/**
 * Whether Settings → Agent has a Running part: whenever the host answered, as on the web; a Whombat without a container
 * engine says why there (`services.list`'s `reason`, else `SERVICES_NOT_HERE`).
 */
export function showsServices(host: Pick<HostInfo, 'services'> | undefined): boolean {
  return !!host;
}

/** The part's words, the web's (`features/agent/settings/services.ts`); the agent by its name. */
export function servicesText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    /** The part's tab. */
    tab: t('data.activity.running'),
    title: t('data.services.title'),
    intro: (agent: string) => t('data.services.intro', { agent }),
    empty: (agent: string) => t('data.services.empty', { agent }),
    open: t('data.services.open'),
    stop: t('data.services.stop'),
    stopLabel: (name: string) => t('data.services.stopLabel', { name }),
    stopTitle: (name: string) => t('data.services.stopTitle', { name }),
    stopBody: (agent: string) => t('data.services.stopBody', { agent }),
    cancel: t('data.common.cancel'),
    stopped: (name: string) => t('data.services.stopped', { name }),
    failed: t('data.services.failed'),
    loadFailed: t('data.services.loadFailed'),
  } as const;
}
export const SERVICES_TEXT = servicesText();

export function serviceStateLabels(locale?: string): Readonly<Record<AgentServiceState, string>> {
  const { t } = mobileTranslator(locale);
  return {
    starting: t('data.services.state.starting'),
    running: t('data.activity.running'),
    stopped: t('data.run.step.stopped'),
    failed: t('data.services.state.failed'),
  };
}
export const SERVICE_STATE_LABELS = serviceStateLabels();

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
  ctx: { now: Date; timeZone: string; locale?: string | undefined },
): ServiceRow[] {
  const labels = serviceStateLabels(ctx.locale);
  const text = servicesText(ctx.locale);
  const { t } = mobileTranslator(ctx.locale);
  return services.map((s) => {
    const stateLabel = labels[s.state];
    const line =
      !s.startedAt || s.state === 'starting'
        ? stateLabel
        : t('data.services.startedAgo', {
            state: stateLabel,
            ago: formatAgo(s.startedAt, ctx.now, ctx.timeZone, ctx.locale),
          });
    const url = s.state === 'running' || s.state === 'starting' ? s.url : null;
    return {
      id: s.id,
      name: s.name,
      stateLabel,
      tone: SERVICE_STATE_TONES[s.state],
      line,
      url,
      canStop: s.state !== 'stopped',
      stopLabel: text.stopLabel(s.name),
      accessibilityLabel: [s.name, line, url].filter(Boolean).join(', '),
    };
  });
}
