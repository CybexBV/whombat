/**
 * Overview's Servers (docs/decisions/overview-one-page.md OVP-02…OVP-08): one card, the column heads and a row a server
 * from `overviewServerRows` — its name the row's link stretched over it, its five figures links of their own above it
 * (each opens its chart or tab). On a narrow page the rows become cards (CSS, by the page's own width). A server waiting
 * to be added, no server yet and the hosts service being down each say so in the same place. Live through
 * `hosts:<burrowId>`.
 */
import { BrandMark } from '@whombat/brand/react';
import { serverQuietWords } from '@whombat/client';
import {
  isHostsUnavailable,
  litSegments,
  type OverviewAmountCell,
  type OverviewCpuCell,
  type OverviewRunningCell,
  type OverviewServerRow,
  type OverviewTempCell,
  overviewServerRows,
  sparklinePaths,
  TILE_SEGMENTS,
} from '@whombat/client/hosts';
import { useHostsFleet, useHostsLive, useHostsStatus } from '@whombat/client/hosts/react';
import { type ThingSummary, thingId } from '@whombat/core';
import { BellOff, Clock, Server } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { LevelPill } from '../../components/StatusMark';
import { useWebI18n } from '../../i18n/provider';
import { CHAT_WORDS } from '../../i18n/shared';
import { useOverviewWords } from '../../i18n/words';
import { useBurrowContext } from '../messaging/useRoom';
import { AppLink } from '../things/parts';
import styles from './Overview.module.css';
import { ReadNote } from './ReadState';

/** The sparkline's drawing box; the SVG stretches it to the cell (`preserveAspectRatio="none"`). */
const SPARK_W = 100;
const SPARK_H = 30;

/** The fleet as Overview reads it: the same queries as the jump links and the sidebar, so one request each. */
export function useOverviewFleet(burrow: string) {
  const { bootstrap } = useBurrowContext(burrow);
  useHostsLive(bootstrap?.burrow.id);
  const status = useHostsStatus({ params: { burrow } }, { retry: false });
  const present = status.data?.present === true;
  const fleet = useHostsFleet(present ? { params: { burrow }, query: {} } : null, { retry: 1 });
  return { status, present, fleet, servers: fleet.data?.servers ?? null };
}

function Meter({ share }: { share: number | null }) {
  const lit = litSegments(share, TILE_SEGMENTS);
  return (
    <span className={styles.meter} aria-hidden="true">
      {Array.from({ length: TILE_SEGMENTS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the segments in order
        <i key={i} className={i < lit ? styles.lit : undefined} />
      ))}
    </span>
  );
}

function CpuCell({ c }: { c: OverviewCpuCell }) {
  const small = [c.word, c.avg].filter(Boolean).join(' · ');
  const paths = sparklinePaths(c.points, SPARK_W, SPARK_H);
  return (
    <AppLink
      href={c.href}
      className={cx(styles.m, c.tone === 'warn' && styles.warn)}
      aria-label={c.spoken}
      data-label={c.label}
      data-cell="cpu"
    >
      <span className={styles.v}>
        <b>{c.value}</b>
        {small ? <small>{small}</small> : null}
      </span>
      {paths ? (
        <svg
          className={styles.spark}
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className={styles.area} d={paths.area} />
          <path className={styles.ln} d={paths.line} />
        </svg>
      ) : null}
    </AppLink>
  );
}

function AmountCell({ c, cell }: { c: OverviewAmountCell; cell: 'memory' | 'storage' }) {
  return (
    <AppLink
      href={c.href}
      className={cx(styles.m, c.tone === 'warn' && styles.warn)}
      aria-label={c.spoken}
      data-label={c.label}
      data-cell={cell}
    >
      <span className={styles.v}>
        <b>{c.value}</b>
        {c.word ? <small>{c.word}</small> : null}
      </span>
      <span className={styles.s}>{c.sub || ' '}</span>
      <Meter share={c.share} />
    </AppLink>
  );
}

function TempCell({ c }: { c: OverviewTempCell }) {
  return (
    <AppLink
      href={c.href}
      className={cx(styles.m, c.tone === 'warn' && styles.warn)}
      aria-label={c.spoken}
      data-label={c.label}
      data-cell="temp"
    >
      <span className={styles.v}>
        <b className={c.noSensor ? styles.muted : undefined}>{c.value}</b>
      </span>
      <span className={styles.s}>{c.sub || ' '}</span>
      {c.noSensor ? null : <Meter share={c.share} />}
    </AppLink>
  );
}

function RunningCell({ c }: { c: OverviewRunningCell }) {
  const { unwell, running, stopped, more } = c.dots;
  return (
    <AppLink
      href={c.href}
      className={cx(styles.m, styles.run)}
      aria-label={c.spoken}
      data-label={c.label}
      data-cell="running"
    >
      <span className={styles.v}>
        {c.nothing ? <small>{c.word}</small> : <b>{c.count}</b>}
        {c.nothing ? null : <small>{c.word}</small>}
      </span>
      {c.nothing ? null : (
        <span className={styles.dots} aria-hidden="true">
          {Array.from({ length: unwell }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: dots are counts, not machines
            <i key={`u${i}`} className={styles.unwell} />
          ))}
          {Array.from({ length: running }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: dots are counts, not machines
            <i key={`r${i}`} />
          ))}
          {Array.from({ length: stopped }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: dots are counts, not machines
            <i key={`s${i}`} className={styles.stopped} />
          ))}
          {more > 0 ? <span className={styles.more}>+{more}</span> : null}
        </span>
      )}
    </AppLink>
  );
}

/**
 * One server's row: its logo, name (the row's link), tag and pill, its system line, “Quiet until 23:00” while it is kept
 * quiet, then the five figures.
 */
export function ServerRow({ row, quiet = null }: { row: OverviewServerRow; quiet?: string | null }) {
  const OVERVIEW_WORDS = useOverviewWords();
  return (
    <li
      className={cx(
        styles.srv,
        styles.srvgrid,
        row.notWorking && styles.bad,
        row.child && styles.child,
        row.offline && styles.offline,
      )}
      data-server={row.id}
      title={row.readTitle}
    >
      <div className={styles.who}>
        <span className={styles.logo} aria-hidden="true">
          {row.mark ? <BrandMark mark={row.mark} size={22} /> : <Icon icon={Server} size={20} />}
        </span>
        <div className={styles.nm}>
          <div className={styles.nmline}>
            <AppLink
              href={row.href}
              className={styles.name}
              aria-label={quiet ? `${row.label}. ${quiet}` : row.label}
            >
              {row.name}
            </AppLink>
            {row.thisWhombat ? <span className={styles.tag}>{OVERVIEW_WORDS.thisWhombat}</span> : null}
            {row.pill ? <LevelPill level={row.level} word={row.pill.word} className={styles.pill} /> : null}
          </div>
          {row.osLine ? <div className={styles.os}>{row.osLine}</div> : null}
          {row.seen ? (
            <div className={styles.stale}>{row.seen}</div>
          ) : row.stale ? (
            <div className={styles.stale}>
              <Icon icon={Clock} size={12} />
              {row.stale}
            </div>
          ) : null}
          {quiet ? (
            <div className={styles.stale} data-quiet="">
              <Icon icon={BellOff} size={12} />
              {quiet}
            </div>
          ) : null}
        </div>
      </div>
      <CpuCell c={row.cpu} />
      <AmountCell c={row.memory} cell="memory" />
      <AmountCell c={row.storage} cell="storage" />
      <TempCell c={row.temp} />
      <RunningCell c={row.running} />
    </li>
  );
}

/** The column heads, also each figure's label on a narrow card. */
function ColumnHead() {
  const OVERVIEW_WORDS = useOverviewWords();
  const c = OVERVIEW_WORDS.columns;
  return (
    <li className={cx(styles.srvhead, styles.srvgrid)} aria-hidden="true">
      <span>{c.server}</span>
      <span>{c.cpu}</span>
      <span>{c.memory}</span>
      <span>{c.storage}</span>
      <span>{c.temp}</span>
      <span>{c.running}</span>
    </li>
  );
}

/** “A server is waiting to be added” after the rows, with Review (Add a server's waiting list). */
function WaitingRow({ pending, onReview }: { pending: number; onReview: () => void }) {
  const { t, tp } = useWebI18n();
  return (
    <li className={cx(styles.srv, styles.waiting)} data-server-waiting={pending}>
      <span className={styles.logo} aria-hidden="true">
        <Icon icon={Server} size={20} />
      </span>
      <div className={styles.nm}>
        <div className={styles.waitingName}>{tp('overview.servers.waiting', pending)}</div>
        <div className={styles.os}>{t('overview.servers.waitingHint')}</div>
      </div>
      <Button size="sm" variant="primary" className={styles.waitingButton} onClick={onReview}>
        {t('overview.servers.review')}
      </Button>
    </li>
  );
}

/**
 * The servers' list under its heading: the rows, then a server waiting to be added; “No servers yet” with Add a server;
 * the hosts service down without saved rows; the fleet's own failed refresh when Overview's note isn't already there.
 */
export function OverviewServers({
  burrow,
  now,
  timeZone,
  onAdd,
  savedNoteShown,
  things,
}: {
  burrow: string;
  now: number;
  timeZone: string;
  /** Home's things: a server kept quiet says until when on its row (the fleet doesn't carry it). */
  things?: readonly Pick<ThingSummary, 'id' | 'kind' | 'quietUntil'>[] | null;
  /** Opens Add a server on this page (`?add=1`). */
  onAdd: () => void;
  /** Overview already says its refresh failed: no second note here. */
  savedNoteShown: boolean;
}) {
  const OVERVIEW_WORDS = useOverviewWords();
  const { t, tag: uiLocale } = useWebI18n();
  const { status, fleet, servers } = useOverviewFleet(burrow);
  const rows = useMemo(
    () => overviewServerRows(servers ?? [], now, timeZone, uiLocale),
    [servers, now, timeZone, uiLocale],
  );
  const quiet = useMemo(
    () => serverQuietWords(things, now, timeZone, uiLocale),
    [things, now, timeZone, uiLocale],
  );
  const pending = fleet.data?.pendingEnrollments ?? 0;
  const down =
    isHostsUnavailable(status.error) || isHostsUnavailable(fleet.error) || status.data?.healthy === false;
  if (down && !rows.length) return <p className={styles.note}>{t('overview.servers.unreachable')}</p>;
  if (!fleet.data && !rows.length)
    return (
      <div role="status" aria-busy="true" className={styles.ph}>
        <p className={styles.loading}>{OVERVIEW_WORDS.loading(CHAT_WORDS.dashboard)}</p>
        <RowPlaceholders />
      </div>
    );
  return (
    <>
      {fleet.error && !savedNoteShown ? (
        // A refresh failed: the rows keep their readings, each with its own time.
        <ReadNote
          className={styles.fleetNote}
          title={OVERVIEW_WORDS.couldntRefresh(CHAT_WORDS.dashboard)}
          body={OVERVIEW_WORDS.savedEach}
          error={fleet.error}
          busy={fleet.isFetching}
          onRetry={() => void fleet.refetch()}
        />
      ) : null}
      <ul className={cx(styles.card, styles.srvlist)} aria-label={t('sidebar.servers')}>
        {rows.length ? <ColumnHead /> : null}
        {rows.map((row) => (
          <ServerRow key={row.id} row={row} quiet={quiet.get(thingId('server', row.id)) ?? null} />
        ))}
        {pending ? <WaitingRow pending={pending} onReview={onAdd} /> : null}
        {!rows.length && !pending ? (
          <li className={cx(styles.note, styles.empty)}>
            {t('overview.servers.empty')}{' '}
            <button type="button" className={styles.inlineLink} onClick={onAdd}>
              {OVERVIEW_WORDS.addServer}
            </button>
          </li>
        ) : null}
      </ul>
    </>
  );
}

/** Placeholder rows in the servers' card while the page loads. */
export function RowPlaceholders({ rows = 3 }: { rows?: number }) {
  return (
    <div className={styles.card} aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders in order
        <div key={r} className={styles.phRow}>
          {Array.from({ length: 6 }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders in order
            <i key={c} />
          ))}
        </div>
      ))}
    </div>
  );
}
