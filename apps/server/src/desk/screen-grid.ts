/**
 * A screen of widgets as it's drawn and listed (docs/decisions/desk-display.md DK-128…DK-138): Settings' summary of a
 * screen, what the glance read that the widgets need, and a screen's grid — its layout (or the draft it's trying),
 * its views as the lock lets them show, what needs the person for its pop-ups. Pure; `service.ts` reads.
 */
import {
  type DeskCalmInput,
  type DeskCalmView,
  DeskGrid,
  type DeskLayout,
  type DeskScreenDetail,
  type DeskScreenSize,
  type DeskScreenSummary,
  type DeskSpotlight,
  type DeskWidgetView,
  deskAttentionFor,
} from '@whombat/core';
import type { FullGlance } from './glance';
import type { GlanceFacts } from './widgets/resolve';
import type { ScreenRecord } from './widgets/types';

/** A screen in Settings → Screens: what it is, its size as it last said, its pages, whether it shows now. */
export function screenSummary(
  record: ScreenRecord,
  online: boolean,
  size: DeskScreenSize | null = record.size,
): DeskScreenSummary {
  const device = record.device?.trim();
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    popups: record.popups,
    doorbell: record.doorbell,
    size,
    pages: record.layout.pages.length,
    online,
    lastSeenAt: record.lastSeenAt?.toISOString() ?? null,
    ...(device && device !== record.name ? { device: device.slice(0, 80) } : {}),
  };
}

/** `desk.screen.get`: the summary with its layout and choices. */
export function screenDetail(summary: DeskScreenSummary, record: ScreenRecord): DeskScreenDetail {
  return { ...summary, layout: record.layout, show: record.show };
}

/** What Whombat's own widgets and the servers' figures read from the glance's one read. */
export function glanceFacts(
  full: FullGlance | null,
  calm: DeskCalmInput | null,
  startOfToday: number,
): GlanceFacts | null {
  if (!full) return null;
  return {
    work: calm?.work ?? full.work,
    coming: calm?.coming ?? [],
    recent: full.recent,
    startOfToday,
    servers: full.servers,
  };
}

/** Nothing needs the person (before the calm glance's first read, or in *Only the time*). */
const NO_ATTENTION = { items: [], more: 0 };

/**
 * A screen's grid now: its layout or the draft it's trying (until `trying.until`), the views given (already trimmed,
 * the moment's among them), what needs the person for its pop-ups and the lock, and a widget taking over for a moment
 * (`spotlight`). Null when it isn't one the screen takes; `warn` says why.
 */
export function screenGrid(input: {
  record: ScreenRecord;
  layout: DeskLayout;
  trying: number | null;
  spotlight?: DeskSpotlight | null;
  views: DeskWidgetView[];
  calm: DeskCalmInput | null;
  view: DeskCalmView;
  warn?: (message: string, err: unknown) => void;
}): DeskGrid | null {
  const { record, calm, view } = input;
  const grid = {
    screen: record.id,
    layout: input.layout,
    views: input.views,
    attention: calm ? deskAttentionFor(calm, record.show, view, record.popups) : NO_ATTENTION,
    popups: record.popups,
    ...(input.trying !== null ? { trying: { until: new Date(input.trying).toISOString() } } : {}),
    ...(input.spotlight ? { spotlight: input.spotlight } : {}),
  };
  const parsed = DeskGrid.safeParse(grid);
  if (parsed.success) return parsed.data;
  input.warn?.('desk: a screen’s grid wasn’t one the screen takes', parsed.error.issues[0]);
  return null;
}
