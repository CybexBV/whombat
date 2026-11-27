import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation, useBootstrap } from '@whombat/client/react';
import { api, type FeedbackIntegrationDetail } from '@whombat/core/contracts';
import type { FeedbackIntegration } from '@whombat/core/domain';
import { formatRecent } from '@whombat/core/text';
import { useId, useState } from 'react';
import { useManaged } from '../../app/providers';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button, ButtonLink } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { cx } from '../../components/cx';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { currentLocale, useWebI18n } from '../../i18n/provider';
import settings from '../settings/SettingsScreen.module.css';
import {
  dropAvailable,
  errorText,
  FEEDBACK_TEXT,
  reportsLine,
  SELF_HOSTED_WARNINGS,
  settle,
  snippetForLauncher,
  snippetForTrail,
  testReportText,
} from './copy';
import styles from './Feedback.module.css';
import { useAgentAssesses, useFeedbackWords, useReportsDestination } from './useFeedbackWords';

/** One installation snippet: what it is and a copy button above, the code wrapped below. */
function CodeBlock({
  code,
  hint,
  copyLabel,
  copied,
}: {
  code: string;
  hint: string;
  copyLabel: string;
  copied: string;
}) {
  return (
    <div className={styles.codeWrap}>
      <div className={styles.codeHead}>
        <p className={styles.hint}>{hint}</p>
        <CopyButton text={code} copied={copied} className={styles.cspCopy}>
          {copyLabel}
        </CopyButton>
      </div>
      <pre className={styles.code}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export interface IntegrationDetailProps {
  burrow: string;
  detail: FeedbackIntegrationDetail;
}

/**
 * How this Whombat delivers website reports. On a managed Whombat (AP-105) the snippets load the widget from the
 * embed origin and pin the site key; health shows the delivery through Whombat's cloud. Where the drop isn't
 * available (an older runtime, or its cloud connection can't carry it), INSTALL keeps AP-102's notice instead of
 * snippets that couldn't work, and intake can be switched off but never on.
 */
export function useDelivery(detail: FeedbackIntegrationDetail) {
  const managed = useManaged() !== null;
  const { health } = detail;
  const drop = managed && dropAvailable(health);
  return {
    managed,
    drop,
    /** Nothing to paste: a managed Whombat without the drop. */
    unavailable: managed && !drop,
    delivery: drop ? health.delivery : null,
    warnings: managed ? health.warnings.filter((w) => !SELF_HOSTED_WARNINGS.has(w.code)) : health.warnings,
  };
}

function useTimeZone(burrow: string) {
  const { data: boot } = useBootstrap({ params: { burrow } });
  return boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'UTC';
}

/** The intake and assessment switches (FB-19), each applied at once through the API, with their outcome. */
export function IntegrationStatus({ burrow, detail }: IntegrationDetailProps) {
  const words = useFeedbackWords(burrow);
  const assesses = useAgentAssesses(burrow);
  const toast = useToast();
  const qc = useQueryClient();
  const ids = useId();
  const setIntake = useApiMutation(api.feedback.setIntake);
  const setAssessment = useApiMutation(api.feedback.setAssessment);
  const [notice, setNotice] = useState<string | null>(null);
  const { integration: i } = detail;
  const { managed, drop } = useDelivery(detail);
  const busy = setIntake.isPending || setAssessment.isPending;

  function applied(next: FeedbackIntegration, done: string) {
    qc.setQueryData(queryKeys.feedback.getIntegration({ params: { burrow, id: i.id } }), (old) =>
      old ? { ...old, integration: next } : old,
    );
    void qc.invalidateQueries({ queryKey: queryKeys.scope(api.feedback.getIntegration, { id: i.id }) });
    void qc.invalidateQueries({ queryKey: queryKeys.scope(api.feedback.listIntegrations) });
    toast.show(done);
  }

  async function toggleIntake(enabled: boolean) {
    setNotice(null);
    try {
      const settled = settle(
        await setIntake.mutateAsync({ params: { burrow, id: i.id }, body: { enabled } }),
      );
      if (settled.ok)
        applied(
          settled.data.integration,
          enabled ? `${i.name} accepts reports again.` : `${i.name} stopped accepting reports.`,
        );
      else setNotice(settled.text);
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  async function toggleAssessment(active: boolean) {
    setNotice(null);
    try {
      const settled = settle(
        await setAssessment.mutateAsync({ params: { burrow, id: i.id }, body: { active } }),
      );
      if (settled.ok)
        applied(settled.data.integration, active ? 'Assessment resumed.' : 'Assessment paused.');
      else setNotice(settled.text);
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  return (
    <>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <div className={settings.card}>
        <div className={styles.switchRow}>
          <span className={settings.rowMain}>
            <span id={`${ids}-intake`} className={settings.rowTitle}>
              {FEEDBACK_TEXT.acceptReports}
            </span>
            <span id={`${ids}-intake-hint`} className={settings.rowMeta}>
              {FEEDBACK_TEXT.acceptReportsHint}
            </span>
          </span>
          <Toggle
            checked={i.intake === 'enabled'}
            // Without the drop a managed Whombat refuses intake: it can still be switched off, never on.
            disabled={busy || (managed && !drop && i.intake !== 'enabled')}
            aria-labelledby={`${ids}-intake`}
            aria-describedby={`${ids}-intake-hint`}
            onCheckedChange={(v) => void toggleIntake(v)}
          />
        </div>
        <div className={styles.switchRow}>
          <span className={settings.rowMain}>
            <span id={`${ids}-assess`} className={settings.rowTitle}>
              {FEEDBACK_TEXT.assessReports}
            </span>
            <span id={`${ids}-assess-hint`} className={settings.rowMeta}>
              {assesses ? FEEDBACK_TEXT.assessReportsHint : words.assessNoAgent}
            </span>
          </span>
          <Toggle
            checked={assesses && i.assessment === 'active'}
            disabled={busy || !assesses}
            aria-labelledby={`${ids}-assess`}
            aria-describedby={`${ids}-assess-hint`}
            onCheckedChange={(v) => void toggleAssessment(v)}
          />
        </div>
      </div>
    </>
  );
}

/** HEALTH: reports, assessments, the public address or the drop's delivery, and the server's warnings. */
export function IntegrationHealth({ burrow, detail }: IntegrationDetailProps) {
  const { tag: uiLocale } = useWebI18n();
  const timeZone = useTimeZone(burrow);
  const navigate = useNavigateHref();
  const where = useReportsDestination(burrow)(detail.integration);
  const { health } = detail;
  const { managed, delivery, warnings } = useDelivery(detail);
  const now = Date.now();
  const a = health.assessments;
  return (
    <div className={settings.card}>
      <dl className={styles.facts}>
        {/* Where they land, with its link when it is the viewer's (feedback-chat.md AP-1832). */}
        <dt>{FEEDBACK_TEXT.reportsGoTo}</dt>
        <dd>
          {where.href ? (
            <a
              href={where.href}
              className={styles.inlineLink}
              onClick={(e) => {
                if (!where.href || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(where.href);
              }}
            >
              {where.text.charAt(0).toUpperCase() + where.text.slice(1)}
            </a>
          ) : (
            where.text.charAt(0).toUpperCase() + where.text.slice(1)
          )}
        </dd>
        <dt>Reports</dt>
        <dd>{reportsLine(health.reportsLast24h)}</dd>
        <dt>Last report</dt>
        <dd>
          {health.lastReportAt ? formatRecent(health.lastReportAt, now, timeZone, uiLocale) : 'None yet'}
        </dd>
        <dt>Assessments</dt>
        <dd>
          {a.queued} queued · {a.running} running ·{' '}
          <span className={a.failed ? styles.bad : undefined}>{a.failed} failed</span> ·{' '}
          <span className={a.blocked ? styles.warn : undefined}>{a.blocked} blocked</span>
        </dd>
        {!managed && (
          <>
            <dt>{FEEDBACK_TEXT.publicAddress}</dt>
            <dd className={health.publicUrl ? styles.mono : styles.warn}>
              {health.publicUrl ?? FEEDBACK_TEXT.noPublicAddress}
            </dd>
          </>
        )}
        {delivery && (
          <>
            <dt>{FEEDBACK_TEXT.delivery}</dt>
            <dd>{FEEDBACK_TEXT.deliveryDrop}</dd>
            <dt>{FEEDBACK_TEXT.published}</dt>
            <dd className={delivery.publishedAt ? undefined : styles.warn}>
              {delivery.publishedAt
                ? formatRecent(delivery.publishedAt, now, timeZone, uiLocale)
                : FEEDBACK_TEXT.notPublished}
            </dd>
            <dt>{FEEDBACK_TEXT.lastCollected}</dt>
            <dd>
              {delivery.lastCollectedAt
                ? formatRecent(delivery.lastCollectedAt, now, timeZone, uiLocale)
                : FEEDBACK_TEXT.notCollected}
            </dd>
            {health.publicUrl && (
              <>
                <dt>{FEEDBACK_TEXT.widgetAddress}</dt>
                <dd className={styles.mono}>{health.publicUrl}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {warnings.length > 0 && (
        <ul className={styles.warnings} aria-label="Warnings">
          {warnings.map((w) => (
            <li key={w.code}>{w.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * INSTALL: one chosen launcher method, the runtime's script with the privacy setting (AP-435) and CSP advice,
 * or AP-102's notice. The neutral custom control is supplied here, also for older runtimes.
 */
export function IntegrationSnippets({ detail }: { detail: FeedbackIntegrationDetail }) {
  const [method, setMethod] = useState(detail.integration.launcher);
  const ids = useId();
  const trail = detail.integration.trail;
  const snippet = snippetForLauncher(snippetForTrail(detail.snippets.basic, trail), method);
  const { unavailable } = useDelivery(detail);
  if (unavailable)
    return (
      <p className={styles.notice} data-feedback-managed="">
        {FEEDBACK_TEXT.managedUnavailable}
      </p>
    );
  return (
    <>
      <label className={cx(styles.field, styles.installChoice)}>
        <span className={styles.fieldLabel} id={`${ids}-install-label`}>
          {FEEDBACK_TEXT.installMethod}
        </span>
        <select
          className={cx(styles.select, styles.installMethod)}
          value={method}
          aria-labelledby={`${ids}-install-label`}
          aria-describedby={`${ids}-install-hint`}
          onChange={(event) => setMethod(event.target.value === 'custom' ? 'custom' : 'floating')}
        >
          <option value="floating">{FEEDBACK_TEXT.floatingMethod}</option>
          <option value="custom">{FEEDBACK_TEXT.customMethod}</option>
        </select>
        <span className={styles.fieldHint} id={`${ids}-install-hint`}>
          {FEEDBACK_TEXT.installHint}
        </span>
      </label>
      <CodeBlock
        code={snippet}
        hint={method === 'custom' ? FEEDBACK_TEXT.customHint : FEEDBACK_TEXT.basicHint}
        copyLabel={FEEDBACK_TEXT.copySnippet}
        copied={FEEDBACK_TEXT.snippetCopied}
      />
      <div className={styles.cspRow}>
        <span className={styles.hint}>{FEEDBACK_TEXT.cspHint}</span>
        <code className={styles.inlineCode}>{detail.snippets.csp}</code>
        <CopyButton text={detail.snippets.csp} copied={FEEDBACK_TEXT.cspCopied} className={styles.cspCopy}>
          {FEEDBACK_TEXT.copyCsp}
        </CopyButton>
      </div>
    </>
  );
}

/**
 * SEND A TEST REPORT (AP-403): there is no endpoint that fakes a visitor, so the test is the real thing: open the
 * website with the snippet in place and send a report with its button; “Check for reports” re-reads the health.
 */
export function TestReport({
  burrow,
  detail,
  onCheck,
  checking,
}: IntegrationDetailProps & { onCheck: () => void; checking: boolean }) {
  const timeZone = useTimeZone(burrow);
  const destination = useReportsDestination(burrow);
  const words = useFeedbackWords(burrow);
  const navigate = useNavigateHref();
  const { unavailable } = useDelivery(detail);
  const ids = useId();
  if (unavailable) return null;
  const { integration: i, health } = detail;
  // Where it lands (feedback-chat.md AP-1832).
  const where = destination(i);
  const origin = i.allowedOrigins[0];
  const last = health.lastReportAt
    ? formatRecent(health.lastReportAt, Date.now(), timeZone, currentLocale())
    : 'None yet';
  return (
    <div className={settings.card}>
      <div className={styles.testBody}>
        <p id={`${ids}-how`} className={styles.testText}>
          {testReportText(i, where.text)}
        </p>
        {i.intake !== 'enabled' && (
          <p className={cx(styles.hint, styles.warn)}>{FEEDBACK_TEXT.testIntakeOff}</p>
        )}
        <div className={styles.testActions}>
          {origin && (
            <ButtonLink
              variant="secondary"
              size="md"
              href={origin}
              target="_blank"
              rel="noopener noreferrer"
              aria-describedby={`${ids}-how`}
            >
              {`Open ${origin}`}
            </ButtonLink>
          )}
          {where.href && (
            <ButtonLink
              variant="secondary"
              size="md"
              href={where.href}
              onClick={(e) => {
                if (!where.href || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(where.href);
              }}
            >
              {words.chat?.open ?? FEEDBACK_TEXT.openChat}
            </ButtonLink>
          )}
          <Button variant="secondary" size="md" onClick={onCheck} disabled={checking}>
            {FEEDBACK_TEXT.checkReports}
          </Button>
          <span className={styles.testStatus} aria-live="polite">
            {reportsLine(health.reportsLast24h)} · Last report: {last}
          </span>
        </div>
      </div>
    </div>
  );
}
