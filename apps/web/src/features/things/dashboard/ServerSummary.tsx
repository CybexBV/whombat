/**
 * A server's Summary, every kind of server alike (Whombat dashboards.md DS-02, DS-09, DS-16, DS-17; dashboards-web.md
 * AP-2050…; mocks server.png, unraid.png; connections-page.md AP-2510): the panels `@whombat/client` builds from the
 * hosts data (`serverDashboard` through `useServerDashboard`: the server's live page, its history for the range read
 * every minute, the busiest guests' own lines), drawn by the one Summary renderer. The page reads them (`dash`), so its
 * tab row knows whether the range picker is still needed there; the figures open their charts with the range beside
 * them (`?range=`). The previous range stays on screen while a new one loads. It needs nothing of the runtime: older
 * ones get it too.
 */
import { LOOK_PLAN_WORDS, threadToOpen } from '@whombat/client';
import { SERVER_DASHBOARD_RANGES, type ServerDetailRow } from '@whombat/client/hosts';
import type { ServerDashboardState } from '@whombat/client/hosts/react';
import { type QuietActions, useHandleLook, useLookResearch } from '@whombat/client/react';
import { type HostSeriesRange, type HostServerStatus, thingId } from '@whombat/core';
import { type ReactNode, useRef } from 'react';
import { useNavigateHref } from '../../../app/routing/navigation';
import { useToast } from '../../../components/Toast';
import { useNow } from '../../messaging/useRoom';
import { BackupsKeptHere } from '../KeptHere';
import { LookCard } from '../page/LookCard';
import { ErrorLine, Skeleton } from '../parts';
import { WhatHappened } from '../quiet/WhatHappened';
import { useThingSearch } from '../search';
import { Dashboard } from './Dashboard';
import type { DashboardContext } from './Panels';
import { TechnicalDetails } from './Verdict';

/** What the server's Technical details list before the cards: its facts, and its parts' links. */
export interface ServerTechnicalView {
  rows: ServerDetailRow[];
  extra: ReactNode;
}

export function ServerSummary({
  burrow,
  serverId,
  name,
  range,
  timeZone,
  onAsk,
  dash,
  quiet = null,
  technical = null,
  status,
  links = null,
  endQuiet = null,
  endingQuiet = false,
  limitFor = null,
}: {
  burrow: string;
  serverId: string;
  name: string;
  range: HostSeriesRange;
  timeZone: string;
  onAsk: (question?: string) => void;
  /** `useServerDashboard` for this server and range, read by the page. */
  dash: Pick<ServerDashboardState, 'panels' | 'details' | 'error' | 'refetch'>;
  /** The head's facts for the Technical details fold at the foot. */
  technical?: ServerTechnicalView | null;
  /** Ignore, Remind me tomorrow, Stop watching and Undo on its lines (quiet-notices.md AP-4828). */
  quiet?: QuietActions | null;
  /** How the server is, for the colour of what the assistant found out (its LookCard). */
  status?: HostServerStatus;
  /** Links to what reads through this server, after its panels (a Mac's Find My). */
  links?: ReactNode;
  /** End now on a line quiet because the server is kept quiet (monitoring.md MON-04). */
  endQuiet?: (() => void) | null;
  endingQuiet?: boolean;
  /** Change the limit in a line's ⋯ (MON-15). */
  limitFor?: DashboardContext['limitFor'];
}) {
  const [, set] = useThingSearch();
  const now = useNow(60_000);
  const thing = thingId('server', serverId);
  const toast = useToast();
  // What the assistant found out about the server and the plan it offers (handle-it.md); none on an older Whombat.
  const look = useLookResearch({ params: { burrow }, query: { key: thing } }, { retry: false });
  const research = look.data?.research ?? null;
  // A Whombat without looks.handle, or nothing that needs a look any more: the question in the Ask pane, as before.
  const question = useRef('');
  // Handed over, its thread opens, where the assistant works on it (backup-places.md BPL-15).
  const navigateHref = useNavigateHref();
  const handle = useHandleLook(burrow, (outcome, thread) => {
    const open = outcome === 'ok' ? threadToOpen(thread) : null;
    if (open) navigateHref(open);
    else if (outcome === 'ask') onAsk(question.current);
    else if (outcome === 'failed') toast.show(LOOK_PLAN_WORDS.failed);
  });
  if (!dash.panels)
    return dash.error ? (
      <ErrorLine error={dash.error} onRetry={dash.refetch} />
    ) : (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading the summary"
        style={{ display: 'grid', gap: 18 }}
      >
        <Skeleton height={108} />
        <Skeleton height={240} />
      </div>
    );
  const ctx: DashboardContext = {
    burrow,
    thing: { id: thing, name, settings: false, canManage: false },
    timeZone,
    now,
    range,
    ranges: SERVER_DASHBOARD_RANGES,
    onRange: (next) => set({ range: next === '24h' ? undefined : next }, { replace: true }),
    onAsk,
    onTab: (tab) => set({ tab: tab === 'summary' ? undefined : tab }),
    quiet,
    research,
    onHandle: (q) => {
      question.current = q;
      handle.mutate(thing);
    },
    endQuiet,
    endingQuiet,
    limitFor,
  };
  return (
    <>
      {research ? (
        <LookCard
          burrow={burrow}
          page={{ research, name, status: status === 'bad' || status === 'offline' ? status : 'warn' }}
          onAsk={() => onAsk()}
        />
      ) : null}
      <Dashboard panels={dash.panels} ctx={ctx} />
      {links}
      {/* When it keeps this Whombat's backups (backup-places.md AP-6710). */}
      <BackupsKeptHere thing={thing} />
      {/* Its outages and its alerts over the last 30 days (monitoring.md MON-09). */}
      <WhatHappened burrow={burrow} thing={thing} />
      <TechnicalDetails
        rows={technical?.rows ?? []}
        extra={technical?.extra}
        panels={dash.details ?? []}
        ctx={ctx}
      />
    </>
  );
}
