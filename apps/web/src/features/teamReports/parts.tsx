/** The pieces the reports' pages share: the way back to the list, a report's kind as an icon, the four steps. */
import { Link } from '@tanstack/react-router';
import { teamReportTrack, teamReportTrackLabel, teamReportWords } from '@whombat/client';
import type { TeamReportKind, TeamReportStatus } from '@whombat/core';
import { Bug, Lightbulb } from 'lucide-react';
import { Icon } from '../../components/Icon';
import { useWebI18n } from '../../i18n/provider';
import { BackLabel, placeStyles as place } from '../settings/Place';
import styles from './TeamReports.module.css';

/** “← Your reports” above a report's or the form's title, as a place page's way back. */
export function BackToReports() {
  const { tag: uiLocale } = useWebI18n();
  const words = teamReportWords(uiLocale);
  return (
    <Link to="/reports" className={place.back} data-reports-back="">
      <BackLabel>{words.back}</BackLabel>
    </Link>
  );
}

export function KindIcon({ kind, size = 17 }: { kind: TeamReportKind; size?: number }) {
  return <Icon icon={kind === 'bug' ? Bug : Lightbulb} size={size} />;
}

/** Received → Looking into it → Being fixed → Fixed, the steps behind done and the team's current one ringed. */
export function ReportTrack({ status }: { status: TeamReportStatus }) {
  const { tag: uiLocale } = useWebI18n();
  const words = teamReportWords(uiLocale);
  return (
    <ol className={styles.track} aria-label={`${words.progress}: ${teamReportTrackLabel(status, uiLocale)}`}>
      {teamReportTrack(status, uiLocale).map((step) => (
        <li
          key={step.label}
          className={styles.step}
          data-state={step.state}
          aria-current={step.state === 'current' ? 'step' : undefined}
        >
          <span className={styles.stepDot} aria-hidden="true" />
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}
