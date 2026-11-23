/**
 * What a kind of connection adds to its page (connection-pages.md CP-06…CP-11; connection-pages-server.md CP-S09;
 * dashboards.md DS-10…DS-13): its own figures and chart cards in place of the generic ones, its notices before the
 * generic ones, its main and side panels, its tabs, the head's first facts, a status more precise than the check's, the
 * service's own page and its actions. Everything else on the page is the generic part's (`things/page.ts`), the
 * machine's figures and charts included unless the kind draws them itself (`ownMachine`) or puts its own first
 * (`machine: 'after'`, service-dashboards.md SD-03, SD-S02).
 */
import type {
  CatalogEntry,
  ThingLine,
  ThingPageAction,
  ThingPageBar,
  ThingPageButton,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageTab,
  ThingStatus,
} from '@whombat/core';
import type { ConnectionViewer } from '../../connections/store';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import type { MachineNow } from '../machine';
import type { ThingQuiet } from '../quiet/store';
import type { KindNotice } from '../quiet/types';
import type { MachineFigures, ResolvedMachine } from '../runs-on';
import type { PageRange, RawPoint } from '../series';

export type ChartPanel = Extract<ThingPagePanel, { kind: 'chart' }>;

/** What a kind's page part reads with. */
export interface KindCtx {
  services: Services;
  row: CatalogConnectionRow;
  entry: CatalogEntry;
  now: Date;
  timeZone: string;
  /** What it runs on, and that machine's figures when they could be read. */
  machine: { at: ResolvedMachine; figures: MachineFigures | null } | null;
  /** The page's range (DS-03): every chart and small line covers it. */
  range: PageRange;
  /** The burrow the page is read in (its servers, for “Open”). */
  burrowId: string;
  /** The machine's disk over the last 30 days (`disk_pct`, `disk_gb`), for its forecast. */
  disk: { pct: RawPoint[]; gb: RawPoint[] };
  /** Who reads the page (`siblingThing`: only connections they see, SD-S08); absent in pure tests. */
  viewer?: ConnectionViewer;
  /** Which checks are on or off for this thing, so opt-in checks don't fetch while off; absent in pure tests. */
  quiet?: ThingQuiet;
}

export interface KindView {
  /** In place of the generic figures (Status, Response time, Last used, Problems); after the machine's. */
  kpis?: ThingPageKpi[];
  /**
   * Its chart cards, after the machine's. Present — even empty — the response-time chart is left out (SD-03: it stays
   * in Settings' checks once a kind draws its own page).
   */
  charts?: ChartPanel[];
  /** It draws the machine's figures and charts itself (Home Assistant: its Supervisor's when there is no machine). */
  ownMachine?: boolean;
  /**
   * `after` (SD-03, SD-S02): its own figures first, then the machine's CPU and Memory only; the machine's chart cards
   * stay on the machine's page, its disk notice stays in Worth a look. Absent: the machine's figures and charts first
   * (DS-10).
   */
  machine?: 'after';
  /**
   * Its Summary is in slots (docs/decisions/service-slots.md): no row of figures, Worth a look as the strip, its
   * panels in rows, and the machine as one card after them with these lines of its own (Plex's version).
   */
  slots?: {
    machine: ThingPageBar[];
    /**
     * The card's figures when Whombat knows no machine it runs on, from the service itself (Home Assistant OS's
     * Supervisor), under this name.
     */
    own?: { figures: MachineNow; name: string };
  };
  /** Worth a look (quiet-notices.md QN-01…QN-04): every line with its nature, check and item. */
  notices: KindNotice[];
  /** Its main and side panels (DS-04), each with its `place` (main when absent). */
  panels: ThingPagePanel[];
  /** Its own tabs after the Summary. */
  tabs: ThingPageTab[];
  /**
   * The key of its own tab the page opens on, when that tab is the dashboard and the Summary isn't (Find My's map,
   * which the apps draw): that tab comes first, the Summary last, and the Summary gets no answer times.
   */
  lead?: string;
  /** The head's first facts (“Home Assistant **2026.10.2** · Container”). */
  facts: ThingLine[];
  /** More precise than the check's (“1 access point offline”). */
  status?: { status: ThingStatus; badge: string };
  open?: { label: string; url: string };
  actions: ThingPageAction[];
  /**
   * Buttons in the head beside its actions (CT-1014, at most 4): Check for updates, Arm and Disarm; `pageButton` makes
   * them with the rules of SD-07.
   */
  buttons?: ThingPageButton[];
  /** When its figures were read; null when nothing could be read. */
  readAt: Date | null;
  /** It shows its last reading while a newer one is read: the page asks again soon (page-speed.md PS-02). */
  refreshing?: boolean;
  /**
   * How often the open page asks again, in seconds (SD-09): 5 while something downloads or plays, 10 for controls and
   * camera snapshots; absent, the page's 60 (DS-16). `refreshing`'s 5 wins when it is sooner; never under 5.
   */
  refreshS?: number;
  problem?: string;
  /** “Show more here” chips (CP-14). */
  suggestions: string[];
  /**
   * The sentence under the name while nothing needs a look (service-settings.md SST-10): “Plex is fine: 2 people are
   * watching and every library is up to date.” A problem's or a warning's sentence is the page's own.
   */
  verdict?: string;
}

/** A kind's page part. */
export type KindPage = (ctx: KindCtx) => Promise<KindView>;
