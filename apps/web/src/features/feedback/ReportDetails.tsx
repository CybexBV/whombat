import { useQueryClient } from '@tanstack/react-query';
import { ApiError, type CommitResult } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation, useBootstrap, useFeedbackReport, useTheAgent } from '@whombat/client/react';
import { api, FEEDBACK_HANDOFF_NOTE_MAX } from '@whombat/core/contracts';
import {
  FEEDBACK_ASSESSMENT_STATE_LABELS,
  FEEDBACK_OUTCOME_LABELS,
  FEEDBACK_STATUS_LABELS,
  type FeedbackAssessment,
  type FeedbackReport,
  type FeedbackReportStatus,
  FeedbackReportStatus as ReportStatus,
} from '@whombat/core/domain';
import { formatBytes, formatClock, formatDate, formatRecent } from '@whombat/core/text';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { currentLocale, useWebI18n } from '../../i18n/provider';
import {
  ATTEMPT_STATE_LABELS,
  CONFIDENCE_LABELS,
  EVIDENCE_KIND_LABELS,
  errorText,
  FEEDBACK_TEXT,
  type FeedbackOutcome,
  REPRODUCTION_LABELS,
  SEVERITY_LABELS,
  settle,
  trailBefore,
  trailPath,
} from './copy';
import styles from './ReportDetails.module.css';
import { useFeedbackWords } from './useFeedbackWords';

const NOT_VISIBLE = 'You can’t see this report.';

export interface ReportDetailsProps {
  burrow: string;
  reportId: string;
  /** The report thread's conversation: its messages refresh after a change so the card follows. */
  conversationId: string;
}

/** A labelled block of plain text (never Markdown, links or mentions). */
function Plain({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className={styles.block}>
      <span className={styles.blockLabel}>{label}</span>
      <p className={styles.plain}>{text}</p>
    </div>
  );
}

function Section({
  title,
  note,
  unverified = false,
  children,
}: {
  title: string;
  note?: ReactNode;
  /** The note warns that what follows is unverified (visitor or website data). */
  unverified?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <h4 id={id} className={styles.sectionTitle}>
          {title}
        </h4>
        {note && <span className={unverified ? styles.sectionWarn : styles.sectionNote}>{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (shown.length === 0) return null;
  return (
    <dl className={styles.facts}>
      {shown.map(([k, v]) => (
        <div key={k} className={styles.fact}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The full report under its card (docs/decisions/feedback.md FB-16, FB-17, FB-22…FB-25): what the visitor sent
 * (unverified), the context the website supplied, the screenshots (shown by the message's own attachments), the
 * assessment with every field, the attempts, and the actions the viewer may take: status, retry, handoff and
 * content removal. Everything visitor- or agent-written is plain text. In your Feedback (AP-1829); a report that isn't
 * there says it can't be seen.
 */
export function ReportDetails({ burrow, reportId, conversationId }: ReportDetailsProps) {
  const query = useFeedbackReport({ params: { burrow, id: reportId } });
  if (query.error && !query.data) {
    const hidden =
      query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 403);
    return hidden ? (
      <p className={styles.muted}>{NOT_VISIBLE}</p>
    ) : (
      <ErrorNote
        message="Couldn’t load this report. Try again in a moment."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data)
    return (
      <div aria-busy="true">
        <SkeletonRows count={3} lines={2} />
      </div>
    );
  return (
    <ReportBody
      burrow={burrow}
      conversationId={conversationId}
      report={query.data.report}
      can={query.data.can}
    />
  );
}

type Can = { setStatus: boolean; retry: boolean; handoff: boolean; redact: boolean };

function ReportBody({
  burrow,
  conversationId,
  report: r,
  can,
}: {
  burrow: string;
  conversationId: string;
  report: FeedbackReport;
  can: Can;
}) {
  const { t } = useWebI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const ids = useId();
  const words = useFeedbackWords(burrow);
  const { words: agent } = useTheAgent(burrow);
  const { data: boot } = useBootstrap({ params: { burrow } });
  const timeZone = boot?.preferences.timeZone ?? boot?.burrow.timeZone ?? 'UTC';
  const now = Date.now();
  const name = (id: string | null) =>
    id ? (boot?.principals.find((p) => p.id === id)?.name ?? 'Someone') : null;

  const setStatus = useApiMutation(api.feedback.setReportStatus);
  const retry = useApiMutation(api.feedback.retryAssessment);
  const handoff = useApiMutation(api.feedback.requestHandoff);
  const redact = useApiMutation(api.feedback.redactReport);
  const busy = setStatus.isPending || retry.isPending || handoff.isPending || redact.isPending;

  const [notice, setNotice] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);

  function applied(next: FeedbackReport) {
    qc.setQueryData(queryKeys.feedback.getReport({ params: { burrow, id: r.id } }), (old) =>
      old ? { ...old, report: next } : old,
    );
    void qc.invalidateQueries({ queryKey: queryKeys.scope(api.feedback.getReport, { id: r.id }) });
    void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.list', { conversationId }) });
    void qc.invalidateQueries({ queryKey: queryKeys.scope('messages.thread') });
  }

  async function run(
    action: () => Promise<CommitResult<FeedbackOutcome<{ report: FeedbackReport }>>>,
    done: string,
    words: { notAvailable: string },
  ): Promise<boolean> {
    setNotice(null);
    try {
      const settled = settle(await action());
      if (settled.ok) {
        applied(settled.data.report);
        toast.show(done);
        return true;
      }
      setNotice(settled.text);
      if (settled.pending)
        void qc.invalidateQueries({ queryKey: queryKeys.scope(api.feedback.getReport, { id: r.id }) });
      return settled.pending;
    } catch (e) {
      setNotice(errorText(e, { ...words, notFound: NOT_VISIBLE }));
      return false;
    }
  }

  const params = { burrow, id: r.id };
  const a = r.assessment;
  const removed = r.contentRemovedAt !== null;
  // The server decides (feedback/read.ts `reportPermissions`): Retry from failed, blocked or paused-while-active;
  // handoff once assessed, again after a decline.
  const canRetry = can.retry;
  const canHandoff = can.handoff;
  const s = r.submitted;
  const ctx = s.context;
  const reporter = [s.reporter.name, s.reporter.email].filter(Boolean).join(' · ');
  const app = ctx.app
    ? [ctx.app.version, ctx.app.environment, ctx.app.build].filter(Boolean).join(' · ')
    : '';
  const browser = ctx.browser
    ? [
        ctx.browser.name,
        ctx.browser.language,
        ctx.browser.viewport ? `${ctx.browser.viewport.width} × ${ctx.browser.viewport.height}` : null,
        ctx.browser.timeZone,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div className={styles.body}>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      {removed ? (
        <p className={styles.muted}>
          {t('reports.contentRemoved', {
            date: formatDate(r.contentRemovedAt ?? r.updatedAt, timeZone, { now }, currentLocale()),
          })}
        </p>
      ) : (
        <>
          <Section title="WHAT THEY SENT" note="Unverified — given by the visitor" unverified>
            <Plain label="What happened" text={s.description} />
            <Plain label="What they expected" text={s.expected} />
            <Plain label="Steps" text={s.steps} />
            <div className={styles.block}>
              <span className={styles.blockLabel}>From</span>
              <p className={styles.plain}>
                {reporter || 'No name or email given.'}
                {s.reporter.verified && s.reporter.email && (
                  <span className={styles.verified} role="img" aria-label={FEEDBACK_TEXT.emailVerifiedLabel}>
                    <Icon name="emailVerified" size={14} />
                    <span aria-hidden="true">{FEEDBACK_TEXT.emailVerified}</span>
                  </span>
                )}
              </p>
            </div>
          </Section>

          <Section title="CONTEXT" note="Supplied by the website — not verified" unverified>
            <Facts
              rows={[
                [
                  'Page',
                  ctx.page ? (
                    <span key="page" className={styles.mono}>
                      {ctx.page.url}
                    </span>
                  ) : null,
                ],
                ['Page title', ctx.page?.title ?? null],
                ['Browser', browser],
                ['App', app],
                ...Object.entries(ctx.custom).map(
                  ([k, v]) =>
                    [
                      k,
                      <span key={k} className={styles.mono}>
                        {String(v)}
                      </span>,
                    ] as [string, ReactNode],
                ),
                [
                  'References',
                  ctx.references.length ? (
                    <span key="references" className={styles.mono}>
                      {ctx.references.join(' · ')}
                    </span>
                  ) : null,
                ],
                ['Sent', ctx.sentAt ? `${formatClock(ctx.sentAt, timeZone)} by the visitor’s clock` : null],
              ]}
            />
            {s.trail.length > 0 && (
              <div className={styles.block}>
                <span className={styles.blockLabel}>{FEEDBACK_TEXT.pagesBefore}</span>
                <ol className={styles.trail}>
                  {s.trail.map((step, i) => {
                    const before = trailBefore(step.at, ctx.sentAt);
                    return (
                      // Steps may repeat a page; their order is what they are.
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, never reordered
                      <li key={i} className={styles.trailStep}>
                        <span className={styles.mono}>{trailPath(step.url)}</span>
                        {step.title && <span className={styles.trailTitle}>{step.title}</span>}
                        {before && <span className={styles.trailWhen}>{before}</span>}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
            {!ctx.page &&
              !browser &&
              !app &&
              Object.keys(ctx.custom).length === 0 &&
              ctx.references.length === 0 &&
              s.trail.length === 0 && <p className={styles.muted}>The website sent no context.</p>}
          </Section>

          {s.attachments.length > 0 && (
            <Section title="SCREENSHOTS" note="Shown with the message above">
              <ul className={styles.list}>
                {s.attachments.map((f) => (
                  <li key={f.id}>
                    <span className={styles.mono}>{f.name}</span>{' '}
                    <span className={styles.muted}>
                      {formatBytes(f.size, currentLocale())}
                      {f.width && f.height ? ` · ${f.width} × ${f.height}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      <Section
        title="ASSESSMENT"
        note={
          a.state === 'not_configured'
            ? undefined
            : `by ${agent.name}${a.workspace ? ` · ${a.workspace.repo} @ ${a.workspace.ref}` : ''}`
        }
      >
        <p className={styles.stateLine} data-state={a.state}>
          {FEEDBACK_ASSESSMENT_STATE_LABELS[a.state]}
          {a.reason ? ` — ${a.reason}` : ''}
        </p>
        {a.result && <AssessmentResult result={a.result} />}
      </Section>

      {r.attempts.length > 0 && (
        <Section title="ATTEMPTS">
          <ol className={styles.list}>
            {r.attempts.map((t) => (
              <li key={t.id}>
                #{t.attempt} · {ATTEMPT_STATE_LABELS[t.state]} · {agent.name} ·{' '}
                {formatRecent(t.startedAt, now, timeZone, currentLocale())}
                {t.finishedAt ? ` – ${formatClock(t.finishedAt, timeZone)}` : ''}
                {t.requestedById ? ` · retried by ${name(t.requestedById)}` : ''}
                {t.error && <span className={styles.error}> — {t.error}</span>}
              </li>
            ))}
          </ol>
        </Section>
      )}

      {r.handoff && (
        <Section title="DEVELOPMENT">
          <p className={styles.plain}>
            Asked for development: approval #{r.handoff.approvalNumber} · {r.handoff.state}
          </p>
        </Section>
      )}

      {(can.setStatus || canRetry || canHandoff || (can.redact && !removed)) && (
        <div className={styles.actions}>
          {can.setStatus && (
            <label className={styles.statusField} htmlFor={`${ids}-status`}>
              <span className={styles.blockLabel}>Status</span>
              <select
                id={`${ids}-status`}
                className={styles.select}
                value={r.status}
                disabled={busy}
                onChange={(e) => {
                  const status = e.target.value as FeedbackReportStatus;
                  void run(
                    () => setStatus.mutateAsync({ params, body: { status } }),
                    `${r.reference} is ${FEEDBACK_STATUS_LABELS[status].toLowerCase()} now.`,
                    { notAvailable: 'Changing a report’s status isn’t available on this Whombat yet.' },
                  );
                }}
              >
                {ReportStatus.options.map((st) => (
                  <option key={st} value={st}>
                    {FEEDBACK_STATUS_LABELS[st]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canRetry && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() => retry.mutateAsync({ params, body: {} }), 'Assessment queued again.', {
                  notAvailable: 'Retrying assessments isn’t available on this Whombat yet.',
                })
              }
            >
              Retry assessment
            </Button>
          )}
          {canHandoff && !asking && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setAsking(true)}>
              Ask for development
            </Button>
          )}
          {can.redact && !removed && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              Remove content
            </Button>
          )}
        </div>
      )}

      {canHandoff && asking && (
        <form
          className={styles.handoff}
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => handoff.mutateAsync({ params, body: { note: note.trim() } }),
              'Development waits for your yes in this thread.',
              { notAvailable: 'Handing reports to development isn’t available on this Whombat yet.' },
            ).then((ok) => {
              if (ok) {
                setAsking(false);
                setNote('');
              }
            });
          }}
        >
          <label className={styles.blockLabel} htmlFor={`${ids}-note`}>
            {words.noteLabel}
          </label>
          <textarea
            id={`${ids}-note`}
            className={styles.textarea}
            value={note}
            maxLength={FEEDBACK_HANDOFF_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            aria-describedby={`${ids}-note-hint`}
          />
          <span id={`${ids}-note-hint`} className={styles.muted}>
            {words.noteHint}
          </span>
          <div className={styles.handoffActions}>
            <Button variant="secondary" size="sm" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy}>
              Hand to development
            </Button>
          </div>
        </form>
      )}

      <Modal open={confirming} onOpenChange={setConfirming}>
        <ModalTitle className={styles.confirmTitle}>Remove the content of {r.reference}?</ModalTitle>
        <ModalDescription className={styles.confirmText}>
          The description, expected result and steps, the visitor’s name and email, the page and browser
          context and the screenshots are deleted for good. The reference, its status, the assessment and the
          signed history stay.
        </ModalDescription>
        <div className={styles.handoffActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="md">
              Cancel
            </Button>
          </ModalClose>
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() =>
              void run(() => redact.mutateAsync({ params, body: {} }), `Content of ${r.reference} removed.`, {
                notAvailable: 'Removing report content isn’t available on this Whombat yet.',
              }).then(() => setConfirming(false))
            }
          >
            Remove content
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function AssessmentResult({ result: x }: { result: FeedbackAssessment }) {
  const rev = x.revision;
  return (
    <>
      <p className={styles.outcome}>
        {FEEDBACK_OUTCOME_LABELS[x.outcome]}{' '}
        <span className={styles.muted}>· {CONFIDENCE_LABELS[x.confidence].toLowerCase()} confidence</span>
      </p>
      <p className={styles.plain}>{x.summary}</p>
      <Facts
        rows={[
          ['Uncertain', x.uncertainty],
          [
            'Reproduction',
            `${REPRODUCTION_LABELS[x.reproduction.status]}${x.reproduction.notes ? ` — ${x.reproduction.notes}` : ''}`,
          ],
          [
            'Revision',
            rev.inspected || rev.reported ? (
              <>
                <span className={styles.mono}>{rev.inspected ?? 'no code read'}</span> inspected
                {rev.reported ? (
                  <>
                    {' '}
                    · <span className={styles.mono}>{rev.reported}</span> reported
                  </>
                ) : null}
                {rev.mismatch ? <span className={styles.warnText}> — {rev.mismatch}</span> : null}
              </>
            ) : (
              'No code read'
            ),
          ],
          [
            'Severity',
            `${SEVERITY_LABELS[x.severity.level]}${x.severity.rationale ? ` — ${x.severity.rationale}` : ''}`,
          ],
          ['Next action', x.nextAction],
          [
            'Duplicate of',
            x.duplicateOf ? (
              <span key="duplicate" className={styles.mono}>
                {x.duplicateOf}
              </span>
            ) : null,
          ],
        ]}
      />
      {x.evidence.length > 0 && (
        <div className={styles.block}>
          <span className={styles.blockLabel}>Evidence</span>
          <ul className={styles.evidence}>
            {x.evidence.map((e) => (
              <li key={`${e.kind}:${e.ref}`}>
                <Tag variant="outline" tone={e.hypothesis ? 'warn' : 'ok'}>
                  {e.hypothesis ? 'Hypothesis' : 'Observed'}
                </Tag>
                <span>
                  <span className={styles.muted}>{EVIDENCE_KIND_LABELS[e.kind]} · </span>
                  <span className={styles.mono}>{e.ref}</span>
                  {e.note ? <span className={styles.evidenceNote}> — {e.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {x.missingInformation.length > 0 && (
        <div className={styles.block}>
          <span className={styles.blockLabel}>Missing information</span>
          <ul className={styles.list}>
            {x.missingInformation.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {x.feature && (
        <div className={styles.block}>
          <span className={styles.blockLabel}>As a feature</span>
          <Facts
            rows={[
              ['Goal', x.feature.goal],
              ['Today', x.feature.existingBehavior],
              ['Workarounds', x.feature.workarounds],
              ['Scope', x.feature.scope],
              ['Trade-offs', x.feature.tradeoffs],
            ]}
          />
        </div>
      )}
    </>
  );
}
