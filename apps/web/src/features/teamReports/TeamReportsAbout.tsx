/**
 * About's WHOMBAT TEAM: Report a problem or idea, with how many reports the person sent
 * and how many have a new answer, opening Your reports. Only where the person may send one or has some.
 */
import { createLink } from '@tanstack/react-router';
import { TEAM_REPORT_WORDS, teamReportsSummary } from '@whombat/client';
import { useTeamReports } from '@whombat/client/react';
import { useId } from 'react';
import { ButtonLink } from '../../components/Button';
import { SectionLabel } from '../../components/SectionLabel';
import styles from '../settings/SettingsScreen.module.css';

const RouterButtonLink = createLink(ButtonLink);

export function TeamReportsAbout({ burrow }: { burrow: string }) {
  const list = useTeamReports(burrow);
  const id = useId();
  if (!list.shown || !list.data) return null;
  const reports = list.data.reports;
  return (
    <section className={styles.section} aria-labelledby={id} data-team-reports-about="">
      <SectionLabel as="h2" id={id}>
        WHOMBAT TEAM
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{TEAM_REPORT_WORDS.entry}</span>
            <span className={styles.rowMeta}>
              {reports.length ? teamReportsSummary(reports) : TEAM_REPORT_WORDS.empty}
            </span>
          </span>
          {reports.length || !list.data.available ? (
            <RouterButtonLink to="/reports" variant="secondary" size="sm">
              {TEAM_REPORT_WORDS.title}
            </RouterButtonLink>
          ) : (
            <RouterButtonLink to="/reports/new" variant="secondary" size="sm">
              {TEAM_REPORT_WORDS.newReport}
            </RouterButtonLink>
          )}
        </div>
      </div>
    </section>
  );
}
