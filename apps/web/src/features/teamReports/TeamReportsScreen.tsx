/**
 * Your reports (`/reports`; Whombat team-reports.md): the problems and ideas the person sent the Whombat Team, as a
 * place page (Settings', the Vault's). Open reports first — those that wait for the person at the top, then those with
 * something new (the new dot), then the latest — and the closed ones folded under Closed while open ones exist (a
 * closed one with something new still shows). New report while the person may send one; why not, quietly, when they
 * can't; a quiet line when the list is the box's copy because the team's side couldn't be reached.
 */
import { createLink, Link } from '@tanstack/react-router';
import {
  TEAM_REPORT_KIND_WORDS,
  TEAM_REPORT_WORDS,
  teamReportGroups,
  teamReportRowLabel,
  teamReportsUnavailableText,
  teamReportWhen,
} from '@whombat/client';
import { useTeamReports } from '@whombat/client/react';
import { TEAM_REPORT_STATUS_WORDS, type TeamReportRow, teamReportNeedsYou } from '@whombat/core';
import { ChevronDown, ChevronRight, ChevronUp, CloudOff, MessageSquareText, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import { errorDetail, PlacePage, PlaceState, placeStyles as place } from '../settings/Place';
import { KindIcon } from './parts';
import styles from './TeamReports.module.css';

const RouterButtonLink = createLink(ButtonLink);

export function TeamReportsScreen({ burrow }: { burrow: string }) {
  const list = useTeamReports(burrow);
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const [showClosed, setShowClosed] = useState(false);
  const ids = useId();
  const data = list.data;
  const groups = teamReportGroups(data?.reports ?? []);
  const closedOpen = !groups.foldable || showClosed;
  const closedRows = closedOpen ? groups.closed : groups.closedWhileFolded;
  const unavailable = data && !data.available && !data.stale ? teamReportsUnavailableText(data.reason) : null;
  return (
    <PlacePage
      title={TEAM_REPORT_WORDS.title}
      intro={TEAM_REPORT_WORDS.intro}
      screen="team-reports"
      action={
        data?.available ? (
          <RouterButtonLink
            to="/reports/new"
            variant="primary"
            size="lg"
            className={styles.newReport}
            iconStart={<Icon icon={Plus} size={16} />}
            data-new-report=""
          >
            {TEAM_REPORT_WORDS.newReport}
          </RouterButtonLink>
        ) : undefined
      }
    >
      {data?.stale ? (
        <p className={styles.quiet} role="status" data-stale="">
          <Icon icon={CloudOff} size={15} />
          {TEAM_REPORT_WORDS.stale}
        </p>
      ) : unavailable ? (
        <p className={styles.quiet}>{unavailable}</p>
      ) : null}
      {!list.supported ? (
        <PlaceState kind="empty" icon={MessageSquareText} title={TEAM_REPORT_WORDS.updateFirst} />
      ) : list.error && !data ? (
        <PlaceState
          kind="failed"
          icon={MessageSquareText}
          title={TEAM_REPORT_WORDS.listFailed}
          onRetry={() => void list.refetch()}
          detail={errorDetail(list.error)}
        />
      ) : !data ? (
        <PlaceState kind="loading" icon={MessageSquareText} title={TEAM_REPORT_WORDS.loading} />
      ) : data.reports.length === 0 ? (
        <PlaceState kind="empty" icon={MessageSquareText} title={TEAM_REPORT_WORDS.empty} />
      ) : (
        <>
          {groups.open.length ? (
            <section className={styles.section} aria-labelledby={`${ids}-open`}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle} id={`${ids}-open`}>
                  {TEAM_REPORT_WORDS.open}
                </h2>
                <span className={styles.count}>{groups.open.length}</span>
              </div>
              <ul className={place.card}>
                {groups.open.map((r) => (
                  <ReportRow key={r.id} row={r} now={now} timeZone={timeZone} />
                ))}
              </ul>
            </section>
          ) : null}
          {groups.closed.length ? (
            <section className={styles.section} aria-labelledby={`${ids}-closed`}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle} id={`${ids}-closed`}>
                  {TEAM_REPORT_WORDS.closed}
                </h2>
                <span className={styles.count}>{groups.closed.length}</span>
                {groups.foldable ? (
                  <button
                    type="button"
                    className={styles.fold}
                    aria-expanded={closedOpen}
                    aria-controls={`${ids}-closed-list`}
                    onClick={() => setShowClosed((was) => !was)}
                  >
                    {closedOpen ? TEAM_REPORT_WORDS.hideClosed : TEAM_REPORT_WORDS.showClosed}
                    <Icon icon={closedOpen ? ChevronUp : ChevronDown} size={14} />
                  </button>
                ) : null}
              </div>
              {closedRows.length ? (
                <ul className={place.card} id={`${ids}-closed-list`}>
                  {closedRows.map((r) => (
                    <ReportRow key={r.id} row={r} now={now} timeZone={timeZone} />
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </PlacePage>
  );
}

/** One report: its kind (with the new dot), title, number, kind and status, when it last changed, and the chevron. */
function ReportRow({ row, now, timeZone }: { row: TeamReportRow; now: number; timeZone: string }) {
  const needsYou = teamReportNeedsYou(row.status);
  return (
    <li>
      <Link
        to="/reports/$reportId"
        params={{ reportId: row.id }}
        search={{}}
        className={cx(place.row, styles.reportRow, row.unread && styles.unread)}
        aria-label={teamReportRowLabel(row)}
        data-report-row={row.id}
        data-unread={row.unread || undefined}
      >
        <span className={cx(place.tile, styles.tileWithDot)} aria-hidden="true">
          <KindIcon kind={row.kind} size={18} />
          {row.unread ? <span className={styles.newDot} /> : null}
        </span>
        <span className={place.main}>
          <span className={place.name}>{row.title}</span>
          <span className={place.line}>
            #{row.number} · {TEAM_REPORT_KIND_WORDS[row.kind]} ·{' '}
            <span className={needsYou ? styles.needsYou : undefined}>
              {TEAM_REPORT_STATUS_WORDS[row.status]}
            </span>
          </span>
        </span>
        <span className={styles.time}>{teamReportWhen(row.updatedAt, now, timeZone)}</span>
        <span className={place.chevron} aria-hidden="true">
          <Icon icon={ChevronRight} size={16} />
        </span>
      </Link>
    </li>
  );
}
