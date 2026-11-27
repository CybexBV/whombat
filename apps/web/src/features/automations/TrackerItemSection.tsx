/**
 * The tracker report on a run's page (docs/decisions/report-trackers.md AP-1024, AP-1025; Whombat TA-14, TA-15): read
 * live from its tracker above the steps — what it is, where it comes from, who sent it, where its fix is (0.75,
 * AP-1111), what happened and what they expected, the screenshot, the conversation — and Reply to the reporter… and Set
 * status…, which the tracker emails to the reporter. The tracker is named in its driver's words (the report's, and the
 * automation's until the report has loaded). Everything the customer wrote is plain text.
 */

import { useQueryClient } from '@tanstack/react-query';
import { ApiError, fixFollowUp, fixLine, fixPullRequest, trackerItemText } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import {
  formatRecent,
  TRACKER_REPLY_MAX,
  type TrackerItemView,
  type TrackerWords,
  trackerStatusLabel,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { type MutableRefObject, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorNote } from '../../components/ListState';
import { Modal, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { currentLocale } from '../../i18n/provider';
import { ImageLightbox, LightboxImage } from '../messaging/MessageAttachments';
import styles from './Automations.module.css';
import { useTrackerItem } from './hooks';
import {
  authorLabel,
  fixPullRequestUrl,
  nextRequest,
  releaseLine,
  reporterLine,
  reportHeading,
  reportPlace,
  reportTags,
  STATUS_CHOICES,
  TRACKER_TEXT,
  type UpdateDraft,
  type UpdateMode,
  type UpdateRequest,
  updateBody,
  updateDoneText,
  updateProblem,
} from './trackerItem';

/** The server's words for a refusal; anything else (no answer) in ours. */
function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

export function TrackerItemSection({
  burrow,
  runId,
  timeZone,
  words,
}: {
  burrow: string;
  runId: string;
  timeZone: string;
  /** The tracker's words as the automation keeps them, until the report says its own. */
  words: TrackerWords;
}) {
  const params = { burrow, runId };
  const { data, error, isPending, refetch } = useTrackerItem({ params }, { retry: false });
  const [mode, setMode] = useState<UpdateMode | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  // The last submission's request id, kept on the page: the same words sent again — after a lost answer, even from a
  // reopened modal — reuse it, so the tracker replays the first instead of emailing twice (AP-1025).
  const request = useRef<UpdateRequest | null>(null);
  const now = new Date();
  const report = data?.report;
  const text = trackerItemText(report?.words ?? words);
  return (
    <section className={styles.section} aria-labelledby="run-tracker" data-tracker-report="">
      <SectionLabel as="h2" id="run-tracker">
        {TRACKER_TEXT.section}
      </SectionLabel>
      <div className={styles.card} aria-busy={isPending || undefined}>
        {!report ? (
          isPending ? (
            <p className={styles.empty}>{text.loading}</p>
          ) : (
            <ErrorNote
              className={styles.reportError}
              message={
                error instanceof ApiError && error.message ? text.failedWith(error.message) : text.failed
              }
              retryLabel={TRACKER_TEXT.retry}
              onRetry={() => void refetch()}
            />
          )
        ) : (
          <>
            <div className={styles.reportBlock}>
              <h3 className={styles.reportTitle}>{reportHeading(report)}</h3>
              <span className={styles.rowMetaWrap}>{reportPlace(report)}</span>
              <ul className={styles.assessmentLine} aria-label={reportTags(report).join(', ')}>
                {reportTags(report).map((tag, i) => (
                  <li key={tag}>
                    <Tag tone={i === 0 ? 'ink' : undefined}>{tag}</Tag>
                  </li>
                ))}
              </ul>
            </div>
            <div className={styles.reportBlock}>
              <dl className={styles.reportFacts}>
                <dt>{TRACKER_TEXT.reporter}</dt>
                <dd>{reporterLine(report.reporter)}</dd>
                <dt>{TRACKER_TEXT.filed}</dt>
                <dd>{formatRecent(report.createdAt, now, timeZone, currentLocale())}</dd>
                {report.fix && (
                  <>
                    <dt>{TRACKER_TEXT.fix}</dt>
                    <dd data-tracker-fix="">
                      <FixLine fix={report.fix} words={report.words} />
                    </dd>
                  </>
                )}
              </dl>
            </div>
            {/* What they wrote, the screenshot beside it (a column of its own on the right). */}
            <div className={`${styles.reportBlock} ${report.screenshot ? styles.reportStory : ''}`}>
              <div className={styles.reportColumn}>
                <span className={styles.fieldLabel}>{TRACKER_TEXT.happened}</span>
                <p className={styles.reportText}>
                  {report.description.trim() || TRACKER_TEXT.nothingWritten}
                </p>
                {report.expected.trim() && (
                  <>
                    <span className={`${styles.fieldLabel} ${styles.reportLabelGap}`}>
                      {TRACKER_TEXT.expected}
                    </span>
                    <p className={styles.reportText}>{report.expected.trim()}</p>
                  </>
                )}
              </div>
              {report.screenshot && (
                <div className={styles.reportColumn}>
                  <span className={styles.fieldLabel}>{TRACKER_TEXT.screenshot}</span>
                  <button
                    type="button"
                    className={styles.reportShot}
                    aria-label={TRACKER_TEXT.enlarge}
                    onClick={() => setEnlarged(true)}
                  >
                    <img src={report.screenshot} alt="" />
                  </button>
                </div>
              )}
            </div>
            <div className={styles.reportBlock}>
              <span className={styles.fieldLabel}>{TRACKER_TEXT.conversation}</span>
              {report.messages.length === 0 ? (
                <p className={styles.reportQuiet}>{TRACKER_TEXT.noReplies}</p>
              ) : (
                <ol className={styles.reportMessages}>
                  {report.messages.map((m, i) => (
                    // The tracker's order, never changed here; two messages may share author and time.
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
                    <li key={i}>
                      <span className={styles.reportMessageMeta}>
                        <span className={styles.reportAuthor}>{authorLabel(m.author, report.words)}</span> ·{' '}
                        {formatRecent(m.at, now, timeZone, currentLocale())}
                      </span>
                      <p className={styles.reportText}>{m.body}</p>
                    </li>
                  ))}
                </ol>
              )}
              {report.release && <p className={styles.reportQuiet}>{releaseLine(report.release)}</p>}
            </div>
            {data.can.update && (
              <div className={styles.reportBlock}>
                <div className={styles.actions}>
                  <Button variant="secondary" size="sm" onClick={() => setMode('reply')}>
                    {TRACKER_TEXT.reply}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setMode('status')}>
                    {TRACKER_TEXT.setStatus}
                  </Button>
                </div>
                <span className={styles.fieldHint}>{text.emails}</span>
              </div>
            )}
          </>
        )}
      </div>
      {report?.screenshot && (
        <ImageLightbox
          open={enlarged}
          onClose={() => setEnlarged(false)}
          title={TRACKER_TEXT.screenshotAlt}
          meta={reportHeading(report)}
        >
          <LightboxImage src={report.screenshot} alt={TRACKER_TEXT.screenshotAlt} />
        </ImageLightbox>
      )}
      {report && (
        <Modal open={mode !== null} onOpenChange={(open) => !open && setMode(null)} width="md">
          {mode && (
            <UpdateForm
              key={mode}
              burrow={burrow}
              runId={runId}
              report={report}
              mode={mode}
              request={request}
              onClose={() => setMode(null)}
            />
          )}
        </Modal>
      )}
    </section>
  );
}

/**
 * Where the report's fix is (AP-1111): “PR #52 merged · live on dev.desk.acme.example (Acme Desk 0.1.176) · waiting for
 * production”, the pull request a link to GitHub; what the customer said about it, and Whombat's note when there is one.
 */
function FixLine({ fix, words }: { fix: NonNullable<TrackerItemView['fix']>; words: TrackerWords }) {
  const pr = fixPullRequest(fix);
  const url = fixPullRequestUrl(fix);
  const line = fixLine(fix, words);
  const followUp = fixFollowUp(fix);
  const note = fix.note?.trim();
  return (
    <span className={styles.reportFix}>
      <span>
        {url ? (
          <a className={styles.inlineLink} href={url} target="_blank" rel="noreferrer">
            {pr}
          </a>
        ) : (
          pr
        )}
        {line.slice(pr.length)}
      </span>
      {followUp && <span>{followUp}</span>}
      {note && <span className={styles.reportQuiet}>{note}</span>}
    </span>
  );
}

/**
 * Reply to the reporter (a reply, and a status if the person wants one) or Set the status (a status, and a reply if
 * they want; Not planned needs one). Mounted per opening; the request id is the page's, for a retry of the same words.
 */
function UpdateForm({
  burrow,
  runId,
  report,
  mode,
  request,
  onClose,
}: {
  burrow: string;
  runId: string;
  report: TrackerItemView;
  mode: UpdateMode;
  request: MutableRefObject<UpdateRequest | null>;
  onClose: () => void;
}) {
  const id = useId();
  const current = STATUS_CHOICES.some((c) => c.id === report.status) ? report.status : '';
  const [draft, setDraft] = useState<UpdateDraft>({
    mode,
    message: '',
    status: mode === 'status' ? (current as UpdateDraft['status']) : '',
  });
  const [tried, setTried] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const update = useApiMutation(api.tracker.update);
  const qc = useQueryClient();
  const toast = useToast();
  const problem = tried ? updateProblem(draft, report.status) : null;
  const shown = problem ?? refused;
  const set = (patch: Partial<UpdateDraft>) => {
    setRefused(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const submit = () => {
    setTried(true);
    setRefused(null);
    if (updateProblem(draft, report.status)) return;
    const body = updateBody(draft);
    // The same words again (a lost answer, a refusal) keep the id: the tracker replays it and emails once (TA-15).
    request.current = nextRequest(request.current, body, () => crypto.randomUUID());
    update.mutate(
      { params: { burrow, runId }, body: { requestId: request.current.id, ...body } },
      {
        onSuccess: (res) => {
          if (res.status !== 'ok') {
            setRefused(res.status === 'blocked' ? res.message : 'That needs a person to approve first.');
            return;
          }
          request.current = null;
          qc.setQueryData(queryKeys.tracker.item({ params: { burrow, runId } }), (old) =>
            old ? { ...old, report: res.data.report } : old,
          );
          toast.show(updateDoneText(body));
          onClose();
        },
        onError: (err) => setRefused(errorText(err, TRACKER_TEXT.unreachable)),
      },
    );
  };

  const replyField = (label: string, hint?: string) => (
    <div className={`${styles.field} ${styles.fieldWide}`}>
      <label className={styles.fieldLabel} htmlFor={`${id}-reply`}>
        {label}
      </label>
      <textarea
        id={`${id}-reply`}
        className={styles.textarea}
        style={{ minHeight: mode === 'reply' ? 140 : 96 }}
        value={draft.message}
        maxLength={TRACKER_REPLY_MAX}
        placeholder={TRACKER_TEXT.replyPlaceholder}
        aria-describedby={hint ? `${id}-reply-hint` : undefined}
        onChange={(e) => set({ message: e.target.value })}
      />
      {hint && (
        <span id={`${id}-reply-hint`} className={styles.fieldHint}>
          {hint}
        </span>
      )}
    </div>
  );

  return (
    <>
      <div className={styles.heading}>
        <ModalTitle className={styles.modalTitle}>
          {mode === 'reply' ? TRACKER_TEXT.replyTitle : TRACKER_TEXT.statusTitle}
        </ModalTitle>
        <ModalDescription className={styles.reportQuiet}>
          {`${report.connection} ${reportHeading(report)}`}
        </ModalDescription>
      </div>
      <div className={styles.fields}>
        {mode === 'reply' ? (
          <>
            {replyField(TRACKER_TEXT.replyLabel)}
            <div className={`${styles.field} ${styles.fieldWide}`}>
              <label className={styles.fieldLabel} htmlFor={`${id}-status`}>
                {TRACKER_TEXT.alsoStatus}
              </label>
              <select
                id={`${id}-status`}
                className={styles.select}
                value={draft.status}
                onChange={(e) => set({ status: e.target.value as UpdateDraft['status'] })}
              >
                <option value="">{`Leave it at ${trackerStatusLabel(report.status)}`}</option>
                {STATUS_CHOICES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <>
            <fieldset className={`${styles.group} ${styles.fieldWide}`}>
              <legend>{TRACKER_TEXT.statusLabel}</legend>
              <div className={styles.checksColumn}>
                {STATUS_CHOICES.map((c) => (
                  <label key={c.id} className={styles.check}>
                    <input
                      type="radio"
                      name={`${id}-status`}
                      value={c.id}
                      checked={draft.status === c.id}
                      onChange={() => set({ status: c.id })}
                    />
                    <span>
                      {c.label}
                      {c.id === report.status ? <span className={styles.reportQuiet}> · now</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {replyField(TRACKER_TEXT.replyLabel, TRACKER_TEXT.statusReplyHint)}
          </>
        )}
      </div>
      <p className={styles.note}>
        {mode === 'reply'
          ? trackerItemText(report.words).replyNote
          : trackerItemText(report.words).statusNote}
      </p>
      {shown && (
        <p className={`${styles.note} ${styles.noteBad}`} role="alert">
          {shown}
        </p>
      )}
      <div className={styles.modalActions}>
        <Button variant="secondary" size="xl" onClick={onClose}>
          {TRACKER_TEXT.cancel}
        </Button>
        <Button variant="primary" size="xl" disabled={update.isPending} onClick={submit}>
          {mode === 'reply' ? TRACKER_TEXT.sendReply : TRACKER_TEXT.sendStatus}
        </Button>
      </div>
    </>
  );
}
