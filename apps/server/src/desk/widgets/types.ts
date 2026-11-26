/**
 * The seams of the screens of widgets in the runtime (docs/decisions/desk-display.md DK-126…DK-149;
 * docs/implementation/desk-display/widgets.md): what the screens' store answers (`ScreensApi`, stream R1), what a
 * connection's or device's widgets come from (`ThingWidgets`, stream R2) and what every resolved widget carries.
 */
import type {
  DeskCalm,
  DeskCalmView,
  DeskCatalogGroup,
  DeskDoorbell,
  DeskGrid,
  DeskLayout,
  DeskPopups,
  DeskScreenKind,
  DeskScreenSize,
  DeskShow,
  DeskWidgetRef,
  DeskWidgetSpec,
  DeskWidgetView,
} from '@whombat/core';
import type { ConnectionViewer } from '../../connections/store';
import type { Services } from '../../services';

/** Whose screen and when its widgets are read. */
export interface WidgetCtx {
  services: Services;
  /** The person whose screen it is: their burrow and what they may see. */
  viewer: ConnectionViewer;
  now: Date;
  timeZone: string;
  /** The assistant's name, for Whombat's own widgets' words. */
  assistant: string;
}

/** A widget resolved: its view, whether it shows what a locked screen leaves out (DK-138), when to read it again. */
export interface Resolved {
  view: DeskWidgetView;
  /** Words or pictures *A summary* leaves out unless the widget's `lock` option is `show`. */
  private: boolean;
  /** Seconds until it is read again; never under 10. */
  refreshS: number;
}

/** A connection's or device's widgets — its figures and the panels of its page (stream R2). */
export interface ThingWidgets {
  /** *Add a widget*'s groups for every thing the viewer sees, or only `thing`'s (its page read now). */
  groups(ctx: WidgetCtx, thing?: DeskWidgetRef): Promise<DeskCatalogGroup[]>;
  /** The views of `figures` and `panel` widgets, one page read per thing; a widget it can't resolve says why. */
  resolve(ctx: WidgetCtx, specs: readonly DeskWidgetSpec[]): Promise<Map<string, Resolved>>;
}

/** A screen as the store keeps it. */
export interface ScreenRecord {
  id: string;
  burrowId: string;
  kind: DeskScreenKind;
  name: string;
  popups: DeskPopups;
  /** When the doorbell rings. */
  doorbell: DeskDoorbell;
  layout: DeskLayout;
  show: DeskShow;
  endpointId: string | null;
  personId: string | null;
  device: string | null;
  size: DeskScreenSize | null;
  lastSeenAt: Date | null;
}

/** The screens' store and drawing (stream R1); the screens elsewhere (stream R3) use it. */
export interface ScreensApi {
  list(burrowId: string): Promise<ScreenRecord[]>;
  get(burrowId: string, id: string): Promise<ScreenRecord | null>;
  byEndpoint(endpointId: string): Promise<ScreenRecord | null>;
  /**
   * A device became a screen (DK-146): writes its row inside the caller's commit (`tx`), the layout a copy of the box's
   * own (`copy`) or one empty page (`empty`).
   */
  addDevice(
    tx: unknown,
    input: {
      burrowId: string;
      personId: string;
      endpointId: string;
      name: string;
      popups: DeskPopups;
      start: 'copy' | 'empty';
      device: string | null;
    },
  ): Promise<ScreenRecord>;
  /** It said its size now (kept at most once a minute unless it changed). */
  seen(id: string, size: DeskScreenSize, at: Date): Promise<void>;
  /** What the screen draws now for what the lock lets show: the calm glance and its grid. */
  draw(screen: ScreenRecord, view: DeskCalmView): Promise<{ calm: DeskCalm; grid: DeskGrid }>;
  /** The time zone of the person the screen is drawn for (their own, else the Whombat's); null without one. */
  timeZone?(screen: ScreenRecord): Promise<string | null>;
  /** A picture one of the screen's widgets names, if it may show it now; null otherwise (always the same refusal). */
  picture(
    screen: ScreenRecord,
    view: DeskCalmView,
    thing: string,
    ref: string,
  ): Promise<{ type: string; bytes: Uint8Array } | null>;
}
