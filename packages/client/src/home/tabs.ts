/**
 * Overview's sections as jump links (docs/decisions/overview-one-page.md): **Servers**, **Connections** (the `services`
 * key: everything connected that isn't a server) and **Pinned**, each with how many it holds and a dot in the worst tone
 * when something in it isn't fine. Pinned only when something is. `overviewSections` (`overview.ts`) builds the page's
 * sections from these; an old `?tab=` address names one of these keys and scrolls to its section. Also Overview's
 * words. Pure; shared by web and phone.
 */
import { clientTranslator } from '../i18n/catalog';
import type { HomeSection } from './sections';
import { THING_TONES } from './sections';

export type ConnectionsTab = 'servers' | 'services' | 'pinned';

export function connectionsTabWords(locale?: string | null): Record<ConnectionsTab, string> {
  const tr = clientTranslator(locale);
  return {
    servers: tr.t('overview.tab.servers'),
    services: tr.t('overview.tab.services'),
    pinned: tr.t('overview.tab.pinned'),
  };
}

export const CONNECTIONS_TAB_WORDS: Record<ConnectionsTab, string> = connectionsTabWords();

export interface ConnectionsTabView {
  key: ConnectionsTab;
  label: string;
  count: number;
  /** The worst of what it holds when that isn't fine; null when all is. */
  tone: 'warn' | 'bad' | null;
  /** “Services, 5, something needs a look”. */
  spoken: string;
}

type Tone = ConnectionsTabView['tone'];

function worst(tones: readonly string[]): Tone {
  if (tones.includes('bad')) return 'bad';
  if (tones.includes('warn')) return 'warn';
  return null;
}

/** The jump links in order, from Overview's sections: Servers where the hosts service runs, Connections, Pinned when any. */
export function connectionsTabs(
  sections: readonly HomeSection[],
  locale?: string | null,
): ConnectionsTabView[] {
  const tr = clientTranslator(locale);
  const words = connectionsTabWords(locale);
  const tabs: ConnectionsTabView[] = [];
  const add = (key: ConnectionsTab, count: number, tone: Tone) =>
    tabs.push({
      key,
      label: words[key],
      count,
      tone,
      spoken: [
        words[key],
        String(count),
        tone === 'bad' ? tr.t('overview.tab.spokenBad') : tone ? tr.t('overview.tab.spokenWarn') : null,
      ]
        .filter(Boolean)
        .join(', '),
    });
  for (const s of sections) {
    if (s.kind === 'servers')
      // An offline server is trouble here, though a connection that is offline is only grey.
      add(
        'servers',
        s.servers.length,
        worst(s.servers.map((t) => (t.status === 'offline' ? 'bad' : THING_TONES[t.status]))),
      );
    else if (s.kind === 'things') add('services', s.rows.length, worst(s.rows.map((r) => r.tone)));
    else if (s.kind === 'panels' && s.widgets.length) add('pinned', s.widgets.length, null);
  }
  return tabs;
}

export function overviewWords(locale?: string | null) {
  const tr = clientTranslator(locale);
  return {
    lookIntoIt: tr.t('overview.lookIntoIt'),
    others: (n: number) => tr.tp('home.otherNeedsYouCount', n),
    readingHistory: tr.t('overview.readingHistory'),
    couldntRefresh: (what: string) => tr.t('overview.couldntRefresh', { what }),
    savedEach: tr.t('overview.savedEach'),
    savedFrom: (when: string) => tr.t('overview.savedFrom', { when }),
    savedUnknown: tr.t('overview.savedUnknown'),
    keepLast: tr.t('overview.keepLast'),
    keepPage: tr.t('overview.keepPage'),
    couldntRead: (what: string) => tr.t('overview.couldntRead', { what }),
    noSaved: tr.t('overview.noSaved'),
    tryAgain: tr.t('overview.tryAgain'),
    moreDetail: tr.t('overview.moreDetail'),
    loading: (what: string) => tr.t('overview.loading', { what }),
    noReadings: tr.t('overview.noReadings'),
    noReadingsBody: tr.t('overview.noReadingsBody'),
    columns: {
      server: tr.t('overview.col.server'),
      cpu: tr.t('overview.col.cpu'),
      memory: tr.t('overview.col.memory'),
      storage: tr.t('overview.col.storage'),
      temp: tr.t('overview.col.temp'),
      running: tr.t('overview.col.running'),
    },
    noSensor: tr.t('overview.noSensor'),
    noSensorValue: '–',
    nothingRunning: tr.t('overview.nothingRunning'),
    thisWhombat: tr.t('overview.thisWhombat'),
    addServer: tr.t('overview.addServer'),
    addConnection: tr.t('overview.addConnection'),
    everythingRunning: tr.t('overview.everythingRunning'),
    onThisPage: tr.t('overview.onThisPage'),
    fromYourChats: tr.t('overview.fromYourChats'),
  };
}

export const OVERVIEW_WORDS = overviewWords();
