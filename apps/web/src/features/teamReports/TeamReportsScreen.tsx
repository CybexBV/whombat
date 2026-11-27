/**
 * Your reports (`/reports`; Whombat team-reports.md): the problems and ideas the person sent the Whombat Team, as a
 * place page (Settings', the Vault's). Open reports first — those that wait for the person at the top, then those with
 * something new (the new dot), then the latest — and the closed ones folded under Closed while open ones exist (a
 * closed one with something new still shows). New report while the person may send one; why not, quietly, when they
 * can't; a quiet line when the list is the box's copy because the team's side couldn't be reached.
 */
import { createLink, Link } from '@tanstack/react-router';
import {
  teamReportGroups,
  teamReportKindWords,
  teamReportRowLabel,
  teamReportsUnavailableText,
  teamReportWhen,
  teamReportWords,
} from '@whombat/client';
import { useTeamReports } from '@whombat/client/react';
import { type TeamReportRow, teamReportNeedsYou, teamReportStatusWords } from '@whombat/core';
import { ChevronDown, ChevronRight, ChevronUp, CloudOff, MessageSquareText, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useWebI18n } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import { errorDetail, PlacePage, PlaceState, placeStyles as place } from '../settings/Place';
import { KindIcon } from './parts';
import styles from './TeamReports.module.css';

const RouterButtonLink = createLink(ButtonLink);

export function TeamReportsScreen({ burrow }: { burrow: string }) {
  const { tag: uiLocale } = useWebI18n();
  const words = teamReportWords(uiLocale);
  const list = useTeamReports(burrow);
  const { timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const [showClosed, setShowClosed] = useState(false);
  const ids = useId();
  const data = list.data;
  const groups = teamReportGroups(data?.reports ?? []);
  const closedOpen = !groups.foldable || showClosed;
  const closedRows = closedOpen ? groups.closed : groups.closedWhileFolded;
  const unavailable =
    data && !data.available && !data.stale ? teamReportsUnavailableText(data.reason, uiLocale) : null;
  return (
    <PlacePage
      title={words.title}
      intro={words.intro}
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
            {words.newReport}
          </RouterButtonLink>
        ) : undefined
      }
    >
      {data?.stale ? (
        <p className={styles.quiet} role="status" data-stale="">
          <Icon icon={CloudOff} size={15} />
          {words.stale}
        </p>
      ) : unavailable ? (
        <p className={styles.quiet}>{unavailable}</p>
      ) : null}
      {!list.supported ? (
        <PlaceState kind="empty" icon={MessageSquareText} title={words.updateFirst} />
      ) : list.error && !data ? (
        <PlaceState
          kind="failed"
          icon={MessageSquareText}
          title={words.listFailed}
          onRetry={() => void list.refetch()}
          detail={errorDetail(list.error)}
        />
      ) : !data ? (
        <PlaceState kind="loading" icon={MessageSquareText} title={words.loading} />
      ) : data.reports.length === 0 ? (
        <PlaceState kind="empty" icon={MessageSquareText} title={words.empty} />
      ) : (
        <>
          {groups.open.length ? (
            <section className={styles.section} aria-labelledby={`${ids}-open`}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle} id={`${ids}-open`}>
                  {words.open}
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
                  {words.closed}
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
                    {closedOpen ? words.hideClosed : words.showClosed}
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
  const { tag: uiLocale } = useWebI18n();
  const TEAM_REPORT_STATUS_WORDS = useLocaleWords(teamReportStatusWords);
  const needsYou = teamReportNeedsYou(row.status);
  return (
    <li>
      <Link
        to="/reports/$reportId"
        params={{ reportId: row.id }}
        search={{}}
        className={cx(place.row, styles.reportRow, row.unread && styles.unread)}
        aria-label={teamReportRowLabel(row, uiLocale)}
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
            #{row.number} · {teamReportKindWords(uiLocale)[row.kind]} ·{' '}
            <span className={needsYou ? styles.needsYou : undefined}>
              {TEAM_REPORT_STATUS_WORDS[row.status]}
            </span>
          </span>
        </span>
        <span className={styles.time}>{teamReportWhen(row.updatedAt, now, timeZone, uiLocale)}</span>
        <span className={place.chevron} aria-hidden="true">
          <Icon icon={ChevronRight} size={16} />
        </span>
      </Link>
    </li>
  );
}
