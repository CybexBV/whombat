import { useAuditLogInfinite, useBootstrap, useTheAgent, useWhombat } from '@whombat/client/react';
import {
  AUDIT_ACTOR_LABELS,
  AUDIT_KIND_FILTER_LABELS,
  AUDIT_KIND_FILTERS,
  type AuditActorFilter,
  AuditActorFilter as AuditActorFilterSchema,
  type AuditDisplayContext,
  type AuditKindFilter,
  auditCsvFileName,
  auditSubtitle,
  exportToast,
  groupAuditByDay,
  type Principal,
  shortNameOf,
} from '@whombat/core';
import { useCallback, useMemo, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { Chip, RemovableChip } from '../../components/Chip';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { saveBlob } from '../../lib/saveBlob';
import styles from './AuditLogScreen.module.css';
import { AuditRow } from './AuditRow';

export interface AuditLogFilters {
  actor: AuditActorFilter;
  kind: AuditKindFilter;
  /** Handle for "Only {agent} ×". */
  who?: string;
  /** Expanded event id (`evt_9f18`, see `apps/web/src/app/routing/search.ts`). */
  open?: string;
}

export interface AuditLogScreenProps extends AuditLogFilters {
  burrow: string;
  /** Updates `?actor=&kind=&who=&open=` (defaults are left out of the URL). */
  onChange: (next: Partial<AuditLogFilters>) => void;
}

/** Downloads a CSV response as a file (no browser-provided helper for this). */
function downloadCsv(csv: string, fileName: string) {
  saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), fileName);
}

/** Rows in a freshly exported CSV: header + one row per event (`toCsv()`'s `\r\n` line endings). */
function countCsvRows(csv: string): number {
  const trimmed = csv.trim();
  return trimmed ? Math.max(0, trimmed.split(/\r\n|\n/).length - 1) : 0;
}

/**
 * The mock opens this event by default (`logOpen: 'e-9f18'` in the reference's seed state). We only
 * apply that default when there's no explicit `open` in the URL and no agent filter (matching the
 * mock's `toLog()`, which resets `logOpen` to `null` when navigating to a filtered log).
 */
const DEFAULT_OPEN_EVENT_ID = 'evt_9f18';

/** Audit log (TODO 13): append-only, signed, filterable, exportable. */
export function AuditLogScreen({ burrow, actor, kind, who, open, onChange }: AuditLogScreenProps) {
  const { client } = useWhombat();
  const toast = useToast();
  const navigate = useNavigateHref();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const { words } = useTheAgent(burrow);
  const { data, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useAuditLogInfinite(
    bootstrap ? { params: { burrow }, query: { actor, kind, who } } : null,
  );
  const [exporting, setExporting] = useState(false);
  // Tracks whether the user has closed a row (the implicit default or one they explicitly opened), so
  // the implicit default doesn't reassert itself the next time `open` is (or drops back to) undefined —
  // see DEFAULT_OPEN_EVENT_ID above and the onToggle handler below.
  const [defaultDismissed, setDefaultDismissed] = useState(false);
  const effectiveOpen = open ?? (!who && !defaultDismissed ? DEFAULT_OPEN_EVENT_ID : undefined);

  const principalById = useMemo(() => {
    const map = new Map<string, Principal>();
    for (const p of bootstrap?.principals ?? []) map.set(p.id, p);
    return map;
  }, [bootstrap]);

  const ctx: AuditDisplayContext | null = useMemo(() => {
    if (!bootstrap) return null;
    return {
      principal: (id) => {
        const p = principalById.get(id);
        if (!p) return undefined;
        // A system actor (GitHub, an automation) signs as Whombat's, beside the agent (OA-17).
        return { kind: p.kind === 'person' ? 'person' : 'agent', name: p.name, shortName: shortNameOf(p) };
      },
      now: bootstrap.serverTime,
      timeZone: bootstrap.burrow.timeZone,
    };
  }, [bootstrap, principalById]);

  const events = useMemo(() => data?.pages.flatMap((p) => p.events) ?? [], [data]);
  const counts = data?.pages[0]?.counts;
  const days = useMemo(() => (ctx ? groupAuditByDay(events, ctx.now, ctx.timeZone) : []), [events, ctx]);

  const whoName = useMemo(() => {
    if (!who) return null;
    const p = [...principalById.values()].find((x) => x.handle === who);
    return p ? shortNameOf(p) : who;
  }, [who, principalById]);

  const handleExport = useCallback(async () => {
    if (!bootstrap) return;
    setExporting(true);
    try {
      const csv = await client.audit.export({ params: { burrow }, query: { actor, kind, who } });
      const fileName = auditCsvFileName(
        bootstrap.burrow.slug,
        bootstrap.serverTime,
        bootstrap.burrow.timeZone,
      );
      downloadCsv(csv, fileName);
      toast.show(exportToast(countCsvRows(csv)));
    } finally {
      setExporting(false);
    }
  }, [client, burrow, actor, kind, who, bootstrap, toast]);

  if (!bootstrap || !ctx) return null;

  return (
    <div className={styles.scroll} data-screen="log">
      <div className={styles.page}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <h1 className={styles.title}>Audit log</h1>
            <p className={styles.subtitle}>{auditSubtitle(bootstrap.burrow.name, words.name)}</p>
          </div>
          <Button variant="secondary" size="xl" onClick={() => void handleExport()} disabled={exporting}>
            Export CSV
          </Button>
        </div>
        <div className={styles.filters}>
          <div className={styles.filterRow}>
            <SegmentedControl
              label="Actor"
              value={actor}
              onChange={(value) => onChange({ actor: value })}
              options={AuditActorFilterSchema.options.map((value) => ({
                value,
                label: AUDIT_ACTOR_LABELS[value],
              }))}
            />
            {whoName && (
              <RemovableChip
                removeLabel={`Remove filter: Only ${whoName}`}
                onClick={() => onChange({ who: undefined })}
              >
                {/* Two flex items, as in the mock: the chip's 8px gap separates the words. */}
                <span>Only</span>
                <span>{whoName}</span>
              </RemovableChip>
            )}
          </div>
          <div className={styles.kindRow}>
            {/* Vault (after Keys, vault.md VT-50) once the log holds a Vault event, or while it's chosen (AP-117):
                a burrow that never used the Vault keeps the mocked chips. */}
            {AUDIT_KIND_FILTERS.filter(
              (value) => value !== 'vault' || kind === 'vault' || !!counts?.vault,
            ).map((value) => (
              <Chip
                key={value}
                active={kind === value}
                count={counts?.[value] ?? 0}
                onClick={() => onChange({ kind: value })}
              >
                {AUDIT_KIND_FILTER_LABELS[value]}
              </Chip>
            ))}
          </div>
        </div>
        {error && !data ? (
          <ErrorNote
            message="Couldn’t load the audit log. Try again in a moment."
            onRetry={() => void refetch()}
          />
        ) : !data ? (
          <SkeletonRows count={8} lines={2} />
        ) : (
          <>
            {days.map((day) => (
              <div key={day.key} className={styles.day}>
                <SectionLabel as="span" className={styles.dayLabel}>
                  {day.label}
                </SectionLabel>
                <div>
                  {day.events.map((event) => (
                    <AuditRow
                      key={event.id}
                      event={event}
                      actor={principalById.get(event.actorId)}
                      ctx={ctx}
                      open={effectiveOpen === event.id}
                      onToggle={() => {
                        const isOpen = effectiveOpen === event.id;
                        if (isOpen) {
                          // Closing any row — the implicit default or one the user explicitly opened —
                          // should stick closed: remember it locally so the default never reasserts
                          // itself afterwards, and only touch the URL if this row's `open` came from it.
                          setDefaultDismissed(true);
                          if (open !== undefined) onChange({ open: undefined });
                        } else {
                          onChange({ open: event.id });
                        }
                      }}
                      onNavigate={navigate}
                    />
                  ))}
                </div>
              </div>
            ))}
            {events.length === 0 && <p className={styles.empty}>Nothing in the log matches these filters.</p>}
          </>
        )}
        {hasNextPage && (
          <Button
            variant="secondary"
            size="md"
            className={styles.loadMore}
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>
    </div>
  );
}
