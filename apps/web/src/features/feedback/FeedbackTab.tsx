import { createLink } from '@tanstack/react-router';
import { ApiError } from '@whombat/client';
import { useFeedbackIntegrations } from '@whombat/client/react';
import { ButtonLink } from '../../components/Button';
import { EmptyNote, ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { Tag } from '../../components/Tag';
import settings from '../settings/SettingsScreen.module.css';
import { assessmentLabel, FEEDBACK_TEXT, intakeLabel, reportsLine, warningsLine } from './copy';
import styles from './Feedback.module.css';
import { useAgentAssesses, useFeedbackWords, useReportsDestination } from './useFeedbackWords';

const RouterButtonLink = createLink(ButtonLink);

/**
 * Settings → Connections → Website feedback (was Settings → Feedback; SS-05; docs/decisions/feedback.md FB-17…FB-19;
 * not in the mocks): the burrow's feedback integrations as Settings' row cards. New integration and each integration are pages of their own
 * (`settings/feedback/new`, `settings/feedback/:id`; docs/decisions/ui-improvements.md AP-400). Where the server
 * says they can't be managed (`can.manage`), it says so.
 */
export function FeedbackTab({ burrow }: { burrow: string }) {
  const words = useFeedbackWords(burrow);
  const assesses = useAgentAssesses(burrow);
  const query = useFeedbackIntegrations({ params: { burrow } });
  // Where its reports land: your Feedback (feedback-chat.md AP-1829).
  const destination = useReportsDestination(burrow);
  const data = query.data;

  const forbidden = query.error instanceof ApiError && query.error.status === 403;
  if (forbidden || (data && !data.can.manage))
    return (
      <div className={settings.card}>
        <p className={settings.empty}>{FEEDBACK_TEXT.locked}</p>
      </div>
    );
  if (query.error && !data)
    return <ErrorNote message={FEEDBACK_TEXT.loadFailed} onRetry={() => void query.refetch()} />;
  if (!data)
    return (
      <div className={settings.card} aria-busy="true">
        <SkeletonRows count={2} lines={3} />
      </div>
    );

  return (
    <>
      <p className={styles.intro}>{words.intro}</p>
      <section className={settings.section}>
        <div className={settings.sectionHead}>
          <SectionLabel as="h2">{FEEDBACK_TEXT.integrations}</SectionLabel>
          <RouterButtonLink variant="secondary" size="sm" to="/settings/feedback/new">
            {FEEDBACK_TEXT.newIntegration}
          </RouterButtonLink>
        </div>
        <div className={settings.card}>
          {data.integrations.length === 0 ? (
            <EmptyNote className={settings.empty}>{FEEDBACK_TEXT.none}</EmptyNote>
          ) : (
            data.integrations.map(({ integration: i, health }) => {
              const warnings = health.warnings.length;
              return (
                <div key={i.id} className={settings.row} data-integration={i.id}>
                  <span className={settings.rowMain}>
                    <span className={settings.rowTitle}>{i.name}</span>
                    <span className={settings.rowMeta}>
                      {i.productLabel} · reports go to {destination(i).text}
                    </span>
                    <span className={styles.mono}>{i.siteId}</span>
                    <span className={styles.statusLine}>
                      <Tag variant="outline" tone={i.intake === 'enabled' ? 'ok' : 'mut'}>
                        {intakeLabel(i)}
                      </Tag>
                      <span>{assessmentLabel(i, words, assesses)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{reportsLine(health.reportsLast24h)}</span>
                      {warnings > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className={styles.warn}>{warningsLine(warnings)}</span>
                        </>
                      )}
                    </span>
                  </span>
                  <RouterButtonLink
                    variant="secondary"
                    size="md"
                    aria-label={`Open ${i.name}`}
                    to="/settings/feedback/$id"
                    params={{ id: i.id }}
                  >
                    {FEEDBACK_TEXT.open}
                  </RouterButtonLink>
                </div>
              );
            })
          )}
        </div>
      </section>
    </>
  );
}
