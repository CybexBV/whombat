/**
 * One Whombat's Home shapes: the contract's (contracts 0.80.0, CT-336, `@whombat/core` `domain/home.ts`), re-exported so
 * the registry, the schema and the sources import them from one place, plus the server's own stored shapes.
 */
import type { ThingFact, ThingStatus } from '@whombat/core';
import type { GlanceLine } from '../things/quiet/glance';

/** What a Needs you or Watch item is about (`HomeRef`). */
export type {
  AutomationToday,
  ChangeActor,
  ChangeEntry,
  HomeOverview,
  HomePart,
  HomeRef,
  HomeSeverity,
  NeedsYouAction,
  NeedsYouItem,
  NeedsYouKind,
  ThingFact,
  ThingKind,
  ThingStatus,
  ThingSummary,
  WatchItem,
  Widget,
  WidgetPoint,
  WidgetSeries,
  WidgetSource,
  WorkingStep,
  WorkingTask,
} from '@whombat/core';

/** A change's subject: the thing it changed (a server, a guest, a connection, a device). */
export interface ChangeSubject {
  kind: string;
  id: string;
  name?: string;
}

/** Where a change points (`ChangeEntry.link`): a burrow-relative app path (`HomeHref`). */
export type ChangeLink = string;

/** A thing's glance, as the connection health poller last saw it (`catalog_connections.glance`). */
export interface ConnectionGlance {
  status: ThingStatus;
  line?: string;
  facts: ThingFact[];
  /** Home Assistant: the integration behind its `log_err_top` points (dashboards-server.md DS-S07). */
  logTop?: string;
  /** Why it isn't fine, in a few plain words, with a status other than `ok` (sidebar.md SB-03, CT-453). */
  reason?: string;
  /** The machine's own name as the service reports it (Unraid's hostname): what it is part of (SB-09, CP-10). */
  hostname?: string;
  /** First health pass whose check answered and whose details could not be read. */
  readFailedSince?: string;
  /**
   * How the last check went when it didn't answer properly (quiet-notices.md QN-S06): no answer, or an error. `status`
   * and `reason` are what the lines came to, so they say “fine” for an outage someone ignored; this stays true.
   */
  outcome?: 'offline' | 'error';
  /**
   * The lines that could colour the dot, as the last pass saw them (QN-S07): whoever shows the thing works its dot out
   * from these and the quiet rows at that moment. Absent: a glance from before 0136, whose `status` stands.
   */
  lines?: GlanceLine[];
  /**
   * What's going on in it now, for the desk's calm glance (desk-display-server.md DK-S140): Plex's viewers, the download
   * queue, new requests. `active` while something is going on; `progress` whole percent. Absent when the kind has none
   * or the last check couldn't read it.
   */
  activity?: ConnectionActivity;
}

/** A connection's activity now (`ConnectionGlance.activity`). */
export interface ConnectionActivity {
  active: boolean;
  /** A few words: “2 watching”, “3 left · 20 min”. */
  value: string;
  /** What it is about: the titles playing, the download first in the queue. */
  detail?: string;
  progress?: number;
}
