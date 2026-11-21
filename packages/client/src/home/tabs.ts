/**
 * Overview's sections as jump links (docs/decisions/overview-one-page.md): **Servers**, **Connections** (the `services`
 * key: everything connected that isn't a server) and **Pinned**, each with how many it holds and a dot in the worst tone
 * when something in it isn't fine. Pinned only when something is. `overviewSections` (`overview.ts`) builds the page's
 * sections from these; an old `?tab=` address names one of these keys and scrolls to its section. Also Overview's
 * words. Pure; shared by web and phone.
 */
import type { HomeSection } from './sections';
import { THING_TONES } from './sections';

export type ConnectionsTab = 'servers' | 'services' | 'pinned';

export const CONNECTIONS_TAB_WORDS: Record<ConnectionsTab, string> = {
  servers: 'Servers',
  services: 'Connections',
  pinned: 'Pinned',
};

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
export function connectionsTabs(sections: readonly HomeSection[]): ConnectionsTabView[] {
  const tabs: ConnectionsTabView[] = [];
  const add = (key: ConnectionsTab, count: number, tone: Tone) =>
    tabs.push({
      key,
      label: CONNECTIONS_TAB_WORDS[key],
      count,
      tone,
      spoken: [
        CONNECTIONS_TAB_WORDS[key],
        String(count),
        tone === 'bad' ? 'something isn’t working' : tone ? 'something needs a look' : null,
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

/**
 * Overview's words, its server and connection pages' too (docs/decisions/overview-server-connection-final.md): the
 * broken thing's one button, the link to the rest of the Inbox, each reading's time, and what a page says while it
 * loads, when a refresh fails (the saved readings stay) and when the first read fails (nothing saved to show).
 */
export const OVERVIEW_WORDS = {
  lookIntoIt: 'Look into it',
  /** “2 other things need you”, after the broken thing. */
  others: (n: number) => `${n} other ${n === 1 ? 'thing needs' : 'things need'} you`,
  readingHistory: 'See reading history',
  /** Overview's own refresh failed: every server keeps its own reading time. */
  couldntRefresh: (what: string) => `Couldn’t refresh ${what}.`,
  savedEach: 'Showing saved readings. Each server keeps its own reading time.',
  /** A page or widget whose refresh failed: the time of the readings it still shows. */
  savedFrom: (when: string) => `Couldn’t refresh; showing readings from ${when}.`,
  savedUnknown: 'Couldn’t refresh; the saved readings’ time is unknown.',
  keepLast: 'The chart and figures below keep their last readings.',
  keepPage: 'What you see below is the last saved page. Its controls may have changed since.',
  couldntRead: (what: string) => `Couldn’t read ${what}.`,
  noSaved: 'There’s no saved copy to show on this device yet.',
  tryAgain: 'Try again',
  moreDetail: 'More detail',
  loading: (what: string) => `Loading ${what}…`,
  noReadings: 'No readings yet',
  noReadingsBody: 'Its readings appear here after its first report.',
  /** The servers' column heads, also each figure's label on a narrow card (overview-one-page.md OVP-02). */
  columns: {
    server: 'Server',
    cpu: 'Processor · 24 h',
    memory: 'Memory',
    storage: 'Storage',
    temp: 'Temperature',
    running: 'Running',
  },
  noSensor: 'No sensor',
  /** A server without a sensor: an en dash where its temperature would be. */
  noSensorValue: '–',
  nothingRunning: 'Nothing running',
  thisWhombat: 'This Whombat',
  addServer: 'Add a server',
  addConnection: 'Add a connection',
  everythingRunning: 'Everything running',
  /** The jump links' accessible name. */
  onThisPage: 'On this page',
  /** Pinned's summary line. */
  fromYourChats: 'From your chats',
} as const;
